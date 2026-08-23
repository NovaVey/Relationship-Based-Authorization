/**
 * `checkInvariant` — build spec §5: exhaustive search over the monotone
 * fragment of the schema graph (union + computedUserset + tupleToUserset;
 * intersection/exclusion are §7's job and yield `UNKNOWN` here, never
 * `HOLDS`).
 *
 * Backward from the goal permission (build spec §5's own suggestion,
 * "usually smaller because permissions have fewer inbound rewrite rules
 * than relations have outbound tuples" — see docs/DECISIONS.md D-116 for
 * why this project doesn't need to weigh that trade-off precisely: the
 * schema-graph IR's own edges already run *from* a permission down into
 * its rewrite tree, exactly the direction backward search wants, so
 * "backward from the goal" and "walk `edgesFrom` starting at the goal
 * node" are the same traversal — a reversed graph was never needed).
 *
 * Each tuple-to-userset edge introduces a fresh object variable with a
 * type bound (`UnionFind.bindSlot`); at each terminal (direct) edge, the
 * accumulated constraints are checked for satisfiability — union-find
 * plus a type check, never a solver (`union-find.ts`). On success, the
 * witness is materialized as one concrete object per variable, one tuple
 * per edge walked.
 */
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import type { GraphEdge, NodeId, SchemaGraph } from '../ir/types.js';
import type { Invariant } from '../invariants/types.js';
import { UnionFind, type VarId } from './union-find.js';
import type { CheckResult, WitnessTuple } from './types.js';

function namedNodeId(namespace: string, name: string): NodeId {
  return `${namespace}#${name}`;
}

interface PathTuple {
  readonly objectVar: VarId;
  readonly objectType: string;
  readonly relation: string;
  readonly subjectVar: VarId;
  readonly subjectType: string;
  readonly subjectRelation?: string;
}

interface AttemptSuccess {
  readonly kind: 'success';
  readonly uf: UnionFind;
  readonly tuples: readonly PathTuple[];
}
interface AttemptFail {
  readonly kind: 'fail';
}
interface AttemptUnknown {
  readonly kind: 'unknown';
  readonly reason: string;
}
type AttemptResult = AttemptSuccess | AttemptFail | AttemptUnknown;

interface SearchContext {
  readonly graph: SchemaGraph;
  readonly schema: CompiledSchema;
  readonly goalSubjectVar: VarId;
  readonly varTypes: Map<VarId, string>;
  readonly fresh: { n: number };
}

function freshVar(ctx: SearchContext, type: string): VarId {
  ctx.fresh.n += 1;
  const id = `$fresh${ctx.fresh.n}`;
  ctx.varTypes.set(id, type);
  return id;
}

/** Combines a hop's own tuple (or none, for a zero-cost computedUserset delegation) with a successful sub-result. */
function prepend(tuple: PathTuple | undefined, sub: AttemptSuccess): AttemptSuccess {
  return { kind: 'success', uf: sub.uf, tuples: tuple ? [tuple, ...sub.tuples] : sub.tuples };
}

/** Merges results from trying every option at one branch point (union children, or subjectTypes entries): first success wins; otherwise UNKNOWN if any branch was UNKNOWN, else FAIL. */
function mergeBranches(results: readonly AttemptResult[]): AttemptResult {
  const success = results.find((r): r is AttemptSuccess => r.kind === 'success');
  if (success) return success;
  const unknown = results.find((r): r is AttemptUnknown => r.kind === 'unknown');
  if (unknown) return unknown;
  return { kind: 'fail' };
}

function attempt(
  ctx: SearchContext,
  nodeId: NodeId,
  currentObjectVar: VarId,
  currentObjectType: string,
  visited: ReadonlySet<NodeId>,
  uf: UnionFind,
): AttemptResult {
  if (visited.has(nodeId)) {
    // Cycles are legal in the schema graph, but the monotone fragment's
    // own small-model property (build spec §1) means a minimal witness
    // never needs to unroll one — revisiting a node this search path has
    // already tried offers no new path, so this branch is a dead end,
    // not an error.
    return { kind: 'fail' };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(nodeId);

  const edges = ctx.graph.edgesFrom.get(nodeId) ?? [];
  if (edges.length === 0) return { kind: 'fail' };

  const byKind = new Map<GraphEdge['kind'], GraphEdge[]>();
  for (const e of edges) {
    const bucket = byKind.get(e.kind);
    if (bucket) bucket.push(e);
    else byKind.set(e.kind, [e]);
  }

  const direct = byKind.get('direct');
  if (direct) {
    const edge = direct[0]!;
    if (edge.kind !== 'direct') throw new Error('unreachable');
    const node = ctx.graph.nodes.get(nodeId);
    if (node?.kind !== 'named')
      throw new Error(`search: direct edge from non-named node ${nodeId}`);
    const relationName = node.name;
    const results = edge.subjectTypes.map((st): AttemptResult => {
      if (st.relation === undefined) {
        if (st.namespace !== ctx.varTypes.get(ctx.goalSubjectVar)) return { kind: 'fail' };
        const uf2 = uf.clone();
        if (!uf2.bindSlot(currentObjectVar, relationName, ctx.goalSubjectVar))
          return { kind: 'fail' };
        const tuple: PathTuple = {
          objectVar: currentObjectVar,
          objectType: currentObjectType,
          relation: relationName,
          subjectVar: ctx.goalSubjectVar,
          subjectType: st.namespace,
        };
        return { kind: 'success', uf: uf2, tuples: [tuple] };
      }
      // A userset-subject entry (`namespace#relation`): the tuple names
      // *some* object of `st.namespace` as its subject, and that object's
      // own `st.relation` userset must in turn reach the goal subject —
      // e.g. `document:o#viewer@group:g#member`, recursing into whether
      // `s` reaches `group:g#member`.
      if (st.target === undefined) return { kind: 'fail' }; // undeclared target namespace — nothing to recurse into (see DirectEdge's own doc comment)
      const existing = uf.slotValue(currentObjectVar, relationName);
      const fv = existing ?? freshVar(ctx, st.namespace);
      const uf2 = uf.clone();
      if (!uf2.bindSlot(currentObjectVar, relationName, fv)) return { kind: 'fail' };
      const sub = attempt(ctx, st.target, fv, st.namespace, nextVisited, uf2);
      if (sub.kind !== 'success') return sub;
      const tuple: PathTuple = {
        objectVar: currentObjectVar,
        objectType: currentObjectType,
        relation: relationName,
        subjectVar: fv,
        subjectType: st.namespace,
        subjectRelation: st.relation,
      };
      return prepend(tuple, sub);
    });
    return mergeBranches(results);
  }

  const computed = byKind.get('computedUserset');
  if (computed) {
    const edge = computed[0]!;
    if (edge.kind !== 'computedUserset') throw new Error('unreachable');
    const targetType = ctx.graph.nodes.get(edge.to)?.namespace ?? currentObjectType;
    return attempt(ctx, edge.to, currentObjectVar, targetType, nextVisited, uf);
  }

  const ttu = byKind.get('tupleToUserset');
  if (ttu) {
    const edge = ttu[0]!;
    if (edge.kind !== 'tupleToUserset') throw new Error('unreachable');
    const existing = uf.slotValue(currentObjectVar, edge.viaRelation);
    const existingType = existing ? ctx.varTypes.get(existing) : undefined;
    const candidates = existingType
      ? edge.targets.filter((t) => t.namespace === existingType)
      : edge.targets;
    const results = candidates.map((t): AttemptResult => {
      const fv = existing ?? freshVar(ctx, t.namespace);
      const uf2 = uf.clone();
      if (!uf2.bindSlot(currentObjectVar, edge.viaRelation, fv)) return { kind: 'fail' };
      const sub = attempt(ctx, t.target, fv, t.namespace, nextVisited, uf2);
      if (sub.kind !== 'success') return sub;
      const tuple: PathTuple = {
        objectVar: currentObjectVar,
        objectType: currentObjectType,
        relation: edge.viaRelation,
        subjectVar: fv,
        subjectType: t.namespace,
      };
      return prepend(tuple, sub);
    });
    if (existingType && candidates.length === 0) {
      // The invariant's own constraint already pinned this exact slot to
      // a type `viaRelation` never actually targets — an invariant/schema
      // mismatch, not a search failure worth silently swallowing as a
      // plain "no witness".
      return {
        kind: 'unknown',
        reason: `${currentObjectType}#${edge.viaRelation} never targets ${existingType}, but the invariant's own constraints require it to`,
      };
    }
    return mergeBranches(results);
  }

  const union = byKind.get('unionChild');
  if (union) {
    const results = union.map((e) => {
      if (e.kind !== 'unionChild') throw new Error('unreachable');
      const targetType = ctx.graph.nodes.get(e.to)?.namespace ?? currentObjectType;
      return attempt(ctx, e.to, currentObjectVar, targetType, nextVisited, uf);
    });
    return mergeBranches(results);
  }

  if (
    byKind.has('intersectionChild') ||
    byKind.has('exclusionBase') ||
    byKind.has('exclusionSubtract')
  ) {
    return {
      kind: 'unknown',
      reason: `${nodeId} uses intersection/exclusion — outside the monotone fragment §5 covers; see build spec §7`,
    };
  }

  return { kind: 'fail' };
}

/** Resolves every variable in `tuples` through `uf.find()` and assigns each resulting representative a stable display label — the invariant's own variable name where one exists, else a sequential `obj1`, `obj2`, ... in first-appearance order. */
function materialize(
  uf: UnionFind,
  tuples: readonly PathTuple[],
  namedVars: ReadonlySet<VarId>,
): WitnessTuple[] {
  const labels = new Map<VarId, string>();
  let counter = 0;
  const labelFor = (v: VarId): string => {
    const rep = uf.find(v);
    const existing = labels.get(rep);
    if (existing) return existing;
    // Prefer a named invariant variable whose own representative this is
    // — `union()` already prefers keeping named variables as the
    // surviving representative, so `rep` itself is usually already one.
    const label = namedVars.has(rep) ? rep : ((counter += 1), `obj${counter}`);
    labels.set(rep, label);
    return label;
  };
  return tuples.map((t) => ({
    objectType: t.objectType,
    object: labelFor(t.objectVar),
    relation: t.relation,
    subjectType: t.subjectType,
    subject: labelFor(t.subjectVar),
    ...(t.subjectRelation !== undefined ? { subjectRelation: t.subjectRelation } : {}),
  }));
}

export function checkInvariant(
  graph: SchemaGraph,
  schema: CompiledSchema,
  invariant: Invariant,
): CheckResult {
  const varTypes = new Map<VarId, string>();
  const namedVars = new Set<VarId>();
  for (const v of invariant.variables) {
    varTypes.set(v.name, v.type);
    namedVars.add(v.name);
  }

  const uf = UnionFind.empty();
  for (const c of invariant.constraints) {
    if (c.kind === 'distinct') {
      if (!uf.markDistinct(c.variables)) {
        return {
          verdict: 'UNKNOWN',
          reason: `distinct(${c.variables.join(', ')}) is self-contradictory`,
        };
      }
    }
  }
  for (const c of invariant.constraints) {
    if (c.kind === 'relationEquals') {
      if (!uf.bindSlot(c.subject, c.relation, c.value)) {
        return {
          verdict: 'UNKNOWN',
          reason: `${c.relation}(${c.subject}) = ${c.value} conflicts with a distinct(...) constraint`,
        };
      }
    }
  }

  const goalObjectType = varTypes.get(invariant.goal.object);
  const goalSubjectType = varTypes.get(invariant.goal.subject);
  if (goalObjectType === undefined || goalSubjectType === undefined) {
    return { verdict: 'UNKNOWN', reason: 'goal references a variable with no type declaration' };
  }
  const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
  if (!graph.nodes.has(goalNodeId)) {
    return { verdict: 'UNKNOWN', reason: `${goalNodeId} is not declared in this schema` };
  }

  const ctx: SearchContext = {
    graph,
    schema,
    goalSubjectVar: invariant.goal.subject,
    varTypes,
    fresh: { n: 0 },
  };
  const result = attempt(ctx, goalNodeId, invariant.goal.object, goalObjectType, new Set(), uf);

  if (result.kind === 'fail') return { verdict: 'HOLDS' };
  if (result.kind === 'unknown') return { verdict: 'UNKNOWN', reason: result.reason };
  return { verdict: 'VIOLATED', witness: materialize(result.uf, result.tuples, namedVars) };
}
