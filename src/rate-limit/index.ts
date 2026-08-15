export type { RateLimitResult, RateLimitStore } from './types.js';
export { MemoryRateLimitStore } from './memory-store.js';
export type { MemoryRateLimitStoreOptions } from './memory-store.js';
export { TenantRateLimiter } from './limiter.js';
export type { TenantRateLimiterOptions } from './limiter.js';
export { createRateLimitMiddleware, assertNotRateLimited } from './middleware.js';
export type { RateLimitMiddlewareOptions } from './middleware.js';
// Re-exported so consumers importing only this subpath can catch/narrow on
// the error type this module's own functions throw, without also importing
// from the package root.
export {
  SecurityKitError,
  RateLimitExceededError,
  InvalidRateLimitPointsError,
  RateLimitConfigurationError,
} from '../errors.js';
