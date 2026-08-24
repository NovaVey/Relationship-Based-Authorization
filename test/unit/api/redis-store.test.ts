/**
 * `src/api/redis-store.ts` — `InMemoryFloodStore` and `RedisFloodStore`, both
 * implementations of the `FloodStore` interface `src/api/server.ts`'s
 * `authFloodGuard` depends on (`increment(key, windowMs): Promise<{ count,
 * msUntilReset }>`). Zero direct coverage existed before this file — the
 * in-process path was previously only ever exercised indirectly, through
 * `test/unit/api/rate-limit.test.ts`'s and `test/unit/api/server.test.ts`'s
 * own route-level flood-guard tests, none of which ever set `env.REDIS_URL`
 * and so never touched `RedisFloodStore` at all.
 *
 * Written from `redis-store.ts`'s own exported types and doc comments —
 * `InMemoryFloodStore`'s "first call in a fresh window returns count: 1
 * without incrementing an existing entry," `RedisFloodStore`'s own doc
 * comment naming the exact Lua script shape (`INCR` + conditional `PEXPIRE`
 * + `PTTL`, one atomic `EVAL`) and its own disclosed PTTL-fallback behavior
 * for an unexpected negative TTL — not from re-reading the implementation
 * to guess what it "should" do.
 *
 * **`InMemoryFloodStore`: real short windows, no fake timers.** This
 * project doesn't use `vi.useFakeTimers` anywhere else (confirmed by
 * grepping the existing test suite before writing this file), so this
 * suite doesn't introduce it either — real, short `windowMs` values (tens
 * of milliseconds) plus a real, short `setTimeout` wait keep this fast and
 * consistent with the rest of the codebase's own testing style.
 *
 * **`RedisFloodStore`: no real Redis.** Constructed with a fake object
 * satisfying only the one method it actually calls (`eval`, confirmed by
 * reading the class directly) via `vi.fn()` — never a real `ioredis`
 * connection, matching this file's own DB-free scope.
 *
 * **`createRedisClient` is deliberately NOT covered here.** See this file's
 * own final `describe.skip` block for why, and this phase's own final
 * report for the explicit, disclosed gap this leaves.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';

import {
  InMemoryFloodStore,
  RedisFloodStore,
  createRedisClient,
} from '../../../src/api/redis-store.js';

// ---------------------------------------------------------------------------
// InMemoryFloodStore
// ---------------------------------------------------------------------------

describe('InMemoryFloodStore', () => {
  it('the-first-call-for-a-fresh-key-returns-count-1-and-the-full-window-as-msuntilreset', async () => {
    const store = new InMemoryFloodStore(100);
    const result = await store.increment('key-a', 10_000);
    expect(result).toEqual({ count: 1, msUntilReset: 10_000 });
  });

  it('repeated-calls-for-the-same-key-within-the-same-window-increment-the-count-each-time', async () => {
    const store = new InMemoryFloodStore(100);
    const first = await store.increment('key-b', 10_000);
    const second = await store.increment('key-b', 10_000);
    const third = await store.increment('key-b', 10_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(third.count).toBe(3);
  });

  it('different-keys-are-counted-completely-independently-of-one-another', async () => {
    const store = new InMemoryFloodStore(100);
    await store.increment('key-c', 10_000);
    await store.increment('key-c', 10_000);
    const otherKeyFirstCall = await store.increment('key-d', 10_000);
    expect(otherKeyFirstCall.count).toBe(1);
  });

  it('msuntilreset-strictly-decreases-across-repeated-calls-within-the-same-still-open-window', async () => {
    const store = new InMemoryFloodStore(100);
    const windowMs = 5_000;
    const first = await store.increment('key-e', windowMs);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await store.increment('key-e', windowMs);
    expect(second.count).toBe(2);
    expect(second.msUntilReset).toBeLessThan(first.msUntilReset);
    expect(second.msUntilReset).toBeGreaterThan(0);
  });

  it('a-call-after-windowms-has-actually-elapsed-resets-the-key-to-count-1-with-a-fresh-full-window-not-a-continuation-of-the-old-count', async () => {
    const store = new InMemoryFloodStore(100);
    const windowMs = 40;
    const first = await store.increment('key-f', windowMs);
    expect(first.count).toBe(1);
    const second = await store.increment('key-f', windowMs);
    expect(second.count).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 40));

    const afterWindowElapsed = await store.increment('key-f', windowMs);
    expect(afterWindowElapsed).toEqual({ count: 1, msUntilReset: windowMs });
  });
});

// ---------------------------------------------------------------------------
// RedisFloodStore
// ---------------------------------------------------------------------------

/** A fake Redis client satisfying only the one method RedisFloodStore actually calls — `eval`. */
function fakeRedisClient(resolvedEvalValue: unknown): {
  redis: Redis;
  evalMock: ReturnType<typeof vi.fn>;
} {
  const evalMock = vi.fn().mockResolvedValue(resolvedEvalValue);
  const redis = { eval: evalMock } as unknown as Redis;
  return { redis, evalMock };
}

describe('RedisFloodStore: the Lua script and key/arg shape passed to eval', () => {
  it('increment-calls-eval-with-a-lua-script-doing-incr-then-conditional-pexpire-then-pttl-on-keys-1', async () => {
    const { redis, evalMock } = fakeRedisClient([1, 5_000]);
    const store = new RedisFloodStore(redis);

    await store.increment('203.0.113.9', 5_000);

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script] = evalMock.mock.calls[0] as [string, ...unknown[]];
    expect(typeof script).toBe('string');
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('PTTL', KEYS[1])");
  });

  it('increment-calls-eval-with-exactly-one-key-the-flood-key-prefix-plus-the-supplied-key-and-windowms-as-the-one-argv', async () => {
    const { redis, evalMock } = fakeRedisClient([1, 5_000]);
    const store = new RedisFloodStore(redis);

    await store.increment('203.0.113.9', 5_000);

    const [, numKeys, key, windowArg] = evalMock.mock.calls[0] as [string, number, string, number];
    expect(numKeys).toBe(1);
    expect(key).toBe('authz:flood:203.0.113.9');
    expect(windowArg).toBe(5_000);
  });

  it('a-different-key-and-windowms-are-passed-through-to-eval-unmodified', async () => {
    const { redis, evalMock } = fakeRedisClient([1, 60_000]);
    const store = new RedisFloodStore(redis);

    await store.increment('198.51.100.42', 60_000);

    const [, , key, windowArg] = evalMock.mock.calls[0] as [string, number, string, number];
    expect(key).toBe('authz:flood:198.51.100.42');
    expect(windowArg).toBe(60_000);
  });
});

describe('RedisFloodStore: parses the [count, ttl] shape eval resolves with into {count, msUntilReset}', () => {
  it('a-fresh-key-count-1-full-window-ttl-response-parses-into-count-1-and-msuntilreset-equal-to-the-ttl', async () => {
    const { redis } = fakeRedisClient([1, 5_000]);
    const store = new RedisFloodStore(redis);
    const result = await store.increment('k', 5_000);
    expect(result).toEqual({ count: 1, msUntilReset: 5_000 });
  });

  it('a-later-call-with-count-5-and-a-shrinking-ttl-parses-into-count-5-and-that-exact-msuntilreset', async () => {
    const { redis } = fakeRedisClient([5, 1_234]);
    const store = new RedisFloodStore(redis);
    const result = await store.increment('k', 5_000);
    expect(result).toEqual({ count: 5, msUntilReset: 1_234 });
  });

  it('a-non-negative-zero-pttl-is-used-verbatim-as-msuntilreset-not-treated-as-the-negative-fallback-case', async () => {
    const { redis } = fakeRedisClient([2, 0]);
    const store = new RedisFloodStore(redis);
    const result = await store.increment('k', 9_000);
    expect(result).toEqual({ count: 2, msUntilReset: 0 });
  });
});

describe("RedisFloodStore: the disclosed PTTL-fallback behavior for a negative TTL (the script's own comment: 'should never actually happen', but defended anyway)", () => {
  it('a-pttl-of-minus-1-key-exists-with-no-expiry-falls-back-to-the-full-windowms-rather-than-a-negative-msuntilreset', async () => {
    const { redis } = fakeRedisClient([1, -1]);
    const store = new RedisFloodStore(redis);
    const result = await store.increment('k', 9_000);
    expect(result).toEqual({ count: 1, msUntilReset: 9_000 });
  });

  it('a-pttl-of-minus-2-key-does-not-exist-also-falls-back-to-the-full-windowms-rather-than-a-negative-msuntilreset', async () => {
    const { redis } = fakeRedisClient([1, -2]);
    const store = new RedisFloodStore(redis);
    const result = await store.increment('k', 9_000);
    expect(result).toEqual({ count: 1, msUntilReset: 9_000 });
  });
});

// ---------------------------------------------------------------------------
// createRedisClient
// ---------------------------------------------------------------------------

/**
 * `createRedisClient` needs a real (or at least real-shaped) `ioredis`
 * client to test its actual claim — that constructing one wires an
 * `'error'` listener onto it that calls the supplied logger instead of
 * letting Node's `EventEmitter` throw an unhandled `'error'` event and crash
 * the process. No real Redis is needed for that: an unreachable host is
 * sufficient to trigger a real `'error'` event, and doing so is fast and
 * deterministic (manually confirmed, outside this suite, against
 * `127.0.0.1:1` — an unassigned, always-refused low port — with the first
 * real `'error'` event firing in single-digit milliseconds in this exact
 * environment). Deliberately does NOT attach a second `'error'` listener of
 * its own to detect the event — doing so would make this test pass
 * regardless of whether `createRedisClient`'s own internal listener exists
 * at all (Node only throws an unhandled `'error'` when there are truly zero
 * listeners), which would test nothing. Instead this polls the fake
 * logger's own mock call count, relying entirely on `createRedisClient`'s
 * own internal listener being the one thing that can make that count ever
 * become nonzero.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('createRedisClient', () => {
  it('does-not-throw-synchronously-when-constructed-against-an-unreachable-host', () => {
    const logger = { error: vi.fn() } as unknown as FastifyBaseLogger;
    let client: Redis | undefined;
    expect(() => {
      client = createRedisClient('redis://127.0.0.1:1', logger);
    }).not.toThrow();
    client?.disconnect();
  });

  it('wires-an-error-listener-onto-the-constructed-client-that-calls-the-supplied-logger-rather-than-crashing-the-process-with-an-unhandled-error-event', async () => {
    const errorMock = vi.fn();
    const logger = { error: errorMock } as unknown as FastifyBaseLogger;

    const client = createRedisClient('redis://127.0.0.1:1', logger);
    try {
      // No listener is attached by this test itself — see this describe
      // block's own doc comment for why that omission is load-bearing.
      await waitUntil(() => errorMock.mock.calls.length > 0, 4_000);
    } finally {
      client.disconnect();
    }

    expect(errorMock).toHaveBeenCalled();
    const [meta, message] = errorMock.mock.calls[0] as [{ err?: unknown }, string];
    expect(meta).toHaveProperty('err');
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  }, 5_000);
});
