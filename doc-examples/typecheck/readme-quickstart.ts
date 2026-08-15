// Mirrors README.md's Quickstart code block. Keep these in sync — see
// doc-examples/README.md for the convention this file is part of.
import express from 'express';
import {
  createTenantMiddleware,
  headerTenantResolver,
  scopeToTenant,
} from '@novavey/multi-tenant-security-kit/tenant';
import {
  RbacPolicy,
  requirePermission,
  subjectFromRequestRoles,
} from '@novavey/multi-tenant-security-kit/rbac';
import {
  TenantRateLimiter,
  createRateLimitMiddleware,
} from '@novavey/multi-tenant-security-kit/rate-limit';

declare const db: { invoices: { find(query: unknown): Promise<unknown[]> } };

const app = express();

// 1. Resolve the tenant for every request, first.
app.use(createTenantMiddleware({ resolver: headerTenantResolver('x-tenant-id') }));

// 2. Rate-limit per tenant.
const limiter = new TenantRateLimiter({ limit: 100, windowMs: 60_000 });
app.use(createRateLimitMiddleware({ limiter }));

// 3. Enforce permissions per route.
const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read'] },
  { name: 'admin', permissions: ['invoices:*'], inherits: ['viewer'] },
]);

app.get(
  '/invoices',
  requirePermission({ policy, permission: 'invoices:read', getSubject: subjectFromRequestRoles() }),
  async (_req, res) => {
    // 4. Every query is scoped to the active tenant by construction.
    const rows = await db.invoices.find(scopeToTenant({ status: 'open' }));
    res.json(rows);
  },
);
