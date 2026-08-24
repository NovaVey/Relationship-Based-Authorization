/**
 * Bulk "reverse lookup" operations — a post-audit improvement, not part of
 * the original phased build in `.claude/commands/build-authz-service.md`.
 * `/check` (`src/audit/checks.ts`'s `performCheck`, `src/resolve/production
 * /resolver.ts`'s `productionCheck`) answers exactly one question: "is this
 * one (subject, object) pair allowed?" This file answers the two natural
 * reverse questions neither `/check` nor `/expand` answer today:
 *
 *  - `listObjects(pool, subject, relationOrPermission, objectNs, options?)`
 *    — every object in `objectNs` that `subject` has `relationOrPermission`
 *    on. The reverse of `/check`: one subject, one relation, every matching
 *    object in a namespace, instead of one specific object.
 *  - `listUsers(pool, object, relationOrPermission, options?)` — every
 *    concrete subject that has `relationOrPermission` on `object`. A
 *    flattened, deduplicated answer to the same question `/expand`
 *    (`src/audit/expand.ts`) already answers as a tree — see
 *    `evaluateExpandNode`'s own doc comment for why this is NOT a trivial
 *    tree-flatten.
 *
 * Both are read-only and, per build spec §6.1 ("there is no cached,
 * precomputed ... permission anywhere that isn't provably derivable from
 * current tuples on demand"), freshly and fully derived from current
 * tuples on every call — neither function here caches anything, ever, not
 * even within one call across repeated invocations.
 *
 * ---
 *
 * **`listObjects`'s soundness argument — independently verified against
 * `resolver.ts` before this file was written, not assumed.** The candidate
 * set is `select distinct object_id from relation_tuples where object_ns =
 * $1` (bounded and paginated, see `LIST_OBJECTS_MAX_CANDIDATES` below),
 * each candidate run through a real `productionCheck`. This is sound and
 * complete only if an object with literally zero `relation_tuples` rows
 * naming it as `object_ns`/`object_id` can NEVER produce `allowed: true`
 * for any subject/relation — verified by reading `resolver.ts`'s
 * `resolve`/`evalRewrite`/`sqlRelationMembershipWithWitness`/
 * `listTupleSubjects` in full (not skimmed) before writing this file, and
 * no counterexample was found:
 *
 *  - `resolve` never changes `object` for a `computedUserset`/permission
 *    indirection — union/intersection/exclusion (`evalRewrite`) all stay on
 *    the same `object` too. So a permission's rewrite tree, however deep,
 *    only ever asks questions about the *original* `object` until it either
 *    bottoms out at a storable relation on that same object, or crosses to
 *    a different object via `tupleToUserset`.
 *  - A storable-relation leaf is answered entirely by
 *    `sqlRelationMembershipWithWitness` -> `fetchReachableFrontier`, whose
 *    recursive CTE seed row is `(object, relation)` at depth 0 — reaching
 *    `allowed: true` requires `fetchTuplesOnFrontier` to find a real,
 *    currently-stored `relation_tuples` row with `object_ns = object.ns`
 *    and `object_id = object.id` at that seed (or the walk can never
 *    advance past it: every later frontier row is reached only by
 *    following a `subject_relation` edge on an already-real row).
 *  - `tupleToUserset` reads `listTupleSubjects(client, object, rule
 *    .relation)` — `select ... where object_ns = object.ns and object_id =
 *    object.id and relation = rule.relation`. Zero rows there means zero
 *    hop targets, contributing nothing to the union (the exact same "empty
 *    branch" behavior as any other union child that finds nothing) — it can
 *    never manufacture a hop out of an object that owns no tuples at all.
 *
 * So every path to `allowed: true`, for any subject/relation, requires at
 * least one `relation_tuples` row with `object_ns = objectNs` and
 * `object_id` = the candidate — exactly the set `listObjects`'s SQL
 * enumerates. No candidate outside that set could ever be `allowed: true`
 * (nothing missed), and every enumerated candidate gets a real, live
 * `productionCheck` (nothing wrong). **If a future change to `resolver.ts`
 * ever adds a rewrite-rule kind or a leaf mechanism that can grant without
 * a real tuple stored on the object itself, this argument — and this
 * file's whole candidate-enumeration strategy — must be re-verified, not
 * assumed to still hold.**
 *
 * **Why `listObjects` calls `productionCheck` directly, never
 * `performCheck` (`src/audit/checks.ts`).** `performCheck`'s own top-of-file
 * doc comment states its contract in the present tense, unconditionally:
 * "every check, allowed or denied, is logged" — and that every real,
 * application-facing check should go through it so nothing that looks like
 * a real caller's check can silently skip the audit trail. `listObjects`
 * doesn't fit that contract's own shape: routing up to
 * `LIST_OBJECTS_MAX_CANDIDATES` synthetic per-candidate checks through
 * `performCheck` for one logical "show me every object" API call would
 * write up to a thousand rows into the `checks` audit table for what a
 * human or a caller experiences as a single question — a structurally
 * different *kind* of question than the single, named "is this one
 * (subject, object) pair allowed" question `performCheck`'s contract was
 * written to cover — mirroring `expand()`'s own established precedent
 * (`src/audit/expand.ts`): `expand()` never routes through `performCheck`
 * either, for the identical reason, even though it also runs real,
 * production-grade checks against real Postgres — a tree-walk/bulk-answer
 * is simply not the single named question `performCheck`'s own contract
 * logs. This is a deliberate, disclosed gap, not
 * an oversight: **no `listObjects` call, and therefore no individual
 * per-candidate check it performs, is ever recorded in the `checks` audit
 * table.** A caller that needs an audited record of "subject X was found to
 * have access to object Y at time T" must still make a real, named
 * `/check`-equivalent call for that specific pair through `performCheck` —
 * `listObjects` is a discovery/reporting tool, not an audit-logged
 * decision path. If a future requirement needs `listObjects` results
 * logged, that's new scope (a batch-check log entry shape distinct from
 * `performCheck`'s own single-row-per-check contract), not something to
 * retrofit here silently.
 *
 * **A disclosed, accepted inefficiency, not hidden:** `ListObjectsOptions`'
 * `atToken`, when present, is threaded unchanged into *every* per-candidate
 * `productionCheck` call, and `productionCheck` independently re-validates
 * it (`assertTokenObserved` against the pool, then `assertTokenObservedOnSnapshot`
 * against that specific call's own `REPEATABLE READ` transaction) on every
 * single one of those calls — the identical token, re-checked once per
 * candidate rather than once per `listObjects` call. This is correct by
 * construction (each candidate's own check is a fully independent
 * transaction with its own snapshot, exactly matching `productionCheck`'s
 * own single-check contract — there is no larger shared transaction here
 * for `listObjects` to hook a one-time check into), just not the cheapest
 * possible implementation. Not fixed here: doing so would mean either (a)
 * giving `listObjects` its own transaction spanning every candidate check,
 * which would violate "one check, one snapshot" being scoped to *one*
 * check (`docs/DECISIONS.md` D-092) — a thousand-candidate transaction
 * held open for a thousand recursive walks is a different, much larger
 * risk profile than what D-092 sized its own `REPEATABLE READ` window
 * for — or (b) inventing a second, `listObjects`-specific token-validation
 * path outside `productionCheck`, which duplicates real correctness logic
 * for a modest constant-factor speedup. Neither is worth it at
 * `LIST_OBJECTS_MAX_CANDIDATES`'s own bounded scale.
 *
 * **A second, disclosed limitation: the candidate scan itself is a plain,
 * unpinned read of current committed state, never pinned to `atToken`, even
 * when `atToken` is supplied.** This cannot cause a `false_grant`-shaped
 * problem — every individual candidate's own `productionCheck` call still
 * independently, correctly enforces `atToken` on its own snapshot, so a
 * candidate that shouldn't be visible as of that token is still correctly
 * evaluated against real, current-enough tuples and can only come back
 * `allowed: true` if a real path exists in a snapshot that has observed at
 * least `atToken` (§6.3's own stated floor, not an exact historical pin —
 * see `docs/CONSISTENCY.md`). What it *can* cause is a strictly
 * incompleteness-shaped gap: an object created after the candidate scan
 * ran (a genuine race, however narrow) simply never appears in the
 * candidate list, and so is silently absent from the result, whether or
 * not `subject` would have been allowed on it — the same asymmetry §6.5
 * already treats as acceptable elsewhere in this codebase (favoring "never
 * wrongly include" over "never wrongly omit" when the two can't both be
 * had for free). Not fixed by pinning the candidate scan to `atToken`
 * either, since `atToken` is a floor, not a ceiling — pinning the scan
 * wouldn't stop a legitimately newer object from being missed by an
 * unlucky race, it would only change which side of "before/after the scan"
 * a given write happens to land on. Revisit only if a caller has a real,
 * stated need for "every object as of exactly this token, guaranteed
 * complete," which is a stronger property than anything else pinning does
 * in this codebase today.
 *
 * **Bounded concurrency, reusing `src/soundness/runner.ts`'s
 * `checkAllQueries` batching shape exactly (slice into
 * `Math.max(1, env.MAX_CONCURRENCY)`-sized batches, `Promise.all` each
 * batch, preserve no particular result order since the final answer is an
 * unordered set) — not imported from there (that function is module-
 * private, and even if it were exported, `listObjects`' per-candidate work
 * unit is a `productionCheck` call keyed by `(subject, object)`, not
 * `checkAllQueries`'s own reference-vs-production dual-check shape; sharing
 * would mean bending one of the two call shapes to fit the other for no
 * real benefit), and no new dependency (`p-limit` or similar) — the same
 * hand-rolled slice-and-await-Promise.all loop this codebase already
 * trusts.
 *
 * ---
 *
 * **`listUsers` is built entirely on top of `expand()`'s already-fetched
 * tree — no new SQL, no new `relation_tuples` reads of its own.** See
 * `evaluateExpandNode`'s own doc comment immediately below for the
 * correctness trap this deliberately does NOT fall into (naively
 * flattening every leaf regardless of node kind, which over-reports for
 * `intersection`/`exclusion`).
 *
 * **`listUsers` does not support `atToken` pinning.** `expand()`
 * (`src/audit/expand.ts`) has no `atToken` option today — only `maxDepth`
 * (`ExpandOptions`) — and extending `expand()` itself is out of scope for
 * this change. `ListUsersOptions` below deliberately has no `atToken`
 * field at all, rather than silently accepting one that would do nothing:
 * an accepted-but-ignored option is exactly the kind of silent
 * approximation this codebase's own conventions forbid. **Revisit if a
 * caller needs `listUsers` pinned to a consistency token** — that would
 * require adding real `atToken` support to `expand()` first (its own
 * `REPEATABLE READ` transaction, per `docs/DECISIONS.md` D-107, would need
 * the identical `assertTokenObservedOnSnapshot`-shaped floor check
 * `productionCheck` already has, run as the transaction's first statement),
 * not bolted onto this file alone.
 *
 * **`listUsers` never touches the `checks` audit table either** — it never
 * calls `performCheck`, `productionCheck`, or `expand()`'s own (nonexistent)
 * audit hook; nothing about "who is in this set" is logged anywhere, the
 * same disclosed gap `listObjects` above states for its own per-candidate
 * checks.
 */
import { env } from '../config/env.js';
import type { ConnectionSource } from '../store/query-executor.js';
import {
  productionCheck,
  type EntityRef,
  type ProductionCheckOptions,
} from '../resolve/production/resolver.js';
import { expand, type ExpandNode, type ExpandOptions } from './expand.js';

/** Re-exported from `src/resolve/production/resolver.ts` rather than redeclared — matching `src/audit/checks.ts`'s own established precedent of reusing the resolver's own `EntityRef` for a thin wrapper file, not `resolver.ts`/`expand.ts`'s own mutual "independently redeclare, never import" discipline (that discipline exists specifically for the reference-vs-production resolver isolation boundary, §6.2 — `list.ts` is neither of those two resolvers, it's a downstream consumer of both, so nothing about that boundary applies here). Structurally identical to `expand.ts`'s own `EntityRef` regardless (both are plain `{ns, id}`), so passing one where the other's declared type is expected (as `listUsers` does, handing this file's `EntityRef` values to `expand()`) type-checks without any conversion. */
export type { EntityRef };

// ---------------------------------------------------------------------------
// listObjects
// ---------------------------------------------------------------------------

/**
 * The cap on how many candidate objects one `listObjects` call will run a
 * real `productionCheck` against. A namespace can hold far more distinct
 * objects than is reasonable to walk in one request/response cycle — each
 * candidate is a full, independent recursive graph walk
 * (`productionCheck`), not a cheap index lookup. 1000 is a deliberately
 * simple, round starting point, not derived from a load test: at
 * `env.MAX_CONCURRENCY`'s own default of 8, 1000 candidates is 125
 * sequential batches of real checks, each batch bounded by whatever the
 * slowest check in it costs — noticeable latency for a single HTTP
 * request, but not unreasonable for what is inherently a bulk
 * discovery/reporting operation (mirroring `LIST_OBJECTS_MAX_CANDIDATES`'s
 * own sibling-in-spirit, `SOUNDNESS_FUZZ_QUERIES`'s default of 5000 for a
 * batch operation that's expected to take real, visible time, not
 * millisecond API latency). A future caller that legitimately needs more
 * than 1000 objects in one namespace answered completely would need real
 * pagination (a `cursor`/`after` parameter continuing past the last
 * returned `object_id`, since candidates are already ordered
 * deterministically) — out of scope for this change; `truncated: true`
 * exists precisely so a caller can detect that need rather than silently
 * receiving an incomplete answer that looks complete.
 */
export const LIST_OBJECTS_MAX_CANDIDATES = 1000;

export interface ListObjectsOptions {
  /** Pinned straight through to every per-candidate `productionCheck` call — see this file's own top-of-file doc comment for the accepted, disclosed re-validation-per-candidate inefficiency this implies. */
  atToken?: number;
  /** Overrides `env.CHECK_MAX_DEPTH` for every per-candidate `productionCheck` call — same option, same meaning as `ProductionCheckOptions.maxDepth`. */
  maxDepth?: number;
}

export interface ListObjectsResult {
  /** Every object in `objectNs` a real `productionCheck` confirmed `subject` has `relationOrPermission` on — never an approximation, never derived from anything but a live check per object. */
  objects: EntityRef[];
  /**
   * `true` iff the candidate scan found more than `LIST_OBJECTS_MAX_CANDIDATES`
   * distinct objects in `objectNs` and this call only checked the first
   * `LIST_OBJECTS_MAX_CANDIDATES` of them (ordered `object_id asc`, for a
   * deterministic, reproducible cutoff) — a caller MUST treat `objects` as
   * possibly incomplete when this is `true`, never as "the real, complete
   * answer happens to be small."
   */
  truncated: boolean;
}

interface CandidateObjectRow {
  object_id: string;
}

/**
 * The candidate scan itself — see this file's own top-of-file doc comment
 * for the soundness argument this depends on (an object with zero tuples
 * naming it as object can never be `allowed: true`) and for why this scan
 * is deliberately a plain, unpinned read even when the caller supplied
 * `atToken`.
 *
 * Fetches `LIST_OBJECTS_MAX_CANDIDATES + 1` rows — one more than the cap —
 * purely to detect truncation from the one query's own row count, instead
 * of a separate `count(*)` query that would double the cost of every call
 * just to answer a boolean. `order by object_id asc` makes the cutoff
 * (which `LIST_OBJECTS_MAX_CANDIDATES` distinct ids get checked, on a
 * namespace with more than that many) deterministic and reproducible
 * across repeated calls against the same data, rather than depending on
 * whatever order Postgres happens to return an unordered `distinct` in.
 */
async function fetchCandidateObjectIds(
  pool: ConnectionSource,
  objectNs: string,
): Promise<{ ids: string[]; truncated: boolean }> {
  const { rows } = await pool.query<CandidateObjectRow>(
    `select distinct object_id
     from relation_tuples
     where object_ns = $1
     order by object_id asc
     limit $2`,
    [objectNs, LIST_OBJECTS_MAX_CANDIDATES + 1],
  );
  const truncated = rows.length > LIST_OBJECTS_MAX_CANDIDATES;
  const kept = truncated ? rows.slice(0, LIST_OBJECTS_MAX_CANDIDATES) : rows;
  return { ids: kept.map((row) => row.object_id), truncated };
}

/**
 * Runs a real `productionCheck(pool, subject, {ns: objectNs, id}, ...)` for
 * every candidate id, `Math.max(1, env.MAX_CONCURRENCY)` at a time — the
 * identical slice-into-batches/`Promise.all`-each-batch shape
 * `src/soundness/runner.ts`'s `checkAllQueries` already establishes (see
 * this file's own top-of-file doc comment for why that function itself
 * isn't reused directly). Batch order is preserved for no particular
 * reason other than determinism of *which* batch a given candidate lands
 * in; the returned array's own order (whichever candidates within a batch
 * happen to resolve first) is not meaningful — `listObjects`'s contract is
 * a set, not a ranked or ordered list.
 */
async function checkCandidatesConcurrently(
  pool: ConnectionSource,
  subject: EntityRef,
  objectNs: string,
  candidateIds: readonly string[],
  relationOrPermission: string,
  checkOptions: ProductionCheckOptions,
): Promise<EntityRef[]> {
  const concurrency = Math.max(1, env.MAX_CONCURRENCY);
  const allowed: EntityRef[] = [];
  for (let start = 0; start < candidateIds.length; start += concurrency) {
    const batch = candidateIds.slice(start, start + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (id): Promise<EntityRef | null> => {
        const object: EntityRef = { ns: objectNs, id };
        const result = await productionCheck(
          pool,
          subject,
          object,
          relationOrPermission,
          checkOptions,
        );
        return result.allowed ? object : null;
      }),
    );
    for (const object of batchResults) {
      if (object !== null) allowed.push(object);
    }
  }
  return allowed;
}

/**
 * Every object in `objectNs` that `subject` has `relationOrPermission` on —
 * the reverse of `/check`. See this file's own top-of-file doc comment for
 * the soundness argument, the `LIST_OBJECTS_MAX_CANDIDATES` cap, and the
 * disclosed inefficiency/incompleteness limitations this function accepts
 * rather than hides.
 *
 * Never throws for an ordinary "no results" case (an empty `objectNs`, a
 * `subject` with zero access anywhere) — returns `{ objects: [],
 * truncated: false }`. A genuinely unreachable database still throws,
 * unchanged from `productionCheck`'s own fail-closed-on-infrastructure-
 * failure contract; nothing in this function catches or swallows a `pg`
 * connection error.
 */
export async function listObjects(
  pool: ConnectionSource,
  subject: EntityRef,
  relationOrPermission: string,
  objectNs: string,
  options: ListObjectsOptions = {},
): Promise<ListObjectsResult> {
  const { ids, truncated } = await fetchCandidateObjectIds(pool, objectNs);

  const checkOptions: ProductionCheckOptions = {
    ...(options.atToken !== undefined ? { atToken: options.atToken } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  };

  const objects = await checkCandidatesConcurrently(
    pool,
    subject,
    objectNs,
    ids,
    relationOrPermission,
    checkOptions,
  );
  return { objects, truncated };
}

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

export interface ListUsersOptions {
  /** Overrides `env.CHECK_MAX_DEPTH` for the underlying `expand()` call — same option, same meaning as `ExpandOptions.maxDepth`. No `atToken` field — see this file's own top-of-file doc comment for why. */
  maxDepth?: number;
}

export interface ListUsersResult {
  /** Every distinct concrete (`subject_relation IS NULL`) subject that the real rewrite-rule-combined boolean formula for `relationOrPermission` on `object` resolves to — deduplicated, sorted by `(ns, id)` for a stable, reproducible order (correctness is set equality; the sort is purely for a readable, diffable result, never load-bearing on its own). */
  subjects: EntityRef[];
}

function subjectKey(ref: EntityRef): string {
  return `${ref.ns}:${ref.id}`;
}

/** Union of every set — the correct combinator for an `ExpandNode` `union` node and for a `tupleToUserset` node's own children (each followed object's own resolved set independently contributes, unconditionally). */
function unionOfMemberSets(
  sets: readonly ReadonlyMap<string, EntityRef>[],
): Map<string, EntityRef> {
  const result = new Map<string, EntityRef>();
  for (const set of sets) {
    for (const [key, ref] of set) result.set(key, ref);
  }
  return result;
}

/**
 * Intersection of every set — the correct combinator for an `ExpandNode`
 * `intersection` node. `sets.length === 0` is handled defensively (returns
 * the empty set rather than throwing or, worse, treating "no branches" as
 * "everyone") but should be unreachable in practice: the schema compiler's
 * own grammar requires an `intersection` rewrite rule to have at least one
 * operand (`a & b`, never a bare `&` with zero operands), so a real
 * `ExpandNode.kind === 'intersection'` node's own `children` array can
 * never actually be empty — mirroring this codebase's own established
 * `assertNeverRewriteRule`-style "defended but disclosed as
 * compiler-unreachable" pattern (`src/resolve/production/resolver.ts`,
 * `src/audit/expand.ts`, `src/schema/dsl/compiler.ts`), applied here to a
 * different, but equally real, "this shouldn't happen but let's not crash
 * or silently over-grant if it somehow does" case.
 */
function intersectionOfMemberSets(
  sets: readonly ReadonlyMap<string, EntityRef>[],
): Map<string, EntityRef> {
  if (sets.length === 0) return new Map();
  const [firstSet] = sets;
  if (firstSet === undefined) return new Map(); // unreachable given the length check immediately above
  const result = new Map<string, EntityRef>();
  for (const [key, ref] of firstSet) {
    if (sets.every((set) => set.has(key))) result.set(key, ref);
  }
  return result;
}

/** `base` minus `subtract`, by key — the correct combinator for an `ExpandNode` `exclusion` node's `base - subtract`. */
function subtractMemberSet(
  base: ReadonlyMap<string, EntityRef>,
  subtract: ReadonlyMap<string, EntityRef>,
): Map<string, EntityRef> {
  const result = new Map<string, EntityRef>();
  for (const [key, ref] of base) {
    if (!subtract.has(key)) result.set(key, ref);
  }
  return result;
}

/** Exhaustiveness guard — independently written for this file's own `ExpandNode` switch, matching this project's own established per-module convention (`docs/DECISIONS.md` D-022) of never sharing this helper across files even though every copy is textually near-identical. */
function assertNeverExpandNode(node: never): never {
  throw new Error(`listUsers: unhandled ExpandNode kind: ${JSON.stringify(node)}`);
}

/**
 * Recursively evaluates an `ExpandNode` (`src/audit/expand.ts`) into the
 * actual `Map` (keyed by `"ns:id"`, values the real `EntityRef`) of
 * concrete subjects it resolves to — pure, synchronous, zero I/O; every
 * fact `expand()` already fetched is right there in the tree it returned,
 * no new `relation_tuples` reads needed.
 *
 * **The correctness trap this function exists to avoid: naively flattening
 * every `directSubjects`/userset-member leaf across the whole tree,
 * regardless of node kind, is WRONG for `intersection` and `exclusion`.**
 * `ExpandNode`'s `union`/`intersection`/`exclusion` nodes show the raw
 * membership of *each branch independently* (`expand()`'s own contract —
 * "who's in each named set," see `expand.integration.test.ts`'s own
 * "expand() shows both sides of an exclusion" case) — they do not
 * themselves encode which concrete subjects satisfy the *combined* boolean
 * formula:
 *
 *  - For `a & b` (intersection), the real set of subjects who actually have
 *    the permission is the INTERSECTION of `a`'s resolved members and `b`'s
 *    — not their union. Someone who is only in `a` (say, only `editor`, not
 *    also `owner`, for `editor & owner`) does NOT have the combined
 *    permission; naive flattening would wrongly include them, an
 *    over-report — the exact `false_grant` shape this whole project treats
 *    as the one unconditionally disqualifying bug class (§6.5).
 *  - For `a - b` (exclusion), the real set is `a`'s members MINUS `b`'s —
 *    naive flattening would wrongly include every member of `b` that's also
 *    (irrelevantly, from a flattening perspective) present somewhere in
 *    `a`'s own leaves, when they should be excluded.
 *
 * The combinator semantics implemented below, one case per `ExpandNode.kind`:
 *
 *  - `union`: union of each child's evaluated set.
 *  - `intersection`: intersection of each child's evaluated set (see
 *    `intersectionOfMemberSets`'s own doc comment for the empty-children
 *    defensive case).
 *  - `exclusion`: `base`'s evaluated set minus `subtract`'s evaluated set.
 *  - `tupleToUserset`: union of each `children[].expansion`'s evaluated
 *    set — every followed object independently, unconditionally
 *    contributes (mirroring how `resolver.ts`'s own `evalRewrite`
 *    `tupleToUserset` case treats each followed object as its own
 *    unconditional union branch, never a combinator that could exclude one
 *    followed object's members based on another's).
 *  - `relation` (the only real leaf): `directSubjects`, unioned with, for
 *    each `usersets[]` entry, that entry's own `expansion`'s evaluated set
 *    — recursive, because a userset member (`group:eng#member`, say) is
 *    never itself a final answer, only ever a pointer to keep expanding;
 *    the actual concrete subjects live at the bottom of that recursion,
 *    never at the pointer itself.
 *  - `cycleGuard`/`depthLimitReached`/`undeclared`: the empty set — these
 *    are non-membership outcomes, exactly mirroring how both check
 *    resolvers treat the equivalent disproof cases as "no": a cycle or a
 *    blown depth budget or an undeclared name never silently becomes "yes"
 *    or gets skipped in a way that could hide a real answer (skipping
 *    would mean treating an unresolved branch as contributing nothing,
 *    which is exactly what returning the empty set already does — there is
 *    no separate "unknown" state this function needs to represent, since
 *    every one of these three outcomes is, by both resolvers' own
 *    fail-closed contract, equivalent to "this branch found no one").
 *
 * Deduplication is automatic and correct by construction: every union
 * merges into the same `Map` keyed by `"ns:id"`, so a subject reachable via
 * two different branches (e.g. both a direct grant and a nested-group
 * path) collapses to exactly one entry, not two.
 */
export function evaluateExpandNode(node: ExpandNode): Map<string, EntityRef> {
  switch (node.kind) {
    case 'union':
      return unionOfMemberSets(node.children.map((child) => evaluateExpandNode(child)));
    case 'intersection':
      return intersectionOfMemberSets(node.children.map((child) => evaluateExpandNode(child)));
    case 'exclusion':
      return subtractMemberSet(evaluateExpandNode(node.base), evaluateExpandNode(node.subtract));
    case 'tupleToUserset':
      return unionOfMemberSets(node.children.map((child) => evaluateExpandNode(child.expansion)));
    case 'relation': {
      const result = new Map<string, EntityRef>();
      for (const subject of node.directSubjects) result.set(subjectKey(subject), subject);
      for (const member of node.usersets) {
        for (const [key, ref] of evaluateExpandNode(member.expansion)) result.set(key, ref);
      }
      return result;
    }
    case 'cycleGuard':
    case 'depthLimitReached':
    case 'undeclared':
      return new Map();
    default:
      return assertNeverExpandNode(node);
  }
}

/**
 * Every concrete subject that has `relationOrPermission` on `object` — a
 * flattened, deduplicated answer to the same question `/expand` already
 * answers as a tree. Built entirely on top of `expand()` (`src/audit/
 * expand.ts`): fetches the real subject tree, then evaluates it with
 * `evaluateExpandNode` (pure, no additional I/O) — see this file's own
 * top-of-file doc comment for why this does not, and cannot yet, support
 * `atToken` pinning.
 *
 * Never throws for an ordinary "no members" case (an undeclared
 * relation/permission, a relation with zero tuples) — returns `{ subjects:
 * [] }`, mirroring `expand()`'s own fail-closed-to-an-explicit-node
 * contract for those cases. A genuinely unreachable database still throws,
 * unchanged from `expand()`'s own contract.
 */
export async function listUsers(
  pool: ConnectionSource,
  object: EntityRef,
  relationOrPermission: string,
  options: ListUsersOptions = {},
): Promise<ListUsersResult> {
  const expandOptions: ExpandOptions =
    options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {};
  const tree = await expand(pool, object, relationOrPermission, expandOptions);
  const members = evaluateExpandNode(tree);
  const subjects = [...members.values()].sort((a, b) =>
    a.ns === b.ns ? a.id.localeCompare(b.id) : a.ns.localeCompare(b.ns),
  );
  return { subjects };
}
