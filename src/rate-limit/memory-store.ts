import { RateLimitConfigurationError } from '../errors.js';
import type { RateLimitResult, RateLimitStore } from './types.js';

/** Internal token-bucket state tracked per key. */
interface Bucket {
  /** Tokens currently available, as of `lastUpdateMs`. May be fractional between calls. */
  tokens: number;
  /** Wall-clock time (ms, from `Date.now()`) the bucket was last refilled/updated. */
  lastUpdateMs: number;
}

/** Configuration for a {@link MemoryRateLimitStore}. */
export interface MemoryRateLimitStoreOptions {
  /**
   * Maximum number of distinct keys' buckets held in memory at once. Once
   * a `consume()` call for a *new* key would exceed this, the
   * least-recently-used bucket is evicted first to make room. An evicted
   * key's next request simply starts a fresh, fully-stocked bucket — the
   * same as any never-before-seen key, never a wider grant than that.
   *
   * @defaultValue `50_000`
   */
  maxBuckets?: number;
}

/**
 * In-memory, process-local token-bucket implementation of {@link RateLimitStore}.
 *
 * Deliberately has **no timers or intervals** — a naive rate limiter that
 * runs a `setInterval` to "drip" tokens would keep the Node event loop alive
 * and leak a handle for every limiter instance (a real problem in tests and
 * serverless environments). Instead, refilling is computed lazily on each
 * {@link consume} call from the elapsed wall-clock time since the bucket was
 * last touched, so an idle bucket costs nothing and there is nothing to
 * `clearInterval`/`unref`.
 *
 * That same no-timers design means this store can't proactively expire idle
 * buckets on a schedule, so distinct *keys* accumulate in memory forever by
 * default — a real concern if the key space is reachable by unauthenticated
 * request input (e.g. a tenant resolver that trusts a client-supplied
 * header with no allowlist behind it). `maxBuckets` bounds this: once
 * exceeded, the least-recently-used bucket is evicted inline on the next
 * `consume()` call for a new key, checked on every call rather than on a
 * timer. This caps memory, but doesn't fully close a determined attacker's
 * ability to *thrash* legitimate tenants' buckets out of the cache by
 * flooding distinct fake keys — pair a wide-open resolver with a real
 * upstream authentication/allowlist layer, the same way you would for any
 * other unauthenticated input.
 *
 * **This store is process-local.** It's the right choice for a single
 * instance, local development, or tests, but two instances of an app (e.g.
 * behind a load balancer, or multiple serverless invocations) each get their
 * own independent budget — a tenant could effectively get `N ×` the intended
 * limit across `N` instances. For a production multi-instance deployment,
 * implement {@link RateLimitStore} against a shared backend instead (e.g.
 * Redis, using `INCR`/`PEXPIRE` or a Lua-scripted token bucket for
 * atomicity, which also gets you real TTL-based expiry) and pass it as
 * `store` to `TenantRateLimiter` — this class is intentionally the
 * *reference* implementation of the interface, not the only one.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxBuckets: number;

  /**
   * @throws {RateLimitConfigurationError} if `maxBuckets` is provided and
   * isn't a positive integer. `maxBuckets: 0` in particular isn't just an
   * odd config value — every `consume()` call for a key inserts its bucket,
   * then immediately evicts it as the (sole, hence "oldest") entry, so
   * state never persists and the limiter is fully inert (verified: ten
   * consecutive full-bucket-cost requests for the same key all succeed).
   */
  constructor(options: MemoryRateLimitStoreOptions = {}) {
    const maxBuckets = options.maxBuckets ?? 50_000;
    if (!Number.isInteger(maxBuckets) || maxBuckets <= 0) {
      throw new RateLimitConfigurationError(
        `Invalid maxBuckets: ${JSON.stringify(options.maxBuckets)}. Must be a positive integer.`,
      );
    }
    this.maxBuckets = maxBuckets;
  }

  /**
   * Refills `key`'s bucket for elapsed time, then attempts to withdraw
   * `points` from it. The bucket is created (fully stocked at `limit`
   * tokens) the first time a key is seen.
   */
  consume(key: string, points: number, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const refillPerMs = limit / windowMs;

    const existing = this.buckets.get(key);
    if (existing) {
      // `Map` iterates in insertion order, so delete-then-re-set is the
      // standard way to bump an existing key to the "most recently used"
      // end — this is what makes the eviction below remove the actual
      // least-recently-used entry, not just whichever was inserted first.
      this.buckets.delete(key);
    }
    const bucket = existing ?? { tokens: limit, lastUpdateMs: now };
    const elapsedMs = Math.max(0, now - bucket.lastUpdateMs);
    // Guard against `elapsedMs * refillPerMs` producing NaN (0 * Infinity)
    // when a caller passes a degenerate windowMs of 0.
    const refillAmount = elapsedMs > 0 ? elapsedMs * refillPerMs : 0;
    bucket.tokens = Math.min(limit, bucket.tokens + refillAmount);
    bucket.lastUpdateMs = now;
    this.buckets.set(key, bucket);

    if (!existing && this.buckets.size > this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) this.buckets.delete(oldestKey);
    }

    if (bucket.tokens >= points) {
      bucket.tokens -= points;
      const tokensToFull = limit - bucket.tokens;
      const resetMs = now + (refillPerMs > 0 ? tokensToFull / refillPerMs : 0);
      return Promise.resolve({
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit,
        resetMs,
      });
    }

    const tokensNeeded = points - bucket.tokens;
    const resetMs = now + (refillPerMs > 0 ? tokensNeeded / refillPerMs : Number.POSITIVE_INFINITY);
    return Promise.resolve({
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      limit,
      resetMs,
    });
  }

  /** Number of distinct keys currently holding a bucket. Mostly useful for tests/introspection. */
  get size(): number {
    return this.buckets.size;
  }

  /** Deletes `key`'s bucket entirely, as if it had never been consumed from. */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}
