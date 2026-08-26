/**
 * The SMT encoding itself — `docs/DECISIONS.md`'s own sketch (the entry
 * documenting §7's bounded search, restated in the entry closing §11),
 * finally implemented for the fragment that sketch says direct
 * satisfiability actually decides: a goal whose own reachable subgraph
 * (`../smt/recursion.ts`'s job to rule out) contains no cycle.
 *
 * The sketch, verbatim in shape:
 *   - one uninterpreted sort per namespace
 *   - one uninterpreted boolean predicate per relation
 *   - union → OR, intersection → AND, exclusion → AND-NOT,
 *     `computedUserset` → the named relation/permission's own formula,
 *     `tupleToUserset` → an existentially-quantified object variable
 *   - ask satisfiability of the goal formula conjoined with the
 *     invariant's own constraints; SAT → candidate `VIOLATED`,
 *     UNSAT → real, unbounded `HOLDS`.
 *
 * **The one deliberate departure from the sketch's own literal wording,
 * and why it's still sound.** The sketch says `tupleToUserset` compiles
 * to "an existentially-quantified object variable" — meaning a native
 * first-order `∃`. This encoder instead hand-Skolemizes every such
 * occurrence: introduces one *fresh, globally unique constant* (never a
 * bound quantifier variable) and asserts the hop directly against it.
 * This is not a shortcut taken for convenience; two things follow from
 * it that a native-quantifier encoding wouldn't get for free:
 *
 * 1. **Witness extraction becomes trivial and exact.** A native `∃x. φ(x)`
 *    satisfied by a model doesn't hand back a *value* for `x` — the
 *    model just certifies the quantified formula is true; recovering a
 *    concrete `x` in general needs either inspecting Z3's own internal
 *    Skolem functions (fragile, version-dependent, and genuinely
 *    complex the moment quantifiers alternate under exclusion's own
 *    negation) or re-solving with a hand-rolled Skolemization anyway.
 *    Doing the Skolemization ourselves means every fresh constant is a
 *    real, named symbol whose model value `model.eval` returns directly
 *    — which is exactly what build spec discipline (D-119 forward)
 *    already demands: a `VIOLATED` verdict is reconstructed as concrete
 *    tuples and independently confirmed through the real engine, never
 *    reported on the solver's word alone (see `../smt/index.ts`).
 * 2. **The soundness argument for the `HOLDS` direction becomes a plain,
 *    checkable model-extension proof, not "trust Z3's quantifier
 *    handling to be both sound *and* complete enough to terminate."**
 *    Standard first-order model theory: for *any* model `M` and *any*
 *    fresh constant symbol `k` that appears nowhere else, `M` can always
 *    be extended to a model `M'` assigning `k` any domain element,
 *    without disturbing what `M` already satisfies (`k` has no other
 *    constraints to conflict with). Two consequences, one per polarity:
 *      - Where the real semantics has `∃u. φ(u)` *true* in some model
 *        `M` (an existential occurring positively), extend `M` to `M'`
 *        by setting `k :=` whatever real witness made it true in `M` —
 *        `M'` satisfies our Skolemized `φ(k)`.
 *      - Where the real semantics has `¬∃u. φ(u)` true in `M` (the same
 *        existential occurring negatively, inside an exclusion's
 *        subtract branch) — meaning `φ(u)` is false for *every* `u` in
 *        `M`'s domain — extend `M` to `M'` by setting `k :=` *anything*;
 *        `φ(k)` is false regardless of which domain element `k` names,
 *        so `M'` satisfies our Skolemized `¬φ(k)` too.
 *    Either way, *any* model of the true, quantified formula extends to
 *    a model of this encoder's Skolemized approximation — regardless of
 *    how deep the existential is nested, or how many exclusions'
 *    negations sit above it. That proves, unconditionally:
 *    `SAT(true formula) ⟹ SAT(this encoder's formula)`, i.e.
 *    `UNSAT(this encoder's formula) ⟹ UNSAT(true formula)`. An `UNSAT`
 *    result is therefore always a genuine, real proof of `HOLDS` — the
 *    one direction this whole tier exists to strengthen over bounded
 *    search's own "up to k" hedge — with no dependence on Z3's
 *    quantifier-elimination heuristics ever being complete.
 *    The price is paid entirely on the other side: this encoder's
 *    formula can be satisfiable in cases the true, fully-quantified
 *    semantics would not be (an over-*approximation* for `SAT`) — which
 *    is exactly why `SAT` is never reported as `VIOLATED` directly, only
 *    as a *candidate* whose reconstructed witness must independently
 *    replay against the real, unmodified engine (`../smt/index.ts`)
 *    before anything is ever reported. A spurious `SAT` this
 *    approximation invents but the true semantics wouldn't simply fails
 *    that replay and this tier falls through, exactly per spec.
 *
 * Every relation is deliberately treated as multi-valued (nothing in
 * this schema DSL declares a relation single-valued/functional), and
 * this encoder never manually forces reuse of an existing binding the
 * way `../reachability/search.ts`'s own `UnionFind.slotValue` does for
 * its own, different (witness-*minimizing*, not soundness-critical)
 * reasons — Z3's own congruence-closure reasoning is free to conclude
 * two constants are equal when doing so is the only way to satisfy the
 * formula (exactly how `tenant_isolation`'s own already-bound
 * `tenant(o) = orgB` gets reused by a fresh `tupleToUserset` hop through
 * `tenant`, without this encoder ever hard-coding that reuse itself).
 */
import type { Bool, Context, Expr, FuncDecl, Sort } from 'z3-solver';
import type { GraphEdge, NodeId, SchemaGraph } from '../ir/types.js';
import type { Constraint, Invariant } from '../invariants/types.js';
import type { WitnessTuple } from '../reachability/types.js';

type Ctx = Context<'main'>;
type Term = Expr<'main'>;

/**
 * How many `compileNode` calls one `encode()` may make before giving up
 * — the SMT-tier counterpart to `../reachability/search.ts`'s own
 * `MAX_ATTEMPT_CALLS` and `../bounded/search.ts`'s own
 * `MAX_BOUNDED_CANDIDATES`: a disclosed ceiling, not a silent hang.
 * `../smt/recursion.ts` already guarantees the reachable subgraph is a
 * DAG (no cycle at all) before this ever runs, so this traversal *will*
 * terminate on its own — this ceiling exists only for the case a DAG's
 * own diamond-shaped sharing (the same node reachable via more than one
 * path) blows up combinatorially under this encoder's plain tree
 * inlining (no memoization — see `encode()`'s own doc comment on why
 * adding it is deliberately out of scope here). 50,000 is the same order
 * of magnitude as this project's own existing ceilings, chosen the same
 * way: comfortably beyond anything build spec rule 0.5's "tens of
 * nodes" schemas could ever need.
 */
export const MAX_SMT_COMPILE_STEPS = 50_000;

class SmtTierInapplicable extends Error {}

/** One tuple atom's own static schema shape, carried alongside its z3 term so a satisfying model can be turned back into a real `WitnessTuple` without re-deriving any of this from the model itself. */
interface AtomInfo {
  readonly objectType: string;
  readonly object: Term;
  readonly relation: string;
  readonly subjectType: string;
  readonly subject: Term;
  readonly subjectRelation?: string;
}

/** The compiled formula, as a tree — mirrors the boolean shape `compileNode` walked, kept alongside the flat z3 `Bool` term so `../smt/witness.ts` can walk the *same* tree, guided by the model's own truth values, to extract a minimal witness (see that file). */
export type FNode =
  | { readonly kind: 'atom'; readonly atom: AtomInfo }
  | { readonly kind: 'and'; readonly children: readonly FNode[] }
  | {
      readonly kind: 'or';
      readonly options: ReadonlyArray<{ readonly term: Bool<'main'>; readonly node: FNode }>;
    }
  | { readonly kind: 'not' }
  | { readonly kind: 'false' };

export interface CompiledFormula {
  readonly term: Bool<'main'>;
  readonly node: FNode;
}

export interface Encoding {
  readonly ctx: Ctx;
  /** Every constraint atom (`distinct`/`relationEquals`/`notRelationEquals`) already asserted, plus the compiled goal formula — the caller (`../smt/index.ts`) still needs to `solver.add(goal.term)` itself, since the un-negated, un-conjoined goal formula is also useful on its own for logging/diagnostics. */
  readonly goal: CompiledFormula;
  /** `s`, `o`, and every other invariant-declared variable, mapped to its own z3 constant and declared type — `../smt/witness.ts` seeds its label map from this, so a fresh Skolem constant the model happens to equate with one of these gets that variable's own real name in the reconstructed witness, not a synthetic `obj1`. */
  readonly declared: ReadonlyMap<string, { readonly term: Term; readonly type: string }>;
  /** `relationEquals` constraints, already turned into tuples — always part of the final witness, mirroring `../bounded/candidates.ts`'s own `generateGivenTuples` discipline (D-118): these are given facts, not something a model needs to be asked to "find" via the atom-extraction walk. */
  readonly given: readonly WitnessTuple[];
}

export type EncodeResult =
  { readonly ok: true; readonly encoding: Encoding } | { readonly ok: false };

function namedNodeId(namespace: string, name: string): NodeId {
  return `${namespace}#${name}`;
}

/**
 * Builds the full SMT problem for `invariant`'s own goal against `graph`
 * — sorts, predicates, every constraint assertion, and the compiled goal
 * formula — or `{ ok: false }` if compilation hit `MAX_SMT_COMPILE_STEPS`
 * (the only way this function itself can fail; every other case just
 * produces a formula, possibly one that's trivially `false`). No
 * `CompiledSchema` parameter: unlike every other tier, this one never
 * needs to re-consult the real compiled schema — everything it needs
 * (a relation's own real subject types, a `tupleToUserset` hop's fully
 * resolved targets) is already carried directly on `graph`'s own edges
 * (`../ir/types.ts`'s own `DirectEdge`/`TupleToUsersetEdge`).
 */
export function encode(ctx: Ctx, graph: SchemaGraph, invariant: Invariant): EncodeResult {
  const sorts = new Map<string, Sort<'main'>>();
  function getSort(namespace: string): Sort<'main'> {
    const existing = sorts.get(namespace);
    if (existing) return existing;
    const sort = ctx.Sort.declare(`Sort_${namespace}`);
    sorts.set(namespace, sort);
    return sort;
  }

  const predicates = new Map<string, FuncDecl<'main'>>();
  function getPredicate(
    objectNamespace: string,
    relation: string,
    subjectNamespace: string,
    subjectRelation?: string,
  ): FuncDecl<'main'> {
    const key = `${objectNamespace}#${relation}#${subjectNamespace}#${subjectRelation ?? ''}`;
    const existing = predicates.get(key);
    if (existing) return existing;
    const decl = ctx.Function.declare(
      `Pred_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      getSort(objectNamespace),
      getSort(subjectNamespace),
      ctx.Bool.sort(),
    );
    predicates.set(key, decl);
    return decl;
  }

  const declared = new Map<string, { term: Term; type: string }>();
  for (const v of invariant.variables) {
    declared.set(v.name, { term: ctx.Const(v.name, getSort(v.type)), type: v.type });
  }

  let freshCounter = 0;
  function freshConst(namespace: string): Term {
    freshCounter += 1;
    return ctx.Const(`skolem_${freshCounter}`, getSort(namespace));
  }

  let steps = 0;
  function compileNode(
    nodeId: NodeId,
    objTerm: Term,
    objType: string,
    subjTerm: Term,
    subjType: string,
  ): CompiledFormula {
    steps += 1;
    if (steps > MAX_SMT_COMPILE_STEPS)
      throw new SmtTierInapplicable('compile step ceiling exceeded');

    const edges = graph.edgesFrom.get(nodeId) ?? [];
    if (edges.length === 0) return { term: ctx.Bool.val(false), node: { kind: 'false' } };

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
      if (node?.kind !== 'named')
        throw new Error(`smt encode: direct edge from non-named node ${nodeId}`);
      const relationName = node.name;
      const options = edge.subjectTypes.map((st) => {
        if (st.relation === undefined) {
          if (st.namespace !== subjType) {
            return { term: ctx.Bool.val(false), node: { kind: 'false' } as const };
          }
          const pred = getPredicate(objType, relationName, st.namespace);
          const term = pred.call(objTerm, subjTerm) as Bool<'main'>;
          const fnode: FNode = {
            kind: 'atom',
            atom: {
              objectType: objType,
              object: objTerm,
              relation: relationName,
              subjectType: st.namespace,
              subject: subjTerm,
            },
          };
          return { term, node: fnode };
        }
        if (st.target === undefined)
          return { term: ctx.Bool.val(false), node: { kind: 'false' } as const };
        const fv = freshConst(st.namespace);
        const pred = getPredicate(objType, relationName, st.namespace, st.relation);
        const hop = pred.call(objTerm, fv) as Bool<'main'>;
        const sub = compileNode(st.target, fv, st.namespace, subjTerm, subjType);
        const term = ctx.And(hop, sub.term);
        const hopNode: FNode = {
          kind: 'atom',
          atom: {
            objectType: objType,
            object: objTerm,
            relation: relationName,
            subjectType: st.namespace,
            subject: fv,
            subjectRelation: st.relation,
          },
        };
        const fnode: FNode = { kind: 'and', children: [hopNode, sub.node] };
        return { term, node: fnode };
      });
      return {
        term: ctx.Or(...options.map((o) => o.term)),
        node: { kind: 'or', options },
      };
    }

    const computed = byKind.get('computedUserset');
    if (computed) {
      const edge = computed[0]!;
      if (edge.kind !== 'computedUserset') throw new Error('unreachable');
      const targetType = graph.nodes.get(edge.to)?.namespace ?? objType;
      return compileNode(edge.to, objTerm, targetType, subjTerm, subjType);
    }

    const ttu = byKind.get('tupleToUserset');
    if (ttu) {
      const edge = ttu[0]!;
      if (edge.kind !== 'tupleToUserset') throw new Error('unreachable');
      const options = edge.targets.map((t) => {
        const fv = freshConst(t.namespace);
        const pred = getPredicate(objType, edge.viaRelation, t.namespace);
        const hop = pred.call(objTerm, fv) as Bool<'main'>;
        const sub = compileNode(t.target, fv, t.namespace, subjTerm, subjType);
        const term = ctx.And(hop, sub.term);
        const hopNode: FNode = {
          kind: 'atom',
          atom: {
            objectType: objType,
            object: objTerm,
            relation: edge.viaRelation,
            subjectType: t.namespace,
            subject: fv,
          },
        };
        const fnode: FNode = { kind: 'and', children: [hopNode, sub.node] };
        return { term, node: fnode };
      });
      if (options.length === 0) return { term: ctx.Bool.val(false), node: { kind: 'false' } };
      return { term: ctx.Or(...options.map((o) => o.term)), node: { kind: 'or', options } };
    }

    const union = byKind.get('unionChild');
    if (union) {
      const options = union.map((e) => {
        if (e.kind !== 'unionChild') throw new Error('unreachable');
        const targetType = graph.nodes.get(e.to)?.namespace ?? objType;
        return compileNode(e.to, objTerm, targetType, subjTerm, subjType);
      });
      return { term: ctx.Or(...options.map((o) => o.term)), node: { kind: 'or', options } };
    }

    const intersection = byKind.get('intersectionChild');
    if (intersection) {
      const subs = intersection.map((e) => {
        if (e.kind !== 'intersectionChild') throw new Error('unreachable');
        return compileNode(e.to, objTerm, objType, subjTerm, subjType);
      });
      return {
        term: ctx.And(...subs.map((s) => s.term)),
        node: { kind: 'and', children: subs.map((s) => s.node) },
      };
    }

    const exclusionBase = byKind.get('exclusionBase')?.[0];
    const exclusionSubtract = byKind.get('exclusionSubtract')?.[0];
    if (exclusionBase && exclusionSubtract) {
      if (
        exclusionBase.kind !== 'exclusionBase' ||
        exclusionSubtract.kind !== 'exclusionSubtract'
      ) {
        throw new Error('unreachable');
      }
      const base = compileNode(exclusionBase.to, objTerm, objType, subjTerm, subjType);
      const subtract = compileNode(exclusionSubtract.to, objTerm, objType, subjTerm, subjType);
      const term = ctx.And(base.term, ctx.Not(subtract.term));
      // The subtract branch's own node is deliberately never included in
      // extraction (`kind: 'not'`, no children) — see this file's own
      // header comment: nothing is ever written *for* a branch that must
      // stay false, only omitted, and self-validation is what confirms
      // that omission was actually sufficient against the real engine.
      return { term, node: { kind: 'and', children: [base.node, { kind: 'not' }] } };
    }

    // A well-formed IR node always has exactly one of the shapes above —
    // defensive only, matching `../reachability/search.ts`'s own
    // `return { kind: 'fail' }` for the equivalent unreached case.
    return { term: ctx.Bool.val(false), node: { kind: 'false' } };
  }

  try {
    const goalObjectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
    const goalSubjectType = invariant.variables.find(
      (v) => v.name === invariant.goal.subject,
    )!.type;
    const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
    const objTerm = declared.get(invariant.goal.object)!.term;
    const subjTerm = declared.get(invariant.goal.subject)!.term;

    const goal = compileNode(goalNodeId, objTerm, goalObjectType, subjTerm, goalSubjectType);

    const given: WitnessTuple[] = [];
    function typeOf(name: string): string {
      return declared.get(name)!.type;
    }
    function assertConstraint(c: Constraint): Bool<'main'> | undefined {
      switch (c.kind) {
        case 'distinct': {
          const terms = c.variables.map((v) => declared.get(v)!.term);
          return ctx.Distinct(...terms);
        }
        case 'relationEquals': {
          const objType = typeOf(c.subject);
          const subjType = typeOf(c.value);
          const pred = getPredicate(objType, c.relation, subjType);
          given.push({
            objectType: objType,
            object: c.subject,
            relation: c.relation,
            subjectType: subjType,
            subject: c.value,
          });
          return pred.call(
            declared.get(c.subject)!.term,
            declared.get(c.value)!.term,
          ) as Bool<'main'>;
        }
        case 'notRelationEquals': {
          const objType = typeOf(c.subject);
          const subjType = typeOf(c.value);
          const pred = getPredicate(objType, c.relation, subjType);
          return ctx.Not(
            pred.call(declared.get(c.subject)!.term, declared.get(c.value)!.term) as Bool<'main'>,
          );
        }
        default: {
          const _never: never = c;
          throw new Error(`smt encode: unhandled constraint kind ${JSON.stringify(_never)}`);
        }
      }
    }
    const constraintTerms = invariant.constraints
      .map(assertConstraint)
      .filter((t): t is Bool<'main'> => t !== undefined);

    // Constraint terms are asserted alongside the goal for the SAT query,
    // but never represented in `finalGoal.node` — none of the three
    // constraint kinds need extraction help: `distinct` and
    // `notRelationEquals` produce no tuples at all (a fact about labels,
    // a filter, respectively), and `relationEquals` is already captured
    // in `given` above, unconditionally, the same "always included,
    // never left to enumeration" discipline `../bounded/candidates.ts`'s
    // own `generateGivenTuples` uses (D-118).
    const finalGoal: CompiledFormula = {
      term: constraintTerms.length > 0 ? ctx.And(goal.term, ...constraintTerms) : goal.term,
      node: goal.node,
    };

    return {
      ok: true,
      encoding: { ctx, goal: finalGoal, declared, given },
    };
  } catch (e) {
    if (e instanceof SmtTierInapplicable) return { ok: false };
    throw e;
  }
}
