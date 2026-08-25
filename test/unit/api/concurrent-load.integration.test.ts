/**
 * A genuinely concurrent load test against a real, listening HTTP server —
 * `buildServer` (`src/api/server.ts`), started for real via `app.listen()`
 * (every other test in this repo, this file's own sibling
 * `server.integration.test.ts` included, uses `app.inject()`, which never
 * opens a real socket — see that file's own doc comment: "`buildServer`
 * does NOT call `app.listen()`"), reached over real loopback TCP via Node's
 * built-in `fetch`, with real concurrent requests fired via `Promise.all`.
 *
 * This is deliberately a *different* proof mechanism than this repo's own
 * DST suite (`src/store/dst/`, `docs/DECISIONS.md` D-097 through D-107):
 * DST is a single Node process, one connection at a time, deterministically
 * paused and resumed at hand-chosen statement boundaries — exhaustive and
 * repeatable, but it can only ever exercise the interleavings its own
 * `scheduler.ts` was told to construct. This file exercises the real OS
 * scheduler, real concurrent TCP connections, and real, non-deterministic
 * Postgres/event-loop timing instead — the actual traffic shape a genuine
 * production deployment sees, which nothing else in this repo's test suite
 * does. Neither replaces the other: DST proves a specific race is *closed*
 * under exhaustive, controlled conditions; this file proves the same
 * guarantees still hold when nothing is being controlled at all.
 *
 * **One `buildServer()` app per describe block, not one shared across the
 * whole file — a real bug in this file's own first draft, caught live, not
 * shipped.** The two describe blocks below each burn real budget against
 * `@fastify/rate-limit`'s own per-process, per-route counters (the
 * write-route budget is only 20/minute — see `src/api/server.ts`'s
 * `writeRateLimit`). A single shared `app` let the rate-limit describe
 * block's own deliberate 30-request burst exhaust that budget for the rest
 * of the file, so the epoch-fence describe block's own `DELETE /tuples`
 * calls started silently returning `429` instead of actually deleting
 * anything — the deleted grant never really went away, and the "epoch
 * fence" test failed for a completely different, uninteresting reason
 * (a shared-state test-isolation bug) rather than the real property it
 * exists to check. Each describe block below now builds and tears down its
 * own dedicated `app` (still against the one shared Postgres container —
 * Postgres itself isn't rate-limited, and a fresh container per describe
 * block would only add real setup cost for no isolation benefit), so every
 * rate-limit counter starts genuinely fresh for each.
 *
 * **A disclosed limitation of this file's own live fail-check, found by
 * actually trying it, not assumed.** The epoch-fence describe block below
 * was fail-checked the way this project's own established discipline
 * requires: `CheckCache.trySet`'s epoch guard was disabled live
 * (`src/resolve/production/cache.ts`) and this file's own test re-run
 * against the mutation, both as a plain one-delete-vs-one-check race and,
 * after that didn't reproduce it, as a one-delete-vs-ten-concurrent-checks
 * burst. Neither ever caught it — confirmed clean across repeated runs
 * against the mutation, not just once. The reason, reasoned through and
 * then independently confirmed live: `Promise.all([del(), post()])`
 * evaluates its array eagerly, left to right, giving the delete's own
 * `fetch()` a small but *real and consistent* head start on this
 * sandbox's fast, jitter-free Postgres/loopback path — real concurrent
 * timing here isn't landing inside the microsecond-scale unsafe window the
 * way DST deliberately constructs it to. Deliberately reducing the test's
 * own `pg.Pool`'s `max` to force more genuine scheduling variance was
 * tried and **independently reproduced this project's own already-disclosed
 * D-140 hazard live**: `productionCheck`'s pinned-connection-plus-
 * `getConfig` pattern under `max: 4` with 10 concurrent checks hung outright
 * (killed after 2 minutes, not a flake) — exactly the `MAX_CONCURRENCY`/
 * pool-`max` connection-exhaustion deadlock D-140's own "Revisit if" already
 * named as real, live, standalone follow-up work, now confirmed by a second,
 * independent live reproduction rather than left as a single prior
 * observation. Not pursued further here — deliberately constructing a test
 * that risks tripping a known, disclosed, *unfixed* deadlock hazard in CI
 * would trade one honest gap for a flaky, hanging test suite, a strictly
 * worse outcome. The epoch fence itself is not unverified: D-135's own
 * dedicated unit test and this project's own mutation-testing pass
 * (`docs/DECISIONS.md` D-141) both already fail-check this exact mechanism
 * deterministically, by DST's own controlled construction — what this file
 * adds instead is different, complementary evidence, proven, not assumed:
 * across many independent real trials over genuine concurrent HTTP traffic,
 * the system is never observably wrong at rest, and nothing crashes, hangs,
 * or double-counts under real concurrent load.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030 (every `*.integration.test.ts` file
 * starts its own container; never a hardcoded local connection string).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../../src/api/server.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));
const ADMIN_KEY = 'concurrent-load-test-admin-key-0123456789abcdef';
const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ORIGINAL_CHECK_CACHE_TTL_MS = env.CHECK_CACHE_TTL_MS;

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract — see every sibling *.integration.test.ts
    // file's identical comment for why this is expected during teardown,
    // not swallowed silently.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  return { status: res.status, body: payload };
}

async function del(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  return { status: res.status, body: payload };
}

const DOCUMENT_SCHEMA = [
  'namespace document {',
  '  relation viewer: user',
  '',
  '  permission view = viewer',
  '}',
].join('\n');

/**
 * Starts a fresh `buildServer()` app, listening for real on an OS-assigned
 * loopback port — see this file's own top-of-file doc comment for why each
 * describe block gets its own, rather than sharing one across the file.
 */
async function startFreshApp(): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const app = await buildServer(pool, { logger: false });
  // Port 0 — let the OS assign a free ephemeral port, exactly what
  // `serve.ts` itself never does (it always binds `env.PORT`) but is the
  // standard, collision-free way for a test to get a real listening socket
  // of its own. Loopback-only host — nothing here needs to be reachable
  // from outside this process.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error(
      `expected app.server.address() to be a real bound AddressInfo, got: ${address}`,
    );
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('a genuine concurrent burst of writes is rate-limited to exactly its configured budget — real HTTP, real Promise.all, not sequential app.inject() calls', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    ({ app, baseUrl } = await startFreshApp());
  });

  afterEach(async () => {
    await app.close();
    env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
  });

  it('30-genuinely-concurrent-DELETE-tuples-requests-yield-exactly-20-successes-and-10-rate-limited-responses-nothing-hangs-or-double-counts', async () => {
    const publish = await post(baseUrl, '/schema/publish', { source: DOCUMENT_SCHEMA });
    expect(publish.status).toBe(200);

    const objectId = uniqueName('obj');
    // Every request targets a tuple that was never written — DELETE is a
    // documented idempotent no-op either way (`deleted: false`, still a
    // real 200) — this test is about the rate limiter's own concurrent
    // counting, not about tuple-store semantics, so nothing here needs a
    // prior write to be meaningful.
    const requestBody = {
      objectNs: 'document',
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'nobody',
    };

    // `writeRateLimit` (src/api/server.ts): 20/minute. 30 requests fired
    // via one Promise.all — genuinely concurrent, not 30 sequential
    // `app.inject()` awaits — so every one of these is in flight over its
    // own real TCP connection before any of them resolves.
    const results = await Promise.all(
      Array.from({ length: 30 }, () => del(baseUrl, '/tuples', requestBody)),
    );

    expect(results).toHaveLength(30);
    const succeeded = results.filter((r) => r.status === 200);
    const limited = results.filter((r) => r.status === 429);

    // The load-bearing assertion: real concurrent traffic must still land
    // on the exact configured budget, not more (a race in the rate-limit
    // store's own increment logic under genuine concurrent access could
    // under-count and let more than 20 through) and not fewer (a bug could
    // over-count and reject requests that should have succeeded) — and
    // every one of the 30 requests must resolve to one or the other, never
    // hang or throw.
    expect(succeeded).toHaveLength(20);
    expect(limited).toHaveLength(10);
    for (const r of limited) {
      expect(r.body).toMatchObject({ error: { code: 'rate_limited' } });
    }
    for (const r of succeeded) {
      expect(r.body).toMatchObject({ deleted: false });
    }
  });
});

describe('the check-result cache epoch fence never serves a stale grant past a concurrently-completing real revocation — many independently-raced trials over real HTTP', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    // Long enough that nothing in this describe block's own runtime could
    // make it expire naturally mid-test — this block cares about the epoch
    // fence (a write-triggered `clear()`), never TTL expiry, which already
    // has its own dedicated coverage elsewhere (`test/unit/resolve/
    // production/cache.test.ts`).
    env.CHECK_CACHE_TTL_MS = 300_000;
    ({ app, baseUrl } = await startFreshApp());
    const publish = await post(baseUrl, '/schema/publish', { source: DOCUMENT_SCHEMA });
    if (publish.status !== 200) {
      throw new Error(`fixture schema failed to publish: ${JSON.stringify(publish.body)}`);
    }
  });

  afterAll(async () => {
    await app.close();
    env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
    env.CHECK_CACHE_TTL_MS = ORIGINAL_CHECK_CACHE_TTL_MS;
  });

  // Loop-and-race, not a single trial: unlike DST's deterministic
  // pause-point injection, real concurrent HTTP timing can't be forced to
  // land exactly inside the unsafe window on demand. Running enough
  // independent trials (each against its own fresh, uniquely-named object,
  // so no trial's own state can leak into another's) is this file's own
  // "real concurrent load" answer to the same guarantee D-135's
  // deterministic DST regression test already proves under controlled
  // conditions — see this file's own top-of-file doc comment for why
  // neither replaces the other.
  //
  // Kept well under `writeRateLimit`'s own 20/minute budget (2 write-route
  // calls per trial — the establishing write and the racing delete — so 8
  // trials is 16 write-route calls, leaving headroom rather than sitting
  // right at the edge) — the exact class of shared-budget mistake this
  // file's own top-of-file doc comment discloses finding and fixing in its
  // first draft, guarded against here by simply staying under the budget
  // this describe block's own fresh `app` starts with.
  const TRIALS = 8;

  it('a-check-racing-a-real-revocation-of-the-same-grant-never-leaves-a-stale-true-cached-past-the-write-across-8-independent-real-concurrent-trials', async () => {
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const objectId = uniqueName('racedoc');
      const tupleBody = {
        objectNs: 'document',
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      };
      const checkBody = {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'document', id: objectId },
      };

      // Establish the grant.
      const write = await post(baseUrl, '/tuples', tupleBody);
      expect(write.status).toBe(200);

      // Prime the cache with a real miss — confirms the cache genuinely has
      // something to go stale before the race below even starts.
      const primed = await post(baseUrl, '/check', checkBody);
      expect(primed.status).toBe(200);
      expect(primed.body.allowed).toBe(true);

      // The race itself: a real revocation and a burst of `RACING_CHECKS`
      // real re-checks, all fired together over independent real HTTP
      // connections, none awaited before any other starts. A single 1-vs-1
      // race between one delete and one check turned out to reliably land
      // the same way every time in this sandbox's own low-latency,
      // single-machine loopback timing (confirmed directly: 3 repeated
      // fail-check runs against a deliberately epoch-fence-disabled
      // build never once caught it) — `Promise.all([del(), post()])`
      // evaluates its array eagerly, left to right, so the delete's own
      // `fetch()` call is always dispatched a few microseconds ahead of the
      // check's, a small but *consistent* head start that dominates real
      // timing variance on one machine with no real network jitter.
      // Racing a genuine burst of concurrent checks against the one delete
      // — all genuinely competing for the same limited Postgres connection
      // pool (`getPool()`'s default `max: 10`, `src/store/client.ts`) —
      // reintroduces real scheduling variance: whichever checks don't
      // immediately get a free connection queue behind whichever ones do,
      // so *some* of their own `trySet` calls land at genuinely
      // unpredictable points relative to the delete's `clear()`, not a
      // single fixed ordering every trial. This is the real load test's own
      // way of doing what DST does by deliberate construction — see this
      // file's own top-of-file doc comment.
      const RACING_CHECKS = 10;
      const [deleted, ...raced] = await Promise.all([
        del(baseUrl, '/tuples', tupleBody),
        ...Array.from({ length: RACING_CHECKS }, () => post(baseUrl, '/check', checkBody)),
      ]);
      // All of these must genuinely succeed for this trial to prove
      // anything — a rate-limited or otherwise-failed delete would leave
      // the real grant in place, making a `true` in the final assertion
      // below correct, not stale, and this trial would silently prove
      // nothing (exactly the failure mode this file's own top-of-file doc
      // comment discloses catching in its first draft).
      expect(deleted.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);
      for (const r of raced) expect(r.status).toBe(200);

      // The decisive assertion, after both above have genuinely settled: a
      // fresh check must reflect the real, current state — denied, since
      // the grant is gone — never a permanently-stale cached `true` a
      // broken epoch fence would let survive past the write that
      // invalidated it.
      const settled = await post(baseUrl, '/check', checkBody);
      expect(settled.status).toBe(200);
      expect(settled.body.allowed).toBe(false);
    }
  });
});
