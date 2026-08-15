import { ForbiddenError } from '../errors.js';
import type { MinimalRequest, MinimalResponse, Middleware, NextFunction } from '../http/types.js';
import { requireCurrentTenantId } from '../tenant/context.js';
import type { RbacPolicy } from './policy.js';
import type { AccessSubject, Permission } from './types.js';

/**
 * Resolves the {@link AccessSubject} (tenant + roles) a permission check
 * should be evaluated against, for a single request. May be async (e.g.
 * to look roles up from a database or decoded token) and may return
 * `undefined` if no subject could be determined — {@link requirePermission}
 * treats that as a denial rather than crashing.
 */
export type SubjectResolver<Req extends MinimalRequest = MinimalRequest> = (
  req: Req,
) => AccessSubject | undefined | Promise<AccessSubject | undefined>;

/** Options for {@link requirePermission}. */
export interface RequirePermissionOptions<Req extends MinimalRequest = MinimalRequest> {
  /** The policy to evaluate the permission check against. */
  policy: RbacPolicy;
  /**
   * The permission required to proceed, or a function of the request that
   * computes it (e.g. to derive `"invoices:${req.method === 'GET' ? 'read' : 'write'}"`).
   */
  permission: Permission | ((req: Req) => Permission);
  /** Determines the subject (tenant + roles) for each request. */
  getSubject: SubjectResolver<Req>;
  /**
   * Called when the permission check is denied, instead of calling
   * `next()`. Defaults to responding
   * `403 { error: "forbidden", message, permission }`. Override this to
   * customize the response shape, add logging/audit hooks, or redirect
   * instead of returning JSON.
   */
  onDenied?: (req: Req, res: MinimalResponse, next: NextFunction, error: ForbiddenError) => void;
}

/** Default `onDenied`: responds `403` with a small JSON body describing the denial. */
function defaultOnDenied<Req extends MinimalRequest>(
  _req: Req,
  res: MinimalResponse,
  _next: NextFunction,
  error: ForbiddenError,
): void {
  res.status(403).json({
    error: 'forbidden',
    message: error.message,
    permission: error.permission,
  });
}

/**
 * Builds Express-compatible middleware that enforces a single RBAC
 * permission before letting a request through.
 *
 * The subject is resolved fresh per-request via `getSubject` (rather than
 * being fixed at middleware-construction time) so the same middleware
 * instance can be reused across every request while still reflecting
 * each caller's actual roles. A `getSubject` that *resolves* to `undefined`
 * (e.g. "no valid session") is treated as a denial via `onDenied`, the same
 * as a real permission failure — "we don't know who this is" and "we know
 * who this is and they're not allowed" both result in the same
 * safe-by-default outcome.
 *
 * A `getSubject` that *throws*, on the other hand, is deliberately **not**
 * treated as a denial — it's forwarded to `next(err)` like any other
 * unexpected error. Collapsing a thrown error (e.g. a downstream
 * auth/session service being unreachable) into an ordinary 403 denial
 * would hide a real outage behind what looks like a routine access-control
 * response, including in any monitoring built on `onDenied`. If you want
 * failures from your own `getSubject` treated as a denial instead of an
 * exception, catch them yourself and resolve to `undefined`.
 */
export function requirePermission<Req extends MinimalRequest = MinimalRequest>(
  options: RequirePermissionOptions<Req>,
): Middleware<Req> {
  const onDenied = options.onDenied ?? defaultOnDenied;

  return (req, res, next) => {
    void (async () => {
      let subject: AccessSubject;
      let permission: Permission;
      try {
        const resolved = await options.getSubject(req);
        if (!resolved) {
          onDenied(
            req,
            res,
            next,
            new ForbiddenError('Access denied: no subject could be resolved for this request.'),
          );
          return;
        }
        subject = resolved;
        permission =
          typeof options.permission === 'function' ? options.permission(req) : options.permission;
      } catch (err) {
        next(err);
        return;
      }

      try {
        options.policy.assert(subject, permission);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          onDenied(req, res, next, err);
          return;
        }
        next(err);
        return;
      }

      // `next()` is deliberately outside both try/catch blocks above (it
      // used to sit inside the second one, right after `.assert()`
      // succeeds). `next()` runs the rest of the request pipeline inline
      // for synchronous downstream code — if a downstream handler threw and
      // this were still inside a try/catch that also calls `next(err)`,
      // that throw would be caught right here and forwarded via `next(err)`
      // a *second* time for the same request (the first, successful call
      // already ran and is what triggered the throw). By the time control
      // reaches here, `.assert()` has already succeeded — nothing left for
      // this middleware to redirect to `onDenied`/`next(err)` on its own
      // account.
      next();
    })();
  };
}

/**
 * Builds a {@link SubjectResolver} that reads roles off a request property
 * (default `"roles"`, e.g. as set by an earlier auth middleware) and takes
 * the tenant id from the active tenant context via
 * {@link requireCurrentTenantId} rather than from anything on the request
 * itself.
 *
 * This is intentional defense-in-depth: it makes it structurally
 * impossible for this helper to construct a subject scoped to a tenant
 * other than the one already active for the request (e.g. from a stale or
 * forged `req.tenantId`-style field), because the tenant always comes from
 * {@link https://github.com/NovaVey/Multi-Tenant-Security-Kit#tenant | the tenant context}
 * set up by `createTenantMiddleware` earlier in the pipeline.
 *
 * @throws {TenantContextError} if no tenant context is active when the resolver runs.
 */
export function subjectFromRequestRoles<Req extends MinimalRequest = MinimalRequest>(
  rolesProperty = 'roles',
): SubjectResolver<Req> {
  return (req) => {
    // `MinimalRequest` deliberately has no index signature (see
    // src/http/types.ts), so reading a caller-configurable property name
    // needs an explicit, narrowly-scoped cast here rather than widening
    // the public type.
    const raw = (req as Record<string, unknown>)[rolesProperty];
    const roles = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { tenantId: requireCurrentTenantId(), roles };
  };
}
