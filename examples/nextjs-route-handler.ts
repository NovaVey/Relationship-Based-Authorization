/**
 * Tenant scoping, rate limiting, and RBAC inside a Next.js (App Router)
 * Route Handler.
 *
 * This file is illustrative, not part of the published package (see
 * eslint.config.js / tsconfig.json — `examples/` is excluded from both) and
 * is not executed by CI. In a real app it would live at e.g.
 * `app/api/invoices/route.ts` — copy the `GET` function below into a file
 * at that path.
 *
 * Deliberately **not** using `createTenantMiddleware`/`createRateLimitMiddleware`
 * here — Route Handlers receive/return the Web Fetch API's `Request`/
 * `Response`, not an Express-style mutable `(req, res, next)` triple.
 * `Request.headers` is a `Headers` object (`.get(name)`, not a plain
 * object), and there's no `res` to call `.status()`/`.json()` on — you
 * return a new `Response`. Those types don't structurally match
 * `MinimalRequest`/`MinimalResponse`, so rather than writing an adapter for
 * a shape that doesn't fit, call the framework-agnostic primitives
 * directly: `runWithTenant()`, `TenantRateLimiter.consume()` +
 * `assertNotRateLimited()`, and `RbacPolicy.assert()` — none of which take
 * a request/response at all.
 *
 * **Runtime matters.** Route Handlers run on the Node.js runtime by
 * default, which is required here — `AsyncLocalStorage` (what
 * `runWithTenant()` is built on) is not available in the Edge runtime. Do
 * *not* add `export const runtime = 'edge'` to a file using this pattern.
 * This is a different concern from a root `middleware.ts` file, which
 * defaults to the Edge runtime and needs an explicit opt-in
 * (`export const config = { runtime: 'nodejs' }`) to use anything in this
 * package — prefer doing tenant-scoped work in Route Handlers, as below,
 * over Next.js Middleware.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { runWithTenant, requireCurrentTenantId } from '../src/tenant/index.js';
import { TenantRateLimiter, assertNotRateLimited } from '../src/rate-limit/index.js';
import { RbacPolicy } from '../src/rbac/index.js';
import { RateLimitExceededError, ForbiddenError } from '../src/errors.js';

const limiter = new TenantRateLimiter({ limit: 100, windowMs: 60_000 });

const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read'] },
  { name: 'billing_admin', permissions: ['invoices:*'], inherits: ['viewer'] },
]);

// Stand-ins for real auth/data lookups — see examples/express-basic.ts for
// the equivalent in-memory data used across every framework example.
declare function rolesForRequest(request: NextRequest): string[];
declare function listOpenInvoices(tenantId: string): unknown[];

export async function GET(request: NextRequest): Promise<Response> {
  const tenantId = request.headers.get('x-tenant-id');
  if (!tenantId) {
    return NextResponse.json({ error: 'tenant_required' }, { status: 400 });
  }

  return runWithTenant({ tenantId }, async () => {
    try {
      assertNotRateLimited(await limiter.consume(tenantId));
      policy.assert({ tenantId, roles: rolesForRequest(request) }, 'invoices:read');
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        return NextResponse.json(
          { error: 'rate_limit_exceeded', retryAfterMs: err.retryAfterMs },
          { status: 429 },
        );
      }
      if (err instanceof ForbiddenError) {
        return NextResponse.json({ error: 'forbidden', message: err.message }, { status: 403 });
      }
      throw err;
    }

    // `requireCurrentTenantId()` / `scopeToTenant()` work here exactly as
    // they do in any other framework's handler — the active tenant context
    // was established by the `runWithTenant()` call above, not by any
    // middleware.
    return NextResponse.json({ invoices: listOpenInvoices(requireCurrentTenantId()) });
  });
}
