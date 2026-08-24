/**
 * Horizontal-scaling readiness (post-audit improvement, opt-in via
 * `env.REDIS_URL`, unset by default — see `src/config/env.ts`'s own doc
 * comment on that variable). Nothing in this file is reachable unless a
 * deployment explicitly sets `REDIS_URL`; a default deployment (this
 * project's own real one, Railway, one `authz-api` service — D-104) never
 * imports past the type-only surface of this module changing behavior.
 *
 * Two independent rate/flood budgets in `src/api/server.ts` are currently
 * scoped to one process's own memory: `@fastify/rate-limit`'s own default
 * `LocalStore`, and this project's own hand-rolled `authFloodGuard` counter
 * (D-105's `LruMap`). Both mean exactly what their names say for a
 * single-instance deployment, and silently mean something *smaller* than
 * configured the moment a deployment runs more than one replica behind the
 * same reverse proxy — `max: 100` per minute becomes, in practice, `max: 100
 * * (replica count)` per minute for the deployment as a whole, since each
 * replica independently thinks it alone is counting every caller. This file
 * gives both mechanisms a real, shared, cross-replica backing store instead:
 * `@fastify/rate-limit` bundles its own `RedisStore` and switches to it
 * automatically once handed a `redis` option (see that plugin's own
 * `index.js` — `settings.redis` truthy is the entire condition), so nothing
 * about that plugin's own registration in `buildServer` needs to change
 * beyond passing the client this file constructs; `authFloodGuard`'s own
 * counter is not a `@fastify/rate-limit` mechanism at all (see that
 * function's own doc comment for why it's hand-rolled), so it needs its own
 * Redis-backed implementation of the identical fixed-window semantics its
 * in-memory `LruMap` version already has — `RedisFloodStore` below.
 */
// Named import, not the default — `ioredis`'s dual CJS/ESM package export
// shape doesn't resolve cleanly to a usable constructor *type* through a
// default import under this project's `NodeNext` module resolution (a real,
// confirmed `tsc` error, not a style preference): `import Redis from
// 'ioredis'` type-checks `Redis` as the whole module namespace object, not
// the class, so `new Redis(...)` and `: Redis` both fail. `ioredis` also
// exports the identical class under the name `Redis` directly
// (`export { default as Redis } from "./Redis"` in its own `index.d.ts`),
// which resolves correctly as both a value and a type.
import { Redis } from 'ioredis';
import { LruMap } from 'toad-cache';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Constructs a real `ioredis` client from `url` and wires a `logger.error`
 * handler onto its `'error'` event before returning. That handler isn't
 * cosmetic: Node's `EventEmitter` *throws* an `'error'` event with no
 * listener attached (a well-known, easy-to-miss footgun, not specific to
 * `ioredis`), so an unhandled connection blip — Redis briefly unreachable, a
 * network hiccup — would otherwise crash this entire process, turning an
 * *optional*, defense-in-depth mechanism into a new, self-inflicted
 * single point of failure for a deployment that only wanted better rate-limit
 * accuracy. `ioredis`'s own default `retryStrategy` keeps attempting to
 * reconnect on its own; this handler only stops a transient failure from
 * being fatal, it doesn't change that retry behavior.
 */
export function createRedisClient(url: string, logger: FastifyBaseLogger): Redis {
  const client = new Redis(url);
  client.on('error', (err: Error) => {
    logger.error(
      { err },
      'Redis client error (rate-limit/flood-guard budgets degrade to per-process only while this persists)',
    );
  });
  return client;
}

/**
 * The interface `authFloodGuard` (`src/api/server.ts`) depends on —
 * deliberately backend-agnostic, so that function's own logic never needs to
 * know or care whether it's counting against local memory or Redis.
 * `increment` both records this call *and* answers the two questions
 * `authFloodGuard` needs to make its own decision: how many requests has
 * `key` made in its current window (including this one), and how many
 * milliseconds remain before that window resets — matching exactly what the
 * pre-existing in-memory-only implementation already computed inline, now
 * named and interfaced so a second implementation can stand in for it
 * without `authFloodGuard` itself changing at all.
 */
export interface FloodStore {
  increment(key: string, windowMs: number): Promise<{ count: number; msUntilReset: number }>;
}

/**
 * The exact fixed-window counting `authFloodGuard` always did, factored out
 * behind `FloodStore` unchanged — same `LruMap` (D-105's own bounded-memory
 * fix), same "first call in a fresh window returns `count: 1` without
 * incrementing an existing entry" behavior. A deployment that never sets
 * `REDIS_URL` gets byte-for-byte the same counting this project has always
 * had; this class exists so `buildServer` can construct *either*
 * implementation behind one shared interface, not because the in-memory
 * logic itself needed to change.
 */
export class InMemoryFloodStore implements FloodStore {
  private readonly state: LruMap<{ count: number; windowStart: number }>;

  constructor(maxEntries: number) {
    this.state = new LruMap(maxEntries);
  }

  // Not `async` — this implementation does no I/O, so there is no `await`
  // for `@typescript-eslint/require-await` to require; `Promise.resolve(...)`
  // alone is what satisfies `FloodStore`'s shared, backend-agnostic
  // interface (`RedisFloodStore` below is the implementation that actually
  // needs to be `async`).
  increment(key: string, windowMs: number): Promise<{ count: number; msUntilReset: number }> {
    const now = Date.now();
    const existing = this.state.get(key);
    if (existing === undefined || now - existing.windowStart >= windowMs) {
      this.state.set(key, { count: 1, windowStart: now });
      return Promise.resolve({ count: 1, msUntilReset: windowMs });
    }
    existing.count += 1;
    return Promise.resolve({
      count: existing.count,
      msUntilReset: Math.max(0, existing.windowStart + windowMs - now),
    });
  }
}

/**
 * `INCR` + conditional `PEXPIRE` + `PTTL`, run as one atomic Lua script via
 * `EVAL` — not three separate round trips — so a fresh key's expiry can
 * never be lost to a race between two concurrent callers both incrementing
 * the same key at the same moment (Redis executes a Lua script to
 * completion without interleaving any other client's commands, the same
 * "make the race structurally impossible, not just unlikely" discipline
 * `acquireWriteLogLock` (`src/store/tuples.ts`) already applies via a
 * Postgres advisory lock for a different race). `windowMs` is passed as
 * `ARGV[1]`, matching `InMemoryFloodStore`'s own per-call `windowMs`
 * parameter — no separate configuration surface for the same value.
 *
 * A key prefix (`authz:flood:`) namespaces this store's own keys in a Redis
 * instance that might be shared with other tenants/uses — never assumed to
 * be a dedicated database.
 */
const FLOOD_KEY_PREFIX = 'authz:flood:';

const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export class RedisFloodStore implements FloodStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; msUntilReset: number }> {
    const raw = await this.redis.eval(
      INCREMENT_WITH_TTL_SCRIPT,
      1,
      FLOOD_KEY_PREFIX + key,
      windowMs,
    );
    const [count, ttl] = raw as [number, number];
    // A `PTTL` of `-1` (key exists with no expiry) or `-2` (key doesn't
    // exist) should never actually happen here — the script itself always
    // sets a `PEXPIRE` on a freshly-created key before ever calling `PTTL` —
    // but falls back to the full `windowMs` rather than a negative/undefined
    // value reaching `authFloodGuard`'s own `Math.ceil(msUntilReset / 1000)`
    // retry-after computation, matching this codebase's own "never trust a
    // downstream value blindly, even one this code itself is supposed to
    // guarantee" discipline (e.g. `assertTokenObservedOnSnapshot`'s own
    // re-verification of a guarantee `productionCheck` already checked once).
    return { count, msUntilReset: ttl >= 0 ? ttl : windowMs };
  }
}
