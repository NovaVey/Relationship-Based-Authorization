/**
 * A pure, zero-I/O classifier: "is this relation/permission monotone under
 * insertion-only tuple writes?" — i.e. can writing a *new* tuple ever cause
 * a previously-`allowed` check against this relation/permission to flip to
 * `denied`? This is the building block PROPERTY 4
 * (monotone-permission-tuple-addition) needs: that metamorphic property only
 * holds for a permission this module classifies `true` — a non-monotone
 * permission (one containing an `ExclusionRule` anywhere in its rewrite
 * tree) is explicitly out of scope for that property, by construction, not
 * by accident.
 *
 * This file imports only from `src/schema/dsl/types.ts` (plain, JSON-safe
 * data shapes — see that file's own doc comment) — no Postgres, no
 * resolver, no other project code. It never shares a function with either
 * resolver: it isn't a resolver at all (it never walks a tuple graph, never
 * answers a `(subject, relation, object)` check), so the project's "the two
 * resolvers share no code" rule doesn't directly apply to it, but it is
 * written the same independent, self-contained way as `src/soundness
 * /generators.ts`'s own `checkRewriteRuleCoverage`/`hasUsersetCycle` — a
 * small, standalone, structurally-independent walk over `CompiledSchema`,
 * with its own freshly-written `assertNeverRewriteRule` exhaustiveness
 * guard rather than an imported one, matching that file's own precedent.
 *
 * ## The algorithm
 *
 * A `CompiledRelation` is monotone unconditionally — a stored fact's own
 * membership test is monotone by definition of set growth under
 * insertion-only writes (adding a tuple can only ever add to a relation's
 * membership, never remove from it). Notably, this is checked *before*
 * `relation.subjectTypes` is ever inspected — a relation's subject types
 * (which may include a self-referential userset type, e.g. this project's
 * own guaranteed group namespace's `relation member: user | <self>#member`,
 * see `src/soundness/generators.ts`'s `buildGroupNamespaceSource`) describe
 * what a *tuple write* may target, not a rewrite-tree edge this classifier
 * needs to traverse. There is no rewrite rule to walk for a stored fact, so
 * a relation's own cyclic subject type is never itself a monotonicity
 * concern for `classifyMonotone` — confirmed directly by this file's own
 * unit tests (see `test/unit/metamorphic/monotonicity.test.ts`, the
 * group-namespace `member` case).
 *
 * A `CompiledPermission`'s `RewriteRule` is monotone iff:
 *
 *   1. it contains no `ExclusionRule` anywhere in its own AST, AND
 *   2. every `ComputedUsersetRule`/`TupleToUsersetRule` leaf's target
 *      `(ns, name)` is itself monotone, recursively, by `classifyMonotone`.
 *
 * `UnionRule` and `IntersectionRule` are treated *identically* here: both
 * require "every child monotone, no exclusion anywhere in any child" — this
 * is deliberate, not an oversight. A naive "exclusion OR intersection bans
 * monotonicity" reading would be **wrong**: the union of monotone sets is
 * monotone, and — less obviously, but just as truly — the *intersection* of
 * monotone sets is also monotone (adding a tuple can only ever grow each
 * intersected set, so it can only ever grow, never shrink, their
 * intersection too). Only `ExclusionRule` is special: `base - subtract` can
 * have a subject *removed* from its result by a tuple write that only ever
 * *adds* to `subtract`'s own membership — the defining counterexample to
 * monotonicity under insertion-only writes, and the one rewrite-rule kind
 * this classifier treats as unconditionally, unrecoverably non-monotone.
 *
 * ## Cycle handling: sound-but-incomplete, deliberately, in one direction only
 *
 * This classifier uses a three-color (white / grey / black) DFS over the
 * `(ns, name)` reference graph. A node currently **grey** (on the current
 * top-level call's own recursion stack — i.e. a cycle back-edge reached it)
 * is conservatively treated as **non-monotone** (`false`).
 *
 * This is the deliberately chosen, **sound-but-incomplete** direction:
 *
 * - **Incomplete** (a known, accepted cost, disclosed here explicitly): a
 *   genuinely-monotone cyclic permission — e.g. this project's own
 *   `generateFixture`-guaranteed hierarchical namespace's self-referential
 *   `view = editor | parent->view` (a plain union of a relation and a
 *   tupleToUserset edge that happens to loop back into `view` itself,
 *   nothing exclusionary anywhere in it) — gets conservatively classified
 *   **non-monotone**, even though it is, semantically, genuinely monotone.
 *   That is a real permission wrongly excluded from whatever downstream
 *   fuzzing coverage consumes this classifier's `true` verdicts. See this
 *   file's own unit tests for a live, worked example of exactly this case,
 *   asserted as the *expected* (non-monotone) outcome, not a bug to fix.
 *
 * - **Never unsound**, by construction: this classifier must never cache an
 *   *optimistic* `true` for a node still in progress (grey). Caching an
 *   optimistic `true` for an in-progress node is the direction that can
 *   misclassify a genuinely **non-monotone** cyclic permission as monotone
 *   — e.g. a cycle whose closure reaches a real `ExclusionRule` only
 *   through a sibling branch of the back-edge, not the back-edge itself —
 *   which would be a soundness bug in *this classifier*, not merely an
 *   incompleteness, and would let a genuinely non-monotone permission slip
 *   into a caller that trusts `true` verdicts as safe. This file's grey
 *   branch (`classifyNodeInternal`, below) always returns `false` directly,
 *   and never writes that `false` into the shared black-result cache
 *   either — the grey answer is a *transient, path-dependent* placeholder
 *   for the in-progress ancestor, not this node's own final classification,
 *   which is computed once, after this node's *entire* rewrite tree
 *   (including every sibling branch reachable from leaves other than the
 *   one that closed the cycle) has been walked. See the adversarial-cycle
 *   unit test for a case constructed specifically to catch a regression
 *   here (an exclusion reachable via a leaf other than the cycle's own
 *   back-edge).
 *
 * ## Memoization
 *
 * Black (fully-resolved) results are memoized in a `WeakMap<CompiledSchema,
 * Map<string, boolean>>` — keyed by schema *object identity*, so repeated
 * top-level `classifyMonotone` calls against the same compiled schema reuse
 * prior work (real re-entrant efficiency, e.g. two permissions that both
 * reach the same third permission), while a schema that's no longer
 * referenced anywhere else can still be garbage-collected along with its
 * cache entry. The per-call grey/black *color* map, by contrast, is fresh
 * on every top-level `classifyMonotone` call — it exists only to detect a
 * cycle *within that one call's own DFS*, not across calls (a black-cached
 * hit is checked, and returns immediately, before the color map is ever
 * consulted — see `classifyNodeInternal`). This mutable memoization cache
 * is the only non-pure-functional-style plumbing in this file; the
 * function's *return value* depends only on `(schema, ns, name)`,
 * deterministically, matching this file's "pure, zero-I/O" contract — the
 * cache is strictly a performance optimization, never an observable part of
 * the answer.
 */
import type {
  CompiledRelation,
  CompiledSchema,
  ExclusionRule,
  NamespaceConfig,
  RewriteRule,
} from '../schema/dsl/types.js';

/**
 * `undefined` (absent from the map) means white/unvisited — matching this
 * project's own established convention of not bothering to write an
 * explicit `WHITE` sentinel when "absent" already means exactly that (see
 * `src/soundness/generators.ts`'s `hasUsersetCycle`, which does write an
 * explicit `WHITE` because it reads the map back with `?? WHITE` in more
 * places; this file only ever checks for `'grey'` specifically, so leaving
 * white implicit is simpler here and equally unambiguous).
 */
type NodeColor = 'grey' | 'black';

/** Per-schema memoized black (fully-resolved) results — see this file's own top doc comment, "Memoization". */
const monotoneResultCache = new WeakMap<CompiledSchema, Map<string, boolean>>();

function nodeKey(ns: string, name: string): string {
  return `${ns}\0${name}`;
}

function getOrCreateCache(schema: CompiledSchema): Map<string, boolean> {
  const existing = monotoneResultCache.get(schema);
  if (existing) return existing;
  const created = new Map<string, boolean>();
  monotoneResultCache.set(schema, created);
  return created;
}

/**
 * Compile-time exhaustiveness guard, independently written for this file
 * rather than imported from anywhere else — matching `src/soundness
 * /generators.ts`'s own `assertNeverRewriteRule` and `src/schema/dsl
 * /compiler.ts`'s own copy: every file that switches on `RewriteRule.kind`
 * in this codebase writes its own copy of this tiny guard rather than
 * sharing one, so a missed case is caught at compile time locally, with no
 * cross-file coupling for something this small.
 */
function assertNeverRewriteRule(node: never): never {
  throw new Error(`monotonicity.ts: unhandled rewrite-rule kind ${JSON.stringify(node)}`);
}

function requireFollowedRelation(
  schema: CompiledSchema,
  ns: string,
  relationName: string,
): CompiledRelation {
  const namespaceConfig = schema.namespaces[ns];
  if (!namespaceConfig) {
    throw new Error(`classifyMonotone: namespace '${ns}' is not declared in this schema`);
  }
  const relation = namespaceConfig.relations[relationName];
  if (!relation) {
    throw new Error(
      `classifyMonotone: a tupleToUserset rule in namespace '${ns}' follows undeclared relation '${relationName}' — this schema was not validated by compileSchema (which would reject this as 'undeclared_reference'/'tuple_to_userset_target_not_a_relation'), or is a malformed hand-built CompiledSchema`,
    );
  }
  return relation;
}

/**
 * Walks one `RewriteRule` AST node, in the context of the permission's own
 * namespace `ns` (needed to resolve a `ComputedUsersetRule`'s same-
 * namespace target, and to look up a `TupleToUsersetRule`'s followed
 * relation). Returns `true` iff this node, and everything it recursively
 * references, is monotone per this file's own rules (see the top doc
 * comment).
 */
function classifyRewriteRule(
  schema: CompiledSchema,
  ns: string,
  rule: RewriteRule,
  cache: Map<string, boolean>,
  colors: Map<string, NodeColor>,
): boolean {
  switch (rule.kind) {
    case 'computedUserset':
      // "declared on the same namespace" — CompiledUsersetRule's own type
      // doc comment (src/schema/dsl/types.ts). Always resolved against
      // THIS node's own `ns`, never a different one — crossing a namespace
      // boundary is exclusively `tupleToUserset`'s job, below.
      return classifyNodeInternal(schema, ns, rule.name, cache, colors);

    case 'union':
    case 'intersection': {
      // Both combinators require "every child monotone, no exclusion
      // anywhere in any child" — see this file's top doc comment for why
      // intersection is deliberately NOT treated as automatically
      // non-monotone. `.map` then `.every` is used here instead of a
      // single lazy `.every(predicate)` specifically so every child is
      // always walked, regardless of whether an earlier child already
      // resolved `false` — a lazy `.every` would short-circuit on the
      // first `false` child and skip the rest of the array entirely.
      // Skipping the rest wouldn't change *this* node's own boolean
      // answer (an AND-combinator is already `false` once any input is
      // `false`), but it would (a) leave an unvisited exclusion or cyclic
      // leaf un-memoized even when it's real and reachable, weakening this
      // classifier's own effectiveness at proving out every rewrite-rule
      // path over repeated calls, and (b) make the specific "which leaf
      // gets checked" behavior order-dependent, which is exactly the class
      // of accidental behavior the adversarial-cycle unit test (see
      // `test/unit/metamorphic/monotonicity.test.ts`) is designed to rule
      // out: an exclusion reachable via a leaf OTHER than a cycle's own
      // back-edge must be found regardless of which child happens to be
      // listed first.
      const childResults = rule.children.map((child) =>
        classifyRewriteRule(schema, ns, child, cache, colors),
      );
      return childResults.every((result) => result);
    }

    case 'exclusion':
      // An ExclusionRule anywhere in the tree makes its entire containing
      // permission non-monotone, full stop — see this file's top doc
      // comment for the semantic argument (a write that only ever adds to
      // `subtract`'s membership can remove a subject from `base -
      // subtract`'s own result). `rule.base`/`rule.subtract` are
      // deliberately never walked: once an exclusion is found, the
      // containing permission is already, unconditionally, `false` —
      // walking into its children could only ever surface *additional*
      // reasons it's non-monotone, never a reason to reverse this `false`
      // back to `true`.
      return false;

    case 'tupleToUserset': {
      const followedRelation = requireFollowedRelation(schema, ns, rule.relation);
      // A tupleToUserset leaf recurses into a target namespace PER SUBJECT
      // TYPE the followed relation declares — a multi-typed relation (e.g.
      // `parent_link: hierA | hierB`) could, at write time, point at
      // either namespace, so this leaf is monotone only if the recursive
      // target is monotone in EVERY namespace it could possibly resolve
      // into, not merely one of them — the same strict-AND reasoning as
      // union/intersection above, including the same "walk every subject
      // type, don't short-circuit" discipline.
      const perSubjectTypeResults = followedRelation.subjectTypes.map((subjectType) => {
        const targetNamespaceConfig = schema.namespaces[subjectType.namespace];
        if (!targetNamespaceConfig) {
          // A subject type whose own namespace isn't declared in this
          // schema at all — e.g. the terminal `user` principal type, which
          // this project's DSL never requires to be declared as its own
          // `namespace` block for a PLAIN (non-userset) subject type (see
          // `compiler.ts`'s `compileRelations`, which validates a plain
          // subject type's namespace only when it happens to resolve,
          // never requiring it to) — has no rewrite tree of its own to
          // walk. It is exactly as terminal as a plain `CompiledRelation`
          // (see the `relation` branch of `classifyNodeInternal`, below),
          // so it contributes `true` here rather than throwing. In a
          // schema that actually went through `compileSchema`, this branch
          // is unreachable for a tupleToUserset's OWN followed relation
          // specifically — `compileRewriteRule`'s own
          // `tuple_to_userset_unknown_namespace` check already rejects a
          // schema where this would happen, at compile time — but this
          // module also accepts a hand-built `CompiledSchema` constructed
          // directly (bypassing `compileSchema` entirely, as this file's
          // own unit tests deliberately do for several cases), so this
          // defensive branch is real and reachable from this module's own
          // public contract, not dead code kept only for symmetry.
          return true;
        }
        return classifyNodeInternal(
          schema,
          subjectType.namespace,
          rule.computedUserset,
          cache,
          colors,
        );
      });
      return perSubjectTypeResults.every((result) => result);
    }

    default:
      return assertNeverRewriteRule(rule);
  }
}

/**
 * The DFS core. `key = nodeKey(ns, name)`. Cache is checked BEFORE color —
 * a black (fully resolved) result from a previous top-level call, or an
 * earlier-visited sibling within this same call, always short-circuits
 * immediately; a node's color is only ever consulted once it's known this
 * is the FIRST time this particular top-level call has reached it.
 */
function classifyNodeInternal(
  schema: CompiledSchema,
  ns: string,
  name: string,
  cache: Map<string, boolean>,
  colors: Map<string, NodeColor>,
): boolean {
  const key = nodeKey(ns, name);

  const cachedResult = cache.get(key);
  if (cachedResult !== undefined) return cachedResult;

  if (colors.get(key) === 'grey') {
    // The sound-but-incomplete cycle case — see this file's top doc
    // comment, "Cycle handling". Deliberately: (a) returns `false`, never
    // an optimistic `true`; (b) does NOT write anything into `cache` or
    // `colors` here — this is a transient, path-dependent answer for
    // whichever in-progress ancestor's DFS asked, not `key`'s own final
    // classification (which is still being computed further up this same
    // call stack, and will itself be cached, correctly, once that
    // in-progress call finishes walking its own full rewrite tree below).
    return false;
  }
  // `colors.get(key) === 'black'` is impossible to reach here: `cache` and
  // `colors` are always written together, in the same two statements, at
  // every point this function reaches a final answer (see the `relation`
  // branch and the bottom of the `permission` branch below) — so a black
  // color always implies a cache hit, already handled above. This comment
  // records that invariant rather than adding an unreachable branch to
  // re-check it.

  colors.set(key, 'grey');

  const namespaceConfig = schema.namespaces[ns];
  if (!namespaceConfig) {
    throw new Error(`classifyMonotone: namespace '${ns}' is not declared in this schema`);
  }

  const relation = namespaceConfig.relations[name];
  if (relation) {
    // A CompiledRelation is monotone unconditionally — see this file's top
    // doc comment. Deliberately does NOT inspect `relation.subjectTypes`
    // at all, even when one of them is a self-referential userset type
    // (e.g. `group#member`'s own `<self>#member`) — a relation's subject
    // types describe what a tuple WRITE may target, not a rewrite-tree
    // edge this classifier needs to traverse; there is no rewrite rule
    // "under" a stored fact.
    colors.set(key, 'black');
    cache.set(key, true);
    return true;
  }

  const permission = namespaceConfig.permissions[name];
  if (!permission) {
    throw new Error(
      `classifyMonotone: '${name}' is neither a relation nor a permission on namespace '${ns}'`,
    );
  }

  const result = classifyRewriteRule(schema, ns, permission.rewrite, cache, colors);
  colors.set(key, 'black');
  cache.set(key, result);
  return result;
}

/**
 * Classifies whether `(ns, name)` — a relation or a permission declared on
 * namespace `ns` in `schema` — is monotone under insertion-only tuple
 * writes: can writing one additional tuple ever cause a check that
 * currently returns `allowed` for this relation/permission to flip to
 * `denied`? See this file's own top doc comment for the full algorithm,
 * the deliberate sound-but-incomplete cycle handling, and the memoization
 * strategy.
 *
 * Throws if `ns` is not declared in `schema`, or if `name` names neither a
 * relation nor a permission on `ns` — both indicate a malformed or
 * mismatched `(schema, ns, name)` triple, not a legitimate "don't know"
 * answer this function should ever paper over with a boolean.
 */
export function classifyMonotone(schema: CompiledSchema, ns: string, name: string): boolean {
  const cache = getOrCreateCache(schema);
  const colors = new Map<string, NodeColor>();
  return classifyNodeInternal(schema, ns, name, cache, colors);
}

/**
 * A real `ExclusionRule` `findFlippableExclusion` (below) can reach from
 * `(ns, name)` by crossing only edges that leave "what a caller needs to
 * check to observe this exclusion's own truth value" unchanged — a `union`
 * branch (safe: with no tuples written anywhere for a fresh subject/object
 * pair except the two this shape asks its caller to write, every OTHER
 * union sibling evaluates `false` by construction, so checking `(ns, name)`
 * directly reflects this exclusion's own base/subtract state) and a
 * same-namespace `computedUserset` pass-through (safe: `ComputedUsersetRule`
 * never changes which object is being evaluated — see that type's own doc
 * comment in `src/schema/dsl/types.ts`). Deliberately does NOT cross an
 * `intersection` child (a sibling conjunct could itself need tuples this
 * function has no way to know about, so satisfying only this exclusion says
 * nothing about the intersection's own overall truth) or a `tupleToUserset`
 * target (crossing to a different object needs an additional "hop" tuple
 * this function never constructs) — see `findFlippableExclusion`'s own doc
 * comment for the same reasoning stated once, and
 * `test/metamorphic/monotonicity.integration.test.ts`'s general-sweep
 * Property 5 for the one caller that turns this into real tuples and a real
 * check today.
 */
export interface LocatedExclusion {
  /**
   * Always the exact `(ns, name)` pair `findFlippableExclusion` was called
   * with, never some node found partway down the walk — every edge this
   * walk crosses (see this interface's own doc comment) leaves the
   * checked object/subject unchanged, so a real check against THIS `(ns,
   * name)` pair, not the exclusion node's own position in the tree,
   * directly reflects the located exclusion's base/subtract truth values.
   */
  ns: string;
  name: string;
  /**
   * The relation a caller must write a tuple against to satisfy the
   * located exclusion's own `base` branch. Always a real `CompiledRelation`
   * name declared on `ns` — never a permission (see `findFlippableExclusion`'s
   * own doc comment on why a further `computedUserset` resolution isn't
   * attempted here) — so a single `writeTuple` call is always sufficient.
   */
  baseRelation: string;
  /**
   * The relation a caller must write a tuple against to satisfy the
   * exclusion's `subtract` branch — the ONE additional write that must flip
   * a check on `(ns, name)` from allowed to denied. Guaranteed distinct
   * from `baseRelation` (see `findFlippableExclusion`'s own degenerate-case
   * rejection, below) — a tuple graph where `baseRelation === subtractRelation`
   * cannot ever satisfy `base` without also satisfying `subtract`, so no
   * `LocatedExclusion` this function returns is ever unwitnessable that way.
   */
  subtractRelation: string;
}

/**
 * Walks `(ns, name)`'s own rewrite tree — reusing the exact same
 * switch-on-`kind` shape `classifyRewriteRule` (above) already uses to
 * classify monotonicity — looking for the first real `ExclusionRule`
 * reachable through the "transparent" edges `LocatedExclusion`'s own doc
 * comment names (`union`, same-namespace `computedUserset`). Returns
 * `undefined` if none is found, or if the first one found doesn't meet the
 * additional "both sides are directly tuple-writable" requirement
 * `LocatedExclusion` promises its own caller (see below) — this function
 * never widens its own search to look for a SECOND candidate once the
 * first found exclusion fails that check; a caller wanting to try another
 * `(ns, name)` starting point does so by calling this function again with
 * a different one, exactly like every other caller of a `classifyMonotone`
 * -shaped function in this file already does per-pair, not per-schema.
 * Throws only for a malformed `(schema, ns)` pair — an undeclared
 * namespace — matching `classifyMonotone`'s own error contract for the
 * same condition; an unrecognized `name` (neither a relation nor a
 * permission on `ns`) is treated as "nothing to walk" and returns
 * `undefined` rather than throwing, since a caller of this function
 * legitimately scans every member name a schema declares without first
 * filtering to permissions only (see this function's own caller in
 * `test/metamorphic/monotonicity.integration.test.ts`).
 *
 * **Why this exists, and why it is deliberately narrower than
 * `classifyMonotone`'s own boolean answer.** `classifyMonotone` already
 * answers "does this rewrite tree contain an `ExclusionRule` ANYWHERE" —
 * but only as a boolean, with no notion of WHERE, and every edge it
 * crosses (including `intersection` and `tupleToUserset`) is fair game for
 * THAT question, since it never needs to construct a real tuple-graph
 * witness afterward (see this file's own top doc comment). Turning
 * "somewhere, non-monotone" into "here is a real (subject, object) tuple
 * graph that flips a real check" needs to know exactly which relation to
 * write a tuple against for `base` and which for `subtract`, and needs
 * every edge crossed on the way there to be one a caller can build real
 * tuples for cheaply and correctly, with no need to independently
 * re-derive resolver behavior (e.g. following a userset-subject chain, or
 * constructing an intermediate tupleToUserset "hop" object) — hence this
 * function's own narrower walk, and its own additional base/subtract
 * shape requirement below. This is exactly the gap PROPERTY 5's own
 * original scope note in `test/metamorphic/monotonicity.integration
 * .test.ts` named as unbuilt machinery when it restricted itself to one
 * hand-verified `generateFixture` shape; this function is what closes it,
 * deliberately kept this narrow rather than growing into a general
 * tuple-graph solver for arbitrary rewrite trees.
 */
export function findFlippableExclusion(
  schema: CompiledSchema,
  ns: string,
  name: string,
): LocatedExclusion | undefined {
  const maybeNamespaceConfig = schema.namespaces[ns];
  if (!maybeNamespaceConfig) {
    throw new Error(`findFlippableExclusion: namespace '${ns}' is not declared in this schema`);
  }
  // Explicitly typed (not just narrowed) so this survives capture by the
  // nested closures below — TS's control-flow narrowing of the throw-guard
  // above does not, by itself, propagate into a nested function body (the
  // nested function could in principle run later, after further
  // reassignment); an explicit annotation on an otherwise-never-reassigned
  // `const` sidesteps that without a non-null assertion at every use site.
  const namespaceConfig: NamespaceConfig = maybeNamespaceConfig;

  // A local, tiny cycle guard — a `computedUserset` chain can loop back on
  // itself (`perm_a = perm_b`, `perm_b = perm_a`) exactly like
  // `classifyNodeInternal`'s own grey-node case, above; unlike that
  // function, this walk has no reason to memoize anything across calls (it
  // only ever runs once, for one `(ns, name)` starting point), so a plain
  // per-call `Set<string>` of permission names already visited on THIS
  // walk is sufficient — no black/grey color distinction needed here.
  function walkPermission(currentName: string, visited: Set<string>): ExclusionRule | undefined {
    if (visited.has(currentName)) return undefined;
    visited.add(currentName);
    const permission = namespaceConfig.permissions[currentName];
    if (!permission) return undefined; // a relation (or an unrecognized name) has no rewrite tree to walk
    return walkRule(permission.rewrite, visited);
  }

  function walkRule(rule: RewriteRule, visited: Set<string>): ExclusionRule | undefined {
    switch (rule.kind) {
      case 'exclusion':
        return rule;
      case 'union':
        // Every child is tried, in order, stopping at the first exclusion
        // found — unlike `classifyRewriteRule`'s own union/intersection
        // case, this is a SEARCH (not an aggregate boolean every caller
        // depends on being complete), so short-circuiting on the first hit
        // is correct here, not merely convenient.
        for (const child of rule.children) {
          const found = walkRule(child, visited);
          if (found) return found;
        }
        return undefined;
      case 'computedUserset':
        return walkPermission(rule.name, visited);
      case 'intersection':
      case 'tupleToUserset':
        // Deliberately not walked — see this function's own top doc
        // comment and `LocatedExclusion`'s doc comment for why crossing
        // either edge would need tuples this function has no way to
        // construct.
        return undefined;
      default:
        return assertNeverRewriteRule(rule);
    }
  }

  const found = walkPermission(name, new Set());
  if (!found) return undefined;

  // Both sides must be a bare `computedUserset` naming a REAL RELATION —
  // never a permission, which would need this function to recurse further
  // to find something tuple-writable (exactly the unbuilt machinery
  // PROPERTY 5's own original scope note names — see this function's own
  // top doc comment). Rejecting here, rather than recursing, keeps this
  // function's own contract simple: every `LocatedExclusion` it returns is
  // directly satisfiable, or directly deniable, by exactly one tuple write
  // per side.
  if (found.base.kind !== 'computedUserset' || found.subtract.kind !== 'computedUserset') {
    return undefined;
  }
  const baseRelation = found.base.name;
  const subtractRelation = found.subtract.name;
  if (!namespaceConfig.relations[baseRelation] || !namespaceConfig.relations[subtractRelation]) {
    return undefined;
  }
  if (baseRelation === subtractRelation) {
    // The degenerate, unwitnessable case — see `LocatedExclusion`'s own
    // doc comment on `subtractRelation`: base and subtract name the exact
    // same relation, so a tuple write satisfying `base` also, unavoidably,
    // satisfies `subtract`. Nothing stops a schema author (or this
    // project's own random generator) from writing `viewer - viewer`; it
    // just isn't a shape this function can hand its caller a real witness
    // for.
    return undefined;
  }

  return { ns, name, baseRelation, subtractRelation };
}
