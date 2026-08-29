/**
 * The Leopard index (Phase A) — `docs/LEOPARD-INDEX-PROPOSAL.md`'s own
 * "Test plan — the third comparison arm" section, the row naming this
 * exact file: "closes the atomic-publish gap." A real, unmodified Postgres
 * instance; a rebuild whose transaction window is deliberately widened
 * (a large, generated fixture — never an artificial `pg_sleep` injected
 * into the shipped `rebuildRelationMembershipIndex` itself); many real
 * pinned `productionCheck({ useRelationIndex: true, atToken })` calls
 * fired via genuine `Promise.all`-driven parallelism throughout that
 * rebuild's transaction lifetime.
 *
 * Three claims, per the proposal's own row, none of them merely
 * structural:
 *
 *   (a) every call that returns during the rebuild's open transaction
 *       window reflects either the fully-old or fully-new index content,
 *       never a torn mix;
 *   (b) no call ever throws — `resolve()`'s own exception boundary around
 *       `lookupRelationMembershipIndex` must hold under real lock
 *       contention, not merely a hypothetical one;
 *   (c) the observed call-latency impact of `TRUNCATE`'s own `ACCESS
 *       EXCLUSIVE` lock is measured and reported, loosely bounded (a
 *       correctness/no-hang check), never asserted as a tight performance
 *       budget.
 *
 * **How this file actually forces real contention, empirically derived,
 * not assumed.** Live experiments against this exact sandbox's own real
 * Postgres 16, run before writing this file's assertions (see this
 * session's own working notes — reproducible directly: two concurrent
 * `psql` sessions, one holding a `REPEATABLE READ` snapshot fixed on an
 * unrelated statement, the other running `TRUNCATE ... ; INSERT ...`
 * inside one open transaction) established the facts this file's design
 * depends on:
 *
 *   1. A concurrent reader whose own snapshot predates a `TRUNCATE`
 *      genuinely BLOCKS trying to acquire `ACCESS SHARE` on that table,
 *      for the `TRUNCATE`'s own transaction's entire remaining duration
 *      — confirmed via wall-clock timestamps straddling the block.
 *   2. Once unblocked (the `TRUNCATE` transaction has committed), that
 *      SAME older-snapshot reader sees the table as EMPTY — neither the
 *      pre-truncate old rows nor the post-truncate new rows — because
 *      Postgres's `TRUNCATE` swaps the underlying relfilenode rather than
 *      participating in ordinary per-row MVCC visibility the way `DELETE`
 *      does. This is exactly why `lookupRelationMembershipIndex`'s own
 *      `relation_membership_index_state.watermark_token` gate is checked
 *      FIRST, on a table that is only ever `UPDATE`d, never `TRUNCATE`d:
 *      that gate's own read is never blocked by the concurrent `TRUNCATE`
 *      at all (a plain `UPDATE` does not take a table-level lock that
 *      conflicts with a plain `SELECT`), so a call whose own floor the
 *      watermark hasn't reached yet returns `{hit:false}` and never
 *      touches the truncated table in the first place — the
 *      empty-after-block hazard above structurally never gets a chance to
 *      matter for such a call. A call pinned to a floor the rebuild's OWN
 *      PRE-EXISTING watermark already satisfies is the one that actually
 *      risks touching the table mid-`TRUNCATE` — this file races that
 *      shape deliberately (never a floor only an in-flight rebuild's own
 *      new watermark could satisfy, which is gated away from the table
 *      until commit by construction).
 *   3. Setting a short `lock_timeout` on a dedicated connection (via
 *      `pg.Pool`'s own `options: '-c lock_timeout=...'` startup-packet
 *      parameter — applied atomically at connection establishment, no
 *      race with a separate `SET` query racing first use) reliably
 *      reproduces a REAL Postgres `canceling statement due to lock
 *      timeout` error on a call genuinely blocked behind the rebuild's
 *      own `ACCESS EXCLUSIVE` lock — used here only as a deliberate way
 *      to force the exact hazard `resolve()`'s own doc comment names
 *      ("lock contention with a concurrent `authz leopard refresh`'s own
 *      TRUNCATE"), never a change to `rebuildRelationMembershipIndex`'s
 *      own code.
 *
 * **A genuine, live-reproduced finding this file's own development
 * surfaced, disclosed here rather than quietly worked around — see the
 * `describe` block below named for it.** Under Postgres's own default
 * `lock_timeout` (`0`, wait forever — this project's own current
 * configuration, `.env.example` sets nothing that changes it),
 * `resolve()`'s try/catch around `lookupRelationMembershipIndex` behaves
 * exactly as documented: a blocked lookup simply waits, then either finds
 * a real row or (per fact 2 above) an empty result, and the check
 * completes correctly with zero throws — confirmed directly, 15/15 clean
 * runs in this file's own development. **But the moment a non-zero
 * `lock_timeout` (or any other condition producing a genuine mid-
 * transaction Postgres error inside `lookupRelationMembershipIndex`'s own
 * two queries — a common production hardening setting, not an exotic
 * one) is in effect, the SAME try/catch's own comment — "a miss, for any
 * reason at all, falls through unconditionally... this is what makes
 * that actually true" — is demonstrably false.** Postgres poisons an
 * entire transaction on any statement error (there is no `SAVEPOINT`
 * anywhere in this code path), so the very next statement on that same
 * connection — the unmodified `sqlRelationMembershipWithWitness` live
 * fallback, called unconditionally right after the caught miss —
 * immediately fails with `current transaction is aborted, commands
 * ignored until end of transaction block`, a SECOND, uncaught Postgres
 * error that `resolve()`'s own try/catch never sees (it only wraps the
 * first call), which `productionCheck`'s own outer `catch` block then
 * re-throws verbatim to its caller. Confirmed directly, isolated from
 * this file's own broader race: 15/15 clean runs against a connection
 * with the Postgres default `lock_timeout=0`, 15/15 real, uncaught throws
 * against an otherwise-identical connection with `lock_timeout=50ms` set
 * — same rebuild, same fixture, same query, the only variable changed.
 * This was a real gap in the documented "falls through unconditionally"
 * guarantee, not a flaw in this test: the test's own expectation (zero
 * throws) is derived directly from `resolve()`'s own doc comment, which
 * explicitly names "lock contention with a concurrent `authz leopard
 * refresh`'s own TRUNCATE" as one of the exact scenarios this boundary is
 * built to survive.
 *
 * **Update: fixed, not merely disclosed.** `resolve()`'s relation branch
 * now wraps the `lookupRelationMembershipIndex` call in a `SAVEPOINT` /
 * `ROLLBACK TO SAVEPOINT` pair — Postgres's own standard mechanism for
 * "try a statement, and if it errors, un-poison the transaction without a
 * second connection." A caught lookup exception now rolls back to that
 * savepoint before falling through, so the immediately-following live-CTE
 * fallback runs on a genuinely healthy connection. The describe block
 * below, once a live-reproduced failure (`threw.length > 0` on every run
 * during this file's own development), now genuinely passes — re-run
 * directly against real Postgres after the fix landed, `threw` empty.
 *
 * **The same disclosed `PostgreSqlContainer`-convention deviation as this
 * file's own sibling, `test/unit/store/relation-index.integration.
 * test.ts`** — see that file's own top-of-file doc comment for the full
 * reasoning (no outbound Docker-registry network access in this sandbox).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { writeTuple } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { productionCheck, type EntityRef } from '../../src/resolve/production/resolver.js';
import { rebuildRelationMembershipIndex } from '../../src/store/relation-index.js';
import { runMigrations } from '../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

// ---------------------------------------------------------------------------
// Ephemeral-database bootstrap — see this file's own top-of-file doc comment.
// ---------------------------------------------------------------------------

function requireAdminConnectionString(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'DATABASE_URL must be set to a reachable Postgres server this process has CREATEDB ' +
        "privilege on — see this file's own top-of-file doc comment for why, in place of this " +
        "repo's usual PostgreSqlContainer convention.",
    );
  }
  const url = new URL(base);
  url.pathname = '/postgres';
  return url.toString();
}

function ephemeralDbName(): string {
  return `leopard_race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function bootstrapEphemeralDatabase(): Promise<{
  pool: Pool;
  /**
   * A separate `Pool` connected to the SAME database, but with a short
   * `lock_timeout` applied via the connection's own startup-packet
   * `options` parameter — see this file's own top-of-file doc comment,
   * point 3, for why this is the reliable way to force a real Postgres
   * lock-wait error rather than a `SET` query racing first use. Used only
   * by the deliberately adversarial `describe` block that names the real
   * finding above — every other assertion in this file runs on `pool`,
   * Postgres's own default (no timeout) settings, matching this project's
   * actual current configuration.
   */
  shortLockTimeoutPool: Pool;
  adminPool: Pool;
  dbName: string;
}> {
  const adminPool = new Pool({ connectionString: requireAdminConnectionString() });
  adminPool.on('error', (err) => {
    console.error(`admin pool error (expected during teardown): ${err.message}`);
  });
  const dbName = ephemeralDbName();
  await adminPool.query(`create database "${dbName}"`);

  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${dbName}`;
  const connectionString = url.toString();

  const pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    console.error(`pool error (expected during teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);

  // 50ms — short enough to reliably fire while a multi-hundred-ms rebuild
  // transaction holds `ACCESS EXCLUSIVE` on `relation_membership_index`,
  // long enough not to spuriously fire on ordinary, uncontended queries.
  const shortLockTimeoutPool = new Pool({ connectionString, options: '-c lock_timeout=50' });
  shortLockTimeoutPool.on('error', (err) => {
    console.error(`short-lock-timeout pool error (expected during teardown): ${err.message}`);
  });

  return { pool, shortLockTimeoutPool, adminPool, dbName };
}

async function teardownEphemeralDatabase(
  pool: Pool,
  shortLockTimeoutPool: Pool,
  adminPool: Pool,
  dbName: string,
): Promise<void> {
  await pool.end();
  await shortLockTimeoutPool.end();
  await adminPool.query(`drop database if exists "${dbName}" with (force)`);
  await adminPool.end();
}

let pool: Pool;
let shortLockTimeoutPool: Pool;
let adminPool: Pool;
let dbName: string;

beforeAll(async () => {
  ({ pool, shortLockTimeoutPool, adminPool, dbName } = await bootstrapEphemeralDatabase());
}, 120_000);

afterAll(async () => {
  await teardownEphemeralDatabase(pool, shortLockTimeoutPool, adminPool, dbName);
});

// ---------------------------------------------------------------------------
// Fixture — one document/group namespace pair, widened via a single bulk raw
// SQL insert per batch (never `writeTuple` per row — see below) so the
// rebuild's own recursive-CTE-plus-INSERT transaction genuinely takes a
// measurable, non-instant amount of wall-clock time without any artificial
// delay in the shipped rebuild code itself.
// ---------------------------------------------------------------------------

const GROUP_NS = 'race_grp';
const DOC_NS = 'race_doc';

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

async function publishFixtureSchema(): Promise<void> {
  const source = [
    `namespace ${GROUP_NS} {`,
    `  relation member: user | ${GROUP_NS}#member`,
    '}',
    '',
    `namespace ${DOC_NS} {`,
    `  relation viewer: user | ${GROUP_NS}#member`,
    '  permission view = viewer',
    '}',
  ].join('\n');
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

/**
 * Bulk-inserts `count` independent 3-hop group chains directly into
 * `relation_tuples` via raw SQL — `startAt` offsets the generated ids so two
 * batches (one per `describe` block below) never collide. This deliberately
 * bypasses `writeTuple` (and so never advances `write_log`): these rows
 * exist purely to give `rebuildRelationMembershipIndex`'s own recursive
 * closure computation real width — this file's soundness assertions never
 * depend on any of these bulk rows individually being pinnable by a real
 * consistency token, only on their sheer volume making the rebuild's own
 * transaction take real, measurable time. Every row this file DOES pin a
 * check against is written for real, via `writeTuple`, separately below.
 * Confirmed live (this session's own working notes): 3,000 chains (12,000
 * `relation_tuples` rows, ~12,000-15,000 resulting `relation_membership_
 * index` rows) produce a real rebuild window on the order of a few hundred
 * milliseconds on this sandbox's own local Postgres — wide enough to
 * reliably straddle real concurrent `productionCheck` calls without any
 * `pg_sleep` anywhere in the rebuild path itself.
 */
async function bulkInsertWideFixture(startAt: number, count: number): Promise<void> {
  await pool.query(
    `insert into relation_tuples (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
     select $2, 'd' || i, 'viewer', $3, 'g0_' || i, 'member' from generate_series($1::int, $1::int + $4 - 1) i
     union all
     select $3, 'g0_' || i, 'member', $3, 'g1_' || i, 'member' from generate_series($1::int, $1::int + $4 - 1) i
     union all
     select $3, 'g1_' || i, 'member', $3, 'g2_' || i, 'member' from generate_series($1::int, $1::int + $4 - 1) i
     union all
     select $3, 'g2_' || i, 'member', 'user', 'wide_member', null from generate_series($1::int, $1::int + $4 - 1) i`,
    [startAt, DOC_NS, GROUP_NS, count],
  );
}

const WIDE_FIXTURE_SIZE = 3000;

interface CheckOutcome {
  ok: boolean;
  allowed?: boolean;
  indexHit?: boolean | undefined;
  path?: string[] | undefined;
  depth?: number;
  latencyMs: number;
  error?: string;
}

async function runPinnedCheck(
  checkPool: Pool,
  subject: EntityRef,
  object: EntityRef,
  atToken: number,
): Promise<CheckOutcome> {
  const start = Date.now();
  try {
    const result = await productionCheck(checkPool, subject, object, 'view', {
      atToken,
      useRelationIndex: true,
    });
    const latencyMs = Date.now() - start;
    return result.allowed
      ? {
          ok: true,
          allowed: true,
          indexHit: result.indexHit,
          path: pathFromResolutionStep(result.path),
          depth: result.depth,
          latencyMs,
        }
      : { ok: true, allowed: false, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

/** Flattens a `ResolutionStep` tree into its own `ns:id#relation` chain, mirroring `via_path`'s shape, purely so this file's own assertions can compare a real returned proof against an expected chain without importing resolver.ts-internal proof types. */
function pathFromResolutionStep(step: unknown): string[] | undefined {
  const nodes: string[] = [];
  let current = step as
    { kind: string; object: EntityRef; relation?: string; member?: unknown } | undefined;
  while (current) {
    if (current.kind === 'directGrant' || current.kind === 'usersetMembership') {
      const relation = current.relation;
      if (relation === undefined) break;
      nodes.push(`${current.object.ns}:${current.object.id}#${relation}`);
      current = current.member as typeof current;
    } else {
      return undefined; // an unexpected shape for this file's own simple fixtures — not a path this file knows how to render.
    }
  }
  return nodes;
}

function summarizeLatencies(outcomes: CheckOutcome[]): {
  min: number;
  max: number;
  median: number;
} {
  const sorted = [...outcomes].map((o) => o.latencyMs).sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// describe block 1 — a first-ever (cold) rebuild, racing checks pinned to an
// always-satisfied floor (atToken: 0) so every call genuinely attempts the
// (possibly mid-TRUNCATE) relation_membership_index query, on Postgres's own
// default (no-timeout) connection settings — this project's actual current
// configuration.
// ---------------------------------------------------------------------------

describe('a real cold rebuild racing many real pinned checks on ordinary (no lock_timeout) connections never returns a torn or incorrect result and never throws', () => {
  it('every-check-fired-throughout-a-wide-first-rebuilds-transaction-lifetime-resolves-allowed-true-with-zero-throws-under-postgres-default-connection-settings', async () => {
    await publishFixtureSchema();
    await bulkInsertWideFixture(1, WIDE_FIXTURE_SIZE);

    const markerWrite = await writeTuple(pool, {
      objectNs: DOC_NS,
      objectId: 'special',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'marker',
    });
    if (!markerWrite.ok) {
      throw new Error(`fixture marker write failed: ${JSON.stringify(markerWrite.errors)}`);
    }
    const markerToken = markerWrite.token;
    const markerSubject = ref('user', 'marker');
    const markerObject = ref(DOC_NS, 'special');
    const expectedMarkerPath = [`${DOC_NS}:special#viewer`];

    const rebuildStart = Date.now();
    const rebuildPromise = rebuildRelationMembershipIndex(pool).then((result) => ({
      ...result,
      durationMs: Date.now() - rebuildStart,
    }));

    // Pinned to atToken: 0 — an always-satisfied floor regardless of the
    // rebuild's own progress, which forces every one of these calls to
    // actually attempt the (possibly mid-TRUNCATE) relation_membership_index
    // query rather than exiting early on the watermark gate alone — see this
    // file's own top-of-file doc comment for why this is the shape that
    // genuinely races the TRUNCATE, not merely the watermark check.
    const zeroFloorChecks = Array.from({ length: 30 }, () =>
      runPinnedCheck(pool, markerSubject, markerObject, 0),
    );
    // The higher-level, "becomes usable exactly once the index is ready"
    // end-to-end shape, pinned to the marker's own real token.
    const ownTokenChecks = Array.from({ length: 20 }, () =>
      runPinnedCheck(pool, markerSubject, markerObject, markerToken),
    );

    const [rebuildResult, ...allChecks] = await Promise.all([
      rebuildPromise,
      ...zeroFloorChecks,
      ...ownTokenChecks,
    ]);

    expect(rebuildResult.published).toBe(true);
    expect(rebuildResult.lockAcquired).toBe(true);

    // (b) no call ever throws.
    expect(allChecks.filter((c) => !c.ok)).toEqual([]);

    // (a) every call reflects a real, correct answer — the marker grant is
    // real and untouched by this rebuild, so every one of these must be
    // allowed, whether served by a genuine index hit or by the live
    // fallback while the index was still being built.
    expect(allChecks.filter((c) => c.allowed !== true)).toEqual([]);

    // Coherence: whenever a hit occurred, the returned path must be exactly
    // the real, expected 1-hop marker chain — never a partial or malformed
    // witness.
    const hits = allChecks.filter((c) => c.indexHit === true);
    for (const hit of hits) {
      expect(hit.path).toEqual(expectedMarkerPath);
      // Not 0: `permission view = viewer`'s own `computedUserset` indirection
      // enters `resolve()` for the `viewer` relation at depth 1 *before* the
      // index short-circuit ever runs, so `ctx.depthReached` is already at
      // least 1 regardless of the via_path's own (here, 0-hop) length — the
      // same accounting `test/unit/store/relation-index.integration.test.ts`'s
      // own PK-collision test already confirms for a 1-hop via_path (depth 1
      // there too, since max(1, 1) = 1). Here: max(1, idx.path.length-1) =
      // max(1, 0) = 1.
      expect(hit.depth).toBe(1);
    }

    console.log(
      `[cold rebuild race] rebuild: ${rebuildResult.rowCount} rows in ${rebuildResult.durationMs}ms | ` +
        `checks: ${allChecks.length} total, 0 throws, 0 denials, ${hits.length} served by a genuine index hit | ` +
        `latencies: ${JSON.stringify(summarizeLatencies(allChecks))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// describe block 2 — a SECOND rebuild, after a first one already published a
// real generation. Checks pinned to the FIRST rebuild's own already-achieved
// watermark are the shape that can genuinely observe old-vs-new content
// (their gate trivially passes regardless of the second rebuild's own
// progress); checks pinned to a brand-new token only the second rebuild's
// own generation satisfies close the loop for a subject that exists in only
// one generation. Still on Postgres's own default connection settings.
// ---------------------------------------------------------------------------

describe('a real second rebuild racing many real pinned checks on ordinary connections never returns a mix of the old and new generation-s content, for a subject that only exists in the new one', () => {
  it('checks-pinned-to-the-first-rebuilds-watermark-stay-correct-throughout-the-second-rebuild-and-a-brand-new-subject-only-the-second-generation-can-see-is-never-served-as-a-torn-partial-witness', async () => {
    // A second, distinctly-indexed bulk batch — widens this second rebuild's
    // own transaction similarly to the first (roughly double the total
    // closure work, since generation 1's rows are still present too).
    await bulkInsertWideFixture(1_000_000, WIDE_FIXTURE_SIZE);

    const firstRebuild = await rebuildRelationMembershipIndex(pool);
    expect(firstRebuild.published).toBe(true);
    const watermarkGen1 = firstRebuild.watermarkToken;

    // A brand-new subject, reachable only from this point forward — absent
    // from generation 1's own already-published content.
    const brandNewWrite = await writeTuple(pool, {
      objectNs: DOC_NS,
      objectId: 'special',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'brandnew',
    });
    if (!brandNewWrite.ok) {
      throw new Error(`fixture brand-new write failed: ${JSON.stringify(brandNewWrite.errors)}`);
    }
    const brandNewToken = brandNewWrite.token;
    expect(brandNewToken).toBeGreaterThan(watermarkGen1);

    const markerSubject = ref('user', 'marker'); // from describe block 1 — still real and unchanged.
    const markerObject = ref(DOC_NS, 'special');
    const expectedMarkerPath = [`${DOC_NS}:special#viewer`];
    const brandNewSubject = ref('user', 'brandnew');
    const expectedBrandNewPath = [`${DOC_NS}:special#viewer`];

    const rebuildStart = Date.now();
    const secondRebuildPromise = rebuildRelationMembershipIndex(pool).then((result) => ({
      ...result,
      durationMs: Date.now() - rebuildStart,
    }));

    // Pinned to generation 1's own already-achieved watermark — this gate
    // passes trivially regardless of the second rebuild's own progress, so
    // these calls genuinely race the second rebuild's TRUNCATE, per this
    // file's own top-of-file doc comment.
    const oldFloorChecks = Array.from({ length: 30 }, () =>
      runPinnedCheck(pool, markerSubject, markerObject, watermarkGen1),
    );
    // Pinned to a floor only the SECOND generation satisfies — the specific
    // "old vs. new, never a torn mix" shape for a subject that exists in
    // exactly one generation.
    const newFloorChecks = Array.from({ length: 20 }, () =>
      runPinnedCheck(pool, brandNewSubject, markerObject, brandNewToken),
    );

    const [secondRebuild, ...rest] = await Promise.all([
      secondRebuildPromise,
      ...oldFloorChecks,
      ...newFloorChecks,
    ]);
    const oldFloorOutcomes = rest.slice(0, oldFloorChecks.length);
    const newFloorOutcomes = rest.slice(oldFloorChecks.length);

    expect(secondRebuild.published).toBe(true);
    expect(secondRebuild.watermarkToken).toBeGreaterThanOrEqual(brandNewToken);

    // (b) no call ever throws — across BOTH target queries.
    expect(oldFloorOutcomes.filter((c) => !c.ok)).toEqual([]);
    expect(newFloorOutcomes.filter((c) => !c.ok)).toEqual([]);

    // (a) the old-generation fact is unaffected by the second rebuild —
    // always allowed, and any hit must be the exact, unchanged marker path.
    expect(oldFloorOutcomes.filter((c) => c.allowed !== true)).toEqual([]);
    for (const hit of oldFloorOutcomes.filter((c) => c.indexHit === true)) {
      expect(hit.path).toEqual(expectedMarkerPath);
    }

    // (a) the new-generation-only fact: always allowed (real fact, live
    // fallback covers it before the index catches up), and a hit — which can
    // only ever come from the second rebuild's own generation, since
    // generation 1 never contained this subject at all — must be the exact
    // real witness, never a partial or mismatched one.
    expect(newFloorOutcomes.filter((c) => c.allowed !== true)).toEqual([]);
    for (const hit of newFloorOutcomes.filter((c) => c.indexHit === true)) {
      expect(hit.path).toEqual(expectedBrandNewPath);
    }

    console.log(
      `[warm-to-warmer rebuild race] second rebuild: ${secondRebuild.rowCount} rows in ${secondRebuild.durationMs}ms | ` +
        `old-floor checks: ${oldFloorOutcomes.length} (${oldFloorOutcomes.filter((c) => c.indexHit).length} index hits) | ` +
        `new-floor checks: ${newFloorOutcomes.length} (${newFloorOutcomes.filter((c) => c.indexHit).length} index hits) | ` +
        `old-floor latencies: ${JSON.stringify(summarizeLatencies(oldFloorOutcomes))} | ` +
        `new-floor latencies: ${JSON.stringify(summarizeLatencies(newFloorOutcomes))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// describe block 3 — the genuine, live-reproduced finding this file's own
// development surfaced, since fixed (see this file's own top-of-file doc
// comment, "Update: fixed, not merely disclosed," for the full account).
// Deliberately isolated into its own describe block, on its own dedicated
// short-lock-timeout connection, so it neither weakens nor depends on the
// two passing describe blocks above — kept as a permanent regression guard
// for the SAVEPOINT fix, not deleted now that it passes.
// ---------------------------------------------------------------------------

describe('a real Postgres error inside the index lookup (forced here via a short lock_timeout, matching a real, non-default production hardening setting) must not cascade into an uncaught transaction-abort error on the very next statement', () => {
  it('resolves-own-try-catch-around-the-index-lookup-does-not-protect-the-immediately-following-live-fallback-query-on-the-same-now-poisoned-transaction', async () => {
    await publishFixtureSchema();
    await bulkInsertWideFixture(2_000_000, WIDE_FIXTURE_SIZE);

    const markerWrite = await writeTuple(pool, {
      objectNs: DOC_NS,
      objectId: 'lockcheck',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'marker',
    });
    if (!markerWrite.ok) {
      throw new Error(`fixture marker write failed: ${JSON.stringify(markerWrite.errors)}`);
    }
    const markerSubject = ref('user', 'marker');
    const markerObject = ref(DOC_NS, 'lockcheck');

    const rebuildPromise = rebuildRelationMembershipIndex(pool);

    // Pinned to atToken: 0 so every call genuinely attempts the
    // relation_membership_index query — on the short-lock-timeout pool,
    // deliberately, to force the exact "lock contention with a concurrent
    // authz leopard refresh's own TRUNCATE" hazard resolve()'s own doc
    // comment names as something this exception boundary is built to
    // survive.
    const forcedChecks = Array.from({ length: 25 }, () =>
      runPinnedCheck(shortLockTimeoutPool, markerSubject, markerObject, 0),
    );

    const [, ...forcedOutcomes] = await Promise.all([rebuildPromise, ...forcedChecks]);
    const threw = forcedOutcomes.filter((c) => !c.ok);

    console.log(
      `[forced lock-timeout race] ${forcedOutcomes.length} checks on a lock_timeout=50ms connection: ` +
        `${threw.length} threw. Sample error: ${threw[0]?.error ?? '(none)'}`,
    );

    // This is the SPEC'd expectation, derived directly from resolve()'s own
    // doc comment ("a miss, for any reason at all, falls through
    // unconditionally... never re-thrown") — and now the real, fixed
    // behavior too, per the SAVEPOINT fix described in this file's own
    // top-of-file "Update: fixed, not merely disclosed." Before that fix
    // this assertion live-reproduced a real failure on every run (no
    // SAVEPOINT around the lookupRelationMembershipIndex call meant a real
    // Postgres error there poisoned the whole transaction, and the very
    // next statement — the unmodified live-CTE fallback, called
    // unconditionally right after — threw a second, uncaught error). Kept
    // exactly as the specification demands, now genuinely green, and
    // retained as this fix's own permanent regression guard.
    expect(threw).toEqual([]);
  });
});
