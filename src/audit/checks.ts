/**
 * `performCheck` — the "every check, allowed or denied, is logged" half of
 * §9 Phase 6's exit criterion. A thin, main-agent-owned wrapper around
 * `productionCheck` (`src/resolve/production/resolver.ts`, Phase 4/6): runs
 * the real check, times it, and inserts exactly one `checks` row (§4)
 * recording the outcome — `resolution_path` populated iff `allowed` is
 * true, matching the resolver's own "present iff allowed" contract for
 * `path`.
 *
 * This is the *only* place in the codebase a real, application-facing
 * check should go through — the CLI's `authz check` command calls this,
 * never `productionCheck` directly, so nothing that looks like a real
 * caller's check can silently skip the audit log. The API's `POST /check`
 * route (`src/api/server.ts`, Phase 8) already routes through this same
 * function for the same reason.
 *
 * **`runSoundnessFuzz` (Phase 5) deliberately does NOT call this.** Its
 * per-query checks (up to `SOUNDNESS_FUZZ_QUERIES` — 5,000 by default) are
 * synthetic fuzz instrumentation against generated, salted fixture data,
 * not real application traffic; logging every one to `checks` would
 * drown a real audit trail in synthetic noise for no benefit — a fuzz
 * run's own result is already durably recorded, in full, as its own
 * `soundness_runs` row. See `docs/DECISIONS.md`.
 *
 * **If the `checks` insert itself fails, `performCheck` throws** — the
 * already-computed `allowed`/`path` result is discarded, never returned.
 * §9 Phase 6's exit criterion states logging as unconditional ("every
 * check ... is logged"), not best-effort; a caller that received an
 * answer this function silently failed to log would have no way to know
 * the audit trail is now missing an entry for a real decision. This
 * matches `productionCheck`'s own established contract (a genuinely
 * unreachable database is an infrastructure failure — exit 3 in the CLI
 * — never smoothed over into an ordinary answer). See `docs/DECISIONS.md`.
 *
 * **The optional `cache` parameter (post-audit improvement, closes D-028;
 * `src/resolve/production/cache.ts`).** Defaults to `undefined`, preserving
 * today's exact behavior byte-for-byte for every one of this function's
 * existing callers (tests, the CLI, and every place that constructs
 * `PerformCheckOptions` without also passing a cache) — nothing has to
 * change at a call site that doesn't opt in. `src/api/server.ts`'s `/check`
 * route is, as of this change, the only real caller that ever passes one,
 * and only when `env.CHECK_CACHE_TTL_MS > 0` (`createCheckCache` returns
 * `undefined` otherwise — see that function's own doc comment).
 *
 * Logging stays unconditional on a hit exactly as on a miss: a hit skips
 * `productionCheck`'s own graph walk, never the `checks` insert. The insert
 * on a **miss** now runs *before* `cache.trySet(...)`, not after (a real
 * bug an adversarial review workflow found before this shipped, not a
 * stylistic choice): if the insert throws, `performCheck` still throws and
 * discards the result exactly as it always has, and — because `trySet`
 * never ran — that discarded result can never live on in the cache and be
 * served to some *other* caller under a checks-table row that misrepresents
 * when/how it was actually computed. `cache.beginMiss()` is called before
 * `productionCheck` even starts, and the epoch it captures is checked again
 * by `trySet` after the insert completes — fencing the *entire* window (the
 * graph walk and the audit insert both) during which a concurrent write
 * could have called `cache.clear()` and made this result stale before it
 * would otherwise be cached. See `cache.ts`'s own top-of-file doc comment,
 * "The epoch fence," for the full race this closes.
 *
 * **A cached ALLOW must never survive a tuple it depended on time-expiring
 * (D-144's own follow-up work, its own new decision entry once complete).**
 * `cache.ts`'s own invalidation machinery — `clear()`, the TTL backstop, the
 * epoch fence — all react to a *write* landing somewhere. None of them react
 * to time simply passing, and a relation tuple carrying a non-null
 * `expiresAt` can leave the live tuple graph purely because the clock
 * advanced, with no write, no `clear()`, and no epoch bump ever happening.
 * A `productionCheck` call made while such a tuple was still live can
 * therefore compute a real, correct `ALLOWED` at that moment and yet be
 * wrong forever after if this function then cached it: the tuple later
 * expires, nothing in `cache.ts` notices, and a stale grant keeps being
 * served past the exact moment it should have flipped to denied. The guard
 * below closes this the only way it safely can without teaching `CheckCache`
 * itself anything about tuple semantics (see `cache.ts`'s own doc comment for
 * why that separation is deliberate): `performCheck` simply skips
 * `cache.trySet(...)` entirely — never even attempting it — whenever the
 * freshly-computed `result.allowed` is `true` and `result.touchedExpiringTuple`
 * is also `true` (`ProductionCheckResult`, `resolver.ts` — conservative by
 * design, set whenever the walk read *any* live tuple with a non-null
 * `expiresAt`, whether or not it actually ended up mattering to the final
 * answer). This is asymmetric on purpose, not a blanket "anything
 * expiry-adjacent never caches": a tuple expiring can only ever remove a
 * grant from the live graph as time moves forward, never add one — there is
 * no clock-driven mechanism that turns a denial into an allow. A cached
 * `DENIED` result is therefore never at risk this way, `touchedExpiringTuple`
 * or not — if the tuple it touched later expires, the check would still be
 * denied, so the cached denial never becomes wrong — and this function
 * continues caching every denied result exactly as it always has, with this
 * change making zero observable difference to that path. Withholding the
 * cache write also never changes what *this* call to `performCheck` itself
 * returns or logs — the real, freshly-computed `result` still comes back to
 * this call's own caller and is still audited unconditionally above; the
 * only thing affected is whether some later, different caller could reuse
 * this exact answer from the cache instead of recomputing it.
 *
 * ---
 *
 * **Hash-chained audit log (post-audit improvement, migration
 * `0006_checks_hash_chain.sql`).** Every row `insertCheckRow` writes now
 * also carries `prev_hash`/`row_hash`: `row_hash` is a SHA-256 hex digest
 * over this row's own canonical field serialization (`canonicalizeCheckRow`
 * below) concatenated with the *previous* chained row's own `row_hash`
 * (`prev_hash`). This makes the audit trail tamper-EVIDENT: silently
 * `UPDATE`-ing any already-committed row's recorded fields (or its own
 * stored `row_hash`) makes that row's stored hash disagree with a fresh
 * recomputation of the identical formula, and — because every later row's
 * own `prev_hash` still points at that row's now-wrong `row_hash` — the
 * chain fails to reverify from that row forward too. `authz audit verify`
 * (`src/cli/commands/audit.ts`) walks the whole chain and reports either
 * "N/N rows verified, chain intact" or the first row (by `chain_seq`) whose
 * stored and recomputed hashes disagree.
 *
 * **What this does NOT provide — stated plainly, not glossed over.** This
 * detects tampering with an already-committed row AFTER THE FACT, the next
 * time someone actually runs `authz audit verify` — it is not a live
 * trigger, and nothing here prevents the `UPDATE` from happening in the
 * first place. More fundamentally: anyone with enough database privilege
 * to tamper with a row in the first place can, in principle, also recompute
 * and rewrite every `row_hash`/`prev_hash` pair from that row forward to
 * make the whole chain re-verify as intact again — this table has no way
 * to stop that on its own, since every input the chain is built from
 * (including the chain's own history) lives in the one database a
 * privileged attacker already controls. Closing that would need an anchor
 * this database cannot provide by itself — e.g. periodically publishing
 * the current chain tip's `row_hash` somewhere outside this database's own
 * reach — genuinely out of scope here, not silently assumed away. What
 * this feature actually buys: an operator can detect the realistic
 * tampering shape (one row quietly edited or restored from a backup,
 * without anyone also fixing up every row after it) without needing to
 * already suspect it or compare against an external copy.
 *
 * **Canonical serialization — exact fields, exact order, why this order.**
 * `canonicalizeCheckRow` NUL-byte-joins (`FIELD_SEPARATOR`) these fields, in
 * this fixed order, matching `insertCheckRow`'s own column list above
 * top-to-bottom (never implicit, so a future column reorder in the SQL
 * can't silently desync from the hash without this comment and the code
 * disagreeing loudly):
 *
 *   subject_ns, subject_id, relation, object_ns, object_id, allowed,
 *   consistency_token, resolution_path, depth, duration_ms, checked_at
 *
 * Every field `insertCheckRow` writes into the row is covered *except*
 * `id` (a random `uuid`, pure row identity — tampering with it doesn't
 * change what decision was recorded), `chain_seq` (pure walk-order
 * bookkeeping — see the migration's own doc comment for why it exists and
 * why it can't itself anchor the chain), and — as of full-repo audit
 * finding #6 — `certain` (migration `0009_checks_certain.sql`). `certain`
 * is deliberately excluded for the same reason `id`/`chain_seq` already
 * are, plus one specific to it: it did not exist when every row chained
 * under migration `0006_checks_hash_chain.sql` already had its `row_hash`
 * computed, so folding it into the canonical serialization now would make
 * `authz audit verify` report every one of those pre-existing, genuinely
 * untampered historical rows as broken the next time the chain is walked —
 * a false "tampered" verdict, not a real one. Covering every remaining
 * column means tampering with *any* of them — including quietly flipping
 * `allowed`, backdating `checked_at`, or swapping in a different
 * `resolution_path` — changes the canonical string and is therefore
 * detected.
 *
 * A plain string concatenation (not NUL-joined) would be ambiguous: without
 * a separator, `("ab", "c")` and `("a", "bc")` serialize identically.
 * NUL (`\0`) is used because it can never appear inside any of these
 * fields for a reason the DSL itself already enforces: `subject_ns`/
 * `subject_id`/`relation`/`object_ns`/`object_id` are always valid
 * identifiers (`IDENTIFIER_PATTERN`, `src/schema/dsl/types.ts` — letters,
 * digits, underscore only); the remaining fields are either a fixed literal
 * (`String(true|false)`, a decimal integer, an ISO-8601 timestamp) or a
 * JSON string built by `canonicalJson`, which always emits properly quoted
 * JSON string content — genuinely embedding a raw NUL byte would require
 * either an identifier violating the DSL's own grammar or a
 * `ResolutionStep` object carrying a string value containing one, and
 * nothing in this codebase ever constructs one. Even if it somehow did,
 * `canonicalJson`'s `JSON.stringify` step would escape it as `\0`
 * inside the surrounding quotes, not emit a literal NUL byte — so the
 * separator's own uniqueness in the joined string is preserved either way.
 *
 * `resolution_path` is hashed via `canonicalJson`, a small recursive
 * JSON serializer with objects' own keys sorted before stringifying —
 * **not** a plain `JSON.stringify(result.path)` — for a real, otherwise
 * silent correctness hazard: Postgres's `jsonb` type does not preserve the
 * key order (or whitespace) a value was originally inserted with; reading
 * a `jsonb` column back can return an object whose keys enumerate in a
 * *different* order than the one the original JS object literal had. If
 * `insertCheckRow` hashed the pre-storage `JSON.stringify(result.path)`
 * string directly, `authz audit verify`'s later recomputation — which can
 * only ever work from a *freshly read* row, jsonb round-trip included —
 * would compute a different string for the exact same, entirely untampered
 * data, and every single check with a non-null `resolution_path` would
 * report as "tampered" the very first time it was verified. `canonicalJson`
 * sorting object keys before stringifying on *both* sides (insert-time and
 * verify-time) makes the two computations agree on the DATA, independent
 * of whatever order jsonb (or a JS object literal) happened to iterate
 * keys in. (Confirmed live, not just reasoned through — see
 * `checks-hash-chain.integration.test.ts`'s own "insert then immediately
 * verify" case, which would fail on the very first assertion if this were
 * wrong.)
 *
 * `consistency_token`/`depth`/`duration_ms` are hashed via plain `String()`
 * rather than a custom null-aware formatter: `String(null)` already
 * produces the literal string `"null"`, `String(true)`/`String(false)`
 * produce the literal we want for `allowed`, and `String(42)` produces the
 * same decimal digits `pg` returns for that same integer read back later
 * (bigint columns come back over the wire as a `string`, per D-018 — but
 * `String(aNumber)` and that returned string are byte-identical for any
 * integer this project's token/depth/duration counters will ever reach
 * long before `Number.MAX_SAFE_INTEGER` stops representing them exactly).
 * `checked_at` is hashed via `Date#toISOString()`, always UTC and always
 * millisecond-precision — see below for why the value hashed is computed
 * in JS, not left to the column's own `now()` default.
 *
 * **Why `checked_at` is passed explicitly instead of using the column's
 * `now()` default.** Two reasons, not one. First, mechanically: this hash
 * has to be computed in JS (`row_hash` needs a value before the row can be
 * inserted), so *something* has to stand in for "when was this row
 * created" before Postgres ever sees the row — there is no way to hash a
 * column's own database-computed default without a second round trip.
 * Second, substantively: `now()`'s documented semantics (fixed at this
 * transaction's own *start*) would have been actively wrong to hash even
 * if it were computable in advance — see `0006_checks_hash_chain.sql`'s own
 * doc comment for the exact concurrent-write scenario where a
 * transaction's start time and its real commit order can disagree. `new
 * Date()` captured in JS immediately before the locked critical section's
 * own `INSERT` runs has no such gap: by that point this call has already
 * acquired `CHECKS_HASH_CHAIN_LOCK_CLASSID` and read the current chain
 * tip, so no other `insertCheckRow` call can be concurrently doing the
 * same — the timestamp genuinely reflects this row's real position in the
 * chain, not merely its transaction's nominal start.
 *
 * **Concurrency: the same class of gap D-083 already found and fixed for
 * `write_log.token`, closed here for `checks.chain_seq`/`row_hash`.**
 * Before this feature existed, `insertCheckRow` ran one bare `pool.query`
 * insert with no transaction and no lock at all — perfectly fine for a
 * plain audit row with no cross-row relationship, but insufficient the
 * moment a row's own content (`prev_hash`) depends on *which* row
 * immediately preceded it. Two concurrent `insertCheckRow` calls that both
 * read "the current chain tip" before either commits would both compute a
 * `prev_hash` pointing at the same predecessor and both insert a row
 * claiming to extend the chain from that same point — a fork, silently
 * corrupting the single-linked-list structure `authz audit verify` assumes
 * (which link is "the real next one" becomes ambiguous, and depending on
 * `chain_seq` tie-breaking, an entire branch's hashes would legitimately
 * chain together internally while quietly NOT covering every row that was
 * actually inserted). `CHECKS_HASH_CHAIN_LOCK_CLASSID` (a transaction-scoped
 * advisory lock, `pg_advisory_xact_lock($1, $2)`, acquired as the very
 * first statement after `BEGIN`) closes this exactly the way
 * `WRITE_LOG_LOCK_CLASSID` closes the identical shape of race for
 * `write_log.token` (`src/store/tuples.ts` — see that constant's own doc
 * comment for the full reasoning, restated only briefly here): the second
 * of any two concurrent `insertCheckRow` calls blocks at the lock
 * acquisition until the first's entire transaction (read tip, compute
 * hash, insert, COMMIT) has fully finished, so "read the tip" and "commit
 * a new tip" can never interleave across two calls. Global, not scoped by
 * namespace/object/subject — like `write_log`, the checks table's hash
 * chain is one single, global sequence, so any two concurrent checks
 * anywhere in the system are a real hazard, not just two checks on the
 * same object.
 *
 * **The honest cost, stated the same way `WRITE_LOG_LOCK_CLASSID`'s own
 * doc comment states it:** every real, application-facing check
 * (`authz check`, `POST /check`) now serializes its own audit-log insert
 * against every other one in the entire system — a genuine throughput
 * ceiling this table did not have before. `productionCheck`'s own graph
 * walk (the actual work of answering a check) is unaffected and still runs
 * fully concurrently; only the few-millisecond audit-insert tail of
 * `performCheck` is now serialized. A deliberate trade of write throughput
 * for a genuine tamper-evidence guarantee, exactly the trade
 * `WRITE_LOG_LOCK_CLASSID` already made for consistency-token ordering.
 */
import { createHash } from 'node:crypto';
import type { ConnectionSource, QueryExecutor } from '../store/query-executor.js';

import {
  productionCheck,
  type EntityRef,
  type ProductionCheckOptions,
  type ProductionCheckResult,
} from '../resolve/production/resolver.js';
import { buildCacheKey, type CheckCache } from '../resolve/production/cache.js';

export type PerformCheckOptions = ProductionCheckOptions;

export type PerformCheckResult = ProductionCheckResult;

// ---------------------------------------------------------------------------
// Hash chain — canonicalization, hashing, genesis, and the serializing lock.
// See this file's own top-of-file doc comment for the full design/rationale.
// ---------------------------------------------------------------------------

/** Separates every canonicalized field — see the top-of-file doc comment's "A plain string concatenation... would be ambiguous" note for why NUL specifically. */
const FIELD_SEPARATOR = '\0';

/**
 * The very first chained row's `prev_hash` — a fixed, documented sentinel,
 * never a real hash of anything. 64 lowercase hex `0` characters: the same
 * length a real SHA-256 hex digest has, so it visually lines up in a
 * `checks` table dump next to genuine hashes, but a real SHA-256 output
 * landing on all-zero bits is computationally infeasible (2^-256), so this
 * value can never be mistaken for — or collide with — an actual row's
 * hash. Exported so `authz audit verify` (`src/cli/commands/audit.ts`) and
 * this file's own tests can both anchor to the identical constant rather
 * than each hand-writing the same 64 zeros.
 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Global advisory-lock key serializing every `insertCheckRow` call's
 * "read the current chain tip, then extend it" sequence — see this file's
 * own top-of-file "Concurrency" section for the exact race this closes.
 * Deliberately the same **two-integer-argument** form
 * `WRITE_LOG_LOCK_CLASSID` (`src/store/tuples.ts`) uses, for the identical
 * reason that file's own doc comment gives: Postgres documents the
 * two-int-key and single-bigint-key (`publish.ts`'s own `hashtext($1)`)
 * forms as two structurally non-overlapping keyspaces, so picking a
 * distinct ASCII tag here is a *guaranteed* non-collision, not merely an
 * unlikely one. `classid` is the ASCII bytes of `hchn` ("hash chain",
 * `0x68 63 68 6e` = `1751345262`) — arbitrary but fixed, greppable, and
 * distinct from `WRITE_LOG_LOCK_CLASSID` (`'wlog'`) and
 * `MIGRATIONS_LOCK_CLASSID` (`'migr'`, `src/store/migrate.ts`). `objid` is
 * a fixed `0`: like `write_log`, this table's hash chain has exactly one
 * thing it ever serializes (the single, global sequence of chained
 * `checks` rows) — no second dimension to key by.
 */
export const CHECKS_HASH_CHAIN_LOCK_CLASSID = 0x6863686e; // ASCII 'hchn' — see doc comment above.
export const CHECKS_HASH_CHAIN_LOCK_OBJID = 0;

/**
 * The exact set of fields `canonicalizeCheckRow` hashes — see this file's
 * own top-of-file "Canonical serialization" section for the field list,
 * order, and why each is formatted the way it is. Deliberately structural
 * (not `CheckRow`/`ProductionCheckResult` themselves) so both
 * `insertCheckRow` (building this from an in-flight check's own JS values)
 * and `src/cli/commands/audit.ts` (building this from a freshly-`select`ed
 * database row) can construct the identical shape from two very different
 * starting points without either one depending on the other's internals.
 */
export interface HashableCheckRow {
  subjectNs: string;
  subjectId: string;
  relation: string;
  objectNs: string;
  objectId: string;
  allowed: boolean;
  /** `null` when the check wasn't pinned to a token — matches `consistency_token`'s own nullability. */
  consistencyToken: number | string | null;
  /** `null` when `allowed` is false — matches `resolution_path`'s own "present iff allowed" contract. */
  resolutionPath: unknown;
  depth: number;
  /** `null` only in the (currently theoretical — `insertCheckRow` always measures a real duration) case the column itself already allows for. */
  durationMs: number | null;
  checkedAt: Date;
}

/**
 * Recursively serializes `value` to JSON with every object's own keys
 * sorted before stringifying — see this file's own top-of-file doc comment
 * ("resolution_path is hashed via canonicalJson...") for exactly why plain
 * `JSON.stringify` is unsafe here (a `jsonb` column round-trip can reorder
 * object keys) and why sorting keys on both the insert-time and
 * verify-time computation makes the two agree regardless. Arrays keep
 * their own order — order is semantically meaningful for an array (e.g.
 * `ResolutionStep`'s own `branches`), never incidental storage order the
 * way an object's key enumeration order can be.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Builds the exact NUL-joined canonical string `computeCheckRowHash` hashes
 * — see this file's own top-of-file "Canonical serialization" section for
 * the field list, order, and formatting rationale. A pure function of its
 * argument only (no DB access, no clock read) — deliberately, so it can be
 * unit-tested without Postgres and called identically from both
 * `insertCheckRow` (a row not yet written) and `audit.ts` (a row freshly
 * read back).
 */
export function canonicalizeCheckRow(row: HashableCheckRow): string {
  return [
    row.subjectNs,
    row.subjectId,
    row.relation,
    row.objectNs,
    row.objectId,
    String(row.allowed),
    String(row.consistencyToken),
    canonicalJson(row.resolutionPath),
    String(row.depth),
    String(row.durationMs),
    row.checkedAt.toISOString(),
  ].join(FIELD_SEPARATOR);
}

/**
 * `row_hash` = SHA-256(`canonicalizeCheckRow(row)` + `FIELD_SEPARATOR` +
 * `prevHash`) — hex-encoded. The separator between the canonical payload
 * and `prevHash` matters for the identical reason it matters between every
 * other field: without it, two different (payload, prevHash) pairs whose
 * concatenation happens to produce the same raw bytes would hash
 * identically. `prevHash` is `GENESIS_PREV_HASH` for the first chained row,
 * otherwise the immediately-preceding chained row's own `row_hash`.
 */
export function computeCheckRowHash(row: HashableCheckRow, prevHash: string): string {
  const canonical = canonicalizeCheckRow(row);
  return createHash('sha256')
    .update(canonical + FIELD_SEPARATOR + prevHash, 'utf8')
    .digest('hex');
}

/**
 * Reads the current chain tip's own `row_hash` — the value the *next*
 * chained row's `prev_hash` must be. `where row_hash is not null` is
 * load-bearing, not defensive styling: every row that existed before
 * migration `0006_checks_hash_chain.sql` has a NULL `row_hash` by design
 * (see that migration's own doc comment for why it doesn't retroactively
 * hash history), so without this filter the very first `insertCheckRow`
 * call after that migration could read a pre-existing, un-hashed row as
 * "the tip" and try to chain onto a `row_hash` that was never actually
 * computed (`undefined`, not a real hash). Ordered by `chain_seq`, not
 * `id`/`checked_at` — see the migration's own doc comment for why those
 * two columns can't safely anchor a walk order under concurrent writers.
 * Must be called with `client` already holding
 * `CHECKS_HASH_CHAIN_LOCK_CLASSID` — see this file's own top-of-file
 * "Concurrency" section. `client: QueryExecutor`, not `ConnectionSource` —
 * this only ever runs one query against a connection its caller already
 * opened, exactly the narrowing `query-executor.ts`'s own doc comment
 * establishes for every function in this codebase that doesn't itself need
 * to open a transaction.
 */
async function fetchChainTipHash(client: QueryExecutor): Promise<string> {
  const { rows } = await client.query<{ row_hash: string }>(
    `select row_hash from checks where row_hash is not null order by chain_seq desc limit 1`,
  );
  return rows[0]?.row_hash ?? GENESIS_PREV_HASH;
}

/**
 * The one `checks` row every call inserts, hit or miss — factored out so
 * both paths write it identically. Opens its own transaction (previously a
 * single bare `pool.query`) purely to make the hash-chain read-then-write
 * atomic and lock-protected — see this file's own top-of-file "Concurrency"
 * section. Mirrors `writeTuple`/`deleteTuple`'s own
 * `BEGIN`/lock/.../`COMMIT`/rollback-on-error shape (`src/store/tuples.ts`)
 * deliberately, including the identical "a failed ROLLBACK must never mask
 * the real error" swallow in the `catch` block.
 */
async function insertCheckRow(
  pool: ConnectionSource,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options: PerformCheckOptions,
  result: PerformCheckResult,
  durationMs: number,
): Promise<void> {
  const consistencyToken = options.atToken ?? null;
  // `result.allowed ? result.path : null` — matches the pre-existing
  // "present iff allowed" contract this file already relied on before the
  // hash chain existed; computed once here so the exact same value backs
  // both the jsonb column and the hash (never two independently-derived
  // "what the path was" values that could theoretically disagree).
  const resolutionPath = result.allowed ? (result.path ?? null) : null;
  // Mirror image of `resolutionPath` above — full-repo audit finding #6:
  // `certain` is populated iff `allowed` is false (`ProductionCheckResult
  // .certain`'s own doc comment, `resolver.ts`), never the other way
  // around. Deliberately NOT threaded into `computeCheckRowHash` below —
  // see this file's own top-of-file "Canonical serialization" section for
  // why this column sits outside the hash chain's covered fields.
  const certain = result.allowed ? null : (result.certain ?? null);
  // Captured once, before the locked section below, and used for both the
  // stored column and the hash — see this file's own top-of-file "Why
  // checked_at is passed explicitly" section.
  const checkedAt = new Date();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Must be the very first statement after BEGIN, before the tip read
    // below and before the insert — see CHECKS_HASH_CHAIN_LOCK_CLASSID's
    // own doc comment for the race this closes.
    await client.query('select pg_advisory_xact_lock($1, $2)', [
      CHECKS_HASH_CHAIN_LOCK_CLASSID,
      CHECKS_HASH_CHAIN_LOCK_OBJID,
    ]);

    const prevHash = await fetchChainTipHash(client);
    const rowHash = computeCheckRowHash(
      {
        subjectNs: subject.ns,
        subjectId: subject.id,
        relation: relationOrPermission,
        objectNs: object.ns,
        objectId: object.id,
        allowed: result.allowed,
        consistencyToken,
        resolutionPath,
        depth: result.depth,
        durationMs,
        checkedAt,
      },
      prevHash,
    );

    await client.query(
      `insert into checks
         (subject_ns, subject_id, relation, object_ns, object_id, allowed,
          consistency_token, resolution_path, depth, duration_ms, checked_at,
          prev_hash, row_hash, certain)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        subject.ns,
        subject.id,
        relationOrPermission,
        object.ns,
        object.id,
        result.allowed,
        consistencyToken,
        resolutionPath !== null ? JSON.stringify(resolutionPath) : null,
        result.depth,
        durationMs,
        checkedAt,
        prevHash,
        rowHash,
        certain,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    // The ROLLBACK call's own failure must never replace `err` — the exact
    // "cleanup's own outcome must never overwrite the thing that actually
    // matters" reasoning `writeTuple`'s own catch block already established
    // (`src/store/tuples.ts`, itself tracing back to D0's crash-injection
    // work — see `docs/DECISIONS.md`). A connection that died mid-transaction
    // can't run ROLLBACK any more than it could run anything else.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Swallowed deliberately — see comment above. Postgres releases the
      // connection (and anything it held) on its own once it's actually
      // gone; there is nothing left to clean up here that matters more than
      // `err` reaching the caller unchanged.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function performCheck(
  pool: ConnectionSource,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options: PerformCheckOptions = {},
  cache?: CheckCache,
): Promise<PerformCheckResult> {
  const cacheKey = cache
    ? buildCacheKey(subject, relationOrPermission, object, options)
    : undefined;

  if (cache && cacheKey !== undefined) {
    const hitStart = performance.now();
    const hit = cache.get(cacheKey);
    if (hit !== undefined) {
      const hitDurationMs = Math.round(performance.now() - hitStart);
      await insertCheckRow(
        pool,
        subject,
        object,
        relationOrPermission,
        options,
        hit,
        hitDurationMs,
      );
      return hit;
    }
  }

  // Captured before `productionCheck` even starts, per this function's own
  // doc comment — fences the whole miss (graph walk + audit insert) against
  // a concurrent `cache.clear()`, not just the graph walk alone.
  const missEpoch = cache?.beginMiss();

  const start = performance.now();
  const result = await productionCheck(pool, subject, object, relationOrPermission, options);
  const durationMs = Math.round(performance.now() - start);

  await insertCheckRow(pool, subject, object, relationOrPermission, options, result, durationMs);

  // Only after the audit insert has succeeded — see this function's own doc
  // comment for why a cache write must never precede it on the miss path.
  // The extra `!(result.allowed && result.touchedExpiringTuple)` guard is
  // D-144's cache-safety fix (see this function's own doc comment, "A cached
  // ALLOW must never survive a tuple it depended on time-expiring"): an
  // allowed result that read a still-live expiring tuple is never written
  // into the cache at all — every other combination, including every denied
  // result regardless of `touchedExpiringTuple`, is cached exactly as before.
  if (
    cache &&
    cacheKey !== undefined &&
    missEpoch !== undefined &&
    !(result.allowed && result.touchedExpiringTuple)
  ) {
    cache.trySet(missEpoch, cacheKey, result);
  }

  return result;
}
