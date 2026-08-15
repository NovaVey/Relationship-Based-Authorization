/**
 * A fuller example wiring all six Multi-Tenant Security Kit modules
 * together in a small Express app.
 *
 * This file is illustrative, not part of the published package (see
 * eslint.config.js / tsconfig.json — `examples/` is excluded from both) and
 * is not executed by CI. To actually run it:
 *
 *   npm install express
 *   npm install --save-dev @types/express tsx
 *   npx tsx examples/express-basic.ts
 *
 * It uses a trivial in-memory "database" so it has no external
 * dependencies beyond Express itself.
 */

import express from 'express';

import {
  createTenantMiddleware,
  headerTenantResolver,
  assertTenantMatches,
  getCurrentTenantId,
  TenantContextError,
  CrossTenantAccessError,
} from '../src/tenant/index.js';
import {
  RbacPolicy,
  requirePermission,
  subjectFromRequestRoles,
  ForbiddenError,
} from '../src/rbac/index.js';
import { TenantRateLimiter, createRateLimitMiddleware } from '../src/rate-limit/index.js';
import type { RateLimitResult } from '../src/rate-limit/index.js';
import { AuditLogger, ConsoleAuditSink, AuditAction } from '../src/audit/index.js';
import { generateTenantIsolationMigration, generateSetTenantContextSql } from '../src/rls/index.js';
import { EnvKeyProvider, TenantEncryptor } from '../src/crypto/index.js';

// ---------------------------------------------------------------------------
// 0. One-time setup: RLS migration text + the per-tenant encryptor.
//    (Printed/used at startup, not per-request.)
// ---------------------------------------------------------------------------

console.log(
  '--- Run this once against your database (or check it into a migration) ---\n' +
    generateTenantIsolationMigration(['invoices']),
);

// A real (Postgres-backed) request handler would run this once per
// request-scoped connection/transaction, binding the real tenant id as a
// parameter — never concatenated into the SQL string:
//   await client.query(generateSetTenantContextSql(), [tenantId]);
console.log('--- Per-request/transaction, before any query ---\n' + generateSetTenantContextSql());

const encryptor = new TenantEncryptor({
  keyProvider: new EnvKeyProvider(
    process.env.MASTER_SECRET ?? 'dev-only-secret-not-for-production',
  ),
});

// ---------------------------------------------------------------------------
// A trivial in-memory "database" standing in for Postgres in this example.
// A real app would run `generateSetTenantContextSql()` (see above) once per
// request-scoped connection/transaction and rely on the RLS policy as a
// second, independent enforcement layer alongside the application-level
// checks below.
// ---------------------------------------------------------------------------

interface Invoice {
  id: string;
  tenantId: string;
  status: string;
  encryptedNotes?: { ciphertext: string; iv: string; authTag: string };
}

const invoices = new Map<string, Invoice>([
  ['inv_1', { id: 'inv_1', tenantId: 'acme', status: 'open' }],
  ['inv_2', { id: 'inv_2', tenantId: 'globex', status: 'open' }],
]);

// ---------------------------------------------------------------------------
// 1. Audit logging — set up once, shared across the app.
// ---------------------------------------------------------------------------

const auditLog = new AuditLogger({ sinks: [new ConsoleAuditSink()] });

// ---------------------------------------------------------------------------
// 2. RBAC policy — set up once, shared across the app.
// ---------------------------------------------------------------------------

const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read'] },
  { name: 'billing_admin', permissions: ['invoices:*'], inherits: ['viewer'] },
]);

// ---------------------------------------------------------------------------
// 3. Rate limiter — set up once, shared across the app.
// ---------------------------------------------------------------------------

const limiter = new TenantRateLimiter({ limit: 100, windowMs: 60_000 });

// ---------------------------------------------------------------------------
// 4. Wire it all up.
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Resolve the tenant first — everything downstream depends on it.
app.use(createTenantMiddleware({ resolver: headerTenantResolver('x-tenant-id') }));

// Rate-limit per tenant. onLimited is only needed here to also audit-log
// the denial — createRateLimitMiddleware's default onLimited (setting
// Retry-After and responding 429) already covers the response itself.
app.use(
  createRateLimitMiddleware({
    limiter,
    onLimited: (_req, res, _next, result: RateLimitResult) => {
      const retryAfterMs = Math.max(0, result.resetMs - Date.now());
      auditLog.log({
        action: AuditAction.RateLimitExceeded,
        outcome: 'denied',
        metadata: { retryAfterMs },
      });
      res.setHeader('Retry-After', Math.max(1, Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs });
    },
  }),
);

app.get(
  '/invoices/:id',
  // <express.Request>: MinimalRequest (requirePermission's default) has no
  // `params` — the onDenied callback below reads `req.params.id`, and the
  // route handler after it reads `req.params.id` too, so both need
  // Express's own request type here rather than the framework-agnostic
  // default. See docs/rbac.md's "Middleware" section for the same pattern.
  requirePermission<express.Request>({
    policy,
    permission: 'invoices:read',
    getSubject: subjectFromRequestRoles(),
    onDenied: (req, res, _next, error) => {
      auditLog.log({
        action: AuditAction.RbacPermissionDenied,
        // String(...): Express 5 types route params as `string | string[]`
        // (to support repeated-segment patterns) — see the same coercion in
        // docs/tenant-isolation.md's assertTenantMatches example.
        targetId: String(req.params.id),
        outcome: 'denied',
        metadata: { permission: error.permission },
      });
      res.status(403).json({ error: 'forbidden', message: error.message });
    },
  }),
  async (req, res) => {
    const invoice = invoices.get(String(req.params.id));
    if (!invoice) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      // Second, explicit guard even though the query above didn't filter by
      // tenant — this is exactly the primary-key-lookup leak this kit exists
      // to close.
      assertTenantMatches(invoice);
    } catch (err) {
      if (err instanceof CrossTenantAccessError) {
        auditLog.log({
          action: AuditAction.TenantIsolationViolation,
          targetId: invoice.id,
          outcome: 'denied',
          metadata: { expectedTenantId: err.expectedTenantId, actualTenantId: err.actualTenantId },
        });
        res.status(404).json({ error: 'not_found' }); // 404, not 403 — don't confirm the resource exists
        return;
      }
      throw err;
    }

    res.json(invoice);
  },
);

app.get('/invoices', async (_req, res) => {
  // A real (SQL) data layer would use scopeToTenant()/tenantWhereClause() —
  // see docs/tenant-isolation.md and docs/row-level-security.md — to scope
  // the query itself. This in-memory example filters in application code,
  // but the principle is identical: derive the filter from the active
  // tenant context, never trust an unscoped read.
  const tenantId = getCurrentTenantId();
  const openInvoices = [...invoices.values()].filter(
    (inv) => inv.tenantId === tenantId && inv.status === 'open',
  );
  res.json(openInvoices);
});

app.post('/invoices/:id/notes', express.text(), async (req, res) => {
  const invoice = invoices.get(req.params.id);
  if (!invoice) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  try {
    // Same guard, same audit-and-404 pattern as the GET handler above —
    // a write path needs this exactly as much as a read path does.
    assertTenantMatches(invoice);
  } catch (err) {
    if (err instanceof CrossTenantAccessError) {
      auditLog.log({
        action: AuditAction.TenantIsolationViolation,
        targetId: invoice.id,
        outcome: 'denied',
        metadata: { expectedTenantId: err.expectedTenantId, actualTenantId: err.actualTenantId },
      });
      res.status(404).json({ error: 'not_found' }); // 404, not 403 — don't confirm the resource exists
      return;
    }
    throw err;
  }

  // Encrypt sensitive free-text under this tenant's own derived key before storing it.
  invoice.encryptedNotes = await encryptor.encrypt(invoice.tenantId, req.body as string);
  res.status(204).end();
});

// Central error handler: turn the kit's typed errors into clean responses,
// and make sure "no tenant context" never surfaces as a raw 500.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof TenantContextError) {
      res.status(400).json({ error: 'tenant_required' });
      return;
    }
    if (err instanceof ForbiddenError) {
      res.status(403).json({ error: 'forbidden', message: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  },
);

app.listen(3000, () => {
  console.log('Example app listening on http://localhost:3000');
});
