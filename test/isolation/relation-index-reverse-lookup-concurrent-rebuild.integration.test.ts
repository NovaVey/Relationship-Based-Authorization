/**
 * The reverse-lookup accelerant for `listObjects` (D-175,
 * `docs/REVERSE-LOOKUP-PROPOSAL.md`) — the isolation-level counterpart to
 * `test/isolation/relation-index-concurrent-rebuild.integration.test.ts`
 * (the Leopard index's own forward-direction proof), same question asked
 * of `fetchReverseIndexCandidates`/`listObjects` instead of
 * `lookupRelationMembershipIndex`/`productionCheck`: a real, unmodified
 * Postgres instance; a rebuild whose transaction window is deliberately
 * widened (a large, generated fixture, never an artificial `pg_sleep`);
 * many real concurrent calls fired throughout that rebuild's transaction
 * lifetime.
 *
 * **Why this file's own race needs a SECOND rebuild against UNCHANGED
 * data, not merely a first cold one — a genuinely different shape from the
 * sibling Leopard file's own two-rebuild design, not copied by rote.**
 * Gate 2 (`fetchReverseIndexCandidates`'s own `watermark >= currentToken()`
 * check, reading `relation_membership_index_state`, a table only ever
 * `UPDATE`d, never `TRUNCATE`d) is what decides whether a call attempts
 * the `relation_membership_index` query at all — and
 * `rebuildRelationMembershipIndex`'s own final `UPDATE ... SET
 * watermark_token = ...` doesn't commit until the very end, alongside the
 * `TRUNCATE`+`INSERT` that populated the table. So for the ENTIRE window a
 * rebuild's transaction is open, any concurrent read of
 * `relation_membership_index_state` still sees the PREVIOUS rebuild's own
 * already-committed watermark value, unchanged. If new writes landed
 * between that previous rebuild and this new one, `currentToken()` has
 * already moved past that stale watermark, so gate 2 correctly misses
 * throughout the whole race — real, but not the race this file exists to
 * force. The one shape that genuinely races the `TRUNCATE` is an operator
 * re-running a rebuild against DATA THAT HASN'T CHANGED since the last one
 * (`fetchReverseIndexCandidates`'s own doc comment already names this
 * exact scenario) — there, the previous rebuild's own watermark already
 * equals `currentToken()`, so gate 2 passes throughout the second
 * rebuild's entire in-flight window, and every racing call genuinely
 * attempts the `relation_membership_index` query while it may be
 * mid-`TRUNCATE`.
 *
 * **A genuinely different, and materially EASIER, correctness shape than
 * the Leopard forward-lookup race — verified live before writing this
 * file's assertions, not assumed by analogy.** A throwaway experiment
 * against this exact sandbox's own real Postgres 16 (two `pg.Pool`
 * connections, one holding an open `TRUNCATE ...; INSERT ...` transaction,
 * the other firing a plain, un-transacted `SELECT` against the same table
 * concurrently) confirmed: a plain, autocommit statement that blocks
 * behind a concurrent `TRUNCATE`'s own `ACCESS EXCLUSIVE` lock, once
 * unblocked, sees the table AFTER the blocking transaction's own commit —
 * fully populated with the NEW generation, never empty, never a torn mix.
 * This is the opposite of `lookupRelationMembershipIndex`'s own situation
 * (`relation-index-concurrent-rebuild.integration.test.ts`'s own top-of-
 * file account): that function's two reads run inside `productionCheck`'s
 * pre-existing `REPEATABLE READ` transaction, whose snapshot is anchored
 * BEFORE the race begins — an older snapshot can never see rows a later
 * `TRUNCATE` re-created, and `TRUNCATE` doesn't participate in per-row MVCC
 * the way `DELETE` does, so that older snapshot sees the table as
 * genuinely empty once unblocked. `fetchReverseIndexCandidates` opens no
 * such transaction at all (see its own doc comment for why no `SAVEPOINT`
 * is needed here either, for the identical underlying reason) — each of
 * its three reads is its own independent, freshly-snapshotted autocommit
 * statement, so a blocked one simply waits, then sees exactly what a
 * fresh, un-raced call would see at that later instant: the complete new
 * generation. **This means the "empty-after-block" hazard gate 3's
 * empty-result rule was written to close never actually manifests via this
 * specific TRUNCATE race for THIS function** — gate 3 still matters (a
 * genuine Postgres error, e.g. a real `lock_timeout`, is still a real
 * possibility, covered by this file's own second `describe` block below),
 * but "blocked, then sees a torn/empty read" specifically is not a hazard
 * this function's own reads are exposed to, unlike its Leopard
 * forward-lookup sibling. Disclosed here as a genuine, verified finding,
 * not silently assumed to match the sibling file's own reasoning.
 *
 * **This project's own established `PostgreSqlContainer` convention**
 * (`docs/DECISIONS.md` D-019/D-030), matching both this file's own direct
 * sibling and every other `*.integration.test.ts` file in this repo.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { listObjects, type EntityRef } from '../../src/audit/list.js';
import {
  fetchReverseIndexCandidates,
  rebuildRelationMembershipIndex,
} from '../../src/store/relation-index.js';
import { runMigrations } from '../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;
/** Same reasoning and same 50ms value as this file's own Leopard-forward-lookup sibling — see that file's own doc comment, point 3. */
let shortLockTimeoutPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const connectionString = container.getConnectionUri();
  pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);

  shortLockTimeoutPool = new Pool({ connectionString, options: '-c lock_timeout=50' });
  shortLockTimeoutPool.on('error', (err) => {
    console.error(
      `short-lock-timeout pool error (expected during container teardown): ${err.message}`,
    );
  });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await shortLockTimeoutPool.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Fixture — same bulk-widening technique as this file's own Leopard-forward
// sibling (raw SQL, bypassing writeTuple, purely to give the rebuild's own
// recursive closure real width/wall-clock duration), plus a handful of real,
// individually-written direct grants to one real subject (`alice`) whose
// exact expected candidate set this file's own assertions can state
// precisely, independent of the bulk fixture's own closure.
// ---------------------------------------------------------------------------

const GROUP_NS = 'rlrace_grp';
const DOC_NS = 'rlrace_doc';
const VIEWER = 'viewer';
const ALICE: EntityRef = { ns: 'user', id: 'alice' };
const MARKER_DOC_IDS = ['aa_marker_1', 'aa_marker_2', 'aa_marker_3', 'aa_marker_4', 'aa_marker_5'];

async function publishFixtureSchema(): Promise<void> {
  const source = [
    `namespace ${GROUP_NS} {`,
    `  relation member: user | ${GROUP_NS}#member`,
    '}',
    '',
    `namespace ${DOC_NS} {`,
    `  relation ${VIEWER}: user | ${GROUP_NS}#member`,
    '}',
  ].join('\n');
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

/** Identical shape to the Leopard-forward sibling file's own `bulkInsertWideFixture` — see that file's own doc comment for why raw SQL, not `writeTuple`, and why this width reliably produces a real, measurable rebuild window on this sandbox's own local Postgres. Every generated subject here is `wide_member`, never `alice` — this fixture exists purely to widen the rebuild, never to contribute to `alice`'s own expected candidate set. */
async function bulkInsertWideFixture(startAt: number, count: number): Promise<void> {
  await pool.query(
    `insert into relation_tuples (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
     select $2, 'd' || i, $5, $3, 'g0_' || i, 'member' from generate_series($1::int, $1::int + $4 - 1) i
     union all
     select $3, 'g0_' || i, 'member', $3, 'g1_' || i, 'member' from generate_series($1::int, $1::int + $4 - 1) i
     union all
     select $3, 'g1_' || i, 'member', $3, 'g2_' || i, 'member' from generate_series($1::int, $1::int + $4 - 1) i
     union all
     select $3, 'g2_' || i, 'member', 'user', 'wide_member', null from generate_series($1::int, $1::int + $4 - 1) i`,
    [startAt, DOC_NS, GROUP_NS, count, VIEWER],
  );
}

const WIDE_FIXTURE_SIZE = 3000;

async function writeMarkerGrants(): Promise<void> {
  for (const id of MARKER_DOC_IDS) {
    const result = await writeTuple(pool, {
      objectNs: DOC_NS,
      objectId: id,
      relation: VIEWER,
      subjectNs: 'user',
      subjectId: 'alice',
    });
    if (!result.ok)
      throw new Error(`fixture marker write failed: ${JSON.stringify(result.errors)}`);
  }
}

interface ListObjectsOutcome {
  ok: boolean;
  ids?: string[];
  truncated?: boolean;
  error?: string;
  latencyMs: number;
}

async function runListObjectsCall(checkPool: Pool): Promise<ListObjectsOutcome> {
  const start = Date.now();
  try {
    const result = await listObjects(checkPool, ALICE, VIEWER, DOC_NS, { useRelationIndex: true });
    return {
      ok: true,
      ids: [...result.objects.map((o) => o.id)].sort(),
      truncated: result.truncated,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, latencyMs: Date.now() - start };
  }
}

interface CandidateOutcome {
  ok: boolean;
  hit?: boolean;
  ids?: string[];
  error?: string;
}

/** Races `fetchReverseIndexCandidates` directly (not only via `listObjects`) purely for observability — proving the race actually reaches the accelerated query (a real mix of hits and misses/blocks), not just that the end-to-end `listObjects` result happens to be correct regardless. */
async function runCandidateCall(checkPool: Pool): Promise<CandidateOutcome> {
  try {
    const result = await fetchReverseIndexCandidates(checkPool, ALICE, VIEWER, DOC_NS, 1000);
    return result.hit
      ? { ok: true, hit: true, ids: [...result.objectIds].sort() }
      : { ok: true, hit: false };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// describe block 1 — a SECOND rebuild against UNCHANGED data (no writes at
// all between the two rebuilds), on ordinary (no lock_timeout) connections —
// this project's actual current configuration. See this file's own
// top-of-file doc comment for why this exact shape, and not a first cold
// rebuild, is what genuinely races gate 2 into attempting the
// relation_membership_index query mid-TRUNCATE.
// ---------------------------------------------------------------------------

describe('a real second rebuild against unchanged data races many real listObjects/fetchReverseIndexCandidates calls through gate 2 while relation_membership_index may be mid-TRUNCATE, and every one still returns the complete, correct set with zero throws', () => {
  it('every-call-fired-throughout-the-seconds-rebuilds-transaction-lifetime-returns-exactly-the-five-real-marker-docs-truncated-false-with-zero-throws', async () => {
    await publishFixtureSchema();
    await bulkInsertWideFixture(1, WIDE_FIXTURE_SIZE);
    await writeMarkerGrants();

    const firstRebuild = await rebuildRelationMembershipIndex(pool);
    expect(firstRebuild.published).toBe(true);

    // Sanity: confirm the accelerant genuinely engages and reports the exact
    // expected set once the index is warm and quiescent — otherwise the race
    // below would prove nothing (a fallback-only path staying correct is not
    // evidence the accelerated path itself survives the race).
    const warmCheck = await fetchReverseIndexCandidates(pool, ALICE, VIEWER, DOC_NS, 1000);
    expect(warmCheck).toEqual({
      hit: true,
      objectIds: [...MARKER_DOC_IDS].sort(),
      truncated: false,
    });

    // The race itself: a second rebuild, no intervening writes, so gate 2's
    // watermark check passes throughout this whole transaction's lifetime —
    // see this file's own top-of-file doc comment for why this is the shape
    // that actually races the TRUNCATE, not merely the watermark gate.
    const rebuildStart = Date.now();
    const secondRebuildPromise = rebuildRelationMembershipIndex(pool).then((result) => ({
      ...result,
      durationMs: Date.now() - rebuildStart,
    }));

    const listObjectsCalls = Array.from({ length: 30 }, () => runListObjectsCall(pool));
    const candidateCalls = Array.from({ length: 30 }, () => runCandidateCall(pool));

    const [secondRebuild, listOutcomes, candidateOutcomes] = await Promise.all([
      secondRebuildPromise,
      Promise.all(listObjectsCalls),
      Promise.all(candidateCalls),
    ]);

    expect(secondRebuild.published).toBe(true);
    expect(secondRebuild.watermarkToken).toBe(firstRebuild.watermarkToken); // unchanged data -> unchanged watermark

    // (b) no call ever throws.
    expect(listOutcomes.filter((o) => !o.ok)).toEqual([]);
    expect(candidateOutcomes.filter((o) => !o.ok)).toEqual([]);

    // (a) every listObjects call returns exactly the real, complete set —
    // never fewer than the five real marker docs (a false-negative/torn
    // result), never more (which would itself indicate a different, more
    // basic bug), whether served by a genuine accelerated hit or the live
    // fallback.
    const expectedIds = [...MARKER_DOC_IDS].sort();
    for (const outcome of listOutcomes) {
      expect(outcome.ids).toEqual(expectedIds);
      expect(outcome.truncated).toBe(false);
    }

    // Direct confirmation of the accelerated query's own coherence: every
    // genuine hit among the raced fetchReverseIndexCandidates calls must
    // report the exact real set too — proving this file's own top-of-file
    // "blocked, then sees the complete new generation, never torn" finding
    // holds under real concurrent load, not just the single-reader
    // experiment that first established it.
    const hits = candidateOutcomes.filter((o) => o.hit === true);
    for (const hit of hits) {
      expect(hit.ids).toEqual(expectedIds);
    }

    console.log(
      `[reverse-lookup second-rebuild race] rebuild: ${secondRebuild.rowCount} rows in ${secondRebuild.durationMs}ms | ` +
        `listObjects calls: ${listOutcomes.length}, 0 throws | ` +
        `candidate calls: ${candidateOutcomes.length} (${hits.length} genuine hits, ${candidateOutcomes.length - hits.length} misses/blocked-then-fresh)`,
    );
  });
});

// ---------------------------------------------------------------------------
// describe block 2 — a real Postgres error forced inside the candidate query
// itself (via a short lock_timeout, matching the Leopard-forward sibling's
// own point 3), proving gate 3's catch-and-fall-back genuinely survives a
// real error, not merely a hypothetical one, and that listObjects's own
// fallback still returns the complete, correct set.
// ---------------------------------------------------------------------------

describe('a real Postgres error inside the candidate query itself (forced via a short lock_timeout) is caught as a miss and listObjects still returns the complete, correct result via its own live fallback — never throws', () => {
  it('forced-lock-timeout-errors-inside-fetchReverseIndexCandidates-are-caught-as-a-miss-and-listObjects-falls-back-to-the-complete-correct-set', async () => {
    // A third, distinctly-offset bulk batch, widening the rebuild further so
    // the forced-short-timeout connections reliably hit real lock contention
    // rather than racing to acquire the lock before the rebuild even starts.
    await bulkInsertWideFixture(1_000_000, WIDE_FIXTURE_SIZE);

    const rebuildPromise = rebuildRelationMembershipIndex(pool);

    const forcedListObjectsCalls = Array.from({ length: 25 }, () =>
      runListObjectsCall(shortLockTimeoutPool),
    );
    const forcedCandidateCalls = Array.from({ length: 25 }, () =>
      runCandidateCall(shortLockTimeoutPool),
    );

    const [, listOutcomes, candidateOutcomes] = await Promise.all([
      rebuildPromise,
      Promise.all(forcedListObjectsCalls),
      Promise.all(forcedCandidateCalls),
    ]);

    // fetchReverseIndexCandidates's own contract: it never throws — a real
    // Postgres error from the candidate query itself is gate 3's job to
    // catch, unconditionally. (The watermark/currentToken reads are NOT
    // wrapped — see that function's own doc comment for why a real error
    // there is treated differently — but neither of those two reads is
    // exposed to lock contention against relation_membership_index at all,
    // so this file's own forced short lock_timeout never reaches them.)
    expect(candidateOutcomes.filter((o) => !o.ok)).toEqual([]);

    // listObjects's own end-to-end contract: never throws either, whether
    // the accelerant hit, missed cleanly, or hit a forced real error
    // internally caught as a miss.
    expect(listOutcomes.filter((o) => !o.ok)).toEqual([]);

    // Every call — hit or fallen back — still returns the exact, complete
    // real set. `truncated: true` here is itself the expected, honest
    // answer, not a bug: the forced lock_timeout makes the accelerant miss
    // on every call, so every one of these falls back to
    // `fetchCandidateObjectIds`'s own namespace-wide, `LIST_OBJECTS_MAX_
    // CANDIDATES`-capped scan — and by this point `DOC_NS` holds two full
    // widened bulk batches (6000 non-marker ids) on top of the five real
    // markers, genuinely past that cap. The markers still always survive
    // the cutoff regardless (their `aa_marker_*` ids sort well before every
    // bulk id's `d*` prefix — the ascending-order cutoff this file's own
    // marker-naming was chosen to guarantee), so this is exactly the
    // "truncated, but still correct for the subject that matters" case,
    // never a silent omission.
    const expectedIds = [...MARKER_DOC_IDS].sort();
    for (const outcome of listOutcomes) {
      expect(outcome.ids).toEqual(expectedIds);
      expect(outcome.truncated).toBe(true);
    }

    const hits = candidateOutcomes.filter((o) => o.hit === true);
    const misses = candidateOutcomes.filter((o) => o.hit === false);
    console.log(
      `[reverse-lookup forced lock-timeout race] listObjects calls: ${listOutcomes.length}, 0 throws | ` +
        `candidate calls: ${candidateOutcomes.length} (${hits.length} genuine hits, ${misses.length} misses, 0 throws)`,
    );
  });
});
