// Mirrors docs/rate-limiting.md's pure (framework-free) examples: basic
// limiter usage and assertNotRateLimited() for non-HTTP call sites. Keep in
// sync — see doc-examples/README.md for the convention this file is part
// of.
import assert from 'node:assert/strict';
import {
  TenantRateLimiter,
  assertNotRateLimited,
} from '@novavey/multi-tenant-security-kit/rate-limit';

// "Basic usage"
const limiter = new TenantRateLimiter({
  limit: 100, // bucket capacity: max points a tenant can hold/spend at once
  windowMs: 60_000, // fully refills over 60 seconds
});

const first = await limiter.consume('acme');
assert.equal(first.allowed, true);
assert.equal(first.limit, 100);
assert.equal(first.remaining, 99);

// "Outside HTTP: background jobs, RPC, GraphQL resolvers"
assertNotRateLimited(first); // does not throw — result.allowed is true

// "Multiple independent limiters"
const apiLimiter = new TenantRateLimiter({ limit: 1000, windowMs: 60_000, keyPrefix: 'api' });
const exportLimiter = new TenantRateLimiter({ limit: 5, windowMs: 3_600_000, keyPrefix: 'export' });
// Different keyPrefixes -> independent budgets, even for the same tenant id.
await apiLimiter.consume('acme', 1000);
const exportResult = await exportLimiter.consume('acme', 1);
assert.equal(exportResult.allowed, true); // unaffected by apiLimiter's budget being exhausted

// assertNotRateLimited() throws RateLimitExceededError once a limiter is exhausted.
const exhaustingLimiter = new TenantRateLimiter({ limit: 1, windowMs: 60_000 });
await exhaustingLimiter.consume('acme');
const denied = await exhaustingLimiter.consume('acme');
assert.equal(denied.allowed, false);
assert.throws(() => assertNotRateLimited(denied), { name: 'RateLimitExceededError' });

console.log('OK rate-limiting.md: pure limiter + assertNotRateLimited examples');
