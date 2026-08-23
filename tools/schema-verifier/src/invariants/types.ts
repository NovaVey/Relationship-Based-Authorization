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

export type Constraint = DistinctConstraint | RelationEqualsConstraint;

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
