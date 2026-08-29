/**
 * The production check engine — build spec `.claude/commands/build-authz-
 * service.md` §4/§6.3/§6.4/§6.7, Phase 4/6. Backed by real Postgres via
 * hand-written SQL (no ORM — see `docs/DECISIONS.md` D-004).
 *
 * Two userset mechanisms this engine has to resolve, deliberately handled
 * by two *different* implementation strategies (not just different code —
 * a genuinely different algorithm shape, per the Phase 4 delegation):
 *
 *  1. Rewrite-rule tuple-to-userset (`TupleToUsersetRule`, e.g.
 *     `parent->view`) crosses object/namespace boundaries and its shape
 *     depends on the *compiled schema*, which varies per namespace. That
 *     can't be one static SQL query across an arbitrary schema, so this
 *     part of the walk is orchestrated here, in TypeScript, recursing once
 *     per rewrite-rule AST node (`evalRewrite`/`resolve`, mutually
 *     recursive below).
 *  2. Stored-tuple userset subjects (`relation_tuples.subject_relation` —
 *     e.g. `document:readme#editor@group:eng#member`, where `group:eng`
 *     may itself nest further groups) is answered by
 *     `sqlRelationMembershipWithWitness`, a recursive `WITH RECURSIVE`
 *     query per relation-level check. The *target* relation name can
 *     change at every hop (a group's `member` relation might point at
 *     another group's `member` relation, or in principle at some other
 *     relation entirely), but the edge shape does not — "follow every
 *     userset-subject tuple on the current (namespace, id, relation)
 *     frontier" is schema-agnostic, which is exactly what makes it
 *     expressible as one recursive CTE instead of TypeScript-orchestrated
 *     recursion.
 *
 * **Isolation from `src/resolve/reference/resolver.ts` is absolute** — see
 * build spec §6.2 and the Phase 4 delegation's own restated non-negotiable.
 * This file's only imports are `src/schema/dsl/types.ts` (plain compiled-
 * schema data), `src/schema/publish.ts` (schema lookup — store
 * infrastructure, not resolver logic), `src/store/tokens.ts` (the
 * consistency-token *mechanism*, explicitly carved out by the Phase 4
 * delegation as shared store infrastructure, not something §6.2's
 * isolation rule applies to), and `src/config/env.ts`. `EntityRef` below is
 * a field-for-field redefinition of whatever shape the reference resolver
 * uses internally for the same concept — never an import of it — matching
 * `docs/DECISIONS.md` D-022's own precedent for `src/store/tuples.ts`'s
 * `TupleKey`. Every resolution-path/disproof type below (Phase 6) is
 * likewise a *field-for-field-named* but wholly independent redeclaration
 * of the reference resolver's own equivalent shapes — same names where the
 * concept is identical (`DirectGrantStep`, `UnionStep`, ...), never an
 * import, and the one place the two shapes genuinely diverge —
 * relation-membership disproof — is deliberately shaped differently to
 * fit this resolver's own SQL-backed mechanism (see `RelationDisproof`
 * below), not forced to match the reference resolver's in-memory tree
 * shape just for symmetry.
 *
 * ---
 *
 * **Phase 6 — the resolution path and `checks.depth` (§6.7, §9 Phase 6's
 * exit criterion).** `ProductionCheckResult` now carries `path` (present
 * iff `allowed` is true) and `depth` (the actual maximum recursion depth
 * reached anywhere in this check — both the TypeScript-orchestrated
 * combinator/tuple-to-userset walk and every SQL-side recursive CTE this
 * check issued, folded into one high-water mark — never just the
 * configured ceiling). See this file's own doc comments on `WalkContext
 * .depthReached` and `sqlRelationMembershipWithWitness`'s own return
 * shape for exactly how that's tracked. Full-repo audit finding #6 adds a
 * third field, `certain` (present iff `allowed` is false — see
 * `ProductionCheckResult.certain`'s own doc comment): a denied check's
 * audit trail used to have no way to distinguish an exhaustively-proven
 * "no" from one a cycle guard or depth ceiling merely gave up on.
 *
 * **Why `RelationDisproof` (used only inside an `ExclusionStep`'s
 * `subtractDisproof`, when a relation-membership check needs to prove a
 * NEGATIVE) is a flat reachability certificate, not a nested tree:** the
 * reference resolver's own relation-level disproof (`resolveRelation`) is
 * built for free as a side effect of an in-memory scan that was going to
 * touch every tuple anyway. This resolver's relation-membership mechanism
 * is one recursive SQL query — reconstructing a *nested* nested nested
 * disproof tree from repeated round-trips would mean re-deriving,
 * TypeScript-side, exactly the transitive closure Postgres already
 * computed once, for no correctness benefit. Instead,
 * `sqlRelationMembershipWithWitness` asks the SAME recursive CTE to return
 * *every* frontier node it actually reached (not just whether one
 * matched), fetches every real tuple stored on each of those nodes in one
 * follow-up query, and packages the result as a flat, self-contained
 * certificate: every reached node's real tuples are listed in full (so a
 * verifier can confirm none of them is a plain match for the subject), and
 * every userset edge out of a reached node is shown to either land on
 * another node in the same certificate or be legitimately excluded by the
 * same depth/cycle rule the SQL guard itself enforces (checkable from the
 * certificate's own `depth`/`ancestorPath` fields, independent of trusting
 * this resolver's own SQL). See `test/unit/resolve/production/production-
 * resolution-path.integration.test.ts` for the independent verifier that
 * checks exactly this, against real Postgres, without importing anything
 * from this file's own SQL.
 *
 * ---
 *
 * **One check, one snapshot (full-repo audit finding #1, `docs/DECISIONS.md`
 * D-092).** Every read this file issues on behalf of one `productionCheck`
 * call — every `sqlRelationMembershipWithWitness` frontier/tuple fetch,
 * every `listTupleSubjects` call for a `tupleToUserset` hop — now runs
 * inside one `REPEATABLE READ` transaction, pinned to one connection
 * acquired once at the top of `productionCheck` and released once at the
 * bottom. Before this, every one of those reads was its own independent,
 * autocommit `pool.query()` call with no shared snapshot at all: a
 * concurrent write landing between, say, the frontier query and the
 * tuple-on-frontier query could make a resolution path cite two facts
 * (an edge and a grant) that never actually coexisted at any single real
 * point in the database's history — a phantom witness in the audit trail
 * this project's whole `resolution_path` mechanism (§6.7) exists to rule
 * out. `REPEATABLE READ` (not `SERIALIZABLE`, which this read-only walk has
 * no need of, and which would add retry-worthy serialization failures this
 * codebase has no retry logic for) gives every read in one check the exact
 * same MVCC snapshot, matching Postgres's own documented semantics for
 * "this transaction sees one consistent point in time" and matching what
 * `docs/CONSISTENCY.md` already claimed before this fix existed.
 *
 * `atToken` pinning composes with this by re-verifying the floor check
 * (`write_log` has advanced to at least `atToken`) as literally the first
 * statement of the just-opened transaction, on the same client whose
 * snapshot every later read in the check will share — see
 * `assertTokenObservedOnSnapshot`'s own doc comment for exactly why a
 * *pool*-level check beforehand isn't sufficient on its own. `getConfig`'s
 * `namespace_configs` reads run on this same pinned client too (closing a
 * gap this fix originally left open — see `productionCheck`'s own doc
 * comment for the full history and the connection-exhaustion deadlock
 * closing it also fixes).
 *
 * **`pool: ConnectionSource`/`client: QueryExecutor`, not concrete
 * `pg.Pool`/`pg.PoolClient` — DST D2 (`docs/DECISIONS.md` D-099).** The
 * same non-breaking narrowing D0/D1 already applied to `src/store/tuples
 * .ts`/`tokens.ts`/`publish.ts`/`migrate.ts`: a real `Pool`/`PoolClient`
 * still satisfies these structurally, so every real caller (`authz
 * check`, `POST /check`, `src/audit/checks.ts`) keeps working with zero
 * changes. **This narrowing is orthogonal to `docs/DECISIONS.md` D-022**,
 * which forbids the *reference* resolver (`src/resolve/reference/
 * resolver.ts`) sharing code with the *production* one — parameterizing
 * which physical driver answers this file's own storage calls touches
 * neither side of that isolation boundary: nothing here imports from or
 * shares code with `src/resolve/reference/`, and D-022's own rule was
 * never about how *this* file talks to Postgres.
 */
import type {
  ConnectionSource,
  QueryExecutor,
  QueryResultLike,
} from '../../store/query-executor.js';

import { env } from '../../config/env.js';
import type { NamespaceConfig, RewriteRule } from '../../schema/dsl/types.js';
import { getLatestNamespaceConfig } from '../../schema/publish.js';
import { assertTokenObserved } from '../../store/tokens.js';
import {
  lookupRelationMembershipIndex,
  type RelationIndexLookup,
} from '../../store/relation-index.js';

/** An object or subject reference — `ns:id`, e.g. `document:readme`, `user:alice`. */
export interface EntityRef {
  ns: string;
  id: string;
}

export interface ProductionCheckOptions {
  /**
   * Pin the read to a consistency token (build spec §6.3). When present,
   * `assertTokenObserved(pool, atToken)` is called *first*, before this
   * call ever opens the transaction/client the walk below runs in — it
   * throws if this database hasn't observed that token yet, per its own
   * documented contract, giving a cheap, well-tested rejection for an
   * obviously too-high token before paying for a connection at all.
   *
   * That alone is *not* sufficient (full-repo audit finding #1,
   * `docs/DECISIONS.md` D-092): it only proves the token had been observed
   * by *some* connection at the moment it ran, not that the `REPEATABLE
   * READ` snapshot this check's own reads will use is anchored at or after
   * that point. `productionCheck` re-verifies the same floor check a
   * second time, as literally the first statement of the transaction it
   * then runs every other read of this check inside — see
   * `assertTokenObservedOnSnapshot`'s own doc comment for exactly why, and
   * `productionCheck`'s own doc comment for the transaction this option
   * now participates in.
   */
  atToken?: number;
  /**
   * Overrides `env.CHECK_MAX_DEPTH` for this call only. Threaded through
   * to *both* depth backstops this engine has: the TypeScript-level
   * combinator/tuple-to-userset walk (`resolve`) and the SQL-level
   * recursive CTE's own `depth` column cap
   * (`sqlRelationMembershipWithWitness`) — see this file's own doc comment
   * on that function for exactly how those two independent ceilings
   * compose. Tests use this to force a budget the depth ceiling itself
   * can't quietly absorb a missing cycle guard into — the same discipline
   * `docs/DECISIONS.md` D-024 records for the reference resolver's own
   * cyclic-case test.
   */
  maxDepth?: number;
  /**
   * Overrides `env.LEOPARD_INDEX_ENABLED === 'true'` for this call only —
   * the exact same "tests use this to force a setting without a global env
   * mutation" precedent `maxDepth` (above) already establishes on this same
   * interface. `docs/LEOPARD-INDEX-PROPOSAL.md` ("The lookup, and the
   * integration point in `resolve()`") — Phase A's index short-circuit
   * (`WalkContext.relationIndexFloor`) is consulted only when this resolves
   * `true` **and** this call is pinned (`atToken !== undefined`); either
   * condition failing leaves `resolve()`'s relation branch byte-identical
   * to today. See `productionCheck`'s own doc comment for exactly how this
   * combines with `env.LEOPARD_INDEX_ENABLED`.
   */
  useRelationIndex?: boolean;
}

// ---------------------------------------------------------------------------
// Resolution-path shapes (§6.7, Phase 6) — the POSITIVE witness tree.
// Field-for-field independent of `src/resolve/reference/resolver.ts`'s own
// shapes of the same name — see this file's own top-of-file doc comment.
// ---------------------------------------------------------------------------

export interface DirectGrantStep {
  kind: 'directGrant';
  object: EntityRef;
  relation: string;
  subject: EntityRef;
}

export interface UsersetMembershipStep {
  kind: 'usersetMembership';
  object: EntityRef;
  relation: string;
  userset: EntityRef;
  usersetRelation: string;
  member: ResolutionStep;
}

export interface UnionStep {
  kind: 'union';
  object: EntityRef;
  branchIndex: number;
  branch: ResolutionStep;
}

export interface IntersectionStep {
  kind: 'intersection';
  object: EntityRef;
  branches: ResolutionStep[];
}

export interface ExclusionStep {
  kind: 'exclusion';
  object: EntityRef;
  base: ResolutionStep;
  subtractDisproof: DisproofStep;
}

export interface TupleToUsersetStep {
  kind: 'tupleToUserset';
  object: EntityRef;
  relation: string;
  computedUserset: string;
  through: EntityRef;
  member: ResolutionStep;
}

export type ResolutionStep =
  | DirectGrantStep
  | UsersetMembershipStep
  | UnionStep
  | IntersectionStep
  | ExclusionStep
  | TupleToUsersetStep;

// ---------------------------------------------------------------------------
// Disproof shapes — the NEGATIVE witness, used only inside an
// `ExclusionStep.subtractDisproof`.
// ---------------------------------------------------------------------------

/** One frontier node's identity in the userset-subject membership graph — matches `sqlRelationMembershipWithWitness`'s own CTE columns. */
export interface RelationClosureKey {
  ns: string;
  id: string;
  relation: string;
}

export type ClosureTuple =
  | { kind: 'plain'; subject: EntityRef }
  | { kind: 'userset'; userset: EntityRef; usersetRelation: string };

/**
 * One node in a reachability certificate: every real tuple stored on it
 * (so a verifier can confirm none is a plain match), its own depth, and
 * its own root-to-here ancestor path (so a verifier can confirm any edge
 * NOT continuing into another certificate node is legitimately excluded by
 * the same depth/cycle rule the SQL recursive CTE itself enforces, per
 * this file's own top-of-file doc comment).
 */
export interface ClosureNode {
  key: RelationClosureKey;
  depth: number;
  ancestorPath: RelationClosureKey[];
  tuples: ClosureTuple[];
}

/** See this file's own top-of-file doc comment for why this is a flat certificate, not a nested tree. */
export interface RelationDisproof {
  kind: 'relationDisproof';
  object: EntityRef;
  relation: string;
  maxDepth: number;
  nodes: ClosureNode[];
}

export interface UnionDisproof {
  kind: 'unionDisproof';
  object: EntityRef;
  branches: DisproofStep[];
}

export interface IntersectionDisproof {
  kind: 'intersectionDisproof';
  object: EntityRef;
  branchIndex: number;
  branch: DisproofStep;
}

/**
 * Either the exclusion's own base is disproven, its own subtract is proven
 * (either genuinely denies it), or — the third, previously-missing case —
 * `subtract` could not be conclusively resolved at all (it hit the TS-level
 * `visited`-Set cycle guard or the depth ceiling somewhere inside it):
 * `subtractUnprovable`.
 *
 * **Why this third case exists — the soundness gap it closes.** Before it
 * existed, `evalRewrite`'s `exclusion` case treated `!subtract.allowed` as
 * "subtract is disproven, so this exclusion holds" unconditionally — but
 * `subtract.allowed === false` is exactly what `resolve`'s own cycle guard
 * (the `visited`-Set check) and the depth ceiling ALSO return the instant
 * they cut a branch off, per this file's own fail-closed convention for
 * every *non-negated* position. Consumed here, inside exclusion's own
 * `NOT`, that fail-closed "can't prove" `false` was silently
 * indistinguishable from a genuine, exhaustively-proven "no" — and `NOT
 * (can't-prove)` is not `true`, even though `NOT false` is. A permission
 * shaped like `view = grant - parent->view` on a self-referencing `parent`
 * (an ordinary hierarchy tuple, nothing exotic — self-referencing `parent`
 * tuples are this DSL's own headline use case) reproduces this concretely:
 * the cycle guard's fail-closed `false` for the unresolvable `parent->view`
 * branch used to flip, via exclusion's own negation, into an unsound
 * `allowed: true` — a real `false_grant`, confirmed live against this exact
 * shape (against the DST in-memory fake, and against the reference
 * resolver independently — both share the identical flaw, which is why
 * differential fuzzing alone could never have caught this) before this fix
 * existed — see the regression test this fix shipped with.
 * `subtractUnprovable` is the distinguishing signal this file's own
 * fail-closed philosophy already uses everywhere else: "cannot prove" now
 * propagates as its own outcome (see `WalkContext`-adjacent
 * `ProductionOutcome`'s own `certain` field below), never silently
 * collapsing into a boolean a negation can flip. It also covers the depth
 * ceiling, not only the cycle guard, for the identical reason (both
 * `reason: 'cycle'` and `reason: 'depth'` hit the exact same `resolve`
 * early-return shape below, so both are covered uniformly, not
 * special-cased apart).
 */
export interface ExclusionDisproof {
  kind: 'exclusionDisproof';
  object: EntityRef;
  reason:
    | { kind: 'baseDisproven'; base: DisproofStep }
    | { kind: 'subtractProven'; subtract: ResolutionStep }
    | { kind: 'subtractUnprovable'; subtract: DisproofStep };
}

export interface TupleToUsersetDisproof {
  kind: 'tupleToUsersetDisproof';
  object: EntityRef;
  relation: string;
  followed: Array<{ through: EntityRef; disproof: DisproofStep }>;
}

/**
 * The TS-level depth ceiling or the TS-level `visited`-Set cycle guard cut
 * this branch off — both are a real, defined "no" for that branch in any
 * *non-negated* position (a plain union/intersection/tupleToUserset branch,
 * or an exclusion's own `base`), but NOT a legitimate disproof of a
 * *negated* one (an exclusion's own `subtract`) — see `ExclusionDisproof`'s
 * own doc comment for the concrete unsoundness this distinction closes, and
 * `ProductionOutcome`'s own `certain` field for the mechanism. Mechanism 2
 * (`sqlRelationMembershipWithWitness`'s own SQL-level path-array cycle
 * guard) never produces this shape at all — its own disproof is always a
 * `RelationDisproof`, never a `BoundReachedDisproof` — see D-026/D-021 for
 * why that mechanism's cycle-pruning is exact/lossless on its own terms.
 * Its own depth ceiling is a separate matter, genuinely out of scope for
 * *this* fix (the cycle-guard fix) at the time it shipped, and disclosed as
 * a residual risk sharing this identical algebraic shape — since closed;
 * see `SqlRelationOutcome`'s own doc comment and `depthCeilingGenuinelyBinding`
 * for how `sqlRelationMembershipWithWitness` now signals a genuinely
 * truncated `false` via its own `certain` field, without ever needing a
 * `BoundReachedDisproof`-shaped leaf of its own.
 */
export interface BoundReachedDisproof {
  kind: 'boundReached';
  object: EntityRef;
  name: string;
  reason: 'cycle' | 'depth';
}

export interface UndeclaredDisproof {
  kind: 'undeclared';
  object: EntityRef;
  name: string;
}

export type DisproofStep =
  | RelationDisproof
  | UnionDisproof
  | IntersectionDisproof
  | ExclusionDisproof
  | TupleToUsersetDisproof
  | BoundReachedDisproof
  | UndeclaredDisproof;

export interface ProductionCheckResult {
  allowed: boolean;
  /** Present if and only if `allowed` is true. */
  path?: ResolutionStep;
  /**
   * Present if and only if `allowed` is false — the mirror image of `path`'s
   * own "present iff relevant" contract. Surfaces `ProductionOutcome.certain`
   * (see that type's own doc comment for the full D-158/D-159/D-160/D-161
   * reasoning) to every application-facing denial, not just to a *containing*
   * exclusion's own internal negation: `true` means this specific check was
   * exhaustively proven false (every branch that could have granted it was
   * actually checked, all the way down); `false` means some branch was cut
   * off by the TS-level `visited`-Set cycle guard, the TS-level depth
   * ceiling, or mechanism 2's own genuinely-binding SQL depth ceiling
   * (`sqlRelationMembershipWithWitness`'s `certain` — see its own doc
   * comment) before it could be fully proven or disproven either way. Full-
   * repo audit finding #6: before this field existed, `certain` was computed
   * correctly (it has to be, for the exclusion/cycle-guard soundness fix
   * itself to work) but silently discarded the moment `resolve`'s top-level
   * outcome reached `productionCheck`'s own final return — an operator
   * looking at a denial in the audit trail had no way to tell a trustworthy,
   * exhaustively-proven "no" from "the walk gave up before it could tell."
   * Purely additive: this field is never consulted by `resolve`/`evalRewrite`
   * themselves and never changes `allowed` — the same "purely additive,
   * never touches the actual decision" discipline this project's audit-trail
   * features have always followed (§6.7, the hash chain, expiring-tuple
   * `touchedExpiringTuple` below).
   */
  certain?: boolean;
  /** The actual maximum recursion depth reached anywhere in this check — see this file's own top-of-file doc comment. */
  depth: number;
  /**
   * D-144 (expiring tuples) — true iff this check's own resolution read at
   * least one LIVE (not currently expired) relation tuple carrying a
   * non-null `expiresAt`, i.e. a tuple with a validity window that could
   * still expire in the future. Deliberately conservative/over-approximate:
   * set whenever any such tuple was read anywhere during the walk
   * (`fetchTuplesOnFrontier` or `listTupleSubjects`), whether or not it
   * ultimately contributed to the final allowed/denied answer — the safe
   * failure direction, matching this project's own established D-149
   * precedent (over-warn rather than under-warn). Consumed by
   * `src/audit/checks.ts`'s `performCheck` to decide whether a result is
   * safe to cache: expiry only ever REMOVES a tuple over time, so a cached
   * `allowed: false` result is always safe to keep serving regardless of
   * this flag, but a cached `allowed: true` result that touched a still-live
   * expiring tuple could go stale-wrong once that tuple's own `expiresAt`
   * passes with no corresponding write event — see that file's own doc
   * comment for the full reasoning.
   */
  touchedExpiringTuple: boolean;
  /**
   * Observability-only addition for Phase 5's Leopard-index third
   * comparison arm (`docs/LEOPARD-INDEX-PROPOSAL.md`, "Test plan — the
   * third comparison arm"; `src/soundness/runner.ts`'s
   * `SoundnessRunOptions.relationIndex`). `true` iff
   * `lookupRelationMembershipIndex` (`src/store/relation-index.ts`) was
   * actually consulted *and returned a hit* anywhere during this check's
   * whole walk; absent (never `false`) otherwise — the same "present iff
   * relevant" convention `path`/`certain` above already use. **Not** the
   * design doc's own literal wording — that document specifies
   * `indexQueriesHit` as a `SoundnessRunResult`-level counter but never
   * states how the fuzz harness is meant to observe, per query, whether a
   * given `productionCheck` call actually hit the index; this field is the
   * minimal, additive mechanism that makes that observable. Never consulted
   * by `resolve`/`evalRewrite` themselves, never changes `allowed`, and
   * deliberately NOT the same thing as "the overall answer came from the
   * index": a relation branch nested inside an exclusion's own `subtract`
   * can hit the index and still leave the *overall* check `allowed: false`
   * (the exclusion denies), so this is tracked independently of the
   * top-level `allowed` value, mirroring `touchedExpiringTuple`'s own
   * whole-walk, not just-the-winning-path, semantics.
   */
  indexHit?: boolean;
}

/**
 * `{ allowed: true; certain: true; proof }` or `{ allowed: false; certain;
 * disproof }` — the one return shape every recursive step below produces.
 *
 * **`certain` — the fix for the exclusion/cycle-guard soundness gap (see
 * `ExclusionDisproof`'s own doc comment for the concrete bug).** `true` for
 * every `allowed: true` outcome, by construction, everywhere in this file
 * (a positive result is only ever produced from a real, verified fact — a
 * SQL-witnessed grant, or every child of a combinator *also* being
 * certainly true — never from an unresolved branch) — a load-bearing
 * invariant every combinator below maintains, not merely a convention. For
 * `allowed: false`, `certain: true` means "exhaustively proven false"
 * (every branch that could have made this true was checked and
 * definitively didn't, including mechanism 2's own SQL-side relation scan —
 * see below); `certain: false` means "the TS-level `visited`-Set cycle
 * guard or the TS-level depth ceiling cut this subtree off, without ever
 * fully proving or disproving it." The distinction is inert everywhere
 * `false` is already the conservative, fail-closed answer (union,
 * intersection, tupleToUserset, an exclusion's own `base`) — it only
 * changes behavior at the ONE place a `false` gets negated:
 * `evalRewrite`'s `exclusion` case, where `subtract.certain === false`
 * must NOT be treated as "subtract disproven, so the exclusion holds"
 * (exactly the unsound flip this fix closes) but as its own outcome,
 * `subtractUnprovable` — the exclusion itself resolves `allowed: false,
 * certain: false`, propagating the same "cannot prove" signal transitively
 * to whatever combinator consumes it next, exactly like the cycle guard's
 * own signal already does everywhere else in this file.
 *
 * **Mechanism 2 (`sqlRelationMembershipWithWitness`) — the identical
 * `certain` reasoning now applies here too, closing a residual risk this
 * file's own D-158 fix originally disclosed but did not fix.** Its own
 * SQL-level path-array cycle guard is exact/lossless (D-021/D-026: pruning
 * an already-visited identity can never drop real reachability, so
 * exhausting the frontier *via cycle-pruning alone* is a genuine, complete
 * proof of absence) — no taint needed there, and none is applied. Its own
 * depth ceiling, however, is exactly as capable of truncating before a real
 * match is found as mechanism 1's TS-level ceiling always was — confirmed
 * live: an exclusion whose `subtract` is a plain relation with a real,
 * tuple-reachable userset-membership chain deeper than the effective
 * budget reproduced a real, live `false_grant` before this fix (subject
 * genuinely IS a member of `subtract`, just beyond the SQL frontier scan's
 * own truncated depth, which used to be unconditionally reported
 * `certain: true`). `depthCeilingGenuinelyBinding` (below
 * `SqlRelationOutcome`) now distinguishes "the frontier scan's own depth
 * ceiling was never actually reached, or was reached but had nothing real
 * left to explore" (still `certain: true`) from "the ceiling cut off a
 * real, unread edge" (`certain: false`) — cheaply, from data
 * `sqlRelationMembershipWithWitness` already fetches for the disproof
 * certificate itself, no new query. See that function's own doc comment
 * for the full reasoning and `test/unit/resolve/production/mechanism-2-
 * exclusion-depth-ceiling.integration.test.ts` for the live regression this
 * fix shipped with.
 */
type ProductionOutcome =
  | { allowed: true; certain: true; proof: ResolutionStep }
  | { allowed: false; certain: boolean; disproof: DisproofStep };

/**
 * Per-check-call state threaded through the recursive walk. `schemaCache`
 * exists purely to avoid re-querying `namespace_configs` for a namespace
 * this same check has already looked up (e.g. `folder`'s `parent->view`
 * revisiting `folder` itself at every hop of a parent chain) — it is
 * rebuilt fresh on every `productionCheck` call, never shared or reused
 * across calls, so it cannot become a correctness-relevant cache (see
 * build spec §6.1: "there is no cached, precomputed ... permission
 * anywhere that isn't provably derivable from current tuples on demand").
 *
 * `depthReached` is a single mutable high-water mark for the whole check —
 * both the TypeScript-level `depth` counter (updated at every `resolve`
 * entry) and every SQL-level recursive CTE's own reached depth (folded in
 * right after each `sqlRelationMembershipWithWitness` call returns) — so
 * `productionCheck`'s returned `depth` reflects the deepest point *either*
 * mechanism actually reached, not just whichever one happened to run last.
 *
 * `client` is the *only* connection this whole check ever needs — every
 * read (`relation_tuples`/`write_log` via `sqlRelationMembershipWithWitness`/
 * `listTupleSubjects`, and, as of this fix, `namespace_configs` via
 * `getConfig` below too) runs on this one pinned `REPEATABLE READ` client.
 * A separate `pool` field used to live here for `getConfig` alone — see
 * `productionCheck`'s own doc comment for why that was a real,
 * production-reachable connection-exhaustion deadlock, not just a
 * theoretical one, and why removing it (one connection per check, never
 * two) is the fix, not a workaround.
 */
interface WalkContext {
  client: QueryExecutor;
  maxDepth: number;
  schemaCache: Map<string, NamespaceConfig | null>;
  depthReached: { value: number };
  /**
   * D-144 (expiring tuples) — a single mutable high-water-mark flag for the
   * whole check, mirroring `depthReached`'s own shape exactly: true the
   * moment ANY read anywhere in this check (either mechanism —
   * `sqlRelationMembershipWithWitness` via `fetchTuplesOnFrontier`, or
   * `listTupleSubjects`'s own tuple-to-userset hop) returns a live tuple
   * carrying a non-null `expires_at`, whether or not that specific tuple
   * ended up on the winning proof/disproof path. `ProductionCheckResult
   * .touchedExpiringTuple`'s own doc comment states why this deliberate
   * over-approximation is the safe direction.
   */
  touchedExpiringTuple: { value: boolean };
  /**
   * Observability-only mutable high-water-mark flag, mirroring
   * `touchedExpiringTuple`'s own shape exactly: `true` the moment the
   * Leopard-index short-circuit below (`ctx.relationIndexFloor !==
   * undefined` branch) actually returns a hit anywhere in this check's
   * whole walk, whether or not that hit ended up on the branch that decided
   * the overall `allowed`/`denied` outcome. See `ProductionCheckResult
   * .indexHit`'s own doc comment for why this is tracked independently of
   * the top-level `allowed` value, and for why this field exists at all
   * (Phase 5's Leopard-index third comparison arm needs a per-check way to
   * observe whether the index was actually consulted-and-hit; nothing in
   * `docs/LEOPARD-INDEX-PROPOSAL.md` itself specifies this mechanism).
   */
  indexHit: { value: boolean };
  /**
   * Phase A of `docs/LEOPARD-INDEX-PROPOSAL.md` — a straight passthrough of
   * `productionCheck`'s own `atToken`, populated exactly once when
   * constructing `ctx`, the same way `maxDepth` itself is already threaded
   * onto this type. `undefined` whenever this specific check is unpinned
   * (`atToken === undefined`) OR the feature is off (`useRelationIndex` /
   * `env.LEOPARD_INDEX_ENABLED` resolves falsy) — in either case,
   * `resolve()`'s relation branch never even attempts the index
   * short-circuit, and behavior is byte-identical to before this field
   * existed. When present, it is the floor
   * `lookupRelationMembershipIndex` requires `relation_membership_index_
   * state.watermark_token` to have reached before an index hit may ever be
   * trusted for this check (Candidate C, `docs/LEOPARD-INDEX-PROPOSAL.md`).
   * Never a new query, never a re-derived value — see `productionCheck`'s
   * own doc comment for exactly how this is computed.
   */
  relationIndexFloor?: number;
}

async function getConfig(ctx: WalkContext, ns: string): Promise<NamespaceConfig | null> {
  const cached = ctx.schemaCache.get(ns);
  if (cached !== undefined) return cached;
  const config = await getLatestNamespaceConfig(ctx.client, ns);
  const resolved = config ?? null;
  ctx.schemaCache.set(ns, resolved);
  return resolved;
}

/**
 * Branch-local cycle-detection key: `(namespace, id, relation-or-
 * permission-name)`, joined with `:`/`#` — separators that can never
 * appear in a real identifier (`IDENTIFIER_PATTERN` in
 * `src/schema/dsl/types.ts` only allows `[a-z][a-z0-9_]*`), so this can
 * never collide by accident.
 */
function entityNameKey(object: EntityRef, name: string): string {
  return `${object.ns}:${object.id}#${name}`;
}

/**
 * The single recursion unit both userset mechanisms funnel through:
 * "is `subject` related to `object` via `name` (a relation or a
 * permission)?" Cycle detection and the depth ceiling both live here, at
 * the one place every re-entry into a name (whether same-object
 * permission indirection or a cross-object hop via tuple-to-userset)
 * passes through — mirroring, independently, the same shape of guarantee
 * §6.4 requires of the reference resolver, not shared code with it.
 *
 * - `depth` counts "how many times has this walk re-entered a name" —
 *   incremented once per recursive descent into a permission's rewrite
 *   tree (see the `permission` branch below); `union`/`intersection`/
 *   `exclusion` combinator nodes do not bump it themselves (`evalRewrite`
 *   just forwards the depth it was given to each child) — a schema
 *   author's choice of how many `|`/`&`/`-` operators to chain is a
 *   static, compiler-verified-acyclic AST shape (see
 *   `src/schema/dsl/compiler.ts`'s `checkCircularPermissions`), not the
 *   *data*-driven recursion this ceiling exists to bound.
 * - `visited` is the current root-to-node path's set of
 *   `entityNameKey`s, added on entry and removed via `finally` right
 *   before this call returns — a hit means the current branch has looped
 *   back to a name it's already in the middle of resolving, which can
 *   only happen via tuple-data-driven recursion (tuple-to-userset
 *   crossing back to an ancestor object, or a same-object permission
 *   re-entered — the compiler already forbids a *static* permission
 *   cycle, so in practice this guards the tuple-to-userset case). Because
 *   this whole walk is strictly sequential (every `for` loop below
 *   `await`s one child before starting the next — never `Promise.all`),
 *   one mutable `Set` shared across sibling branches is safe: a sibling
 *   only ever sees the keys still on the *current* path, since each
 *   completed branch removes its own entries before the next sibling
 *   starts.
 * - When `name` is a storable **relation**, the entire remaining question
 *   — direct grant or arbitrarily-nested userset membership — is handed
 *   off whole to `sqlRelationMembershipWithWitness`, which is self-
 *   contained and cycle-safe on its own (its own path-array-based cycle
 *   guard, its own depth cap). This function's own `visited`/`depth`
 *   bookkeeping still applies to the *entry* into that relation check, but
 *   the recursion inside the userset-subject graph never comes back
 *   through this function — it's a different (SQL-level) recursion
 *   entirely.
 */
async function resolve(
  ctx: WalkContext,
  subject: EntityRef,
  object: EntityRef,
  name: string,
  visited: Set<string>,
  depth: number,
): Promise<ProductionOutcome> {
  ctx.depthReached.value = Math.max(ctx.depthReached.value, depth);
  // `certain: false` — see `ProductionOutcome`'s own doc comment: this is a
  // truncation, not a proof, and must not be silently treated as one by a
  // containing exclusion's own `NOT`.
  if (depth > ctx.maxDepth) {
    return {
      allowed: false,
      certain: false,
      disproof: { kind: 'boundReached', object, name, reason: 'depth' },
    };
  }

  const key = entityNameKey(object, name);
  if (visited.has(key)) {
    // `certain: false` — same reasoning as the depth backstop above.
    return {
      allowed: false,
      certain: false,
      disproof: { kind: 'boundReached', object, name, reason: 'cycle' },
    };
  }
  visited.add(key);
  try {
    const config = await getConfig(ctx, object.ns);
    if (!config) {
      return { allowed: false, certain: true, disproof: { kind: 'undeclared', object, name } };
    }

    const relation = config.relations[name];
    if (relation) {
      const remainingDepth = Math.max(0, ctx.maxDepth - depth);

      // Phase A Leopard-index short-circuit (`docs/LEOPARD-INDEX-
      // PROPOSAL.md`, "The lookup, and the integration point in
      // `resolve()`"). `ctx.relationIndexFloor` is `undefined` whenever this
      // check is unpinned or the feature is off; in either case this whole
      // block is skipped and behavior below is byte-identical to before
      // this feature existed.
      if (ctx.relationIndexFloor !== undefined) {
        // A thrown exception here — a transient error scoped to the two new
        // tables, lock contention with a concurrent `authz leopard
        // refresh`'s own TRUNCATE, or a malformed row reaching
        // `reconstructProof` — must never fail the whole check: a miss, for
        // any reason at all, falls through unconditionally to the
        // unmodified `sqlRelationMembershipWithWitness` call below. This
        // `try`/`catch` is the disclosed fix for the proposal's own first
        // draft, which had no such boundary (an uncaught throw here would
        // propagate straight through `resolve()`/`evalRewrite()` and fail a
        // check the live CTE alone would have answered correctly — strictly
        // worse than the feature being off).
        //
        // **A second, more subtle gap in that same "falls through
        // unconditionally" claim, found live and closed here — not merely
        // catching the exception is not enough.** Postgres poisons an
        // *entire* transaction the instant any statement inside it errors:
        // every subsequent statement on this same connection fails with
        // "current transaction is aborted, commands ignored until end of
        // transaction block," until a `ROLLBACK` (whole transaction) or a
        // `ROLLBACK TO SAVEPOINT` restores it. Confirmed live: a real
        // `lock_timeout` racing a concurrent rebuild's own `TRUNCATE` (an
        // ordinary hardening config, not an exotic one) makes
        // `lookupRelationMembershipIndex`'s own SELECT fail — the `catch`
        // below correctly swallows *that* error, but without the
        // `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair here, the immediately
        // following `sqlRelationMembershipWithWitness` call — on the same,
        // now-poisoned connection — would itself throw a *second*, uncaught
        // "transaction is aborted" error, propagating straight through and
        // failing the whole check exactly as if this boundary didn't exist
        // at all. A `SAVEPOINT` (Postgres's own standard mechanism for
        // "try a statement, and if it errors, un-poison the transaction
        // without a second connection") is genuinely new to this codebase —
        // `grep -rn "SAVEPOINT" src/` returns nothing before this fix —
        // disclosed the same way `pg_try_advisory_xact_lock`'s own novelty
        // already is above.
        let idx: RelationIndexLookup;
        await ctx.client.query('SAVEPOINT leopard_lookup');
        try {
          idx = await lookupRelationMembershipIndex(
            ctx.client,
            object,
            name,
            subject,
            remainingDepth,
            ctx.relationIndexFloor,
          );
          await ctx.client.query('RELEASE SAVEPOINT leopard_lookup');
        } catch {
          // Restores this connection's transaction to the state it was in
          // right before the lookup — the fallback call below now runs on
          // a genuinely healthy connection, not a poisoned one.
          await ctx.client.query('ROLLBACK TO SAVEPOINT leopard_lookup');
          await ctx.client.query('RELEASE SAVEPOINT leopard_lookup');
          idx = { hit: false }; // logged/counted elsewhere, never re-thrown
        }
        if (idx.hit) {
          ctx.depthReached.value = Math.max(ctx.depthReached.value, idx.path.length - 1);
          ctx.touchedExpiringTuple.value ||= idx.touchedExpiringTuple;
          ctx.indexHit.value = true;
          return { allowed: true, certain: true, proof: reconstructProof(idx.path, subject) };
        }
        // miss, for any reason at all — fall through, unconditionally.
      }

      const sqlOutcome = await sqlRelationMembershipWithWitness(
        ctx.client,
        object,
        name,
        subject,
        remainingDepth,
      );
      ctx.depthReached.value = Math.max(ctx.depthReached.value, sqlOutcome.depthReached);
      ctx.touchedExpiringTuple.value ||= sqlOutcome.touchedExpiringTuple;
      // `sqlOutcome.certain` — see `SqlRelationOutcome`'s own doc comment
      // for why mechanism 2's own `false` is no longer unconditionally
      // reported certain (the D-158 residual risk this closes).
      return sqlOutcome.allowed
        ? { allowed: true, certain: true, proof: sqlOutcome.proof }
        : { allowed: false, certain: sqlOutcome.certain, disproof: sqlOutcome.disproof };
    }

    const permission = config.permissions[name];
    if (permission) {
      return await evalRewrite(ctx, permission.rewrite, subject, object, visited, depth + 1);
    }

    // Undeclared relation/permission name — fail closed, never throw.
    return { allowed: false, certain: true, disproof: { kind: 'undeclared', object, name } };
  } finally {
    visited.delete(key);
  }
}

/** Exhaustiveness guard — independently duplicated, not imported from
 * `src/schema/dsl/compiler.ts`'s identical pattern, per the same reasoning
 * `docs/DECISIONS.md` D-022 records for the reference resolver. */
function assertNeverRewriteRule(node: never): never {
  throw new Error(`unreachable rewrite-rule kind: ${JSON.stringify(node)}`);
}

async function evalRewrite(
  ctx: WalkContext,
  rule: RewriteRule,
  subject: EntityRef,
  object: EntityRef,
  visited: Set<string>,
  depth: number,
): Promise<ProductionOutcome> {
  switch (rule.kind) {
    case 'computedUserset': {
      return resolve(ctx, subject, object, rule.name, visited, depth);
    }
    case 'union': {
      const disproofs: DisproofStep[] = [];
      // See `ProductionOutcome`'s own doc comment — union is a plain
      // (non-negated) OR, so `false` here is certain only if every branch
      // consulted was itself certain; one cycle/depth-cut branch taints the
      // whole union's own "no" without changing the "no" itself.
      let allCertain = true;
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        if (child === undefined) continue; // unreachable given the loop bound
        const outcome = await evalRewrite(ctx, child, subject, object, visited, depth);
        if (outcome.allowed) {
          return {
            allowed: true,
            certain: true,
            proof: { kind: 'union', object, branchIndex: i, branch: outcome.proof },
          };
        }
        allCertain &&= outcome.certain;
        disproofs.push(outcome.disproof);
      }
      return {
        allowed: false,
        certain: allCertain,
        disproof: { kind: 'unionDisproof', object, branches: disproofs },
      };
    }
    case 'intersection': {
      const proofs: ResolutionStep[] = [];
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        if (child === undefined) continue; // unreachable given the loop bound
        const outcome = await evalRewrite(ctx, child, subject, object, visited, depth);
        if (!outcome.allowed) {
          // Kleene AND: a `false` branch makes the whole intersection
          // `false` regardless of any other (possibly still-unevaluated)
          // branch's own value — so this short-circuit is exact, and the
          // stopping branch's own `certain` flag is exactly the
          // intersection's own.
          return {
            allowed: false,
            certain: outcome.certain,
            disproof: {
              kind: 'intersectionDisproof',
              object,
              branchIndex: i,
              branch: outcome.disproof,
            },
          };
        }
        proofs.push(outcome.proof);
      }
      return {
        allowed: true,
        certain: true,
        proof: { kind: 'intersection', object, branches: proofs },
      };
    }
    case 'exclusion': {
      const base = await evalRewrite(ctx, rule.base, subject, object, visited, depth);
      if (!base.allowed) {
        // Short-circuit unchanged from before this fix — `NOT` never sits
        // between `base` and the top here, so a `base` that's `false`
        // (certain OR merely cut-off/uncertain) safely makes the whole
        // exclusion `false` either way (Kleene AND: `false` dominates
        // regardless of the other, unevaluated operand's own value) —
        // `certain` is simply carried forward unchanged, never re-derived.
        return {
          allowed: false,
          certain: base.certain,
          disproof: {
            kind: 'exclusionDisproof',
            object,
            reason: { kind: 'baseDisproven', base: base.disproof },
          },
        };
      }
      const subtract = await evalRewrite(ctx, rule.subtract, subject, object, visited, depth);
      if (subtract.allowed) {
        return {
          allowed: false,
          certain: true,
          disproof: {
            kind: 'exclusionDisproof',
            object,
            reason: { kind: 'subtractProven', subtract: subtract.proof },
          },
        };
      }
      // *** The fix for the exclusion/cycle-guard soundness gap. ***
      // `subtract.allowed === false` alone is NOT sufficient to conclude
      // "subtract disproven, so this exclusion holds" — that reasoning is
      // exactly what let a cycle-guard (or depth-ceiling) hit inside
      // `subtract` flip, via this very `NOT`, into an unsound `allowed:
      // true`. Only a *certain* `false` (an exhaustive disproof) may be
      // treated as "not excluded." An *uncertain* one propagates its own
      // "cannot prove" signal instead — this exclusion itself resolves
      // `allowed: false, certain: false`, denying it (fail-closed, matching
      // this file's own convention everywhere else) while still letting
      // any FURTHER containing exclusion see that this "no" is not safe to
      // negate either. See `ExclusionDisproof`'s own doc comment for the
      // concrete reproduction this closes.
      if (!subtract.certain) {
        return {
          allowed: false,
          certain: false,
          disproof: {
            kind: 'exclusionDisproof',
            object,
            reason: { kind: 'subtractUnprovable', subtract: subtract.disproof },
          },
        };
      }
      return {
        allowed: true,
        certain: true,
        proof: { kind: 'exclusion', object, base: base.proof, subtractDisproof: subtract.disproof },
      };
    }
    case 'tupleToUserset': {
      const { subjects, touchedExpiringTuple } = await listTupleSubjects(
        ctx.client,
        object,
        rule.relation,
      );
      ctx.touchedExpiringTuple.value ||= touchedExpiringTuple;
      const followed: Array<{ through: EntityRef; disproof: DisproofStep }> = [];
      // Same "union over every followed tuple" shape as `evalRewrite`'s own
      // `union` case above — see `ProductionOutcome`'s own doc comment.
      let allCertain = true;
      for (const newObject of subjects) {
        const outcome = await resolve(
          ctx,
          subject,
          newObject,
          rule.computedUserset,
          visited,
          depth,
        );
        if (outcome.allowed) {
          return {
            allowed: true,
            certain: true,
            proof: {
              kind: 'tupleToUserset',
              object,
              relation: rule.relation,
              computedUserset: rule.computedUserset,
              through: newObject,
              member: outcome.proof,
            },
          };
        }
        allCertain &&= outcome.certain;
        followed.push({ through: newObject, disproof: outcome.disproof });
      }
      return {
        allowed: false,
        certain: allCertain,
        disproof: { kind: 'tupleToUsersetDisproof', object, relation: rule.relation, followed },
      };
    }
    default:
      return assertNeverRewriteRule(rule);
  }
}

interface TupleSubjectRow {
  subject_ns: string;
  subject_id: string;
  /** See `FrontierTupleRow.expires_at`'s own doc comment — the identical D-144 liveness/touch-tracking convention, applied to this file's other real-tuple read. */
  expires_at: Date | null;
}

/**
 * Every stored subject of `(object, relation)`, treating each tuple's
 * subject as a new object reference — the tuple-to-userset hop itself
 * ("follow `parent`, then recurse `view` on whatever it points to"). Per
 * `src/schema/dsl/types.ts`'s own contract, `relation` here always names an
 * actual storable relation (the compiler rejects a `tupleToUserset` whose
 * `relation` names a permission), so no schema check is needed before this
 * query — only whether `object`'s namespace declares it at all, which
 * `resolve` already established by the time `evalRewrite` reaches this
 * branch (the *followed* relation's own row may not even exist on this
 * object if there are simply no tuples for it, which is not an error —
 * zero rows here just means zero branches to recurse into, i.e. this
 * `tupleToUserset` rule contributes nothing, same as any other empty
 * union branch).
 *
 * Deliberately ignores `subject_relation` on the followed-relation tuples
 * themselves — tuple-to-userset's own semantics only care about *where the
 * edge points* (the tuple's `subject_ns`/`subject_id`), never about
 * whether that pointer happens to also be a userset reference; membership
 * *within* whatever it points to is a separate question, resolved by
 * recursing `computedUserset` on the new object.
 *
 * Takes `client` (this check's own `REPEATABLE READ`-pinned connection),
 * never `pool` — full-repo audit finding #1, `docs/DECISIONS.md` D-092.
 * This is exactly the kind of `relation_tuples` read that fix exists for:
 * without it, a `tupleToUserset` hop's own subject list could be read from
 * a different real moment in the database's history than the frontier
 * queries `sqlRelationMembershipWithWitness` issues later in the very same
 * check.
 *
 * Expiring tuples (D-144): the `where` clause's `expires_at is null or
 * expires_at > now()` excludes an expired tuple-to-userset link exactly as
 * if it had already been deleted — a `parent`-style relation that has
 * timed out is simply never followed. Unlike `fetchTuplesOnFrontier`'s own
 * read (mechanism 2), this is a wholly separate mechanism (mechanism 1)
 * with no other query that would otherwise catch an expiring hop here, so
 * this function reports its own `touchedExpiringTuple` back to its caller
 * directly rather than relying on some other read to cover it.
 */
async function listTupleSubjects(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
): Promise<{ subjects: EntityRef[]; touchedExpiringTuple: boolean }> {
  const { rows } = await client.query<TupleSubjectRow>(
    `select subject_ns, subject_id, expires_at
     from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3
       and (expires_at is null or expires_at > now())`,
    [object.ns, object.id, relation],
  );
  return {
    subjects: rows.map((row) => ({ ns: row.subject_ns, id: row.subject_id })),
    touchedExpiringTuple: rows.some((row) => row.expires_at !== null),
  };
}

// ---------------------------------------------------------------------------
// Mechanism 2 — relation-membership, with the full positive/negative
// witness reconstruction (Phase 6). See this file's own top-of-file doc
// comment for why the disproof shape is a flat certificate.
// ---------------------------------------------------------------------------

/**
 * Exported (not module-private, despite `sqlRelationMembershipWithWitness`
 * being this shape's only in-file consumer) for exactly one reason,
 * matching `src/store/tuples.ts`'s own `WRITE_LOG_LOCK_CLASSID` precedent:
 * DST D3's own differential-equivalence suite (`docs/DECISIONS.md` D-100)
 * needs to call the *real* `fetchReachableFrontier` directly against real
 * Postgres and compare its output row-for-row against the in-memory
 * `fetchReachableFrontierVia` — exporting the real function and its real
 * row shape means that suite exercises the actual production query, not a
 * hand-copied SQL string that could silently drift out of sync with this
 * file on a future edit.
 */
export interface FrontierRow {
  ns: string;
  id: string;
  relation: string;
  depth: number;
  path: string[];
}

/**
 * Every frontier node reached while transitively following userset-subject
 * tuples from `(object, relation)` — the *entire* recursive CTE's own
 * output, not just whether a match exists. Cycle safety is identical to
 * the boolean-only query this replaces (see `docs/DECISIONS.md` D-026):
 * the `path` column excludes a row the instant its own key would repeat
 * one already on that branch, and `depth < maxDepth` is an independent
 * backstop. The seed row (`depth = 0`, the starting `(object, relation)`
 * itself) is always present, even with zero recursion.
 *
 * Takes `client` (this check's own `REPEATABLE READ`-pinned connection),
 * never `pool` — full-repo audit finding #1, `docs/DECISIONS.md` D-092. See
 * `productionCheck`'s own doc comment for the transaction this runs inside.
 *
 * **Per-iteration dedup (full-repo audit finding #2, `docs/DECISIONS.md`
 * D-092).** The recursive term's `select` is `distinct on (subject_ns,
 * subject_id, subject_relation)`, not a plain `select` — Postgres allows
 * `DISTINCT ON` directly in a recursive term (confirmed against real
 * Postgres 16; only `ORDER BY`/`LIMIT`/`OFFSET`/aggregates/window
 * functions are rejected there, and this doesn't need any of those to
 * still be correct — see the paragraph below). Without it, a node reached
 * via K different upstream paths in one iteration has *all* of its
 * outgoing edges independently re-expanded K times in the next iteration —
 * ordinary `WITH RECURSIVE` semantics, and exactly what a "diamond of
 * diamonds" reconvergent group hierarchy (expected per D-021, and the
 * normal shape of a real nested-group tree) produces: `b^d` rows for only
 * `b*d` distinct nodes. Confirmed directly against real Postgres before
 * this fix landed: a 12-level, branching-3 chain of reconvergent diamonds
 * (well within the default `CHECK_MAX_DEPTH` of 25) never returned within
 * a 20-second timeout on the unfixed query; the identical query, with only
 * this `distinct on` added, returns in under 100ms. See
 * `cross-resolver-agreement.integration.test.ts`'s own
 * "a subject_relation-based ... reconvergent diamond" test for the
 * committed regression/performance guard.
 *
 * **Why this can't silently drop real reachability (the thing to be most
 * careful about here, per the finding's own instruction).** `DISTINCT ON`
 * only collapses *duplicate, same-iteration* rows for one identity down to
 * one representative row — it never prevents a *genuinely new* identity
 * from being discovered. The concern worth naming explicitly: could
 * collapsing to one representative path for a node cause its cycle guard
 * (`not (... = any(m.path))`) to block a child identity that a *different*
 * (discarded) duplicate's path wouldn't have blocked? No — any identity
 * that could ever appear in a chosen representative's own `path` array
 * must, by construction, have already been added to the frontier as its
 * *own* row at an earlier (or the same) iteration — appearing in someone's
 * ancestor list is only possible by having been discovered first. So that
 * identity's own children were already (or will still be) explored via its
 * own frontier entry, independent of whatever a *different* node's
 * dedup-selected representative does later. This was additionally verified
 * empirically, not just argued: a throwaway differential fuzz script (not
 * committed — the reasoning above and this file's own regression test are
 * the durable artifacts) generated 3,000 random cyclic/reconvergent graphs
 * (6–25 nodes, out-degree 0–5) and compared the *set* of reachable
 * `(ns,id,relation)` identities returned by this query with and without the
 * `distinct on` — zero mismatches. Note this dedups *within* one
 * iteration only, not globally across every iteration a node could ever
 * reappear at (a true global "visited" set isn't expressible in a
 * standard-conforming Postgres recursive CTE without violating its "the
 * recursive table may be referenced only once" restriction); a node
 * rediscovered at a much later, unrelated depth can still appear more than
 * once in this function's raw output, which `dedupeFrontier` immediately
 * below already existed to collapse for correctness (not performance)
 * before this fix, and still does.
 *
 * **`depth`/`ancestorPath` note:** because `DISTINCT ON` (with no `ORDER
 * BY` — Postgres rejects `ORDER BY` in a recursive term outright) picks an
 * unspecified representative among same-iteration duplicates, the specific
 * `depth`/`path` kept for a node that had multiple same-iteration parents
 * is real (a genuine root-to-node walk through real tuples — never
 * fabricated) but not guaranteed to be the *shortest* available one. This
 * is a deliberate, disclosed trade of a small amount of diagnostic
 * precision (`checks.depth`'s high-water mark, §6.7) for eliminating the
 * exponential blowup — it does not affect `allowed`/`denied` correctness,
 * per the reachability argument above.
 *
 * Exported — see `FrontierRow`'s own doc comment for why (DST D3's
 * differential-equivalence suite, `docs/DECISIONS.md` D-100, calls this
 * real function directly against a real Postgres testcontainer).
 *
 * **Expiring tuples (D-144).** The recursive term's own `where` clause
 * excludes an expired edge tuple (`rt.expires_at is null or rt.expires_at >
 * now()`) exactly as if it had already been deleted — an expired userset
 * link is simply never traversed. Deliberately not reflected in `FrontierRow`
 * itself (no new column here): `fetchTuplesOnFrontier`'s own result set
 * already re-reads every real tuple on every node this function reaches,
 * `subject_relation` set or not, which is a strict superset of the edges
 * this function's own traversal consumed — see that function's own doc
 * comment for why `touchedExpiringTuple` tracking lives there instead,
 * keeping `FrontierRow`'s shape (and DST's differential-equivalence
 * comparison against it) completely unaffected by this feature.
 */
export async function fetchReachableFrontier(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
  maxDepth: number,
): Promise<FrontierRow[]> {
  const { rows } = await client.query<FrontierRow>(
    `with recursive membership(ns, id, relation, depth, path) as (
       select
         $1::text as ns,
         $2::text as id,
         $3::text as relation,
         0 as depth,
         array[$1::text || ':' || $2::text || '#' || $3::text] as path
       union all
       select distinct on (rt.subject_ns, rt.subject_id, rt.subject_relation)
         rt.subject_ns,
         rt.subject_id,
         rt.subject_relation,
         m.depth + 1,
         m.path || (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation)
       from relation_tuples rt
       join membership m
         on rt.object_ns = m.ns and rt.object_id = m.id and rt.relation = m.relation
       where rt.subject_relation is not null
         and (rt.expires_at is null or rt.expires_at > now())
         and m.depth < $4
         and not (
           (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation) = any (m.path)
         )
     )
     select ns, id, relation, depth, path from membership`,
    [object.ns, object.id, relation, maxDepth],
  );
  return rows;
}

function frontierKeyStr(row: Pick<FrontierRow, 'ns' | 'id' | 'relation'>): string {
  return `${row.ns}:${row.id}#${row.relation}`;
}

/** Dedupes reached frontier rows by identity, keeping the minimum-depth occurrence of each (deterministic, arbitrary tie-break otherwise). Exported alongside `FrontierRow`/`fetchReachableFrontier` — see `FrontierRow`'s own doc comment for why (DST D3's differential-equivalence suite applies this identical dedup to both the real and in-memory frontier outputs before comparing them). */
export function dedupeFrontier(rows: readonly FrontierRow[]): Map<string, FrontierRow> {
  const byKey = new Map<string, FrontierRow>();
  for (const row of rows) {
    const key = frontierKeyStr(row);
    const existing = byKey.get(key);
    if (!existing || row.depth < existing.depth) byKey.set(key, row);
  }
  return byKey;
}

interface FrontierTupleRow {
  object_ns: string;
  object_id: string;
  relation: string;
  subject_ns: string;
  subject_id: string;
  subject_relation: string | null;
  /**
   * Non-null iff this real, stored tuple carries a validity window (D-144).
   * Every row returned here has already passed the liveness filter in this
   * function's own SQL (see `fetchTuplesOnFrontier`'s doc comment) — a
   * non-null value here means "live right now, but not forever," never
   * "expired." `productionCheck` folds this into `touchedExpiringTuple`
   * (see `ProductionCheckResult`'s own doc comment) precisely because this
   * function's result set already covers every tuple `fetchReachableFrontier`
   * itself traversed as an edge (any tuple stored on a reached frontier
   * node, `subject_relation` set or not) as well as every plain-grant
   * candidate — so checking expiry here alone is sufficient without also
   * threading it through `FrontierRow` itself.
   */
  expires_at: Date | null;
}

/**
 * Every real `relation_tuples` row stored on any of `frontier`'s nodes, in
 * one query. Takes `client` (this check's own `REPEATABLE READ`-pinned
 * connection), never `pool` — the exact query pair (this one, and the
 * `fetchReachableFrontier` call that produced `frontier`) full-repo audit
 * finding #1's concrete counterexample was about: without a shared
 * snapshot, a userset edge this function's caller already saw could be
 * deleted, and its target independently (re)granted, between these two
 * queries — see `docs/DECISIONS.md` D-092 and `productionCheck`'s own doc
 * comment for the transaction this now runs inside.
 *
 * **Expiring tuples (D-144).** `where rt.expires_at is null or rt.expires_at
 * > now()` excludes an expired tuple exactly as if it had already been
 * deleted — real Postgres's `now()` is fixed at this transaction's own start
 * (the same `REPEATABLE READ` anchoring `assertTokenObservedOnSnapshot`'s
 * own doc comment already relies on for the token floor check), so every
 * read inside one check agrees on the same instant, never drifting mid-walk.
 * This is the ONE place in this mechanism expiry is filtered — deliberately
 * not also duplicated into `fetchReachableFrontier`'s own frontier-discovery
 * query, since this query's own frontier-unnest join already re-reads every
 * real tuple stored on every reached node (`subject_relation` set or not),
 * a strict superset of the edge tuples that query traversed to reach those
 * nodes in the first place — see `FrontierTupleRow.expires_at`'s own doc
 * comment for why checking expiry here alone is sufficient.
 */
async function fetchTuplesOnFrontier(
  client: QueryExecutor,
  frontier: ReadonlyMap<string, FrontierRow>,
): Promise<FrontierTupleRow[]> {
  if (frontier.size === 0) return [];
  const nsArr: string[] = [];
  const idArr: string[] = [];
  const relArr: string[] = [];
  for (const row of frontier.values()) {
    nsArr.push(row.ns);
    idArr.push(row.id);
    relArr.push(row.relation);
  }
  const { rows } = await client.query<FrontierTupleRow>(
    `select rt.object_ns, rt.object_id, rt.relation, rt.subject_ns, rt.subject_id, rt.subject_relation, rt.expires_at
     from relation_tuples rt
     join (
       select unnest($1::text[]) as ns, unnest($2::text[]) as id, unnest($3::text[]) as relation
     ) as frontier
       on rt.object_ns = frontier.ns and rt.object_id = frontier.id and rt.relation = frontier.relation
     where rt.expires_at is null or rt.expires_at > now()`,
    [nsArr, idArr, relArr],
  );
  return rows;
}

function groupTuplesByFrontierKey(
  tupleRows: readonly FrontierTupleRow[],
): Map<string, FrontierTupleRow[]> {
  const byKey = new Map<string, FrontierTupleRow[]>();
  for (const row of tupleRows) {
    const key = frontierKeyStr({ ns: row.object_ns, id: row.object_id, relation: row.relation });
    const existing = byKey.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byKey.set(key, [row]);
    }
  }
  return byKey;
}

/**
 * Parses one `path` element (`ns:id#relation`) back into its parts.
 * Unambiguous: every namespace/id/relation is restricted to
 * `[a-z][a-z0-9_]*` (`IDENTIFIER_PATTERN`), which never contains `:` or
 * `#`, so splitting on the first occurrence of each is always correct.
 */
function parseFrontierKeyString(raw: string): RelationClosureKey {
  const hashIndex = raw.indexOf('#');
  const colonIndex = raw.indexOf(':');
  if (hashIndex < 0 || colonIndex < 0 || colonIndex >= hashIndex) {
    throw new Error(`sqlRelationMembershipWithWitness: malformed frontier key '${raw}'`);
  }
  return {
    ns: raw.slice(0, colonIndex),
    id: raw.slice(colonIndex + 1, hashIndex),
    relation: raw.slice(hashIndex + 1),
  };
}

/** Reconstructs a positive proof from a winning frontier row's own `path` — a plain linear walk, not a search. */
function reconstructProof(path: readonly string[], plainSubject: EntityRef): ResolutionStep {
  const nodes = path.map(parseFrontierKeyString);
  const lastIndex = nodes.length - 1;
  const last = nodes[lastIndex];
  if (!last)
    throw new Error('sqlRelationMembershipWithWitness: empty path on a winning frontier row');

  let current: ResolutionStep = {
    kind: 'directGrant',
    object: { ns: last.ns, id: last.id },
    relation: last.relation,
    subject: plainSubject,
  };
  for (let i = lastIndex - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    const child = nodes[i + 1];
    if (!node || !child)
      throw new Error('sqlRelationMembershipWithWitness: inconsistent path reconstruction');
    current = {
      kind: 'usersetMembership',
      object: { ns: node.ns, id: node.id },
      relation: node.relation,
      userset: { ns: child.ns, id: child.id },
      usersetRelation: child.relation,
      member: current,
    };
  }
  return current;
}

function closureTupleFromRow(row: FrontierTupleRow): ClosureTuple {
  return row.subject_relation === null
    ? { kind: 'plain', subject: { ns: row.subject_ns, id: row.subject_id } }
    : {
        kind: 'userset',
        userset: { ns: row.subject_ns, id: row.subject_id },
        usersetRelation: row.subject_relation,
      };
}

function buildRelationDisproof(
  object: EntityRef,
  relation: string,
  maxDepth: number,
  frontier: ReadonlyMap<string, FrontierRow>,
  tuplesByFrontierKey: ReadonlyMap<string, FrontierTupleRow[]>,
): RelationDisproof {
  const nodes: ClosureNode[] = [...frontier.values()]
    .sort((a, b) => a.depth - b.depth)
    .map((row) => ({
      key: { ns: row.ns, id: row.id, relation: row.relation },
      depth: row.depth,
      ancestorPath: row.path.map(parseFrontierKeyString),
      tuples: (tuplesByFrontierKey.get(frontierKeyStr(row)) ?? []).map(closureTupleFromRow),
    }));
  return { kind: 'relationDisproof', object, relation, maxDepth, nodes };
}

/**
 * Same shape as `ProductionOutcome`, plus the deepest frontier depth this
 * specific call's own recursive CTE reached (0 if it never recursed at
 * all), plus `touchedExpiringTuple` (D-144) — true iff `fetchTuplesOnFrontier`
 * returned any live tuple carrying a non-null `expires_at`, regardless of
 * whether it was the one that matched; see `ProductionCheckResult
 * .touchedExpiringTuple`'s own doc comment for why this is deliberately
 * over-approximate.
 *
 * **`certain` on the `allowed: false` branch — closes the residual D-158
 * risk this file's own top-of-file doc comment used to disclose as
 * not-yet-addressed.** Previously this function's own `false` outcome was
 * *always* treated as an exhaustive disproof by its caller (`resolve`),
 * regardless of whether `fetchReachableFrontier`'s own `depth < maxDepth`
 * ceiling actually cut off real, unexplored frontier before the search
 * naturally exhausted itself. That was safe reasoning for the SQL
 * path-array cycle guard (D-021/D-026: exact and lossless, pruning an
 * already-visited identity never drops real reachability) but never for
 * the depth ceiling, which — exactly like mechanism 1's own TS-level
 * ceiling before the D-158 fix — can genuinely truncate before a real
 * match is found. Consumed inside an exclusion's own `NOT` (`evalRewrite`'s
 * `exclusion` case, via `resolve`), a depth-truncated `false` wrongly
 * reported as `certain: true` reproduces the identical unsound flip D-158
 * fixed for mechanism 1: `NOT (can't-prove)` silently became `true`. See
 * `depthCeilingGenuinelyBinding` below for how this is now detected —
 * cheaply, from data this function already fetched, no new query.
 */
type SqlRelationOutcome =
  | { allowed: true; proof: ResolutionStep; depthReached: number; touchedExpiringTuple: boolean }
  | {
      allowed: false;
      disproof: DisproofStep;
      depthReached: number;
      touchedExpiringTuple: boolean;
      certain: boolean;
    };

/**
 * Detects whether `fetchReachableFrontier`'s own `depth < maxDepth` ceiling
 * genuinely suppressed real, unexplored frontier — as opposed to the search
 * simply having nowhere further to go and coincidentally stopping right at
 * the ceiling. This is the "was the ceiling actually still binding" signal
 * `RelationDisproof` itself has no field for (this file's own top-of-file
 * doc comment) — computed here instead, from data `sqlRelationMembershipWithWitness`
 * already fetched for the disproof certificate itself, so no new query is
 * needed.
 *
 * **Why only nodes at exactly `depth === maxDepth` can ever be the site of
 * a genuine truncation.** `fetchReachableFrontier`'s recursive term only
 * ever refuses to expand a frontier row `m` when `m.depth < maxDepth` is
 * false, i.e. exactly when `m.depth === maxDepth` (a row can never be
 * present in the frontier with `depth > maxDepth` at all — the same clause
 * excludes it from ever being added). Any row with `depth < maxDepth` was
 * always free to expand as far as its own real tuples allowed, so it can
 * never be the site of a budget-caused gap — only cycle-pruning (D-021,
 * already accounted for separately) could have stopped it there, and that
 * is exact/lossless.
 *
 * **Why checking against `frontier` (every node this call ever reached, at
 * its own minimum discovered depth) rather than just each node's own
 * `path`/`ancestorPath` is the correct comparison.** What matters for
 * soundness is only "was every real tuple that could contain a match ever
 * actually read?" — not "did this exact lineage's own edge get walked by
 * the CTE." If a deepest node's outgoing userset edge points at an
 * identity already present in `frontier` (discovered via any other,
 * possibly shorter, route), that identity's own tuples were already read
 * by `fetchTuplesOnFrontier` regardless of whether this specific edge was
 * ever traversed — no gap. Only an edge pointing somewhere `frontier` has
 * never heard of at all is evidence of a real, unexplored branch.
 *
 * **Why only nodes whose *minimum* discovered depth equals `maxDepth`
 * matter.** `frontier` (via `dedupeFrontier`) already keeps the smallest
 * depth ever recorded for each identity. A node that also happens to
 * appear at `maxDepth` via some other, longer lineage but has a *shorter*
 * real lineage too was already given a chance to expand via that shorter
 * lineage (since its own depth there is `< maxDepth`) — so it is never
 * flagged here, correctly: nothing about it was actually left unexplored.
 */
function depthCeilingGenuinelyBinding(
  frontier: ReadonlyMap<string, FrontierRow>,
  depthReached: number,
  maxDepth: number,
  tuplesByFrontierKey: ReadonlyMap<string, FrontierTupleRow[]>,
): boolean {
  if (depthReached !== maxDepth) return false; // never even reached the ceiling — nothing to suppress
  for (const row of frontier.values()) {
    if (row.depth !== maxDepth) continue;
    const tuples = tuplesByFrontierKey.get(frontierKeyStr(row)) ?? [];
    for (const t of tuples) {
      if (t.subject_relation === null) continue; // a plain grant, not an outgoing userset edge
      const targetKey = frontierKeyStr({
        ns: t.subject_ns,
        id: t.subject_id,
        relation: t.subject_relation,
      });
      if (!frontier.has(targetKey)) return true; // a real edge to somewhere never actually read
    }
  }
  return false;
}

/**
 * Answers "is `subject` a transitive member of the set granted by
 * `relation` on `object`?" — mechanism #2 from this file's own top-of-file
 * doc comment — and, unlike the boolean-only query it replaces, always
 * also reconstructs the full positive or negative witness (Phase 6, §6.7):
 * a `directGrant`/`usersetMembership` chain reconstructed from the winning
 * frontier row's own `path` when `allowed`, or a `RelationDisproof`
 * reachability certificate covering every node this call's own recursion
 * actually reached, when not. See this file's own top-of-file doc comment
 * for why the disproof is a flat certificate rather than a nested tree,
 * and `docs/DECISIONS.md` D-026 for the two independent cycle-safety
 * mechanisms this function still relies on unchanged (the SQL `path`-array
 * guard, and the `depth < maxDepth` backstop) — nothing about adding
 * witness reconstruction changes either guarantee, since both live inside
 * `fetchReachableFrontier`'s own recursive CTE, untouched.
 *
 * Takes `client` (this check's own `REPEATABLE READ`-pinned connection),
 * never `pool` — full-repo audit finding #1, `docs/DECISIONS.md` D-092.
 * The frontier fetch and the tuple-on-frontier fetch immediately below are
 * exactly the query *pair* that finding's own concrete counterexample
 * describes: without a shared snapshot between them, a userset edge the
 * first query observed could be deleted — and its target independently
 * (re)granted — before the second query runs, stitching a resolution path
 * together from two facts that never coexisted at any single real point in
 * the database's history. See `productionCheck`'s own doc comment for the
 * transaction this now runs inside.
 */
async function sqlRelationMembershipWithWitness(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
  subject: EntityRef,
  maxDepth: number,
): Promise<SqlRelationOutcome> {
  const frontierRows = await fetchReachableFrontier(client, object, relation, maxDepth);
  const frontier = dedupeFrontier(frontierRows);
  const depthReached = frontierRows.reduce((max, row) => Math.max(max, row.depth), 0);

  const tupleRows = await fetchTuplesOnFrontier(client, frontier);
  const tuplesByFrontierKey = groupTuplesByFrontierKey(tupleRows);
  // D-144 — see FrontierTupleRow.expires_at's own doc comment for why this
  // one check covers every expiring tuple relevant to this whole mechanism,
  // both the plain-grant candidates below and every userset edge
  // fetchReachableFrontier traversed to reach this frontier in the first
  // place (tupleRows is a strict superset of those edges).
  const touchedExpiringTuple = tupleRows.some((t) => t.expires_at !== null);

  const orderedFrontier = [...frontier.values()].sort((a, b) => a.depth - b.depth);
  for (const row of orderedFrontier) {
    const tuples = tuplesByFrontierKey.get(frontierKeyStr(row)) ?? [];
    const match = tuples.some(
      (t) =>
        t.subject_relation === null && t.subject_ns === subject.ns && t.subject_id === subject.id,
    );
    if (match) {
      return {
        allowed: true,
        proof: reconstructProof(row.path, subject),
        depthReached,
        touchedExpiringTuple,
      };
    }
  }

  return {
    allowed: false,
    disproof: buildRelationDisproof(object, relation, maxDepth, frontier, tuplesByFrontierKey),
    depthReached,
    touchedExpiringTuple,
    certain: !depthCeilingGenuinelyBinding(frontier, depthReached, maxDepth, tuplesByFrontierKey),
  };
}

/**
 * Re-verifies, as literally the first statement of the `REPEATABLE READ`
 * transaction `productionCheck` is about to run every other read of this
 * check inside, that *this transaction's own snapshot* has already
 * observed `token` — full-repo audit finding #1, `docs/DECISIONS.md`
 * D-092.
 *
 * Still **not** a call to `src/store/tokens.ts`'s `assertTokenObserved`
 * (also still not imported for that reason), but the *reason* has changed
 * since this function was first written — worth stating precisely rather
 * than leaving stale reasoning in place (`docs/DECISIONS.md` D-092's own
 * "Revisit if" flagged exactly this: "if `assertTokenObserved`... [is]
 * ever widened to a smaller structural type... `assertTokenObservedOnSnapshot`
 * ... should be deleted and replaced with a direct call"). That widening
 * happened in D0 (`src/store/tokens.ts`'s `assertTokenObserved` now takes
 * `QueryExecutor`, satisfied by both `Pool` and this function's own
 * `client` parameter) — so the original *structural* barrier is gone, and
 * `assertTokenObserved(client, atToken)` would type-check today. This
 * function is kept separate anyway, by deliberate choice now rather than
 * by type-system necessity: its own error message names *this check's own
 * transaction snapshot* specifically (see the thrown message below),
 * distinguishing a rare, expected-possible snapshot-anchoring race from
 * the pool-level pre-check `productionCheck` already ran moments earlier —
 * collapsing the two would silently lose that distinction for anyone
 * debugging why the second check failed when the first one just passed.
 * `productionCheck` still calls the real, unchanged `assertTokenObserved
 * (pool, atToken)` first — before ever opening this transaction — for its
 * already-tested malformed-token validation (`NaN`, negative, non-integer)
 * and its documented external error contract; by the time this function
 * runs, `token` is already known to be a valid non-negative integer, so
 * this only re-checks *observation*, against this connection's own
 * snapshot rather than trusting the earlier, different-connection check's
 * result to still describe whatever snapshot this transaction happens to
 * end up with.
 *
 * Why re-check at all, given `write_log` only ever grows and a single
 * Postgres instance with synchronous commits guarantees a later snapshot
 * sees everything an earlier one did: because a *fixed* snapshot's
 * guarantee is only as good as knowing precisely when it was taken, and
 * `REPEATABLE READ`'s snapshot is taken at this transaction's *first
 * query* (per Postgres's own documented semantics), not at `BEGIN` —
 * running this query first is what makes that anchor point provably no
 * earlier than "write_log has reached `token`," rather than relying on an
 * argument about connection-pool timing holding forever. This mirrors this
 * project's own established discipline for this exact class of property —
 * "a real, testable assertion rather than an assumption" — `docs/
 * CONSISTENCY.md`'s own words for `assertTokenObserved` itself.
 */
/**
 * The exact SQL text `assertTokenObservedOnSnapshot` issues — pulled out as
 * a named constant purely so `guardPinnedClientForSnapshotAnchor` below can
 * recognize the anchor query by exact identity, not some fuzzier heuristic
 * (a substring match, a comment tag, ...). Both live in this one file, so
 * this is a plain same-file constant, not a shared abstraction.
 */
const ANCHOR_QUERY_TEXT = 'select max(token) as max_token from write_log';

async function assertTokenObservedOnSnapshot(client: QueryExecutor, token: number): Promise<void> {
  const { rows } = await client.query<{ max_token: string | null }>(ANCHOR_QUERY_TEXT);
  const raw = rows[0]?.max_token;
  const observed = raw === null || raw === undefined ? null : Number(raw);
  if (observed === null || token > observed) {
    throw new Error(
      `consistency token ${token} has not been observed by this check's own transaction ` +
        `snapshot (highest token visible to this snapshot: ${observed ?? 'none — no writes yet'})`,
    );
  }
}

/**
 * A real, runtime-enforced version of the ordering `assertTokenObservedOnSnapshot`'s
 * own doc comment above depends on but, until now, only enforced by code
 * structure — disclosed as a genuine, still-open gap in `docs/DECISIONS.md`
 * D-139 ("a pg-side runtime check enforcing that `productionCheck`'s
 * snapshot-anchoring query always runs first ... was applied only to the
 * in-memory fake [`src/store/dst/connection.ts`'s `TxState.Snapshot`
 * handling], never to the real `resolver.ts`"). This closes that gap.
 *
 * Wraps `productionCheck`'s pinned client, for the whole lifetime of one
 * check, so that whenever `atToken` is set, the first non-transaction-
 * control query Postgres actually sees on this connection must genuinely BE
 * `assertTokenObservedOnSnapshot`'s own query (`ANCHOR_QUERY_TEXT`) — not
 * "called first in this file's source text," but "the first statement this
 * physical connection executes after `BEGIN`," which is the only thing that
 * actually determines where `REPEATABLE READ`'s snapshot anchors. Any other
 * query attempted first throws immediately, naming the offending SQL — an
 * internal-invariant violation (a future accidental reordering inside this
 * file, e.g. some new read added ahead of the anchor check), never
 * something a `productionCheck` caller's own arguments could trigger, so
 * this is deliberately not a "fails closed" / `disproof`-shaped outcome:
 * it throws, the same way a genuinely unreachable database throws (see
 * `productionCheck`'s own doc comment on that distinction).
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK` are recognized by exact text match against the
 * three literals `productionCheck` itself issues on this same client
 * (nothing fuzzier — this wrapper only ever needs to recognize this one
 * file's own three control statements, not "is this SQL transaction
 * control" in general) and never count toward "has a query run yet."
 *
 * Only constructed when `atToken !== undefined` (see `productionCheck`
 * below): with no token to pin there is no snapshot-anchor requirement to
 * enforce, and the un-pinned path gets back the exact same `client`
 * reference, not even a passthrough object — zero added overhead, per this
 * project's own "build a thing only when the current need actually depends
 * on it" discipline.
 *
 * Deliberately minimal, single-purpose machinery, not a general
 * "instrumented connection" abstraction, and never shared with
 * `src/resolve/reference/resolver.ts` (which has no Postgres snapshot to
 * anchor in the first place, so this concept doesn't even apply there).
 *
 * Exported *only* so `test/unit/resolve/production/snapshot-anchor-
 * invariant.test.ts` (DB-free, unit-level) can exercise the violation path
 * directly against a hand-written fake `QueryExecutor` — `productionCheck`
 * itself always calls this in the one order that keeps the invariant
 * satisfied; this wrapper exists to catch a future *accidental* reordering,
 * not because normal operation could ever trip it today. Matches this
 * file's own established precedent for `fetchReachableFrontier`/
 * `dedupeFrontier`/`FrontierRow` (exported for direct test access to the
 * real mechanism, not a hand-copied stand-in).
 */
export function guardPinnedClientForSnapshotAnchor(client: QueryExecutor): QueryExecutor {
  let firstNonControlQueryText: string | null = null;
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResultLike<Row>> {
      const isTransactionControl =
        text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
        text === 'COMMIT' ||
        text === 'ROLLBACK';
      if (!isTransactionControl && firstNonControlQueryText === null) {
        firstNonControlQueryText = text;
        if (text !== ANCHOR_QUERY_TEXT) {
          throw new Error(
            "internal invariant violation: a query ran on productionCheck's pinned " +
              'REPEATABLE READ connection before assertTokenObservedOnSnapshot (the ' +
              'snapshot-anchoring check) — this should never happen. Postgres anchors a ' +
              "REPEATABLE READ snapshot at the transaction's first query, not at BEGIN, so " +
              'assertTokenObservedOnSnapshot must always be the first non-transaction-control ' +
              `query issued on this connection whenever atToken is set. Offending query: ${text}`,
          );
        }
      }
      return client.query<Row>(text, params);
    },
  };
}

/**
 * The production check engine's entry point. Fails closed
 * (`{ allowed: false }`, never a throw) for every legitimate "no" —
 * no published schema for `object.ns`, an undeclared relation/permission
 * name, zero tuples anywhere in the path, the depth budget exhausted, a
 * cycle. A genuinely unreachable/erroring database throws instead — the
 * opposite of a "no" answer, and deliberately distinguishable from one
 * (see build spec §7's exit-code table: infrastructure failure, exit 3,
 * is not the same outcome as a real denial, exit 0). This matches
 * `src/store/tuples.ts`'s own established pattern (an unreachable pool
 * makes `writeTuple`/reads throw, never silently return an empty/false
 * result) — nothing in this function or the ones it calls catches or
 * swallows a `pg` connection error; it propagates as-is.
 *
 * **One check, one transaction (full-repo audit finding #1,
 * `docs/DECISIONS.md` D-092).** Every `relation_tuples`/`write_log` read
 * this whole check performs — across however many `resolve`/`evalRewrite`
 * recursions and `sqlRelationMembershipWithWitness`/`listTupleSubjects`
 * calls a union/intersection/exclusion/tupleToUserset tree needs — runs on
 * one connection acquired here, inside one `REPEATABLE READ` transaction
 * opened here and committed (or rolled back) here. `REPEATABLE READ`, not
 * `SERIALIZABLE`: this transaction only ever reads, so it needs Postgres's
 * snapshot-isolation guarantee (one consistent point in time for every read
 * in it), not `SERIALIZABLE`'s additional write-conflict detection, which
 * would add serialization-failure retries this codebase has no retry logic
 * for, for no benefit a read-only transaction could ever collect on.
 *
 * **`getConfig`'s `namespace_configs` lookups now run on this same pinned
 * client too (`docs/DECISIONS.md`, the entry closing D-140's own "Revisit
 * if") — previously a disclosed, deliberate gap; now closed, for a reason
 * stronger than the residual snapshot-consistency argument that originally
 * justified leaving it open.** The original scoping reasoning still holds
 * as a description of what closing this gap additionally buys: `getConfig`
 * used to run on the plain `pool`, a second, independent connection outside
 * this transaction, and `WalkContext.schemaCache` already made the
 * dangerous case (the *same* namespace observed at two *different*
 * published versions within one check) structurally impossible even then
 * — what was left open was only the strictly weaker property that two
 * *different* namespaces touched by the same check could each be read as
 * of a very slightly different moment if a schema publish (rare,
 * admin-gated) landed mid-check. That's a real, if narrow, correctness
 * improvement this fix closes as a side effect, but it is not why this
 * changed.
 *
 * **The actual reason: needing a *second* pool connection per check was a
 * real, production-reachable connection-exhaustion deadlock, confirmed
 * live, not theoretical.** Under N concurrent `productionCheck` calls where
 * N is at or past the connection pool's own `max`, every connection gets
 * consumed by the N calls' own pinned `client` acquisitions before any of
 * them can obtain the *second* connection `getConfig` used to need —
 * mutual starvation, not contention that resolves once a connection frees
 * up (nothing releases until `getConfig` itself succeeds, and nothing lets
 * `getConfig` succeed). First disclosed as a byproduct of an unrelated test
 * (`docs/DECISIONS.md` D-140: 40 concurrent `productionCheck` calls
 * deadlocked for real against local Postgres, confirmed directly via
 * `pg_stat_activity`), then independently reproduced live a second time
 * (D-142: a deliberately shrunk connection pool hung outright under 10
 * concurrent checks, killed after a 2-minute timeout, not a flake). A
 * check now only ever needs exactly one connection, for its entire life,
 * no matter how many distinct namespaces the walk touches — the deadlock
 * is closed structurally, not merely made numerically less likely by
 * documenting or enforcing `MAX_CONCURRENCY < pool.max` (the alternative,
 * weaker fix D-140's own "Revisit if" also named).
 *
 * `src/audit/expand.ts`'s `expand()` had the identical `pool`/`client`
 * split for the identical reason, sharing this exact deadlock risk under
 * concurrent `/expand` traffic — fixed the same way, in the same change.
 */
export async function productionCheck(
  pool: ConnectionSource,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options?: ProductionCheckOptions,
): Promise<ProductionCheckResult> {
  const atToken = options?.atToken;
  if (atToken !== undefined) {
    // Cheap, well-tested rejection of an obviously malformed or
    // impossibly-high token before this call ever opens a connection for
    // the real check below — see assertTokenObservedOnSnapshot's own doc
    // comment for why this alone is not sufficient.
    await assertTokenObserved(pool, atToken);
  }

  const maxDepth = options?.maxDepth ?? env.CHECK_MAX_DEPTH;
  const depthReached = { value: 0 };
  const touchedExpiringTuple = { value: false };
  // Observability-only — see `WalkContext.indexHit`'s own doc comment.
  const indexHit = { value: false };
  // Phase A Leopard-index gate (`docs/LEOPARD-INDEX-PROPOSAL.md`, "One
  // trivial addition to `WalkContext`..."): a straight passthrough of
  // `atToken`, present on `ctx` only when this check is both pinned AND the
  // feature is enabled (the per-call `useRelationIndex` override, falling
  // back to `env.LEOPARD_INDEX_ENABLED` when omitted). Never a new query,
  // never a re-derived value — `atToken` is already in hand above.
  const relationIndexEnabled = options?.useRelationIndex ?? env.LEOPARD_INDEX_ENABLED === 'true';
  const relationIndexFloor = relationIndexEnabled && atToken !== undefined ? atToken : undefined;

  const client = await pool.connect();
  // Wrapped at acquisition, before this connection's very first query, so
  // the guard sees literally everything issued on it — see
  // `guardPinnedClientForSnapshotAnchor`'s own doc comment. Only wrapped
  // when there's an `atToken` anchor requirement to enforce; the unpinned
  // path keeps the exact same `client` reference, zero added overhead.
  const guardedClient = atToken !== undefined ? guardPinnedClientForSnapshotAnchor(client) : client;
  try {
    await guardedClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (atToken !== undefined) {
      await assertTokenObservedOnSnapshot(guardedClient, atToken);
    }
    const ctx: WalkContext = {
      client: guardedClient,
      maxDepth,
      schemaCache: new Map(),
      depthReached,
      touchedExpiringTuple,
      indexHit,
      // `exactOptionalPropertyTypes` — see `rowToTuple`'s (`src/store/
      // tuples.ts`) identical "only spread it in when it has a real value"
      // pattern: `relationIndexFloor` is `number | undefined`, but
      // `WalkContext.relationIndexFloor` is `number`-or-absent, not
      // `number | undefined` present.
      ...(relationIndexFloor !== undefined ? { relationIndexFloor } : {}),
    };
    const outcome = await resolve(ctx, subject, object, relationOrPermission, new Set(), 0);
    await guardedClient.query('COMMIT');
    return outcome.allowed
      ? {
          allowed: true,
          path: outcome.proof,
          depth: depthReached.value,
          touchedExpiringTuple: touchedExpiringTuple.value,
          // `exactOptionalPropertyTypes` — present (`true`) only when the
          // index was actually consulted-and-hit anywhere in this check;
          // see `ProductionCheckResult.indexHit`'s own doc comment.
          ...(indexHit.value ? { indexHit: true } : {}),
        }
      : {
          allowed: false,
          // Full-repo audit finding #6 — see `ProductionCheckResult.certain`'s
          // own doc comment. Threaded through unchanged from the top-level
          // `resolve` outcome; never re-derived here.
          certain: outcome.certain,
          depth: depthReached.value,
          touchedExpiringTuple: touchedExpiringTuple.value,
          // See the `allowed: true` branch above — a nested branch inside a
          // negated position (an exclusion's own `subtract`) can hit the
          // index while the overall check still resolves `allowed: false`.
          ...(indexHit.value ? { indexHit: true } : {}),
        };
  } catch (err) {
    // The ROLLBACK call's own failure must never replace `err` — the exact
    // bug class found and fixed via DST crash-injection work in
    // src/store/tuples.ts, src/schema/publish.ts, and src/store/migrate.ts
    // (docs/DECISIONS.md D-097/D-098), missed here until the second
    // full-repo audit (D-106): a connection that died mid-check can't run
    // a ROLLBACK any more than it could run anything else, so a naive
    // `await client.query('ROLLBACK')` here would throw a second, different
    // error that silently masks the real one this catch block is already
    // propagating — an operator would see "connection terminated" instead
    // of whatever actually made the check fail, at exactly the moment the
    // real cause matters most.
    try {
      await guardedClient.query('ROLLBACK');
    } catch {
      // Swallowed deliberately — see comment above. Postgres releases the
      // connection (and anything it held) on its own once it's actually
      // gone; there is nothing left to clean up here that matters more
      // than `err` reaching the caller unchanged.
    }
    throw err;
  } finally {
    client.release();
  }
}
