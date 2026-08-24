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
import type { Invariant, NotRelationEqualsConstraint } from '../invariants/types.js';
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

/**
 * How many total `attempt()` calls one `checkInvariant()` run may make
 * before giving up honestly (`UNKNOWN`) rather than continuing to search
 * — the exact-search counterpart to `../bounded/search.ts`'s own
 * `MAX_BOUNDED_CANDIDATES`, same order of magnitude and same reasoning:
 * a hard, disclosed ceiling beats an unbounded hang. Exists specifically
 * because the cycle-guard soundness fix below (`instanceKey`, allowing a
 * node to be revisited once per distinct invariant-named variable, not
 * just once ever) can no longer promise the OLD guard's much stronger,
 * but unsound, bound of "at most one visit per node in the entire
 * search" — an adversarial invariant with many named variables, each
 * independently revisiting a node inside a schema cycle that also has
 * ordinary branching (a union with multiple children), can make the
 * *number* of `attempt()` calls grow combinatorially in the variable
 * count, even though the guard genuinely never lets the recursion run
 * forever (see `docs/DECISIONS.md` for the confirmed, measured blowup
 * this ceiling closes). 100,000 was chosen the same way
 * `MAX_BOUNDED_CANDIDATES` was: comfortably beyond anything build spec
 * rule 0.5's own "tens of nodes" schemas could ever need, while still
 * keeping worst-case latency on an adversarial invariant in the
 * neighborhood of a second, not a hang.
 */
export const MAX_ATTEMPT_CALLS = 100_000;

interface SearchContext {
  readonly graph: SchemaGraph;
  readonly schema: CompiledSchema;
  readonly goalSubjectVar: VarId;
  readonly varTypes: Map<VarId, string>;
  readonly fresh: { n: number };
  /**
   * Every variable name the invariant itself declares (`s`, `x`, `o`,
   * ... — never an engine-minted `$freshN`) — see `attempt()`'s own
   * `instanceKey` computation for why this needs to be known at every
   * recursive call, not just at `materialize()` time (the only place
   * `checkInvariant` used to need this distinction before the
   * cycle-guard soundness fix below).
   */
  readonly namedVars: ReadonlySet<VarId>;
  /** Mutable, shared across the whole search — see `MAX_ATTEMPT_CALLS`'s own doc comment. */
  readonly budget: { remaining: number };
  /**
   * The invariant's own `not <relation>(<var>) = <var>` constraints,
   * precomputed once (`docs/DECISIONS.md` D-131) rather than re-filtered
   * out of `invariant.constraints` on every `attempt()` call. Enforced at
   * exactly one dispatch site inside `attempt()` — the bare-principal
   * direct edge — deliberately, not the sibling userset-subject branch or
   * `tupleToUserset`'s own dispatch; see `NotRelationEqualsConstraint`'s
   * own doc comment for why that scope is narrower than "this relation
   * can never reach this value via any path."
   */
  readonly notRelationEquals: readonly NotRelationEqualsConstraint[];
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
  visited: ReadonlySet<string>,
  uf: UnionFind,
): AttemptResult {
  if (ctx.budget.remaining <= 0) {
    // See MAX_ATTEMPT_CALLS's own doc comment — this is the honest,
    // disclosed exit once the search has done as much work as it's
    // allowed to, never a silent HOLDS/VIOLATED it can no longer back up.
    return {
      kind: 'unknown',
      reason: `search exceeded its ${MAX_ATTEMPT_CALLS}-call exploration budget — cannot decide within a bounded number of steps`,
    };
  }
  ctx.budget.remaining -= 1;

  // Cycles are legal in the schema graph — but the monotone fragment's
  // own small-model property (build spec §1) only promises that a
  // *given, fixed* object never needs its node revisited: a node reached
  // again with the SAME object (the same invariant-named variable, or a
  // fresh, engine-minted one already tried as a fresh instance of this
  // node) really is a dead end, since nothing new could be learned. It
  // does NOT promise a node reached with a genuinely DIFFERENT object
  // is redundant — found the hard way (docs/DECISIONS.md documents the
  // confirmed false-HOLDS this produced before this fix): an invariant's
  // own `relationEquals` constraint can pin one instance of a node's
  // relation slot away from the goal subject while a later, freshly
  // introduced instance of the exact same node stays completely
  // unconstrained and free to succeed.
  //
  // `instanceKey` is what actually distinguishes those two cases: one of
  // the invariant's own finitely many declared variables (resolved
  // through `uf.find()` so two names the search has since unified —
  // e.g. two `relationEquals` lines pinning the same slot to two
  // different names — share one key, not two, matching `UnionFind`'s
  // own `bindSlot`/`slotValue` fix, see that file) gets its own key;
  // every engine-minted, unconstrained variable collapses to the single
  // shared `'$fresh'` key, since any two are provably interchangeable —
  // nothing in this invariant language's constraint grammar can ever
  // reference a variable *search.ts* itself minted, only the invariant's
  // own declared names, so no fresh variable is ever distinguishable
  // from any other at the point it's introduced. `MAX_ATTEMPT_CALLS`
  // above is this relaxation's own necessary companion: allowing more
  // than one visit per node, per named variable, means the old
  // guarantee of "at most one visit to any node, ever, in this search"
  // no longer holds, so total work is bounded by an explicit budget
  // instead.
  const representative = uf.find(currentObjectVar);
  const instanceKey = ctx.namedVars.has(representative) ? representative : '$fresh';
  const visitKey = `${nodeId}::${instanceKey}`;
  if (visited.has(visitKey)) {
    return { kind: 'fail' };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);

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
        // notRelationEquals exclusion (docs/DECISIONS.md D-131): reject
        // this hop if it would bind exactly the triple an invariant's own
        // `not <relation>(<var>) = <var>` constraint rules out. Checked
        // against `uf2` — POST this hop's own `bindSlot` — not the
        // pre-bind `uf`: `bindSlot`'s own `union()` side effect is what
        // can turn an as-yet-unconstrained alias into the excluded value,
        // so checking pre-bind could miss a collision `bindSlot` itself
        // just created. Deliberately scoped to this bare-principal branch
        // only — see `NotRelationEqualsConstraint`'s own doc comment for
        // why the sibling userset-subject branch below, and
        // `tupleToUserset`'s own dispatch, are not covered.
        for (const c of ctx.notRelationEquals) {
          if (
            c.relation === relationName &&
            uf2.same(c.subject, currentObjectVar) &&
            uf2.slotEquals(c.subject, c.relation, c.value)
          ) {
            return { kind: 'fail' };
          }
        }
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

  const intersection = byKind.get('intersectionChild');
  if (intersection) {
    // AND-infeasibility short-circuit (docs/DECISIONS.md, the entry
    // documenting this): intersection requires every child to hold for
    // the SAME object/subject. attempt() returning 'fail' for a child —
    // called independently here, with the same currentObjectVar/uf this
    // whole node was reached with, same pattern as unionChild's own
    // sibling calls above — means that child is structurally impossible
    // no matter what tuples exist (the D-129 fix is exactly what makes
    // this true in general, not just for acyclic subtrees). If ANY child
    // is structurally impossible, the whole intersection is too,
    // regardless of what the other children say — sound, and requires no
    // risky merging of two independently-successful witnesses (a much
    // bigger, separately-scoped problem: see this entry's own "not
    // attempted" note). If no child is a structural 'fail', this falls
    // through to the same 'unknown' every other unresolved
    // intersection/exclusion case gets below — deliberately not
    // attempting to combine two successes into one witness.
    for (const edge of intersection) {
      if (edge.kind !== 'intersectionChild') throw new Error('unreachable');
      const result = attempt(ctx, edge.to, currentObjectVar, currentObjectType, nextVisited, uf);
      if (result.kind === 'fail') return { kind: 'fail' };
    }
  }

  const exclusionBase = byKind.get('exclusionBase')?.[0];
  const exclusionSubtract = byKind.get('exclusionSubtract')?.[0];
  if (exclusionBase && exclusionSubtract) {
    // Exclusion reduction (docs/DECISIONS.md, same entry as above).
    // `A - B`: if A itself is structurally impossible, so is A - B,
    // regardless of B (a subject must satisfy A before B can subtract
    // anything from it) — B's own attempt() is never even called in
    // that case. Otherwise, if B is structurally impossible (attempt()
    // on it returns 'fail'), subtracting an always-empty set changes
    // nothing — A - B is exactly A, so A's own result (success or
    // unknown, whichever it was) is returned as-is. If B is NOT
    // structurally impossible, this falls through to 'unknown': proving
    // "B is always true whenever A is satisfied" would be a universal
    // claim this existential-witness search doesn't decide, and is
    // deliberately not attempted here.
    if (exclusionBase.kind !== 'exclusionBase' || exclusionSubtract.kind !== 'exclusionSubtract') {
      throw new Error('unreachable');
    }
    const baseResult = attempt(
      ctx,
      exclusionBase.to,
      currentObjectVar,
      currentObjectType,
      nextVisited,
      uf,
    );
    if (baseResult.kind === 'fail') return { kind: 'fail' };
    const subtractResult = attempt(
      ctx,
      exclusionSubtract.to,
      currentObjectVar,
      currentObjectType,
      nextVisited,
      uf,
    );
    if (subtractResult.kind === 'fail') return baseResult;
  }

  if (intersection || (exclusionBase && exclusionSubtract)) {
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
  const notRelationEquals: NotRelationEqualsConstraint[] = [];
  for (const c of invariant.constraints) {
    if (c.kind === 'notRelationEquals') {
      notRelationEquals.push(c);
      // Upfront contradiction check (docs/DECISIONS.md D-131): if a
      // `relationEquals` constraint (already bound into `uf` above) has
      // already pinned this exact `(relation, subject)` slot to the very
      // value this `not ...` constraint excludes, the invariant asks for
      // two things that can never both be true — self-contradictory,
      // same treatment `markDistinct`'s own self-contradiction check
      // above gets, and for the same reason: an honest `UNKNOWN`, not a
      // silently-wrong verdict produced by a search that never even
      // notices the conflict.
      if (uf.slotEquals(c.subject, c.relation, c.value)) {
        return {
          verdict: 'UNKNOWN',
          reason: `not ${c.relation}(${c.subject}) = ${c.value} conflicts with a relationEquals(...) constraint that already pins ${c.relation}(${c.subject}) to ${c.value}`,
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
    namedVars,
    budget: { remaining: MAX_ATTEMPT_CALLS },
    notRelationEquals,
  };
  const result = attempt(ctx, goalNodeId, invariant.goal.object, goalObjectType, new Set(), uf);

  if (result.kind === 'fail') return { verdict: 'HOLDS' };
  if (result.kind === 'unknown') return { verdict: 'UNKNOWN', reason: result.reason };
  return { verdict: 'VIOLATED', witness: materialize(result.uf, result.tuples, namedVars) };
}
