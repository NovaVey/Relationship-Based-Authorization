/**
 * A reference `RateLimitStore` implementation backed by Redis, for
 * multi-instance deployments where the default `MemoryRateLimitStore`
 * (process-local) would let each instance hand out its own independent
 * budget — see "Scaling past one process" in docs/rate-limiting.md.
 *
 * This file is illustrative, not part of the published package (see
 * eslint.config.js / tsconfig.json — `examples/` is excluded from both) and
 * is not executed by CI. To actually run it:
 *
 *   npm install ioredis
 *   npm install --save-dev tsx
 *   npx tsx examples/redis-rate-limit-store.ts
 *
 * It mirrors MemoryRateLimitStore's lazy-refill token-bucket math exactly
 * (see src/rate-limit/memory-store.ts) but computes it atomically inside
 * Redis via a Lua script, so concurrent requests across many
 * processes/instances never race on a read-modify-write, and all instances
 * agree on elapsed time via Redis's own clock (TIME) regardless of their
 * own clock skew — the whole reason to centralize this in Redis at all.
 */

import Redis from 'ioredis';
import type { RateLimitResult, RateLimitStore } from '../src/rate-limit/index.js';

const CONSUME_SCRIPT = `
local key = KEYS[1]
local points = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])

local time = redis.call('TIME')
local nowMs = math.floor(tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local lastUpdateMs = tonumber(data[2])
if tokens == nil then
  tokens = limit
  lastUpdateMs = nowMs
end

local refillPerMs = limit / windowMs
local elapsedMs = math.max(0, nowMs - lastUpdateMs)
local refillAmount = elapsedMs > 0 and (elapsedMs * refillPerMs) or 0
tokens = math.min(limit, tokens + refillAmount)

local allowed, remaining, resetMs
if tokens >= points then
  allowed = 1
  tokens = tokens - points
  remaining = math.floor(tokens)
  local tokensToFull = limit - tokens
  resetMs = nowMs + (refillPerMs > 0 and (tokensToFull / refillPerMs) or 0)
else
  allowed = 0
  remaining = math.floor(tokens)
  local tokensNeeded = points - tokens
  resetMs = nowMs + (refillPerMs > 0 and (tokensNeeded / refillPerMs) or 1e15)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(nowMs))
-- Outlive the refill window comfortably so idle buckets don't leak memory,
-- without expiring mid-window and silently resetting an active tenant.
redis.call('PEXPIRE', key, math.ceil(windowMs * 2))

return { tostring(allowed), tostring(remaining), tostring(limit), tostring(math.floor(resetMs)) }
`;

type ConsumeReply = [allowed: string, remaining: string, limit: string, resetMs: string];

// The runtime contract `redis.defineCommand` gives us for the script above
// — ioredis has no static knowledge of a dynamically-defined command's
// signature, so this declares it by hand rather than trying to derive it.
interface RedisRateLimitCommands {
  mtskConsume(key: string, points: string, limit: string, windowMs: string): Promise<ConsumeReply>;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis & RedisRateLimitCommands;

  constructor(redis: Redis) {
    // Registers the script once per client; ioredis caches it (via
    // EVALSHA, falling back to EVAL only if the script isn't loaded on
    // that particular Redis node) so steady-state calls are cheap.
    redis.defineCommand('mtskConsume', { numberOfKeys: 1, lua: CONSUME_SCRIPT });
    this.redis = redis as Redis & RedisRateLimitCommands;
  }

  async consume(
    key: string,
    points: number,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    const [allowed, remaining, limitOut, resetMs] = await this.redis.mtskConsume(
      key,
      String(points),
      String(limit),
      String(windowMs),
    );
    return {
      allowed: allowed === '1',
      remaining: Number(remaining),
      limit: Number(limitOut),
      resetMs: Number(resetMs),
    };
  }

  /** Deletes `key`'s bucket entirely, as if it had never been consumed from. */
  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// --- usage ---------------------------------------------------------------
//
// import { TenantRateLimiter } from '../src/rate-limit/index.js';
//
// const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
// const limiter = new TenantRateLimiter({
//   store: new RedisRateLimitStore(redis),
//   limit: 100,
//   windowMs: 60_000,
// });
