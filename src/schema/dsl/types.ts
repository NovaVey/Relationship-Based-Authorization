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
 *
 * This pattern and length cap are necessary but not sufficient for a
 * schema-declaration identifier: `namespace`/`relation`/`permission`
 * themselves each satisfy both yet are rejected as reserved words
 * (`RESERVED_WORDS`, `src/schema/dsl/parser.ts`) — a real gap between this
 * exported grammar and what the parser actually enforces, found and folded
 * into the property-fuzz test's own oracle rather than filtered around (see
 * that test's own doc comment). Not narrow to a namespace name specifically
 * (second full-repo audit, finding #12, LOW, corrected 2026-08-22; D-062's
 * own framing made the same overclaim) — `validateIdentifier` is called
 * unconditionally, with no context-based exemption, at every identifier-
 * declaration site the parser has: a namespace name, a relation name, a
 * permission name, a subject-type namespace and its `#relation` suffix, and
 * every rewrite-rule/tuple-to-userset reference. Confirmed directly:
 * `compileSchema('namespace document { relation permission: user }')` is
 * rejected exactly like a namespace named `permission` would be. A
 * subject/object id (`src/store/tuples.ts`'s `validateIdentifiers`) has
 * no such carve-out — this pattern and length cap are both necessary and
 * sufficient there.
 */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * The maximum number of nested `(` levels a single permission expression
 * may contain (`parser.ts`'s `parseAtom`/`parseTerm`/`parseExpression` are
 * mutually recursive on native JS call-stack frames, one frame per level of
 * `(` nesting — with no ceiling, a source string with a few thousand nested
 * parens around a trivial expression drives that recursion past Node's
 * default call-stack size and throws a raw, unhandled `RangeError` instead
 * of a clean, located `SchemaError`).
 *
 * 100 is deliberately generous: every real schema this project has ever
 * written (see `schema/example.authz`, and every worked example in
 * `.claude/commands/build-authz-service.md` §5) nests at most 1-2 levels
 * deep — a human author has no reason to write a permission expression
 * nesting parentheses anywhere near this deep, and the compiler's own
 * paren-depth counter never counts toward this ceiling until an author (or
 * an attacker) actually writes that many literal `(` characters in a row.
 * Nesting exactly `MAX_EXPRESSION_NESTING_DEPTH` levels deep still compiles;
 * one level past it is rejected with `expression_nesting_too_deep`
 * (`src/schema/dsl/errors.ts`) — see `docs/DECISIONS.md` for the audit this
 * closes and why 100 was chosen over the audit's own suggested 100-200
 * range.
 */
export const MAX_EXPRESSION_NESTING_DEPTH = 100;

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
