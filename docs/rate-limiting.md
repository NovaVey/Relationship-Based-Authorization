# Per-tenant rate limiting

`@novavey/multi-tenant-security-kit/rate-limit`

Protects shared backend capacity from any single noisy tenant, using a
token-bucket algorithm keyed per tenant. This is not a substitute for
edge/network-layer DDoS protection — it's about fairness between tenants
sharing the same backend, not about defending your edge.

## Basic usage

```ts
import {
  TenantRateLimiter,
  createRateLimitMiddleware,
} from '@novavey/multi-tenant-security-kit/rate-limit';

const limiter = new TenantRateLimiter({
  limit: 100, // bucket capacity: max points a tenant can hold/spend at once
  windowMs: 60_000, // fully refills over 60 seconds
});

app.use(createRateLimitMiddleware({ limiter }));
```

`limit` and `windowMs` must both be positive, finite numbers — the
constructor throws `RateLimitConfigurationError` otherwise. This isn't just
strictness for its own sake: every store computes refill as `limit /
windowMs`, so a `windowMs` of `0` produces an infinite refill rate and
silently disables rate limiting entirely (every bucket refills to full
capacity between any two calls, no matter how little time actually passed).

Mount this after [`createTenantMiddleware`](./tenant-isolation.md) (unless
you supply your own `getTenantId`) — by default the middleware resolves the
tenant via `requireCurrentTenantId()`.

On **every** request — allowed or not — the middleware sets
`RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` response
headers (per the
[IETF RateLimit-Headers draft](https://www.ietf.org/archive/id/draft-ietf-httpapi-ratelimit-headers-08.html)
convention: `Reset` is whole seconds until refill, not an epoch timestamp),
so well-behaved clients can self-throttle even on successful requests. When
the budget is exhausted, the default response is `429` with a `Retry-After`
header and `{ error: 'rate_limit_exceeded', retryAfterMs }`.

## Variable request cost

Not every request should cost the same. `createRateLimitMiddleware` is
generic over the request type (defaulting to the framework-agnostic
`MinimalRequest`, which only has `headers`/`hostname`/`method`/`url`) — pass
your framework's request type as the type argument to get its properties
(`req.path`, `req.params`, etc.) in these callbacks:

```ts
import type { Request } from 'express';

createRateLimitMiddleware<Request>({
  limiter,
  points: (req) => (req.path === '/export' ? 20 : 1),
});
```

## Custom tenant resolution

```ts
createRateLimitMiddleware<Request>({
  limiter,
  // `String(...)`: Express 5 types route params as `string | string[]` (to
  // support repeated-segment patterns).
  getTenantId: (req) => String(req.params.tenantId), // instead of the active tenant context
});
```

## Customizing the limited response

```ts
createRateLimitMiddleware({
  limiter,
  onLimited: (req, res, next, result) => {
    res.status(429).json({ code: 'TOO_MANY_REQUESTS', resetAt: new Date(result.resetMs) });
  },
});
```

## Outside HTTP: background jobs, RPC, GraphQL resolvers

`createRateLimitMiddleware` deliberately never _throws_ — an HTTP middleware
should respond `429` directly rather than force every caller to install an
error-handling middleware. For call sites that want exception-based flow
instead — background jobs, queue consumers, RPC/GraphQL resolvers, or any
code calling `TenantRateLimiter.consume` directly — use
`assertNotRateLimited`:

```ts
import { assertNotRateLimited } from '@novavey/multi-tenant-security-kit/rate-limit';

const result = await limiter.consume(tenantId);
assertNotRateLimited(result); // throws RateLimitExceededError if result.allowed is false
```

## Multiple independent limiters

Give each limiter its own `keyPrefix` so unrelated limits (e.g. "API calls"
vs. "exports") don't collide, even if they happen to share a store:

```ts
const apiLimiter = new TenantRateLimiter({ limit: 1000, windowMs: 60_000, keyPrefix: 'api' });
const exportLimiter = new TenantRateLimiter({ limit: 5, windowMs: 3_600_000, keyPrefix: 'export' });
```

## Scaling past one process

The default `store` is `MemoryRateLimitStore` — a lazy, timer-free
token-bucket keyed by wall-clock elapsed time, kept in a `Map`. It's
process-local: correct and dependency-free for a single instance (or for
tests), but each process gets its own independent budget in a multi-instance
deployment, which effectively multiplies every tenant's real limit by the
instance count.

Being timer-free also means `MemoryRateLimitStore` can't proactively expire
idle buckets on a schedule — every distinct key it's ever seen stays in
memory until evicted. If the key space is reachable by unauthenticated
request input (e.g. a tenant resolver that trusts a client-supplied header
with nothing validating it upstream), that's an unbounded-memory-growth
vector. `maxBuckets` (default `50_000`) bounds it: once exceeded, the
least-recently-used bucket is evicted inline on the next `consume()` call
for a new key — an evicted key's next request just starts a fresh,
fully-stocked bucket, never a wider grant than a never-before-seen key
would get.

```ts
const store = new MemoryRateLimitStore({ maxBuckets: 100_000 });
```

Raise it if you genuinely expect more concurrent distinct tenants than
that; a real, unauthenticated-reachable deployment should still pair this
with an actual upstream authentication/allowlist layer — bounding memory
doesn't stop an attacker from thrashing legitimate tenants' buckets out of
the cache by flooding fake keys, it only caps how much memory that costs.

`maxBuckets` must be a positive integer — the constructor throws
`RateLimitConfigurationError` otherwise. `maxBuckets: 0` in particular isn't
just an odd value: every `consume()` call would insert a bucket and then
immediately evict it as the sole (hence "oldest") entry, so no state ever
persists and the limiter goes fully inert.

For multi-instance deployments, implement the small `RateLimitStore`
interface against a shared backend (Redis is the natural choice) and pass it
to `TenantRateLimiter`:

```ts
import type {
  RateLimitStore,
  RateLimitResult,
} from '@novavey/multi-tenant-security-kit/rate-limit';

class RedisRateLimitStore implements RateLimitStore {
  async consume(
    key: string,
    points: number,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    // Needs to be atomic (a Lua script, e.g. via ioredis's `defineCommand`,
    // is the standard way) so concurrent requests across instances don't
    // race on a read-modify-write. See the full, runnable reference
    // implementation at examples/redis-rate-limit-store.ts — it mirrors
    // MemoryRateLimitStore's token-bucket math exactly, just computed
    // atomically inside Redis.
    throw new Error('not implemented — see examples/redis-rate-limit-store.ts');
  }
}

const limiter = new TenantRateLimiter({
  store: new RedisRateLimitStore(),
  limit: 100,
  windowMs: 60_000,
});
```

This package intentionally ships no Redis dependency — implementing the
interface is a small, explicit choice you make, not something bundled in.

## API reference

| Export                               | Kind      | Summary                                                                                                                                            |
| ------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RateLimitResult`                    | type      | `{ allowed, remaining, limit, resetMs }`                                                                                                           |
| `RateLimitStore`                     | interface | `consume(key, points, limit, windowMs)`; optional `reset(key)`                                                                                     |
| `MemoryRateLimitStore`               | class     | Default in-memory, process-local store                                                                                                             |
| `MemoryRateLimitStoreOptions`        | type      | `{ maxBuckets? }` — LRU-eviction cap, default `50_000`                                                                                             |
| `TenantRateLimiterOptions`           | type      | `{ store?, limit, windowMs, keyPrefix? }`                                                                                                          |
| `TenantRateLimiter`                  | class     | `new TenantRateLimiter(options)`; `.consume(tenantId, points?)`                                                                                    |
| `RateLimitMiddlewareOptions<Req>`    | type      | Options for `createRateLimitMiddleware`                                                                                                            |
| `createRateLimitMiddleware(options)` | function  | Builds the enforcement middleware                                                                                                                  |
| `assertNotRateLimited(result)`       | function  | Throws `RateLimitExceededError` if `!result.allowed`, for non-HTTP call sites                                                                      |
| `SecurityKitError`                   | class     | Base class every error in this package extends; carries a stable `.code`                                                                           |
| `RateLimitExceededError`             | class     | Thrown by `assertNotRateLimited()`; `code: 'RATE_LIMIT_EXCEEDED'`, carries `.retryAfterMs`                                                         |
| `InvalidRateLimitPointsError`        | class     | Thrown by `.consume()` if `points` isn't a positive, finite number; `code: 'INVALID_RATE_LIMIT_POINTS'`                                            |
| `RateLimitConfigurationError`        | class     | Thrown if `limit`/`windowMs` (`TenantRateLimiter`) or `maxBuckets` (`MemoryRateLimitStore`) is invalid; `code: 'RATE_LIMIT_CONFIGURATION_INVALID'` |
