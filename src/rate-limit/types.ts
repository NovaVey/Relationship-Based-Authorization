/**
 * Shared types for the per-tenant rate limiting module. Kept separate from
 * the store/limiter implementations so alternative {@link RateLimitStore}
 * backends (e.g. a Redis-backed store for multi-instance deployments) can
 * depend on just this file without pulling in the in-memory implementation.
 */

/**
 * The outcome of a single {@link RateLimitStore.consume} call.
 *
 * Exposed directly to middleware (for `RateLimit-*` response headers) and to
 * callers that want to make their own allow/deny decision, so it captures
 * everything needed to do both without a second lookup.
 */
export interface RateLimitResult {
  /** Whether this request is allowed to proceed. */
  allowed: boolean;
  /** Tokens left in the bucket after this call (never negative). */
  remaining: number;
  /** The bucket's capacity, echoed back for convenience when rendering headers. */
  limit: number;
  /** Epoch-ms estimate of when the budget is fully refilled. */
  resetMs: number;
}

/**
 * Pluggable backend for rate-limit state.
 *
 * `TenantRateLimiter` (see `limiter.ts`) is deliberately storage-agnostic: it
 * only knows how to build a namespaced key and delegate to this interface.
 * The default implementation ({@link MemoryRateLimitStore}, `memory-store.ts`)
 * keeps state in an in-process `Map`, which is fine for a single instance,
 * local dev, or tests — but is invisible to other processes/instances. To
 * rate-limit a horizontally-scaled deployment correctly, implement this
 * interface against a shared backend (e.g. Redis, using `INCR`/`PEXPIRE` or a
 * Lua-scripted token bucket) and pass it as `store` to `TenantRateLimiter`.
 */
export interface RateLimitStore {
  /**
   * Attempts to withdraw `points` from the bucket identified by `key`,
   * creating it (fully-stocked, per `limit`) on first use. `limit` and
   * `windowMs` are passed on every call — rather than fixed at store
   * construction — so a single store instance can serve callers with
   * different limits per key.
   */
  consume(key: string, points: number, limit: number, windowMs: number): Promise<RateLimitResult>;
  /** Clears any state held for `key`, as if it had never been consumed from. */
  reset?(key: string): Promise<void> | void;
}
