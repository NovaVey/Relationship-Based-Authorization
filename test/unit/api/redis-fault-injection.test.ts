/**
 * A real Redis outage, end to end through the real HTTP API — closing
 * `docs/CAPABILITY-GAPS.md`'s "Fault injection above the storage seam"
 * finding: both Redis-backed mechanisms (`@fastify/rate-limit`'s own
 * bundled Redis store, and this project's own hand-rolled `authFloodGuard`
 * via `RedisFloodStore`) already failed **closed** before this file
 * existed, but neither path had any test coverage at all, and both
 * produced a bare `500 internal_error` rather than this codebase's own
 * established `503 infrastructure_unavailable` convention for "a real
 * dependency is unreachable" — indistinguishable, on the wire, from a
 * genuine unanticipated bug in this service's own code. See
 * `src/api/server.ts`'s own `authFloodGuard` and `setErrorHandler` doc
 * comments for the fix these tests pin.
 *
 * **A real `ioredis` client, not a hand-mocked object — deliberately.**
 * `@fastify/rate-limit`'s own bundled `RedisStore` calls
 * `this.redis.defineCommand(...)` in its own constructor (confirmed by
 * reading `node_modules/@fastify/rate-limit/store/RedisStore.js` directly)
 * to register a custom Lua-script command — a plain `{ eval: vi.fn() }`
 * fake (this file's own sibling, `redis-store.test.ts`, uses exactly that
 * shape for `RedisFloodStore` alone) has no `defineCommand` method at all,
 * so it cannot stand in for what the global rate-limiter's own store
 * construction needs. A real `Redis` instance satisfies both mechanisms at
 * once; `lazyConnect: true` + `maxRetriesPerRequest: 1` + a disabled
 * `retryStrategy` (none of which `createRedisClient` itself sets, since
 * real production *wants* to keep retrying a transient blip — see that
 * function's own doc comment) makes the first real command against an
 * always-refused local port reject in single-digit milliseconds,
 * confirmed live before writing these tests, matching this project's own
 * established "real client, tuned for fast deterministic failure" pattern
 * (`test/isolation/*-concurrent-rebuild.integration.test.ts`'s own
 * short-`lock_timeout` Postgres connection, applied here to Redis).
 * Injected via `buildServer`'s own `options.redisClient` test-only
 * override (`src/api/server.ts`), never a real `REDIS_URL`/real Redis
 * server — this is a fast, DB-free (Postgres-free, in this file's case —
 * the fake `pool` below is never actually queried, since every request
 * here is rejected before any route handler runs) unit-level test.
 *
 * **The two describe blocks below cleanly isolate the two Redis call
 * sites — confirmed live via a deliberate fail-check on each, not assumed
 * from reading `server.ts` alone.** Every *gated* route (writes,
 * `/check`/`/expand`) sets its own `config.rateLimit.hook: 'preHandler'`
 * (`writeRateLimit`/`gatedReadRateLimit`, `src/api/server.ts` — D-065's own
 * "must run after auth, not before" reasoning) — so `@fastify/rate-limit`'s
 * own check for these routes is appended to the *same* `preHandler` array
 * as `[authFloodGuard, requireAdminAuth]`, running *after* both, per
 * Fastify's own registration-order-within-a-stage execution. Since
 * `authFloodGuard` already sends a response and returns on a Redis
 * failure, the rate-limiter's own later preHandler-stage check for these
 * routes never runs at all — `authFloodGuard`'s own catch is the only
 * thing protecting a gated route, confirmed by temporarily removing just
 * that catch (leaving the `setErrorHandler` heuristic untouched): the
 * gated-route test below immediately broke (500), proving it depends on
 * `authFloodGuard`'s own fix specifically, not on the heuristic. The
 * *ungated* routes (`/schema/compile`, `/health`) have no route-level
 * `config.rateLimit` override at all, so the global registration's own
 * default hook (`'onRequest'`, unset by `server.ts`) is what runs — the
 * only thing that can fail for these routes, confirmed the same way:
 * temporarily removing just the `setErrorHandler` heuristic (leaving
 * `authFloodGuard`'s own catch untouched) broke both ungated-route tests
 * below, while the gated-route test stayed green.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Redis } from 'ioredis';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ADMIN_KEY = 'redis-fault-injection-admin-key';

/** Never actually queried — every request in this file is rejected before any route handler runs, so a real Postgres connection is never needed. */
function fakePool(): Pool {
  return { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool;
}

/**
 * A real `ioredis` client pointed at a genuinely unreachable local address,
 * tuned for fast, deterministic failure — see this file's own top-of-file
 * doc comment for why `createRedisClient` itself is never used here.
 * `65535` is never a real listening port in this test environment (the
 * same "unassigned, always-refused" reasoning `redis-store.test.ts`'s own
 * `createRedisClient` tests already establish for port `1`) — a different
 * port purely so this file's own connection attempts are never confused
 * with that file's, should both run concurrently.
 */
function brokenRedisClient(): Redis {
  const client = new Redis({
    host: '127.0.0.1',
    port: 65535,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // Required — see `createRedisClient`'s own doc comment (`src/api/
  // redis-store.ts`) for why an unhandled `'error'` event would otherwise
  // crash this entire test process. `lazyConnect: true` means no
  // connection is attempted until the first real command below, so this
  // listener is armed well before that can happen.
  client.on('error', () => {});
  return client;
}

let app: FastifyInstance | undefined;
let redisClient: Redis | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await redisClient?.quit().catch(() => undefined);
  redisClient = undefined;
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
});

describe('a gated write route, with Redis genuinely unreachable, is rejected 503 infrastructure_unavailable — never a bare 500, never a false 429', () => {
  it('post-tuples-with-a-valid-admin-key-against-a-broken-redis-client-returns-503-not-500-or-429', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    redisClient = brokenRedisClient();
    app = await buildServer(fakePool(), { logger: false, redisClient });

    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: 'document',
        objectId: 'readme',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('infrastructure_unavailable');
    // Never falsely claims Postgres — the whole point of
    // infrastructureUnavailableError's own new `service` parameter
    // (src/api/errors.ts).
    expect(body.error.message).toMatch(/^Redis:/);
  });
});

describe('an ungated route (no authFloodGuard in its own preHandler chain at all), with Redis genuinely unreachable, is still rejected 503 by the global rate-limiter alone', () => {
  it('post-schema-compile-with-no-credential-at-all-against-a-broken-redis-client-still-returns-503-proving-the-global-limiters-own-path-independent-of-authfloodguard', async () => {
    redisClient = brokenRedisClient();
    app = await buildServer(fakePool(), { logger: false, redisClient });

    // /schema/compile requires no admin key and has no requireAdminAuth
    // preHandler — see test/unit/api/rate-limit.test.ts's own identical
    // characterization of this exact route, reused here for the identical
    // reason: it is governed by the bare global rate-limiter alone, with
    // no authFloodGuard anywhere in its own preHandler chain to confound
    // which mechanism actually produced this response.
    const res = await app.inject({
      method: 'POST',
      url: '/schema/compile',
      payload: { source: 'namespace document {\n  relation viewer: user\n}' },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('infrastructure_unavailable');
    expect(body.error.message).toMatch(/^Redis:/);
  });
});

describe('a real Redis outage on the global rate-limiter path never falls back to a bare 500, confirming the disclosed heuristic in setErrorHandler actually engages', () => {
  it('the-503-response-above-is-never-a-500-even-though-the-underlying-ioredis-error-carries-no-statuscode-of-its-own', async () => {
    redisClient = brokenRedisClient();
    app = await buildServer(fakePool(), { logger: false, redisClient });

    const res = await app.inject({ method: 'GET', url: '/health' });

    // /health requires no credential and has no authFloodGuard either —
    // the third distinct ungated route shape, confirming this isn't
    // specific to /schema/compile.
    expect(res.statusCode).toBe(503);
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).not.toBe(429);
  });
});
