import { RateLimitExceededError } from '../errors.js';
import type { MinimalRequest, MinimalResponse, Middleware, NextFunction } from '../http/types.js';
import { requireCurrentTenantId } from '../tenant/context.js';
import type { TenantRateLimiter } from './limiter.js';
import type { RateLimitResult } from './types.js';

/**
 * Clamps a possibly-non-finite value to a real, finite number — an
 * unclamped `Infinity`/`NaN` reaching `res.setHeader(...)` becomes the
 * literal string `"Infinity"`/`"NaN"`, not a valid `Retry-After` or
 * `RateLimit-Reset` value. `TenantRateLimiter`'s own constructor already
 * rejects a non-positive/non-finite `limit`/`windowMs`, so the *built-in*
 * `MemoryRateLimitStore` can no longer produce this once wired up through
 * it — but `RateLimitStore` is a public extension point (see
 * "Scaling past one process" in the rate-limiting docs), and nothing
 * requires a custom implementation to make the same promise; some
 * legitimately want to express "never resets" as `Infinity`. Falls back to
 * `Number.MAX_SAFE_INTEGER`, not `0` — a colossally-far-future reset is a
 * more honest signal to a client than "resets immediately".
 */
function finiteOrMax(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * Throws {@link RateLimitExceededError} if `result.allowed` is `false`.
 *
 * `createRateLimitMiddleware` deliberately does *not* throw — an HTTP
 * middleware should respond `429` directly rather than force every caller
 * to install an error-handling middleware just to turn an exception back
 * into a response. This helper is for the other call sites that want the
 * exception-based flow instead: background jobs, queue consumers, RPC/
 * GraphQL resolvers, or any code calling `TenantRateLimiter.consume`
 * directly outside of the HTTP middleware pipeline.
 */
export function assertNotRateLimited(result: RateLimitResult): void {
  if (!result.allowed) {
    const retryAfterMs = Math.max(0, finiteOrMax(result.resetMs - Date.now()));
    throw new RateLimitExceededError(retryAfterMs);
  }
}

/** Converts an epoch-ms timestamp into whole seconds remaining, floored at `0`. */
function secondsUntil(epochMs: number): number {
  return Math.max(0, Math.ceil(finiteOrMax(epochMs - Date.now()) / 1000));
}

/** Options for {@link createRateLimitMiddleware}. */
export interface RateLimitMiddlewareOptions<Req extends MinimalRequest = MinimalRequest> {
  /** The limiter to consume budget from on every request. */
  limiter: TenantRateLimiter;
  /**
   * How many points each request costs. Either a fixed number (default `1`)
   * or a function of the request, for endpoints where cost varies (e.g. a
   * bulk-export route that costs more than a simple read).
   */
  points?: number | ((req: Req) => number);
  /**
   * Resolves the tenant id to rate-limit against. Defaults to
   * `requireCurrentTenantId()`, which reads the tenant bound by
   * `createTenantMiddleware` — mount that middleware before this one unless
   * you supply your own `getTenantId`.
   */
  getTenantId?: (req: Req) => string;
  /**
   * Called instead of `next()` when the budget is exhausted. Defaults to
   * setting a `Retry-After` header (seconds, integer, minimum `1`) and
   * responding `429` with `{ error: 'rate_limit_exceeded', retryAfterMs }`.
   * Override to customize the response body/status, e.g. to match an
   * existing API error envelope.
   */
  onLimited?: (req: Req, res: MinimalResponse, next: NextFunction, result: RateLimitResult) => void;
}

/** Default `onLimited`: sets `Retry-After` and responds `429` with a JSON body. */
function defaultOnLimited<Req extends MinimalRequest>(
  _req: Req,
  res: MinimalResponse,
  _next: NextFunction,
  result: RateLimitResult,
): void {
  const retryAfterMs = Math.max(0, finiteOrMax(result.resetMs - Date.now()));
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', retryAfterSec);
  res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs });
}

/**
 * Builds Express-compatible middleware that enforces a {@link TenantRateLimiter}
 * budget per request.
 *
 * On *every* request — allowed or not — it sets the `RateLimit-Limit`,
 * `RateLimit-Remaining`, and `RateLimit-Reset` response headers (per the
 * {@link https://www.ietf.org/archive/id/draft-ietf-httpapi-ratelimit-headers-08.html | IETF RateLimit-Headers draft}
 * convention: `Reset` is whole seconds until the budget refills, not an
 * epoch timestamp), so clients can self-throttle even on successful
 * requests. It then calls `next()` if the request is within budget, or the
 * `onLimited` handler otherwise.
 *
 * Mount this after `createTenantMiddleware` (unless `getTenantId` is
 * supplied) so a tenant context is already active.
 */
export function createRateLimitMiddleware<Req extends MinimalRequest = MinimalRequest>(
  options: RateLimitMiddlewareOptions<Req>,
): Middleware<Req> {
  const getTenantId = options.getTenantId ?? (() => requireCurrentTenantId());
  const onLimited = options.onLimited ?? defaultOnLimited<Req>;

  return (req, res, next) => {
    void (async () => {
      try {
        const tenantId = getTenantId(req);
        const points =
          typeof options.points === 'function' ? options.points(req) : (options.points ?? 1);
        const result = await options.limiter.consume(tenantId, points);

        res.setHeader('RateLimit-Limit', result.limit);
        res.setHeader('RateLimit-Remaining', result.remaining);
        res.setHeader('RateLimit-Reset', secondsUntil(result.resetMs));

        if (!result.allowed) {
          onLimited(req, res, next, result);
          return;
        }
      } catch (err) {
        next(err);
        return;
      }
      // `next()` is deliberately outside the try/catch above (it used to
      // sit inside it, on the `result.allowed` branch). `next()` runs the
      // rest of the request pipeline inline for synchronous downstream
      // code — if a downstream handler threw and this were still inside a
      // try/catch that also calls `next(err)`, that throw would be caught
      // right here and forwarded via `next(err)` a *second* time for the
      // same request (the first, successful call already ran and is what
      // triggered the throw). `onLimited` (the "budget exhausted" branch)
      // deliberately stays inside the try/catch above, unlike this call —
      // unlike our own bare `next()`, it isn't guaranteed to invoke
      // downstream code at all (the default implementation just sends a
      // response), so a throw from it is still exactly the kind of
      // unexpected failure `next(err)` exists to report.
      next();
    })();
  };
}
