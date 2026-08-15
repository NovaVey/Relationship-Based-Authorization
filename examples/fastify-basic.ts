/**
 * Wiring the tenant + rate-limit middleware into a Fastify app.
 *
 * This file is illustrative, not part of the published package (see
 * eslint.config.js / tsconfig.json — `examples/` is excluded from both) and
 * is not executed by CI. To actually run it:
 *
 *   npm install fastify
 *   npm install --save-dev tsx
 *   npx tsx examples/fastify-basic.ts
 *
 * Fastify's `reply` object uses `.status()/.send()/.header()`, not
 * Express's `.status()/.json()/.setHeader()` — close, but not close enough
 * for `MinimalResponse`'s exact method names (verified: `.status()` is
 * indeed aliased on `FastifyReply`, but there is no `.json()` or
 * `.setHeader()`). `toMinimalResponse` below is the one bit of glue this
 * needs; `FastifyRequest` itself already structurally satisfies
 * `MinimalRequest` with no adapter (same `headers`/`hostname`/`method`/`url`
 * shape as Express's `Request`).
 *
 * Mount each middleware via Fastify's own hook system (`addHook`) rather
 * than `app.use()` — Fastify has no built-in Express-style middleware
 * chain, and the closest add-on (`@fastify/middie`) hands middleware raw
 * Node `http.ServerResponse` objects, which don't have `.status()`/`.json()`
 * either, so it wouldn't remove the need for an adapter. `onRequest` runs
 * before routing, same as mounting early in Express.
 */

import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';

import {
  createTenantMiddleware,
  headerTenantResolver,
  getCurrentTenantId,
} from '../src/tenant/index.js';
import { createRateLimitMiddleware, TenantRateLimiter } from '../src/rate-limit/index.js';
import type { MinimalResponse, NextFunction } from '../src/http/types.js';

function toMinimalResponse(reply: FastifyReply): MinimalResponse {
  return {
    get statusCode() {
      return reply.statusCode;
    },
    status(code: number) {
      reply.status(code);
      return this;
    },
    json(body: unknown) {
      reply.send(body);
      return this;
    },
    setHeader(name: string, value: string | number) {
      reply.header(name, value);
      return this;
    },
  };
}

// Fastify hook `done` callbacks only accept `Error | undefined`, stricter
// than this package's `NextFunction` (`unknown | undefined`) — normalize
// whatever a middleware passes `next()` before handing it to Fastify.
function toHookDone(done: (err?: Error) => void): NextFunction {
  return (err) => {
    done(err instanceof Error ? err : err ? new Error(String(err)) : undefined);
  };
}

const app = Fastify();

const tenantMw = createTenantMiddleware({ resolver: headerTenantResolver('x-tenant-id') });
const limiter = new TenantRateLimiter({ limit: 100, windowMs: 60_000 });
const rateLimitMw = createRateLimitMiddleware({ limiter });

// Resolve the tenant first — everything downstream depends on it.
app.addHook('onRequest', (request, reply, done) => {
  tenantMw(request, toMinimalResponse(reply), toHookDone(done));
});

// Rate-limit per tenant.
app.addHook('onRequest', (request, reply, done) => {
  rateLimitMw(request, toMinimalResponse(reply), toHookDone(done));
});

// RBAC (`requirePermission(...)`) and audit logging follow the exact same
// `Middleware<Req, Res>` shape as the two hooks above — reuse
// `toMinimalResponse`/`toHookDone` for those too rather than duplicating
// the adapter per module. See examples/express-basic.ts for a fuller
// RBAC + audit + RLS + crypto walkthrough (the module APIs themselves don't
// change between frameworks, only this adapter layer does).

app.get('/whoami', async () => {
  return { tenantId: getCurrentTenantId() };
});

app.listen({ port: 3000 }).then(
  (address) => console.log(`Example app listening on ${address}`),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
