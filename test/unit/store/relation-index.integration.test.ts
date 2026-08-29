/**
 * The Leopard index (Phase A) — `docs/LEOPARD-INDEX-PROPOSAL.md` — the
 * LOCALVERIFY-grade live reproduction of Candidates C, F, G end-to-end
 * against real Postgres, per that document's own "Test plan — the third
 * comparison arm" section (the row naming this exact file). Every
 * assertion below is derived from the proposal's own stated candidate
 * properties and from `src/store/relation-index.ts`'s own doc comments —
 * written before this file's author read `src/resolve/production/
 * resolver.ts`'s integration point in detail, per this project's own
 * test-authoring discipline (`.claude/agents/test-author.md`,
 * `.claude/commands/build-authz-service.md` §14).
 *
 * **This project's own established `PostgreSqlContainer` convention
 * (`docs/DECISIONS.md` D-019/D-030)** — its own dedicated ephemeral
 * Postgres *server*, not merely a dedicated database within a shared one,
 * which trivially satisfies the isolation concern below with no manual
 * bootstrap of its own. **Corrected here, not the same as first shipped:**
 * an earlier version of this file (and its sibling,
 * `test/isolation/relation-index-concurrent-rebuild.integration.test.ts`)
 * hand-rolled an ephemeral-database-within-an-existing-server mechanism
 * instead, justified by this being written in a sandbox with no outbound
 * Docker-registry access — a real constraint on the sandbox that authored
 * it, but the wrong constraint to design the *shipped* file around: CI
 * runs every other `*.integration.test.ts` file in this repo against a
 * real container with no such limitation, and that hand-rolled mechanism
 * requires a pre-existing `DATABASE_URL`-reachable server CI never
 * provisions for this job — confirmed live, the first CI run of this file
 * failed with exactly that "DATABASE_URL must be set" error while every
 * other, container-based integration file in the same job passed. Fixed
 * by adopting the same convention as everything else.
 *
 * **Why this file needs its own dedicated database at all** (now trivially
 * true, kept for context): `relation_membership_index`/`relation_
 * membership_index_state` are singleton, whole-database-global tables
 * (one row, one table, `docs/LEOPARD-INDEX-PROPOSAL.md`'s own deliberate
 * design) that every `rebuildRelationMembershipIndex` call truncates and
 * repopulates from scratch. This file's own sibling
 * (`relation-index-concurrent-rebuild.integration.test.ts`) also calls
 * `rebuildRelationMembershipIndex` against the same-shaped global tables —
 * running both against one shared database would make the two files race
 * each other's rebuilds nondeterministically. A dedicated container per
 * file closes this exactly the way every other file's own isolation
 * already works.
 */
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, deleteTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { productionCheck, type EntityRef } from '../../../src/resolve/production/resolver.js';
import {
  rebuildRelationMembershipIndex,
  lookupRelationMembershipIndex,
  RELATION_INDEX_REFRESH_LOCK_CLASSID,
  RELATION_INDEX_REFRESH_LOCK_OBJID,
} from '../../../src/store/relation-index.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract — see the identical comment in every
    // sibling *.integration.test.ts file in this repo.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Fixture helpers — matching this repo's own established integration-test
// conventions (see e.g. `test/unit/resolve/production/mechanism-2-exclusion-
// depth-ceiling.integration.test.ts`, `test/unit/resolve/production/
// expiring-tuples.integration.test.ts`).
// ---------------------------------------------------------------------------

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): TupleKey {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

async function writeOk(t: TupleKey): Promise<{ token: number }> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
  return { token: result.token };
}

/** `groupNs#member` nests itself; `docNs#viewer` accepts a plain user or a `groupNs#member` userset — the same shape `mechanism-2-exclusion-depth-ceiling.integration.test.ts` already establishes for exercising mechanism 2. */
function nestedGroupSchemaSource(groupNs: string, docNs: string): string {
  return [
    `namespace ${groupNs} {`,
    `  relation member: user | ${groupNs}#member`,
    '}',
    '',
    `namespace ${docNs} {`,
    `  relation viewer: user | ${groupNs}#member`,
    '  permission view = viewer',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Candidate: the PK-collision fix — two different frontier nodes under one
// root both granting the identical subject must not crash the rebuild, and
// the surviving row must be one real, coherent witness (never a via_path
// from one candidate paired with a min_expires_at aggregated across both).
// `docs/LEOPARD-INDEX-PROPOSAL.md`, "The rebuild," step 3's own "second
// correction."
// ---------------------------------------------------------------------------

describe('two different frontier nodes under one root both granting the identical subject do not crash the rebuild, and the surviving row stays one real, coherent witness', () => {
  it('a-shorter-non-expiring-path-and-a-longer-expiring-path-to-the-same-subject-under-one-root-survive-the-rebuild-as-a-single-row-whose-via-path-and-min-expires-at-both-belong-to-the-shorter-winning-path', async () => {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    await publishOk(nestedGroupSchemaSource(groupNs, docNs));

    // Short path (1 hop, via_path length 2): doc:d#viewer -> group:ga#member -> plain grant to
    // alice, no expiry.
    await writeOk(tuple(docNs, docId, 'viewer', groupNs, 'ga', 'member'));
    await writeOk(tuple(groupNs, 'ga', 'member', 'user', 'alice'));

    // Long path (2 hops, via_path length 3): doc:d#viewer -> group:gB#member ->
    // group:gC#member -> plain grant to the SAME alice, WITH a real future expiry — if the
    // rebuild's PK-collision fix silently fell back to an independently-aggregated
    // `min(min_expires_at)` alongside an arbitrary `via_path`, this expiry would leak onto the
    // winning (short, non-expiring) row.
    const longPathExpiry = new Date(Date.now() + 60_000);
    await writeOk(tuple(docNs, docId, 'viewer', groupNs, 'gb', 'member'));
    await writeOk(tuple(groupNs, 'gb', 'member', groupNs, 'gc', 'member'));
    const lastWrite = await writeTuple(pool, {
      ...tuple(groupNs, 'gc', 'member', 'user', 'alice'),
      expiresAt: longPathExpiry,
    });
    if (!lastWrite.ok) throw new Error(`fixture write failed: ${JSON.stringify(lastWrite.errors)}`);

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.lockAcquired).toBe(true);
    expect(rebuildResult.published).toBe(true);

    const { rows } = await pool.query<{ via_path: string[]; min_expires_at: Date | null }>(
      `select via_path, min_expires_at from relation_membership_index
       where object_ns = $1 and object_id = $2 and relation = 'viewer'
         and subject_ns = 'user' and subject_id = 'alice'`,
      [docNs, docId],
    );
    // Exactly one surviving row — no unique-constraint crash on the PK collision, and no
    // duplicate either.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The shortest real candidate wins deterministically, never the longer one — matching
    // `fetchReachableFrontier`'s own "shortest available, never fabricated" BFS ordering.
    expect(row.via_path).toEqual([`${docNs}:${docId}#viewer`, `${groupNs}:ga#member`]);
    // The load-bearing coherence assertion: min_expires_at genuinely belongs to the winning
    // (short, non-expiring) via_path, not an aggregate min() computed independently across
    // both candidates — which would have wrongly produced a non-null value here.
    expect(row.min_expires_at).toBeNull();

    // End-to-end confirmation via the real production check: an index-served ALLOW for this
    // exact query must report the same short, 1-hop path, not the longer one.
    const checkResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      { atToken: rebuildResult.watermarkToken, useRelationIndex: true },
    );
    expect(checkResult.allowed).toBe(true);
    if (checkResult.allowed) {
      expect(checkResult.indexHit).toBe(true);
      // remainingDepth spends 1 level entering `viewer`; the winning via_path is 1 hop, so the
      // reported depth must be 1, not the longer candidate's 2.
      expect(checkResult.depth).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Candidate F: an index hit longer than the caller's own maxDepth must fall
// back to the live resolver instead of silently overriding that caller's
// narrower budget. `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Candidate F."
// ---------------------------------------------------------------------------

describe('an index hit whose stored via_path is longer than the caller-s own maxDepth falls back to the live resolver instead of silently overriding the caller-s narrower budget', () => {
  async function buildThreeHopFixture(): Promise<{
    groupNs: string;
    docNs: string;
    docId: string;
    watermarkToken: number;
  }> {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    await publishOk(nestedGroupSchemaSource(groupNs, docNs));
    // doc:d#viewer -> g0#member -> g1#member -> g2#member -> plain grant to zara.
    // via_path = [doc#viewer, g0#member, g1#member, g2#member] — length 4, i.e. 3 hops.
    await writeOk(tuple(docNs, docId, 'viewer', groupNs, 'g0', 'member'));
    await writeOk(tuple(groupNs, 'g0', 'member', groupNs, 'g1', 'member'));
    await writeOk(tuple(groupNs, 'g1', 'member', groupNs, 'g2', 'member'));
    await writeOk(tuple(groupNs, 'g2', 'member', 'user', 'zara'));

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);
    return { groupNs, docNs, docId, watermarkToken: rebuildResult.watermarkToken };
  }

  it('a-direct-lookup-with-maxdepth-one-hop-short-of-the-stored-3-hop-via-path-misses', async () => {
    const { docNs, docId, watermarkToken } = await buildThreeHopFixture();
    const result = await lookupRelationMembershipIndex(
      pool,
      { ns: docNs, id: docId },
      'viewer',
      { ns: 'user', id: 'zara' },
      2, // one hop short of the real 3-hop path
      watermarkToken,
    );
    expect(result.hit).toBe(false);
  });

  it('a-direct-lookup-with-maxdepth-exactly-covering-the-stored-3-hop-via-path-hits-confirming-the-gate-is-not-off-by-one', async () => {
    const { docNs, docId, watermarkToken } = await buildThreeHopFixture();
    const result = await lookupRelationMembershipIndex(
      pool,
      { ns: docNs, id: docId },
      'viewer',
      { ns: 'user', id: 'zara' },
      3, // exactly enough
      watermarkToken,
    );
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.path).toHaveLength(4);
    }
  });

  it('a-pinned-production-check-at-a-too-small-maxdepth-denies-instead-of-being-wrongly-granted-by-an-index-hit-that-ignores-its-own-budget', async () => {
    const { docNs, docId, watermarkToken } = await buildThreeHopFixture();
    // permission `view` spends one depth level entering the `viewer` relation, so
    // remainingDepth = maxDepth - 1. maxDepth: 3 -> remainingDepth: 2, one hop short of the
    // real 3-hop chain — must deny, exactly like the un-accelerated live path already does at
    // this budget (`mechanism-2-exclusion-depth-ceiling.integration.test.ts`'s own precedent).
    const indexed = await productionCheck(pool, ref('user', 'zara'), ref(docNs, docId), 'view', {
      atToken: watermarkToken,
      useRelationIndex: true,
      maxDepth: 3,
    });
    const unaccelerated = await productionCheck(
      pool,
      ref('user', 'zara'),
      ref(docNs, docId),
      'view',
      { atToken: watermarkToken, useRelationIndex: false, maxDepth: 3 },
    );
    expect(unaccelerated.allowed).toBe(false);
    // The actual soundness assertion: turning the index on must never grant something the
    // unaccelerated live path, at the identical budget, correctly denies.
    expect(indexed.allowed).toBe(false);
  });

  it('the-same-pinned-production-check-is-granted-via-a-genuine-index-hit-once-maxdepth-covers-the-real-3-hop-chain', async () => {
    const { docNs, docId, watermarkToken } = await buildThreeHopFixture();
    const result = await productionCheck(pool, ref('user', 'zara'), ref(docNs, docId), 'view', {
      atToken: watermarkToken,
      useRelationIndex: true,
      maxDepth: 4, // remainingDepth: 3, exactly enough
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.indexHit).toBe(true);
      expect(result.depth).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Candidate C: watermark staleness must never produce a false ALLOW — "the
// single most load-bearing property in this document." Full end-to-end via
// a real revocation and a real pinned productionCheck.
// ---------------------------------------------------------------------------

describe('a pinned check past a revocation the index-s own watermark has not observed falls back to the live resolver and denies, never grants on stale index content', () => {
  it('a-revocation-committed-after-the-indexs-watermark-is-never-masked-by-a-stale-index-hit-under-a-check-pinned-past-that-revocations-own-token', async () => {
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    await publishOk(
      [
        `namespace ${docNs} {`,
        '  relation viewer: user',
        '',
        '  permission view = viewer',
        '}',
      ].join('\n'),
    );

    const write = await writeOk(tuple(docNs, docId, 'viewer', 'user', 'carol'));

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);
    const watermark = rebuildResult.watermarkToken;
    expect(watermark).toBeGreaterThanOrEqual(write.token);

    // Sanity: the index genuinely captured this grant before revoking anything — otherwise the
    // "denied after revoke" assertion below would prove nothing (an already-denied check staying
    // denied is not evidence the staleness gate did any work).
    const preRevoke = await productionCheck(pool, ref('user', 'carol'), ref(docNs, docId), 'view', {
      atToken: watermark,
      useRelationIndex: true,
    });
    expect(preRevoke.allowed).toBe(true);
    if (preRevoke.allowed) {
      expect(preRevoke.indexHit).toBe(true);
    }

    // The real revocation — a write the index's own watermark has NOT observed.
    const del = await deleteTuple(pool, tuple(docNs, docId, 'viewer', 'user', 'carol'));
    if (!del.ok) throw new Error(`fixture delete failed: ${JSON.stringify(del.errors)}`);
    expect(del.token).toBeGreaterThan(watermark);

    // Pinned to (at least) the revocation's own token: watermark < atToken, so
    // lookupRelationMembershipIndex must report {hit:false} unconditionally and fall through to
    // the live CTE, which reflects the real, current, revoked state.
    const postRevoke = await productionCheck(
      pool,
      ref('user', 'carol'),
      ref(docNs, docId),
      'view',
      { atToken: del.token, useRelationIndex: true },
    );
    expect(postRevoke.allowed).toBe(false);

    // Direct confirmation of the mechanism itself, not just the end-to-end outcome: the lookup
    // must report a real miss (staleness), not merely "no row" for some unrelated reason.
    const directLookup = await lookupRelationMembershipIndex(
      pool,
      { ns: docNs, id: docId },
      'viewer',
      { ns: 'user', id: 'carol' },
      25,
      del.token,
    );
    expect(directLookup.hit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Candidate G: an index-hit ALLOW must never survive past a stored path's
// own real expiry, independent of watermark freshness — no write-log entry
// is ever produced by an expiry crossing, so the watermark check alone can
// never catch this. Reproduced correctly per this task's own guidance: a
// short REAL expiry and a real sleep past it, re-querying the SAME
// already-built index row with NO intervening rebuild — never a backdated
// `relation_tuples.expires_at`, which `lookupRelationMembershipIndex` never
// re-reads at all (it only ever reads the already-materialized
// `relation_membership_index.min_expires_at`).
// ---------------------------------------------------------------------------

describe('an index-served ALLOW never survives past its own stored tuple-s real expiry, even with no intervening rebuild', () => {
  it('a-short-lived-real-expiry-flips-the-same-already-built-index-row-from-hit-to-miss-purely-from-real-time-passing-with-no-second-rebuild-and-no-relation-tuples-write', async () => {
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    await publishOk(
      [
        `namespace ${docNs} {`,
        '  relation viewer: user',
        '',
        '  permission view = viewer',
        '}',
      ].join('\n'),
    );

    const expiresAt = new Date(Date.now() + 1200); // ~1.2s in the future — short but real.
    const write = await writeTuple(pool, {
      ...tuple(docNs, docId, 'viewer', 'user', 'dana'),
      expiresAt,
    });
    if (!write.ok) throw new Error(`fixture write failed: ${JSON.stringify(write.errors)}`);

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);
    const watermark = rebuildResult.watermarkToken;

    // Immediately after the rebuild: the tuple is still live — a genuine index hit, correctly
    // flagged as touching an expiring tuple.
    const before = await lookupRelationMembershipIndex(
      pool,
      { ns: docNs, id: docId },
      'viewer',
      { ns: 'user', id: 'dana' },
      25,
      watermark,
    );
    expect(before.hit).toBe(true);
    if (before.hit) {
      expect(before.touchedExpiringTuple).toBe(true);
    }

    // Real time passing the tuple's own expires_at — no second rebuild, no relation_tuples
    // write of any kind. `relation_membership_index.min_expires_at` for this row is unchanged;
    // only Postgres's own now() has moved.
    await delay(1800);

    const after = await lookupRelationMembershipIndex(
      pool,
      { ns: docNs, id: docId },
      'viewer',
      { ns: 'user', id: 'dana' },
      25,
      watermark,
    );
    expect(after.hit).toBe(false);

    // End-to-end confirmation via the real production check: pinned to the same watermark, no
    // new writes, the answer must now be denied purely from time passing.
    const check = await productionCheck(pool, ref('user', 'dana'), ref(docNs, docId), 'view', {
      atToken: watermark,
      useRelationIndex: true,
    });
    expect(check.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A concurrent refresh holding the advisory lock — reproduced deterministically
// via a second, real, held connection, not Promise.all timing luck.
// ---------------------------------------------------------------------------

describe('a concurrent refresh holding the advisory lock makes a second rebuild report lockAcquired: false and do no work at all, deterministically', () => {
  it('a-rebuild-attempted-while-the-refresh-lock-is-held-by-another-real-session-returns-lockacquired-false-published-false-and-a-zeroed-result-then-a-fresh-rebuild-succeeds-once-the-lock-is-released', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // The blocking form, on a dedicated, separately-held connection/session — this genuinely
      // holds the lock system-wide (advisory locks are keyed by classid/objid across the whole
      // server, not merely within one connection), so `rebuildRelationMembershipIndex`'s own
      // `pg_try_advisory_xact_lock` on a different session is guaranteed to fail, not merely
      // likely to under Promise.all timing.
      await holder.query('select pg_advisory_xact_lock($1, $2)', [
        RELATION_INDEX_REFRESH_LOCK_CLASSID,
        RELATION_INDEX_REFRESH_LOCK_OBJID,
      ]);

      const blocked = await rebuildRelationMembershipIndex(pool);
      expect(blocked).toEqual({
        watermarkToken: 0,
        rowCount: 0,
        published: false,
        lockAcquired: false,
      });
    } finally {
      // Releases the transaction-scoped advisory lock — Postgres releases it automatically at
      // ROLLBACK/COMMIT, never needing an explicit unlock call.
      await holder.query('ROLLBACK');
      holder.release();
    }

    // Once released, a fresh rebuild must succeed normally — the earlier contention must not
    // have left any lingering state (a stuck lock, a half-applied truncate) behind.
    const after = await rebuildRelationMembershipIndex(pool);
    expect(after.lockAcquired).toBe(true);
    expect(after.published).toBe(true);
  });
});
