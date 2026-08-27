/**
 * The Horn-clause (CHC) encoder — the v2 answer `docs/DECISIONS.md` D-118
 * and D-125 already named ("a dedicated fixpoint-aware solver (Horn-clause/
 * CHC engines such as Z3's PDR/Spacer, built for exactly this 'least
 * fixpoint over recursive relations' shape)... is the real v2 answer") and
 * D-151 deliberately left out of scope ("Revisit if a real schema needs
 * this tier to decide a genuinely recursive goal — that's the sketch's own
 * named Horn-clause/CHC fixpoint-solver v2 phase"). Where `./encode.ts`
 * inlines a permission's rewrite tree into one flat, quantifier-free
 * formula (and therefore *requires* `./recursion.ts`'s `isRecursive` to be
 * false first, or the inlining would never terminate), this module compiles
 * the same rewrite tree into a *graph* of Horn clauses — one registered
 * relation per schema-graph node, one rule per rewrite-rule disjunct/
 * conjunct — and lets Z3's own PDR/Spacer engine compute the least fixpoint
 * over it. A genuine cycle in the schema graph becomes a genuine cycle in
 * the Horn-clause dependency graph, which Spacer is built to handle
 * directly; this module's own compiler still needs a visited-node guard
 * (`compileNode`'s own `compiled` set, below) so *building* the rule set
 * terminates on a cycle too — Spacer's fixpoint search handles the
 * *semantic* recursion, this guard handles this module's own graph walk.
 *
 * **Two real, load-bearing findings from directly exercising the real
 * `Fixedpoint` API (`node_modules/z3-solver/build/high-level/types.d.ts`)
 * before designing anything, both empirically confirmed with small,
 * isolated scripts, not assumed from documentation:**
 *
 * 1. **Every namespace shares one Z3 `Int` sort — never a per-namespace
 *    uninterpreted `Sort.declare`, unlike `./encode.ts`.** Confirmed live:
 *    `Fixedpoint.query()` returns `'unknown'` for even the most trivial
 *    possible query (one ground fact, zero recursion, zero negation) the
 *    moment the domain is an uninterpreted sort — Spacer's model-based
 *    projection (the step that generalizes a concrete counterexample into
 *    a reusable lemma) has no procedure for a domain with no theory
 *    structure at all beyond equality. The same query over `Int` (also an
 *    infinite domain, also with no assumed structure our schemas ever rely
 *    on beyond equality) decides instantly and correctly, including
 *    through genuine multi-level recursion. Using `Int` as a shared,
 *    generic "object identity" domain across every namespace is sound by
 *    the same kind of argument `./encode.ts`'s own header comment already
 *    makes for Skolemization: two countably infinite domains with nothing
 *    but equality defined on them are interchangeable for any sentence
 *    that only ever asserts or queries equality — and this encoder never
 *    asserts an equality *between* two different namespaces' values (every
 *    predicate's own declared argument positions already keep them apart,
 *    schema-graph-edge by schema-graph-edge, exactly as `./encode.ts`'s own
 *    per-namespace sorts do structurally instead). No cardinality bound is
 *    assumed or needed either way.
 * 2. **Negation of a registered relation is not usable here — confirmed
 *    broken, not merely undesirable, across every configuration tried.**
 *    `exclusion` (`A - B`) and `notRelationEquals` both need to negate a
 *    relation inside a Horn rule body. Tried: `engine` set to `'spacer'`,
 *    `'datalog'`, `'bmc'`, and left at the default `'auto-config'`; the
 *    negated relation registered vs. left unregistered (a plain background
 *    predicate); asserted via `addRule` (a fact-rule) vs. `add` (a
 *    background axiom); with recursion and without; with the negated
 *    relation given zero rules at all (empty by construction) and with a
 *    single ground fact; negation inside a rule body and negation directly
 *    in the top-level `query()` argument itself. Every single variant
 *    returned `'unknown'` (`getReasonUnknown()` reporting `'ok'` — not an
 *    error, just an engine that can't decide), including the most minimal
 *    possible case: one registered relation, zero rules for it anywhere,
 *    queried through nothing but a sibling rule's own negated reference to
 *    it. This is not a Datalog-with-negation *stratification* subtlety
 *    (that would only bite a schema shape where the negated branch is
 *    itself recursive) — it reproduces on the flattest possible case, so
 *    scoping around "stratified negation only" would not actually route
 *    around it. Given this, `compileNode` below declines outright
 *    (`ChcTierInapplicable`) the moment it meets an `exclusionBase`/
 *    `exclusionSubtract` pair, and `tryChcTier` (`./chc.ts`) declines
 *    outright whenever the invariant has any `notRelationEquals`
 *    constraint — the same "this tier doesn't apply, fall through to
 *    bounded search" outcome every other inapplicable case already gets,
 *    never a wrong answer. See `docs/DECISIONS.md` for this same account,
 *    cross-referenced.
 *
 * **Every registered relation is unary (`obj: Int -> Bool`), never
 * binary.** `./encode.ts`'s own `compileNode` already establishes that the
 * goal's subject stays exactly one fixed value (the invariant's own
 * declared subject constant) for the *entire* compilation — no rewrite
 * rule this DSL has ever introduces a new subject-side hop, only new
 * object-side ones (`tupleToUserset`, and a userset-typed `direct` edge's
 * own recursion target). This encoder makes that already-true fact
 * explicit in the encoding itself: the subject is baked in as one closed-
 * over ground `Int` constant per compiled invariant, and every registered
 * relation is `Rel_<nodeId>(obj): Bool` — "does the invariant's own fixed
 * subject reach this node, starting from `obj`." Base (leaf) predicates —
 * "does this exact tuple exist" — stay binary (`Pred(obj, subj): Bool`,
 * the same shape `./encode.ts` declares), matching that file's own
 * predicate-naming scheme exactly, for two reasons: witness bookkeeping
 * needs both arguments explicitly to build a real `WitnessTuple`, and a
 * base predicate genuinely could in principle be invoked with more than
 * one subject value in a future extension of this encoder — keeping it
 * binary costs nothing today and forecloses nothing later.
 *
 * **Base predicates are the adversary's free choice, encoded as
 * `∀o,s. Pred(o,s)` — an unconditional rule, not a background axiom.**
 * This is the CHC-setting counterpart of `./encode.ts`'s own choice to
 * leave every base predicate a genuinely free, uninterpreted Z3 function:
 * the invariant-checking question is "does *some* tuple set exist making
 * the goal true," i.e. an existential over every possible interpretation
 * of every base relation. For every operator in this encoder's actual
 * scope (union, intersection, `computedUserset`, `tupleToUserset`, and a
 * `direct` edge's own bare/userset options) widening a base predicate can
 * only ever make *more* of the goal reachable, never less — so "does an
 * interpretation exist" reduces exactly to "assume the most permissive one
 * (universally true) and ask whether the goal is then derivable," the same
 * monotone argument `docs/DECISIONS.md`'s small-model property already
 * makes for the plain reachability search, applied here to justify a
 * concrete Horn-clause encoding choice instead. (Confirmed empirically too,
 * independent of the argument above: a registered relation with no rule
 * deriving it anywhere defaults to *empty* in Spacer's own least fixpoint —
 * this project never wants that default for a base predicate, hence the
 * explicit unconditional rule.)
 */
import type { Bool, Context, Fixedpoint, FuncDecl, Sort } from 'z3-solver';
import type { GraphEdge, NodeId, SchemaGraph } from '../ir/types.js';
import type { Invariant } from '../invariants/types.js';
import type { WitnessTuple } from '../reachability/types.js';

type Ctx = Context<'main'>;

/**
 * How many `compileNode` calls one `encodeChc()` may make before giving up
 * — this tier's own counterpart to `./encode.ts`'s `MAX_SMT_COMPILE_STEPS`.
 * Unlike that file, this compiler is cycle-safe by construction (the
 * `compiled` visited-set below), so this ceiling exists only for the same
 * "diamond-shaped sharing could blow up rule count" reason, not to survive
 * an infinite loop — 50,000, the same order of magnitude, chosen the same
 * way (comfortably beyond build spec rule 0.5's "tens of nodes" schemas).
 */
export const MAX_CHC_COMPILE_STEPS = 50_000;

class ChcTierInapplicable extends Error {}

interface ChcRelation {
  readonly nodeId: NodeId;
  readonly namespace: string;
  readonly decl: FuncDecl<'main'>;
}

interface ChcPredicate {
  readonly decl: FuncDecl<'main'>;
  readonly objectType: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectRelation?: string;
}

export interface ChcEncoding {
  readonly ctx: Ctx;
  readonly fp: Fixedpoint<'main'>;
  readonly graph: SchemaGraph;
  /** Every schema-graph node this compilation actually registered a Horn relation for — `./chc-witness.ts` re-walks exactly this same set, by nodeId, to reconstruct a witness through targeted re-queries against this same, already-built program. */
  readonly relations: ReadonlyMap<NodeId, ChcRelation>;
  /** Every base predicate this compilation registered, keyed exactly like `./encode.ts`'s own `getPredicate` (`${objectNamespace}#${relation}#${subjectNamespace}#${subjectRelation ?? ''}`) — `./chc-witness.ts` re-derives the same key from the same edge data to look up the identical declaration, never a second predicate for the same tuple shape. */
  readonly predicates: ReadonlyMap<string, ChcPredicate>;
  readonly goalRelation: ChcRelation;
  /** The invariant's own declared subject, baked in as one ground `Int` value — see this file's own header comment for why every registered relation is unary. */
  readonly subjectValue: number;
  readonly subjectType: string;
  readonly goalObjectValue: number;
  /** Every invariant-declared variable's own assigned `Int` value, and its type — `distinct(...)` is satisfied by construction (every named variable gets its own value, and nothing in this invariant language ever requires two *different* named variables to coincide — see this file's own header comment), and `./chc-witness.ts` seeds its own label map from this so a fresh value the walk happens to reuse still gets the invariant's own real name. */
  readonly namedValues: ReadonlyMap<string, { readonly value: number; readonly type: string }>;
  /** `relationEquals` constraints, already turned into tuples and asserted as ground facts — always part of the final witness, mirroring `./encode.ts`'s own `given` discipline (itself mirroring `../bounded/candidates.ts`'s `generateGivenTuples`, D-118). */
  readonly given: readonly WitnessTuple[];
  /** The next integer `./chc-witness.ts` may mint for a fresh, never-before-used object — every named value below it, so a freshly minted witness value can never collide with an invariant-declared one. */
  readonly nextFreshValue: number;
}

export type ChcEncodeResult =
  | { readonly ok: true; readonly encoding: ChcEncoding }
  | { readonly ok: false; readonly reason: string };

function namedNodeId(namespace: string, name: string): NodeId {
  return `${namespace}#${name}`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function predicateKey(
  objectNamespace: string,
  relation: string,
  subjectNamespace: string,
  subjectRelation?: string,
): string {
  return `${objectNamespace}#${relation}#${subjectNamespace}#${subjectRelation ?? ''}`;
}

/**
 * Compiles `graph`'s own goal (`invariant.goal`) into a Horn-clause
 * `Fixedpoint` program on `ctx`, or `{ ok: false }` with a human-readable
 * reason for any of this tier's own disclosed, deliberate scope
 * boundaries — see this file's own header comment for exactly what those
 * are and why. Never throws for an in-scope schema.
 */
export function encodeChc(ctx: Ctx, graph: SchemaGraph, invariant: Invariant): ChcEncodeResult {
  const intSort: Sort<'main'> = ctx.Int.sort();
  const boolSort = ctx.Bool.sort();
  const fp = new ctx.Fixedpoint();
  fp.set('engine', 'spacer');

  // Every invariant-declared variable gets its own, distinct Int value —
  // always sound for the "does a witness exist" question this tier
  // answers (see this file's own header comment): nothing in this
  // invariant language ever requires two *different* named variables to
  // coincide, only (optionally, via `distinct(...)`) that they must not.
  const namedValues = new Map<string, { value: number; type: string }>();
  invariant.variables.forEach((v, i) => {
    namedValues.set(v.name, { value: i, type: v.type });
  });
  const nextFreshValue = invariant.variables.length;

  const relations = new Map<NodeId, ChcRelation>();
  function getRelation(nodeId: NodeId): ChcRelation {
    const existing = relations.get(nodeId);
    if (existing) return existing;
    const node = graph.nodes.get(nodeId);
    if (node === undefined) throw new Error(`chc encode: unknown node ${nodeId}`);
    const decl = ctx.Function.declare(`Rel_${sanitize(nodeId)}`, intSort, boolSort);
    fp.registerRelation(decl);
    const rel: ChcRelation = { nodeId, namespace: node.namespace, decl };
    relations.set(nodeId, rel);
    return rel;
  }

  const predicates = new Map<string, ChcPredicate>();
  function getPredicate(
    objectType: string,
    relation: string,
    subjectType: string,
    subjectRelation?: string,
  ): ChcPredicate {
    const key = predicateKey(objectType, relation, subjectType, subjectRelation);
    const existing = predicates.get(key);
    if (existing) return existing;
    const decl = ctx.Function.declare(`Pred_${sanitize(key)}`, intSort, intSort, boolSort);
    fp.registerRelation(decl);
    // The adversary's free choice — see this file's own header comment
    // for the monotone argument this relies on.
    const o = ctx.Int.const('o');
    const s = ctx.Int.const('s');
    fp.addRule(ctx.ForAll([o, s], decl.call(o, s)), `${key}-universal`);
    const pred: ChcPredicate = {
      decl,
      objectType,
      relation,
      subjectType,
      ...(subjectRelation !== undefined ? { subjectRelation } : {}),
    };
    predicates.set(key, pred);
    return pred;
  }

  let steps = 0;
  const compiled = new Set<NodeId>();
  function compileNode(nodeId: NodeId): void {
    if (compiled.has(nodeId)) return; // cycle-safe: a node is compiled at most once, ever.
    compiled.add(nodeId);

    steps += 1;
    if (steps > MAX_CHC_COMPILE_STEPS) {
      throw new ChcTierInapplicable(`compile step ceiling (${MAX_CHC_COMPILE_STEPS}) exceeded`);
    }

    const rel = getRelation(nodeId);
    const objType = rel.namespace;
    const edges = graph.edgesFrom.get(nodeId) ?? [];
    if (edges.length === 0) return; // no rule at all -> empty in the least fixpoint, matching `./encode.ts`'s own `{ term: false }` case.

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
      const node = graph.nodes.get(nodeId);
      if (node?.kind !== 'named') {
        throw new Error(`chc encode: direct edge from non-named node ${nodeId}`);
      }
      const relationName = node.name;
      for (const st of edge.subjectTypes) {
        if (st.relation === undefined) {
          if (st.namespace !== subjectType) continue; // bare-principal option whose type can never match the fixed goal subject — a dead end, exactly like `./encode.ts`'s own `{ term: false }`.
          const pred = getPredicate(objType, relationName, st.namespace);
          const o = ctx.Int.const('o');
          const body = pred.decl.call(o, ctx.Int.val(subjectValue)) as Bool<'main'>;
          fp.addRule(ctx.ForAll([o], ctx.Implies(body, rel.decl.call(o) as Bool<'main'>)));
          continue;
        }
        if (st.target === undefined) continue; // undeclared target namespace — nothing to recurse into.
        const targetRel = getRelation(st.target);
        compileNode(st.target);
        const pred = getPredicate(objType, relationName, st.namespace, st.relation);
        const o = ctx.Int.const('o');
        const g = ctx.Int.const('g');
        const body = ctx.And(
          pred.decl.call(o, g) as Bool<'main'>,
          targetRel.decl.call(g) as Bool<'main'>,
        );
        fp.addRule(ctx.ForAll([o, g], ctx.Implies(body, rel.decl.call(o) as Bool<'main'>)));
      }
      return;
    }

    const computed = byKind.get('computedUserset');
    if (computed) {
      const edge = computed[0]!;
      if (edge.kind !== 'computedUserset') throw new Error('unreachable');
      compileNode(edge.to);
      const targetRel = getRelation(edge.to);
      const o = ctx.Int.const('o');
      fp.addRule(
        ctx.ForAll(
          [o],
          ctx.Implies(targetRel.decl.call(o) as Bool<'main'>, rel.decl.call(o) as Bool<'main'>),
        ),
      );
      return;
    }

    const ttu = byKind.get('tupleToUserset');
    if (ttu) {
      const edge = ttu[0]!;
      if (edge.kind !== 'tupleToUserset') throw new Error('unreachable');
      for (const t of edge.targets) {
        compileNode(t.target);
        const targetRel = getRelation(t.target);
        const pred = getPredicate(objType, edge.viaRelation, t.namespace);
        const o = ctx.Int.const('o');
        const g = ctx.Int.const('g');
        const body = ctx.And(
          pred.decl.call(o, g) as Bool<'main'>,
          targetRel.decl.call(g) as Bool<'main'>,
        );
        fp.addRule(ctx.ForAll([o, g], ctx.Implies(body, rel.decl.call(o) as Bool<'main'>)));
      }
      return;
    }

    const union = byKind.get('unionChild');
    if (union) {
      for (const e of union) {
        if (e.kind !== 'unionChild') throw new Error('unreachable');
        compileNode(e.to);
        const childRel = getRelation(e.to);
        const o = ctx.Int.const('o');
        fp.addRule(
          ctx.ForAll(
            [o],
            ctx.Implies(childRel.decl.call(o) as Bool<'main'>, rel.decl.call(o) as Bool<'main'>),
          ),
        );
      }
      return;
    }

    const intersection = byKind.get('intersectionChild');
    if (intersection) {
      const o = ctx.Int.const('o');
      const conjuncts: Bool<'main'>[] = [];
      for (const e of intersection) {
        if (e.kind !== 'intersectionChild') throw new Error('unreachable');
        compileNode(e.to);
        const childRel = getRelation(e.to);
        conjuncts.push(childRel.decl.call(o) as Bool<'main'>);
      }
      fp.addRule(
        ctx.ForAll([o], ctx.Implies(ctx.And(...conjuncts), rel.decl.call(o) as Bool<'main'>)),
      );
      return;
    }

    const exclusionBase = byKind.get('exclusionBase')?.[0];
    const exclusionSubtract = byKind.get('exclusionSubtract')?.[0];
    if (exclusionBase && exclusionSubtract) {
      // See this file's own header comment, finding 2 — negation of a
      // registered relation is confirmed unusable in this setting.
      throw new ChcTierInapplicable(
        `${nodeId} uses exclusion, which needs Horn-clause negation — confirmed unsupported by this z3-solver build's Fixedpoint engine (see this file's own header comment); this tier does not attempt it`,
      );
    }

    // A well-formed IR node always has exactly one of the shapes above —
    // defensive only, matching `./encode.ts`'s own equivalent fallthrough.
  }

  let subjectValue = 0;
  let subjectType = '';

  try {
    const goalObjectType = invariant.variables.find((v) => v.name === invariant.goal.object)?.type;
    const goalSubjectType = invariant.variables.find(
      (v) => v.name === invariant.goal.subject,
    )?.type;
    if (goalObjectType === undefined || goalSubjectType === undefined) {
      return { ok: false, reason: 'goal references a variable with no type declaration' };
    }
    subjectType = goalSubjectType;
    subjectValue = namedValues.get(invariant.goal.subject)!.value;
    const goalObjectValue = namedValues.get(invariant.goal.object)!.value;

    const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
    if (!graph.nodes.has(goalNodeId)) {
      return { ok: false, reason: `${goalNodeId} is not declared in this schema` };
    }

    compileNode(goalNodeId);
    const goalRelation = getRelation(goalNodeId);

    const given: WitnessTuple[] = [];
    for (const c of invariant.constraints) {
      if (c.kind !== 'relationEquals') continue;
      const subjType = namedValues.get(c.subject)!.type;
      const valType = namedValues.get(c.value)!.type;
      const pred = getPredicate(subjType, c.relation, valType);
      const subjVal = namedValues.get(c.subject)!.value;
      const objVal = namedValues.get(c.value)!.value;
      fp.addRule(pred.decl.call(ctx.Int.val(subjVal), ctx.Int.val(objVal)) as Bool<'main'>);
      given.push({
        objectType: subjType,
        object: c.subject,
        relation: c.relation,
        subjectType: valType,
        subject: c.value,
      });
    }

    const encoding: ChcEncoding = {
      ctx,
      fp,
      graph,
      relations,
      predicates,
      goalRelation,
      subjectValue,
      subjectType,
      goalObjectValue,
      namedValues,
      given,
      nextFreshValue,
    };
    return { ok: true, encoding };
  } catch (e) {
    if (e instanceof ChcTierInapplicable) return { ok: false, reason: e.message };
    throw e;
  }
}
