/**
 * The invariant language (build spec §4) — deliberately tiny. An invariant
 * is exactly three things: a set of typed variables, a set of constraints
 * between them, and a goal permission call. Nothing here knows what a
 * "tenant" is, or resolves a relation/permission/type name against a real
 * schema — that only happens in §5, when an invariant and a schema graph
 * are walked together. This module's only job is turning source text into
 * this shape, or a clear, line-numbered reason it couldn't.
 */

/** One typed variable declaration, e.g. `s: user` → `{ name: 's', type: 'user' }`. */
export interface TypedVariable {
  readonly name: string;
  readonly type: string;
}

/**
 * `distinct(orgA, orgB)` — every listed variable must bind to a different
 * object. This is the entire reason the invariant language is a constraint
 * problem rather than plain reachability (§4): "cross-tenant" means
 * precisely that two variables must NOT collapse onto the same node.
 */
export interface DistinctConstraint {
  readonly kind: 'distinct';
  readonly variables: readonly string[];
}

/**
 * `tenant(s) = orgA` — applying the named relation (resolved against the
 * real schema only in §5, not here) to `subject` must equal `value`. Lets
 * an invariant say "the object this relation points to" without the
 * invariant language itself needing a first-class notion of what that
 * relation means.
 */
export interface RelationEqualsConstraint {
  readonly kind: 'relationEquals';
  readonly relation: string;
  readonly subject: string;
  readonly value: string;
}

/**
 * `not tenant(s) = orgA` — the negation of `RelationEqualsConstraint`: no
 * witness may ever assume a tuple where applying `relation` to `subject`
 * equals `value`. Deliberately narrow (build spec §4 extension, see
 * `docs/DECISIONS.md` D-131): `subject` and `value` must both already be
 * declared invariant variables — there is no way to introduce a fresh one
 * here, and no userset-subject form (`value` is always a bare principal,
 * matching `RelationEqualsConstraint`'s own scope exactly). This closes
 * "assuming this specific, already-known fact is false, does the goal
 * still hold" — not "this relation can never be satisfied via any object,
 * anywhere," which needed a fundamentally different, schema-level
 * primitive this entry deliberately did not attempt — see
 * `NeverRelationConstraint`, added later specifically to close that gap.
 */
export interface NotRelationEqualsConstraint {
  readonly kind: 'notRelationEquals';
  readonly relation: string;
  readonly subject: string;
  readonly value: string;
}

/**
 * `never team#member(s)` — the schema-level primitive `NotRelationEqualsConstraint`'s
 * own doc comment names as deliberately out of scope: "this relation can
 * never be satisfied via any object, anywhere" (`docs/DECISIONS.md` D-131's
 * own "Revisit if", closed by the entry documenting this type). Unlike
 * `NotRelationEqualsConstraint` (which excludes one already-known,
 * already-declared triple), this excludes the *entire* declared relation
 * `<namespace>#<relation>` from ever resolving `subject` as its subject —
 * via its bare-principal branch, a wildcard-declared branch, or any
 * userset-subject branch it declares — at any object, named or freshly
 * introduced mid-search, and at any recursion depth.
 *
 * **Namespace-qualified by design, not just by convention** — a real,
 * adversarially-found unsoundness this entry's own design process caught
 * before shipping: two unrelated namespaces routinely declare a
 * same-named relation (`team.member` and `group.member` are both real,
 * unrelated relations in this project's own third-party fixture corpus).
 * A bare-relation-name match (no namespace) would silently block *both*
 * whenever they share a name, closing a real escape through one while
 * silently discarding a genuine, unrelated violation through the other —
 * this is precisely why the syntax requires `<namespace>#<relation>`
 * (reusing the schema DSL's own existing `type#relation` userset-subject
 * notation) rather than a bare relation name the way
 * `NotRelationEqualsConstraint` gets away with (that primitive is immune
 * to the same collision only as a side effect of *also* requiring the
 * excluded object to unify with an already-declared invariant variable —
 * a guard this constraint deliberately drops, since "any object" is the
 * whole point).
 *
 * **`subject` must still be a declared invariant variable** (no
 * fresh-variable introduction, matching `NotRelationEqualsConstraint`'s
 * own scope) — but because `../reachability/search.ts`'s whole search
 * architecture only ever asks "can the invariant's own fixed goal subject
 * reach here," this constraint only ever fires where `subject` unifies
 * (directly, or transitively via other constraints) with the goal's own
 * subject variable; naming any other declared variable is accepted by the
 * parser but is a silent no-op, exactly the same scope limit
 * `NotRelationEqualsConstraint`'s own `value` field already has today.
 *
 * **Given-fact exemption, not an absolute universal negation.** If the
 * invariant's own `relationEquals` constraints already establish
 * `<relation>(x) = subject` for some object `x` — the ordinary way these
 * invariants pin their own legitimate premise — that fact is exempted
 * from the block; every *other* object (named or fresh) stays blocked.
 * Without this, an invariant needing both a `relationEquals` given and a
 * `never` naming the very same relation/value would be self-contradictory
 * by construction, for no useful reason: the given already represents the
 * one legitimate route the invariant means to hold fixed, and `never`'s
 * whole purpose is to rule out an *additional*, adversarial instance of
 * the same relation resolving the same value — not to retract the
 * premise the invariant itself just asserted.
 */
export interface NeverRelationConstraint {
  readonly kind: 'neverRelation';
  readonly namespace: string;
  readonly relation: string;
  readonly subject: string;
}

export type Constraint =
  | DistinctConstraint
  | RelationEqualsConstraint
  | NotRelationEqualsConstraint
  | NeverRelationConstraint;

/** `goal: view(s, o)` — the permission call the verifier searches for a witness to. */
export interface Goal {
  readonly permission: string;
  readonly subject: string;
  readonly object: string;
}

export interface Invariant {
  readonly name: string;
  readonly variables: readonly TypedVariable[];
  readonly constraints: readonly Constraint[];
  readonly goal: Goal;
}

/** Line-numbered, matching this project's existing `SchemaError` shape (`src/schema/dsl/errors.ts`) so downstream reporting can treat both uniformly. */
export interface InvariantError {
  readonly message: string;
  readonly line: number;
}

export type ParseInvariantsResult =
  | { readonly ok: true; readonly invariants: readonly Invariant[] }
  | { readonly ok: false; readonly errors: readonly InvariantError[] };
