import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimitConfigurationError, SecurityKitError } from '../../src/errors.js';
import { MemoryRateLimitStore } from '../../src/rate-limit/memory-store.js';

describe('MemoryRateLimitStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a burst up to the limit', async () => {
    const store = new MemoryRateLimitStore();

    for (let i = 0; i < 5; i++) {
      const result = await store.consume('acme', 1, 5, 1000);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(5 - (i + 1));
    }
  });

  it('denies the request that exceeds the limit', async () => {
    const store = new MemoryRateLimitStore();

    for (let i = 0; i < 5; i++) {
      await store.consume('acme', 1, 5, 1000);
    }

    const result = await store.consume('acme', 1, 5, 1000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(5);
  });

  it('reports remaining tokens before the withdrawal when denied', async () => {
    const store = new MemoryRateLimitStore();
    // Drain to exactly 1 token remaining.
    for (let i = 0; i < 4; i++) {
      await store.consume('acme', 1, 5, 1000);
    }

    const result = await store.consume('acme', 2, 5, 1000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(1);
  });

  it('computes resetMs as the time the bucket will be full again when allowed', async () => {
    const store = new MemoryRateLimitStore();
    // limit=10, windowMs=1000 -> 100ms per token. Consume 4, leaving 6/10.
    const result = await store.consume('acme', 4, 10, 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(6);
    // 4 tokens short of full * 100ms/token = 400ms from now (t=0).
    expect(result.resetMs).toBe(400);
  });

  it('computes resetMs as the time enough tokens will be available when denied', async () => {
    const store = new MemoryRateLimitStore();
    // Drain the bucket entirely (limit=5).
    for (let i = 0; i < 5; i++) {
      await store.consume('acme', 1, 5, 1000);
    }

    // windowMs=1000, limit=5 -> 200ms per token. Need 3 tokens -> 600ms.
    const result = await store.consume('acme', 3, 5, 1000);
    expect(result.allowed).toBe(false);
    expect(result.resetMs).toBe(600);
  });

  it('refills tokens over elapsed time', async () => {
    const store = new MemoryRateLimitStore();

    // Drain the bucket (limit=5, windowMs=1000 -> 200ms/token).
    for (let i = 0; i < 5; i++) {
      await store.consume('acme', 1, 5, 1000);
    }
    let result = await store.consume('acme', 1, 5, 1000);
    expect(result.allowed).toBe(false);

    // Advance halfway through the window: 2.5 tokens should be available.
    vi.advanceTimersByTime(500);
    result = await store.consume('acme', 2, 5, 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);

    // Advance the rest of the window; ~2.5 more tokens accrue on top of the
    // 0.5 left over (spending tokens mid-window delays reaching full
    // capacity relative to the theoretical linear refill curve).
    vi.advanceTimersByTime(500);
    result = await store.consume('acme', 3, 5, 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('never refills beyond the bucket capacity', async () => {
    const store = new MemoryRateLimitStore();
    await store.consume('acme', 1, 5, 1000);

    // Advance far beyond the window; tokens should cap at `limit`.
    vi.advanceTimersByTime(1_000_000);
    const result = await store.consume('acme', 5, 5, 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('reset() clears a bucket back to full capacity', async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 5; i++) {
      await store.consume('acme', 1, 5, 1000);
    }
    const denied = await store.consume('acme', 1, 5, 1000);
    expect(denied.allowed).toBe(false);

    store.reset('acme');

    const result = await store.consume('acme', 1, 5, 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('reset() on an unknown key is a harmless no-op', () => {
    const store = new MemoryRateLimitStore();
    expect(() => store.reset('never-seen')).not.toThrow();
  });

  it('keeps independent keys from interfering with each other', async () => {
    const store = new MemoryRateLimitStore();

    for (let i = 0; i < 5; i++) {
      await store.consume('acme', 1, 5, 1000);
    }
    const acmeResult = await store.consume('acme', 1, 5, 1000);
    expect(acmeResult.allowed).toBe(false);

    const globexResult = await store.consume('globex', 1, 5, 1000);
    expect(globexResult.allowed).toBe(true);
    expect(globexResult.remaining).toBe(4);
  });

  it('allows different limits/windows to be used per call for the same key', async () => {
    const store = new MemoryRateLimitStore();
    const first = await store.consume('acme', 1, 3, 1000);
    expect(first.remaining).toBe(2);
    expect(first.limit).toBe(3);

    // A subsequent call is free to pass a different limit; the store just
    // reports it back and caps the (already-lower) token count against it.
    const second = await store.consume('acme', 1, 10, 1000);
    expect(second.limit).toBe(10);
  });

  // Regression: this store had no eviction at all — every distinct key ever
  // seen accumulated in the Map forever. Combined with an unauthenticated
  // key source (e.g. a tenant resolver trusting a client-supplied header),
  // that's an unbounded-memory-growth DoS vector. maxBuckets bounds it via
  // inline LRU eviction, no timers.
  describe('maxBuckets (LRU eviction)', () => {
    it('defaults to never evicting for realistic key counts', async () => {
      const store = new MemoryRateLimitStore();
      for (let i = 0; i < 1000; i++) {
        await store.consume(`tenant-${i}`, 1, 5, 1000);
      }
      expect(store.size).toBe(1000);
    });

    it('evicts the least-recently-used key once maxBuckets is exceeded', async () => {
      const store = new MemoryRateLimitStore({ maxBuckets: 2 });

      await store.consume('a', 1, 5, 1000);
      await store.consume('b', 1, 5, 1000);
      expect(store.size).toBe(2);

      // A 3rd distinct key pushes size over the cap — 'a' (least recently
      // used, never touched again since) should be evicted, not 'b'.
      await store.consume('c', 1, 5, 1000);
      expect(store.size).toBe(2);

      // 'a' was evicted: this "second" consume for 'a' actually starts a
      // fresh bucket (remaining = limit - 1 = 4), not a continuation of
      // its earlier state (which would be remaining = 3 after 2 calls).
      const aAgain = await store.consume('a', 1, 5, 1000);
      expect(aAgain.remaining).toBe(4);
    });

    it('touching a key via consume() protects it from eviction (real LRU, not FIFO)', async () => {
      const store = new MemoryRateLimitStore({ maxBuckets: 2 });

      await store.consume('a', 1, 5, 1000);
      await store.consume('b', 1, 5, 1000);
      // Touch 'a' again — it's now the most-recently-used, 'b' is now the
      // least-recently-used, even though 'a' was inserted first.
      await store.consume('a', 1, 5, 1000);

      // A 3rd distinct key should evict 'b' (LRU), not 'a', even though a
      // naive FIFO-by-insertion-order eviction would have picked 'a'.
      await store.consume('c', 1, 5, 1000);

      // 'a' should still hold its accumulated state (2 consumes deep:
      // remaining = 5 - 2 = 3 before this 3rd real consume).
      const aStillTracked = await store.consume('a', 1, 5, 1000);
      expect(aStillTracked.remaining).toBe(2);

      // 'b' was evicted: starts fresh.
      const bEvicted = await store.consume('b', 1, 5, 1000);
      expect(bEvicted.remaining).toBe(4);
    });

    it('never evicts when re-consuming an already-tracked key, even at the cap', async () => {
      const store = new MemoryRateLimitStore({ maxBuckets: 1 });
      await store.consume('a', 1, 5, 1000);
      expect(store.size).toBe(1);

      // Repeated calls to the SAME key never grow past 1 entry and never
      // spuriously evict 'a' itself.
      await store.consume('a', 1, 5, 1000);
      await store.consume('a', 1, 5, 1000);
      expect(store.size).toBe(1);

      const result = await store.consume('a', 1, 5, 1000);
      expect(result.remaining).toBe(1); // 5 - 4 real consumes
    });

    // Regression (HIGH): maxBuckets was never validated. maxBuckets: 0 in
    // particular isn't just an odd config value — every consume() call for
    // a key inserts its bucket, then immediately evicts it as the (sole,
    // hence "oldest") entry, so state never persists and the limiter is
    // fully inert. Verified live before this fix: ten consecutive
    // full-bucket-cost requests for the same key all succeeded, and
    // store.size stayed at 0 throughout.
    describe('invalid maxBuckets', () => {
      for (const maxBuckets of [0, -1, -100, 1.5, NaN, Infinity, -Infinity]) {
        it(`rejects maxBuckets = ${maxBuckets} with RateLimitConfigurationError`, () => {
          expect(() => new MemoryRateLimitStore({ maxBuckets })).toThrow(
            RateLimitConfigurationError,
          );
        });
      }

      it('maxBuckets = 0 is rejected before the bypass can ever occur (real end-to-end check)', async () => {
        expect(() => new MemoryRateLimitStore({ maxBuckets: 0 })).toThrow(
          RateLimitConfigurationError,
        );
      });

      it('the thrown error is a SecurityKitError with a stable code', () => {
        try {
          new MemoryRateLimitStore({ maxBuckets: 0 });
          expect.unreachable('constructor should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(RateLimitConfigurationError);
          expect(err).toBeInstanceOf(SecurityKitError);
          expect((err as RateLimitConfigurationError).code).toBe(
            'RATE_LIMIT_CONFIGURATION_INVALID',
          );
        }
      });

      it('accepts a valid maxBuckets (sanity check the validation is not overly strict)', () => {
        expect(() => new MemoryRateLimitStore({ maxBuckets: 1 })).not.toThrow();
        expect(() => new MemoryRateLimitStore({ maxBuckets: 100_000 })).not.toThrow();
      });

      it('the default (no maxBuckets option) still constructs without throwing', () => {
        expect(() => new MemoryRateLimitStore()).not.toThrow();
        expect(() => new MemoryRateLimitStore({})).not.toThrow();
      });
    });
  });
});
