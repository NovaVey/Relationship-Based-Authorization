// Mirrors docs/tenant-isolation.md's code samples. Keep these in sync — see
// doc-examples/README.md for the convention this file is part of.
import express from 'express';
import {
  createTenantMiddleware,
  headerTenantResolver,
  subdomainTenantResolver,
  claimTenantResolver,
  assertSameTenant,
  assertTenantMatches,
  scopeToTenant,
  runWithTenant,
} from '@novavey/multi-tenant-security-kit/tenant';

declare const app: express.Express;
declare const db: {
  invoices: {
    findById(id: string): Promise<{ tenantId: string; id: string }>;
    find(query: unknown): Promise<unknown[]>;
  };
};

// "Resolving the tenant from a request"

app.use(createTenantMiddleware({ resolver: headerTenantResolver() }));
app.use(createTenantMiddleware({ resolver: subdomainTenantResolver() }));
app.use(
  createTenantMiddleware({
    resolver: claimTenantResolver(
      (req) => (req as express.Request & { auth?: Record<string, unknown> }).auth,
      'tenant_id',
    ),
  }),
);

// "Background jobs and non-HTTP entry points"
declare const job: { tenantId: string };
declare function processJob(job: { tenantId: string }): void;
await runWithTenant({ tenantId: job.tenantId }, () => processJob(job));

// "Guarding against cross-tenant access" — import block
void assertSameTenant;

// assertTenantMatches usage
declare const req: express.Request;
{
  const invoice = await db.invoices.findById(String(req.params.id));
  assertTenantMatches(invoice); // throws CrossTenantAccessError if invoice.tenantId !== the active tenant
}

// scopeToTenant usage
{
  const rows = await db.invoices.find(scopeToTenant({ status: 'open' }));
  void rows;
}
