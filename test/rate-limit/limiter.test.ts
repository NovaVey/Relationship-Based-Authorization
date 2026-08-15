import { describe, expect, it, vi } from 'vitest';

import {
  InvalidRateLimitPointsError,
  RateLimitConfigurationError,
  SecurityKitError,
} from '../../src/errors.js';
import { TenantRateLimiter } from '../../src/rate-limit/limiter.js';
import { MemoryRateLimitStore } from '../../src/rate-limit/memory-store.js';
import type { RateLimitResult, RateLimitStore } from '../../src/rate-limit/types.js';

describe('TenantRateLimiter', () => {
  it('defaults to a MemoryRateLimitStore when none is supplied', async () => {
    const limiter = new TenantRateLimiter({ limit: 2, windowMs: 1000 });
    expect((await limiter.consume('acme')).allowed).toBe(true);
    expect((await limiter.consume('acme')).allowed).toBe(true);
    expect((await limiter.consume('acme')).allowed).toBe(false);
  });

  it('namespaces store keys by tenant id so tenants do not share a bucket', async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new TenantRateLimiter({ store, limit: 1, windowMs: 1000 });

    expect((await limiter.consume('acme')).allowed).toBe(true);
    expect((await limiter.consume('acme')).allowed).toBe(false);
    // A different tenant gets its own, independent bucket.
    expect((await limiter.consume('globex')).allowed).toBe(true);
  });

  it('defaults points to 1 per call', async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new TenantRateLimiter({ store, limit: 3, windowMs: 1000 });

    const first = await limiter.consume('acme');
    expect(first.remaining).toBe(2);
  });

  it('accepts an explicit points argument', async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new TenantRateLimiter({ store, limit: 10, windowMs: 1000 });

    const result = await limiter.consume('acme', 4);
    expect(result.remaining).toBe(6);
  });

  it('uses the "tenant" key prefix by default', async () => {
    const consume = vi.fn(async (): Promise<RateLimitResult> => ({
      allowed: true,
      remaining: 9,
      limit: 10,
      resetMs: 0,
    }));
    const store: RateLimitStore = { consume };
    const limiter = new TenantRateLimiter({ store, limit: 10, windowMs: 1000 });

    await limiter.consume('acme', 1);
    expect(consume).toHaveBeenCalledWith('tenant:acme', 1, 10, 1000);
  });

  it('respects a custom keyPrefix', async () => {
    const consume = vi.fn(async (): Promise<RateLimitResult> => ({
      allowed: true,
      remaining: 9,
      limit: 10,
      resetMs: 0,
    }));
    const store: RateLimitStore = { consume };
    const limiter = new TenantRateLimiter({
      store,
      limit: 10,
      windowMs: 1000,
      keyPrefix: 'exports',
    });

    await limiter.consume('acme', 2);
    expect(consume).toHaveBeenCalledWith('exports:acme', 2, 10, 1000);
  });

  // Regression: points was never validated — a zero, negative, NaN, or
  // infinite value reached the store's arithmetic unchecked. Zero/negative
  // unconditionally "succeeded" in MemoryRateLimitStore (tokens >=
  // 0/negative is always true) regardless of the tenant's actual
  // remaining budget — a real bypass, given the library's own "variable
  // request cost" feature (points as a function of the request)
  // explicitly invites deriving this value from request data a
  // cost-function bug could get wrong.
  describe('invalid points', () => {
    for (const points of [0, -1, -100, NaN, Infinity, -Infinity]) {
      it(`rejects points = ${points} with InvalidRateLimitPointsError, without ever calling the store`, async () => {
        const consume = vi.fn(async (): Promise<RateLimitResult> => ({
          allowed: true,
          remaining: 9,
          limit: 10,
          resetMs: 0,
        }));
        const limiter = new TenantRateLimiter({
          store: { consume },
          limit: 10,
          windowMs: 1000,
        });

        await expect(limiter.consume('acme', points)).rejects.toThrow(InvalidRateLimitPointsError);
        // Validation must happen before the store is ever touched — an
        // invalid value must not reach (and potentially confuse) a real
        // store implementation's own accounting.
        expect(consume).not.toHaveBeenCalled();
      });
    }

    it('the thrown error is a SecurityKitError with a stable code and carries the offending value', async () => {
      const limiter = new TenantRateLimiter({
        store: new MemoryRateLimitStore(),
        limit: 5,
        windowMs: 1000,
      });
      try {
        await limiter.consume('acme', -5);
        expect.unreachable('consume should have rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidRateLimitPointsError);
        expect(err).toBeInstanceOf(SecurityKitError);
        const error = err as InvalidRateLimitPointsError;
        expect(error.code).toBe('INVALID_RATE_LIMIT_POINTS');
        expect(error.points).toBe(-5);
      }
    });
  });

  // Regression (HIGH): limit/windowMs were never validated at construction,
  // unlike points. A windowMs of 0 in particular isn't just an odd config
  // value — MemoryRateLimitStore (and, per the RateLimitStore contract, any
  // conforming store) computes refill as `limit / windowMs`; windowMs = 0
  // produces an infinite refill rate, so every bucket refills to full
  // capacity between any two calls no matter how little time actually
  // passed — a full, silent rate-limit bypass. Verified live before this
  // fix: draining a bucket fully and consuming again a few ms later still
  // succeeded, every time.
  describe('invalid limit/windowMs', () => {
    for (const limit of [0, -1, -100, NaN, Infinity, -Infinity]) {
      it(`rejects limit = ${limit} with RateLimitConfigurationError`, () => {
        expect(() => new TenantRateLimiter({ limit, windowMs: 1000 })).toThrow(
          RateLimitConfigurationError,
        );
      });
    }

    for (const windowMs of [0, -1, -100, NaN, Infinity, -Infinity]) {
      it(`rejects windowMs = ${windowMs} with RateLimitConfigurationError`, () => {
        expect(() => new TenantRateLimiter({ limit: 5, windowMs })).toThrow(
          RateLimitConfigurationError,
        );
      });
    }

    it('rejects windowMs = 0 before the bypass can ever occur (real end-to-end check)', async () => {
      // Belt-and-suspenders: prove the specific exploit shape the audit
      // demonstrated is closed, not just that *a* constructor field is
      // validated somewhere.
      expect(() => new TenantRateLimiter({ limit: 5, windowMs: 0 })).toThrow(
        RateLimitConfigurationError,
      );
    });

    it('the thrown error is a SecurityKitError with a stable code', () => {
      try {
        new TenantRateLimiter({ limit: 5, windowMs: 0 });
        expect.unreachable('constructor should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitConfigurationError);
        expect(err).toBeInstanceOf(SecurityKitError);
        expect((err as RateLimitConfigurationError).code).toBe('RATE_LIMIT_CONFIGURATION_INVALID');
      }
    });

    it('accepts valid limit/windowMs values (sanity check the validation is not overly strict)', () => {
      expect(() => new TenantRateLimiter({ limit: 1, windowMs: 1 })).not.toThrow();
      expect(() => new TenantRateLimiter({ limit: 1000, windowMs: 60_000 })).not.toThrow();
    });
  });

  it('delegates to a fully custom store implementation', async () => {
    const calls: Array<[string, number, number, number]> = [];
    const store: RateLimitStore = {
      consume(key, points, limit, windowMs) {
        calls.push([key, points, limit, windowMs]);
        return Promise.resolve({ allowed: false, remaining: 0, limit, resetMs: 12345 });
      },
    };
    const limiter = new TenantRateLimiter({ store, limit: 5, windowMs: 2000, keyPrefix: 'rpc' });

    const result = await limiter.consume('acme', 3);
    expect(result).toEqual({ allowed: false, remaining: 0, limit: 5, resetMs: 12345 });
    expect(calls).toEqual([['rpc:acme', 3, 5, 2000]]);
  });
});
