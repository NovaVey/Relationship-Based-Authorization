/**
 * D-144 (expiring tuples) against a real Postgres — the actual proof this
 * feature exists to pass, not a mocked stand-in for one. `writeTuple`'s own
 * write-time validation (`validateExpiresAt`) rejects an already-past
 * `expiresAt`, so this file simulates real time passing the same way
 * `audit.integration.test.ts`'s own tampering fail-check does: a raw SQL
 * `UPDATE` against an already-committed row, run directly against the
 * container, entirely outside `writeTuple`/the CLI/the API.
 *
 * Two stories, both against the real, unmodified `productionCheck`/
 * `performCheck`:
 *   1. A live, not-yet-expired tuple grants access; the identical tuple,
 *      once its `expires_at` is in the past, is treated as though it had
 *      been deleted — `allowed` flips from true to false with no write to
 *      `relation_tuples` beyond the raw `UPDATE` that simulates the clock
 *      passing, and `expand()`'s own resolved tree agrees.
 *   2. The cache-safety fix (`src/audit/checks.ts`): an ALLOWED result that
 *      touched a live expiring tuple is never written into a real
 *      `CheckCache`, so a raw `UPDATE` expiring that tuple immediately
 *      after is reflected on the very next check — not masked by a stale
 *      cache entry for however long `CHECK_CACHE_TTL_MS` would otherwise
 *      allow.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../../src/store/tuples.js';
import { publishSchema } from '../../../../src/schema/publish.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import { performCheck } from '../../../../src/audit/checks.js';
import { expand } from '../../../../src/audit/expand.js';
import { CheckCache, buildCacheKey } from '../../../../src/resolve/production/cache.js';
import { runMigrations } from '../../../../src/store/migrate.js';
import { env } from '../../../../src/config/env.js';
import { closePool } from '../../../../src/store/client.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let verifyPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  verifyPool = new Pool({ connectionString: container.getConnectionUri() });
  verifyPool.on('error', (err) => {
    // pg's own documented contract — see this repo's every other
    // integration test's identical note: an idle client hitting a
    // background/network-level error (most commonly this file's own
    // container being stopped in afterAll) crashes the whole run with an
    // unhandled 'error' event otherwise, even though every real assertion
    // already passed.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(verifyPool, MIGRATIONS_DIR);
  env.DATABASE_URL = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await verifyPool.end();
  await container.stop();
});

afterEach(async () => {
  await closePool();
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(verifyPool, t);
  if (!result.ok)
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(verifyPool, source);
  if (!result.ok) throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
}

/** Simulates real time passing an already-written tuple's own expires_at — a raw SQL UPDATE, entirely outside writeTuple (whose own validateExpiresAt would reject writing an already-past expiresAt directly). */
async function expireTupleNow(objectNs: string, objectId: string, relation: string): Promise<void> {
  await verifyPool.query(
    `update relation_tuples set expires_at = now() - interval '1 second'
     where object_ns = $1 and object_id = $2 and relation = $3`,
    [objectNs, objectId, relation],
  );
}

describe('a real expiring tuple grants access while live, and is treated as absent once its own expires_at has passed — check and expand agree', () => {
  it('productioncheck-and-expand-both-flip-from-granted-to-absent-purely-from-a-real-expires_at-crossing-with-no-relation_tuples-write', async () => {
    const ns = uniqueName('doc');
    const objectId = uniqueName('obj');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );

    await writeOk({
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'erin',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const before = await productionCheck(
      verifyPool,
      { ns: 'user', id: 'erin' },
      { ns, id: objectId },
      'view',
    );
    expect(before.allowed).toBe(true);
    expect(before.touchedExpiringTuple).toBe(true);

    const treeBefore = await expand(verifyPool, { ns, id: objectId }, 'view');
    expect(JSON.stringify(treeBefore)).toContain('erin');

    // The actual fail-check: time passing, simulated by a raw SQL UPDATE —
    // no call to writeTuple/deleteTuple, no new relation_tuples row.
    await expireTupleNow(ns, objectId, 'viewer');

    const after = await productionCheck(
      verifyPool,
      { ns: 'user', id: 'erin' },
      { ns, id: objectId },
      'view',
    );
    expect(after.allowed).toBe(false);

    // expand()'s own tree must agree with check's own answer — a stale tree
    // still showing an expired grant would be exactly the kind of silent
    // audit-trail/check divergence docs/CONSISTENCY.md's new section warns
    // against.
    const treeAfter = await expand(verifyPool, { ns, id: objectId }, 'view');
    expect(JSON.stringify(treeAfter)).not.toContain('erin');
  });
});

describe('the check-result cache never serves a stale ALLOW past a real expires_at crossing (D-144 cache-safety fix, against real Postgres)', () => {
  it('an-allowed-check-that-touched-a-live-expiring-tuple-is-never-cached-so-an-immediate-expiry-is-reflected-on-the-very-next-check', async () => {
    const ns = uniqueName('doc');
    const objectId = uniqueName('obj');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    await writeOk({
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'frank',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // A real CheckCache with a generous TTL — if this fix were absent, the
    // first ALLOW below would be cached for the full 60 real seconds,
    // masking the immediate expiry this test simulates next.
    const cache = new CheckCache(100, 60_000);
    const subject = { ns: 'user', id: 'frank' };
    const object = { ns, id: objectId };
    const key = buildCacheKey(subject, 'view', object, {});

    const first = await performCheck(verifyPool, subject, object, 'view', {}, cache);
    expect(first.allowed).toBe(true);
    expect(first.touchedExpiringTuple).toBe(true);
    // The actual proof of the fix: never written into the cache.
    expect(cache.get(key)).toBeUndefined();

    await expireTupleNow(ns, objectId, 'viewer');

    const second = await performCheck(verifyPool, subject, object, 'view', {}, cache);
    // A wrongly-cached first result would have returned `allowed: true`
    // here — the cache is still well within its own 60s TTL. Getting the
    // real, freshly-recomputed answer instead is exactly what "never
    // cached" has to mean in practice, not just in the object identity
    // asserted above.
    expect(second.allowed).toBe(false);
  });
});
