// Mirrors docs/rate-limiting.md's code samples. Keep these in sync — see
// doc-examples/README.md for the convention this file is part of.
import express from 'express';
import type { Request } from 'express';
import {
  TenantRateLimiter,
  createRateLimitMiddleware,
  assertNotRateLimited,
} from '@novavey/multi-tenant-security-kit/rate-limit';
import type {
  RateLimitStore,
  RateLimitResult,
} from '@novavey/multi-tenant-security-kit/rate-limit';

declare const app: express.Express;
declare const tenantId: string;

// "Basic usage"
const limiter = new TenantRateLimiter({
  limit: 100, // bucket capacity: max points a tenant can hold/spend at once
  windowMs: 60_000, // fully refills over 60 seconds
});

app.use(createRateLimitMiddleware({ limiter }));

// "Variable request cost"
createRateLimitMiddleware<Request>({
  limiter,
  points: (req) => (req.path === '/export' ? 20 : 1),
});

// "Custom tenant resolution"
createRateLimitMiddleware<Request>({
  limiter,
  getTenantId: (req) => String(req.params.tenantId), // instead of the active tenant context
});

// "Customizing the limited response"
createRateLimitMiddleware({
  limiter,
  onLimited: (req, res, next, result) => {
    void req;
    void next;
    res.status(429).json({ code: 'TOO_MANY_REQUESTS', resetAt: new Date(result.resetMs) });
  },
});

// "Outside HTTP: background jobs, RPC, GraphQL resolvers"
{
  const result = await limiter.consume(tenantId);
  assertNotRateLimited(result); // throws RateLimitExceededError if result.allowed is false
}

// "Multiple independent limiters"
const apiLimiter = new TenantRateLimiter({ limit: 1000, windowMs: 60_000, keyPrefix: 'api' });
const exportLimiter = new TenantRateLimiter({ limit: 5, windowMs: 3_600_000, keyPrefix: 'export' });
void apiLimiter;
void exportLimiter;

// "Scaling past one process" — Redis store interface implementation
class RedisRateLimitStore implements RateLimitStore {
  async consume(
    key: string,
    points: number,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    void key;
    void points;
    void limit;
    void windowMs;
    throw new Error('not implemented — see examples/redis-rate-limit-store.ts');
  }
}

const redisLimiter = new TenantRateLimiter({
  store: new RedisRateLimitStore(),
  limit: 100,
  windowMs: 60_000,
});
void redisLimiter;
