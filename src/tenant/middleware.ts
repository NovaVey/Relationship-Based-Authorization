import { InvalidTenantIdError } from '../errors.js';
import type { MinimalRequest, MinimalResponse, Middleware, NextFunction } from '../http/types.js';
import { runWithTenant } from './context.js';
import type { TenantContext } from './types.js';

/**
 * Resolves a {@link TenantContext} from an incoming request. May be async
 * (e.g. to look the tenant up in a database) and may return `undefined` if
 * no tenant could be determined.
 */
export type TenantResolver<Req extends MinimalRequest = MinimalRequest> = (
  req: Req,
) => TenantContext | undefined | Promise<TenantContext | undefined>;

/**
 * Default tenant id shape: 1-64 chars of letters, digits, `-`, `_`. Override via `validateTenantId`.
 *
 * Exported only so `test/tenant/*.fuzz.test.ts` has a real oracle to fuzz
 * against instead of duplicating this pattern (and risking drift) in a test
 * file. Not re-exported from `tenant/index.ts`, so it stays out of the
 * package's public API.
 */
export const DEFAULT_TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates `tenantId` against `validate` (defaulting to the same
 * `/^[a-zA-Z0-9_-]{1,64}$/` pattern {@link createTenantMiddleware} itself
 * defaults to), throwing {@link InvalidTenantIdError} if it fails.
 *
 * `createTenantMiddleware` deliberately never throws for an invalid
 * resolved tenant id — an HTTP middleware should respond directly (via
 * `onMissing`) rather than force every caller to install an
 * error-handling middleware, the same reasoning `createRateLimitMiddleware`
 * and `requirePermission` follow. For call sites that want exception-based
 * flow instead — background jobs, queue consumers, RPC/GraphQL resolvers,
 * or any code that receives a tenant id from an untrusted source outside
 * the HTTP request pipeline — use this function, mirroring
 * `assertNotRateLimited`'s role for rate limiting.
 *
 * ```ts
 * import { assertValidTenantId } from '@novavey/multi-tenant-security-kit/tenant';
 *
 * assertValidTenantId(job.tenantId); // throws InvalidTenantIdError if malformed
 * await runWithTenant({ tenantId: job.tenantId }, () => processJob(job));
 * ```
 *
 * @throws {InvalidTenantIdError} if `validate(tenantId)` returns `false`.
 */
export function assertValidTenantId(
  tenantId: string,
  validate: (tenantId: string) => boolean = (id) => DEFAULT_TENANT_ID_PATTERN.test(id),
): void {
  if (!validate(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }
}

/**
 * Why {@link TenantMiddlewareOptions.onMissing} is running: no resolver
 * produced a tenant at all (`'missing'`), or one was resolved but rejected
 * by `validateTenantId` (`'invalid'`) — present alongside the
 * resolved-but-rejected id itself, so a custom handler can log or branch on
 * it without receiving it wrapped in a thrown error.
 */
export type TenantMissingInfo = { reason: 'missing' } | { reason: 'invalid'; tenantId: string };

export interface TenantMiddlewareOptions<Req extends MinimalRequest = MinimalRequest> {
  /** Determines the tenant for each request. See the `*TenantResolver` helpers below for common strategies. */
  resolver: TenantResolver<Req>;
  /**
   * Validates a resolved tenant id before it's trusted. Defaults to
   * rejecting anything but `[a-zA-Z0-9_-]{1,64}` — deliberately strict,
   * since this value often flows into SQL identifiers, cache keys, and
   * file paths downstream.
   */
  validateTenantId?: (tenantId: string) => boolean;
  /**
   * Called when no tenant could be resolved, *or* one was resolved but
   * failed `validateTenantId` — `info.reason` distinguishes the two, and
   * `info.tenantId` carries the rejected value for the `'invalid'` case.
   * Defaults to responding `400 { error: "tenant_required" | "invalid_tenant" }`.
   * Set this to implement e.g. a public/marketing-site fallback that skips
   * tenant scoping entirely by calling `next()` without resolving a tenant.
   */
  onMissing?: (req: Req, res: MinimalResponse, next: NextFunction, info: TenantMissingInfo) => void;
}

/**
 * Builds Express-compatible middleware that resolves the tenant for each
 * request and runs the rest of the request pipeline inside
 * {@link runWithTenant}, so `getCurrentTenant()` / `requireCurrentTenantId()`
 * (and everything built on them — RBAC, rate limiting, audit logging) work
 * for the lifetime of that request.
 *
 * Mount this as early as possible, before any route or middleware that
 * touches tenant-scoped data.
 */
export function createTenantMiddleware<Req extends MinimalRequest = MinimalRequest>(
  options: TenantMiddlewareOptions<Req>,
): Middleware<Req> {
  const validateTenantId =
    options.validateTenantId ?? ((id: string) => DEFAULT_TENANT_ID_PATTERN.test(id));
  const onMissing =
    options.onMissing ??
    ((_req: Req, res: MinimalResponse, _next: NextFunction, info: TenantMissingInfo) => {
      res.status(400).json(
        info.reason === 'invalid'
          ? { error: 'invalid_tenant', message: 'The resolved tenant id failed validation.' }
          : {
              error: 'tenant_required',
              message: 'No tenant could be resolved for this request.',
            },
      );
    });

  return (req, res, next) => {
    void (async () => {
      let context: TenantContext;
      try {
        const resolved = await options.resolver(req);
        if (!resolved) {
          onMissing(req, res, next, { reason: 'missing' });
          return;
        }
        if (!validateTenantId(resolved.tenantId)) {
          onMissing(req, res, next, { reason: 'invalid', tenantId: resolved.tenantId });
          return;
        }
        context = resolved;
      } catch (err) {
        next(err);
        return;
      }
      // Deliberately outside the try/catch above. `next()` runs the rest of
      // the request pipeline, inline and synchronously for any synchronous
      // downstream code — if a downstream handler threw and that try/catch
      // still wrapped this call, it would be caught right here and
      // forwarded via `next(err)`, a *second* call to `next` for the same
      // request (the first, successful call already ran and is what
      // triggered the throw). This package's `Middleware`/`NextFunction`
      // types are framework-agnostic — `next` is whatever the caller
      // supplied, with no guarantee of Express-router-style internal
      // exception isolation — so that double call is a real, reachable bug,
      // not a hypothetical one. Whatever happens inside `next()` from here
      // is downstream code's problem to handle, not this middleware's; it
      // has already done its own job (resolving and validating the tenant)
      // successfully by the time it gets here.
      runWithTenant(context, () => next());
    })();
  };
}

// The three `*TenantResolver` factories below deliberately don't share one
// parameter convention — `headerTenantResolver(headerName?)` takes a bare
// string, `subdomainTenantResolver(options?)` takes an options object, and
// `claimTenantResolver(decode, claim?)` takes a function plus a bare string.
// Each shape fits what that resolver actually needs: a header/claim name is
// a single, simple value, so a bare optional parameter is the lightest
// possible call site; `subdomainTenantResolver` has (today) only one config
// knob too, but an options object leaves room to add another without a
// breaking signature change, and reads better for what's more of a "policy"
// than a "name"; `claimTenantResolver`'s primary, always-required input is
// the `decode` function itself, with the claim name a secondary,
// rarely-changed default — putting `decode` first and `claim` last mirrors
// that. This is a deliberate per-resolver fit, not an oversight to unify.

/** Resolves the tenant from a request header (default: `x-tenant-id`). */
export function headerTenantResolver<Req extends MinimalRequest = MinimalRequest>(
  headerName = 'x-tenant-id',
): TenantResolver<Req> {
  const key = headerName.toLowerCase();
  return (req) => {
    const raw = req.headers[key];
    const tenantId = Array.isArray(raw) ? raw[0] : raw;
    return tenantId ? { tenantId } : undefined;
  };
}

export interface SubdomainTenantResolverOptions {
  /** Number of trailing labels to strip (e.g. `2` for `acme.app.example.com` -> `example.com` stripped, `acme` kept). Default `2`. */
  baseDomainLabels?: number;
}

/**
 * Resolves the tenant from the leftmost label of the request's hostname,
 * e.g. `acme.yourapp.com` -> tenant `acme`. Returns `undefined` for bare
 * apex/base domains (no subdomain present) or unresolvable hosts.
 */
export function subdomainTenantResolver<Req extends MinimalRequest = MinimalRequest>(
  options: SubdomainTenantResolverOptions = {},
): TenantResolver<Req> {
  const baseDomainLabels = options.baseDomainLabels ?? 2;
  return (req) => {
    const hostHeader = req.headers.host;
    const host = req.hostname ?? (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader);
    if (!host) return undefined;
    const hostname = host.split(':')[0] ?? '';
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length <= baseDomainLabels) return undefined;
    const tenantId = labels[0];
    return tenantId ? { tenantId } : undefined;
  };
}

/**
 * Resolves the tenant from a claim on an already-decoded token/session
 * object (e.g. a verified JWT payload). Pass your own `decode` function so
 * this stays agnostic of how you verify tokens (jsonwebtoken, jose, a
 * session store, ...) — this helper only extracts the claim, it never
 * performs verification itself.
 */
export function claimTenantResolver<Req extends MinimalRequest = MinimalRequest>(
  decode: (
    req: Req,
  ) => { [claim: string]: unknown } | undefined | Promise<{ [claim: string]: unknown } | undefined>,
  claim = 'tenant_id',
): TenantResolver<Req> {
  return async (req) => {
    const claims = await decode(req);
    const tenantId = claims?.[claim];
    return typeof tenantId === 'string' && tenantId.length > 0 ? { tenantId } : undefined;
  };
}
