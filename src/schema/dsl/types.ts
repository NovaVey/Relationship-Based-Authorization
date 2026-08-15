/**
 * The compiled output shape for a namespace DSL schema — see
 * `.claude/commands/build-authz-service.md` §5 (the grammar this compiles)
 * and §4 (`namespace_configs.config jsonb`, where this shape is stored).
 *
 * This file is the contract. `src/store/` (Phase 2) validates tuple writes
 * against `NamespaceConfig.relations`; the reference resolver (Phase 3) and
 * the production resolver (Phase 4) walk `CompiledPermission.rewrite`
 * trees. None of them ever read `source_dsl` or re-parse DSL text at
 * runtime — only this compiled shape. Changing it after Phase 2 depends on
 * it is a breaking change and belongs in `docs/DECISIONS.md`.
 *
 * Deliberately plain, JSON-safe data: no functions, no `undefined` values
 * embedded in objects (an absent optional field is simply omitted, never
 * set to `undefined`, so `JSON.stringify` round-trips exactly what a
 * `jsonb` column will actually store) and no debug-only fields like source
 * line numbers — those exist only transiently during compilation (see
 * `parser.ts`'s `Parsed*` types) and are stripped before this shape is
 * produced.
 */

/**
 * An identifier — a namespace, relation, or permission name. Lowercase
 * `snake_case`, must start with a letter, capped at 63 characters (the
 * Postgres identifier length this project's own predecessor learned to
 * respect the hard way — see `test/isolation/identifier-and-tuple-
 * validation.fuzz.test.ts`, "an identifier at exactly the documented length
 * limit is accepted, and one character over is rejected"). Every namespace,
 * relation, and permission name in a compiled schema matches this pattern;
 * the parser enforces it at the point each name is declared.
 */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * A subject type a `relation` is allowed to store as the subject of a
 * tuple: either a direct/terminal principal type (`user` — no `relation`
 * field) or a userset reference into another namespace's relation
 * (`group#member` — `relation: "member"`). This is what a tuple writer
 * (Phase 2) checks a write's `subject_ns` / `subject_relation` against.
 */
export interface SubjectTypeRef {
  namespace: string;
  /** Present only for a `namespace#relation` userset subject type. */
  relation?: string;
}

/**
 * A storable relation — the only kind of name a tuple write may target.
 * `permission`s are never storable; see `CompiledPermission` and the
 * compiler's `duplicate_member_name` / structural separation of
 * `relations` from `permissions` in `NamespaceConfig`, which is what
 * makes "only a relation, never a permission, can be the target of a
 * tuple write" true by construction rather than by convention.
 */
export interface CompiledRelation {
  kind: 'relation';
  name: string;
  subjectTypes: SubjectTypeRef[];
}

/**
 * A leaf rewrite-rule node: "the set of subjects related to this object via
 * the relation or permission named `name`, declared on the same
 * namespace." Zanzibar calls this a `computed_userset`. This is the only
 * rewrite-rule kind that can name either a `relation` or a `permission` —
 * every other kind either combines other rewrite rules or crosses a
 * namespace boundary via `tupleToUserset`.
 */
export interface ComputedUsersetRule {
  kind: 'computedUserset';
  name: string;
}

/** The set of subjects satisfying ANY child rule. */
export interface UnionRule {
  kind: 'union';
  children: RewriteRule[];
}

/** The set of subjects satisfying EVERY child rule. */
export interface IntersectionRule {
  kind: 'intersection';
  children: RewriteRule[];
}

/** The set of subjects satisfying `base` but not `subtract` ("a - b"). */
export interface ExclusionRule {
  kind: 'exclusion';
  base: RewriteRule;
  subtract: RewriteRule;
}

/**
 * "Follow `relation` from this object to whatever it points at, then
 * recurse into `computedUserset` (a relation or permission name) on that
 * object's namespace" — e.g. `parent->view` follows the `parent` relation,
 * then recurses into `view` on whatever namespace `parent` points to.
 * `relation` MUST name an actual storable `relation` in this same
 * namespace (never a `permission` — there is nothing to walk in the tuple
 * store for a computed permission); the compiler rejects a schema that
 * tries otherwise. `computedUserset` is resolved against a *different*
 * namespace's compiled config at walk time, which is why this is
 * structurally distinct from `ComputedUsersetRule` rather than sharing its
 * shape.
 */
export interface TupleToUsersetRule {
  kind: 'tupleToUserset';
  relation: string;
  computedUserset: string;
}

/**
 * Every rewrite-rule kind the DSL supports, as a discriminated union on
 * `kind` — a resolver walking this tree switches exhaustively on `kind`
 * and the type system (via a `never`-typed default case, see
 * `compiler.ts`'s `assertNeverRewriteRule`) catches a missed case at
 * compile time rather than at 2am in a resolver.
 */
export type RewriteRule =
  ComputedUsersetRule | UnionRule | IntersectionRule | ExclusionRule | TupleToUsersetRule;

/** A computed relation — never a valid tuple-write target. See `CompiledRelation`. */
export interface CompiledPermission {
  kind: 'permission';
  name: string;
  rewrite: RewriteRule;
}

export interface NamespaceConfig {
  namespace: string;
  /** Keyed by relation name — the only valid targets of a tuple write. */
  relations: Record<string, CompiledRelation>;
  /** Keyed by permission name — computed only, never a tuple-write target. */
  permissions: Record<string, CompiledPermission>;
}

/**
 * The full compiled output of one compilation unit (one or more `namespace`
 * blocks compiled together — see `compiler.ts`'s tuple-to-userset
 * cross-namespace validation for why "compiled together" matters). This is
 * what gets stored as `namespace_configs.config` per namespace (§4) — one
 * row per `namespaces[ns]`, not one row per compilation unit.
 */
export interface CompiledSchema {
  namespaces: Record<string, NamespaceConfig>;
}
