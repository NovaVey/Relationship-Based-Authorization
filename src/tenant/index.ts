export type { TenantContext, TenantScoped } from './types.js';
export {
  runWithTenant,
  getCurrentTenant,
  requireCurrentTenant,
  getCurrentTenantId,
  requireCurrentTenantId,
} from './context.js';
export { assertSameTenant, assertTenantMatches, scopeToTenant } from './guard.js';
// Re-exported so consumers importing only this subpath can catch/narrow on
// the error types this module's own functions throw, without also
// importing from the package root.
export {
  SecurityKitError,
  TenantContextError,
  CrossTenantAccessError,
  InvalidTenantIdError,
} from '../errors.js';
export {
  createTenantMiddleware,
  headerTenantResolver,
  subdomainTenantResolver,
  claimTenantResolver,
  assertValidTenantId,
} from './middleware.js';
export type {
  TenantResolver,
  TenantMiddlewareOptions,
  TenantMissingInfo,
  SubdomainTenantResolverOptions,
} from './middleware.js';
