/**
 * Wiring the tenant + rate-limit middleware into a Koa app.
 *
 * This file is illustrative, not part of the published package (see
 * eslint.config.js / tsconfig.json — `examples/` is excluded from both) and
 * is not executed by CI. To actually run it:
 *
 *   npm install koa
 *   npm install --save-dev @types/koa tsx
 *   npx tsx examples/koa-basic.ts
 *
 * Two adapters, both needed because Koa's shape genuinely differs from
 * Express's, verified rather than assumed:
 *
 * 1. Response: Koa's `ctx` sets outgoing state via property assignment
 *    (`ctx.status = 200`, `ctx.body = value`) and `ctx.set(name, value)` for
 *    headers, not `MinimalResponse`'s `.status()/.json()/.setHeader()`
 *    method calls — `toMinimalResponse` below bridges that. `ctx` itself
 *    (not `ctx.request`) already structurally satisfies `MinimalRequest` as
 *    the request half, no adapter needed there.
 * 2. Control flow: this package's `Middleware` calls a callback-style
 *    `next(err?)`, while Koa's own `next` is a zero-argument function
 *    returning a `Promise<void>` (Koa's onion model — errors propagate by
 *    `throw`/rejection through that promise, not by passing an error to
 *    `next`). `toKoaMiddleware` bridges the two so the active tenant
 *    context (set via `runWithTenant` inside `createTenantMiddleware`) is
 *    still in scope when Koa's own `next()` — and therefore the rest of the
 *    middleware chain — runs.
 */

import Koa from 'koa';
import type { Context, Next } from 'koa';

import {
  createTenantMiddleware,
  headerTenantResolver,
  getCurrentTenantId,
} from '../src/tenant/index.js';
import { createRateLimitMiddleware, TenantRateLimiter } from '../src/rate-limit/index.js';
import type { Middleware, MinimalResponse } from '../src/http/types.js';

function toMinimalResponse(ctx: Context): MinimalResponse {
  return {
    get statusCode() {
      return ctx.status;
    },
    status(code: number) {
      ctx.status = code;
      return this;
    },
    json(body: unknown) {
      ctx.body = body;
      return this;
    },
    setHeader(name: string, value: string | number) {
      ctx.set(name, String(value));
      return this;
    },
  };
}

function toKoaMiddleware(mw: Middleware<Context>): (ctx: Context, next: Next) => Promise<void> {
  return (ctx, next) =>
    new Promise<void>((resolve, reject) => {
      mw(ctx, toMinimalResponse(ctx), (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(next());
      });
    });
}

const app = new Koa();

const tenantMw = createTenantMiddleware({ resolver: headerTenantResolver('x-tenant-id') });
const limiter = new TenantRateLimiter({ limit: 100, windowMs: 60_000 });
const rateLimitMw = createRateLimitMiddleware({ limiter });

// Resolve the tenant first — everything downstream depends on it.
app.use(toKoaMiddleware(tenantMw));

// Rate-limit per tenant.
app.use(toKoaMiddleware(rateLimitMw));

// RBAC (`requirePermission(...)`) and audit logging follow the exact same
// `Middleware<Req, Res>` shape as the two hooks above — reuse
// `toKoaMiddleware` for those too rather than duplicating the adapter per
// module. See examples/express-basic.ts for a fuller RBAC + audit + RLS +
// crypto walkthrough (the module APIs themselves don't change between
// frameworks, only this adapter layer does).

app.use((ctx) => {
  ctx.body = { tenantId: getCurrentTenantId() };
});

app.listen(3000, () => {
  console.log('Example app listening on http://localhost:3000');
});
