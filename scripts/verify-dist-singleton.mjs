#!/usr/bin/env node
/**
 * Guards against a specific, previously-shipped regression class: the
 * package's public entry points (., ./tenant, ./rbac, ./rate-limit, ./audit,
 * ...) must all share exactly ONE `AsyncLocalStorage` instance for the
 * active-tenant context.
 *
 * That's only true if the build genuinely compiles src/tenant/context.ts to
 * a single physical file that every other compiled entry point imports —
 * i.e. bundle:false in tsup.config.ts. If a future change flips that back to
 * bundling each entry independently (bundle:true, the tsup default), every
 * entry silently gets its OWN copy of context.ts and therefore its own
 * separate storage — tenant context set via one subpath becomes invisible
 * to code reached via another, exactly the failure this script exists to
 * catch before it ever reaches npm again.
 *
 * This deliberately runs against the built dist/ output (not src/ via
 * vitest) — the bug only exists in bundled output, so a source-level test
 * can never catch it. Run via `npm run verify:dist`, after `npm run build`.
 *
 * Checked against BOTH published formats (ESM and CJS), not just one. The
 * fix mechanism (module-per-file compilation) is the same for both, but
 * "the same mechanism produces the same result in both formats" is exactly
 * the kind of unverified assumption that let the original bug ship — this
 * script exists because "should be fine" wasn't good enough the first time.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
if (!existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` before `npm run verify:dist`.');
  process.exit(1);
}

async function checkSingleton(format, mods) {
  const {
    runWithTenant,
    getCurrentTenantId,
    rootRequireTenantId,
    subjectFromRequestRoles,
    TenantRateLimiter,
    AuditLogger,
    InMemoryAuditSink,
  } = mods;

  await runWithTenant({ tenantId: 'acme' }, async () => {
    assert.equal(
      getCurrentTenantId(),
      'acme',
      `[${format}] ./tenant: context readable within its own subpath`,
    );

    assert.equal(
      rootRequireTenantId(),
      'acme',
      `[${format}] root package (.) does not share the ./tenant AsyncLocalStorage instance`,
    );

    const subject = await subjectFromRequestRoles()({ headers: {}, roles: ['admin'] });
    assert.equal(
      subject.tenantId,
      'acme',
      `[${format}] ./rbac does not share the ./tenant AsyncLocalStorage instance`,
    );

    const limitResult = await new TenantRateLimiter({ limit: 10, windowMs: 1000 }).consume(
      rootRequireTenantId(),
    );
    assert.equal(
      limitResult.allowed,
      true,
      `[${format}] ./rate-limit tenant-scoped consume failed`,
    );

    const sink = new InMemoryAuditSink();
    new AuditLogger({ sinks: [sink] }).log({ action: 'test', outcome: 'success' });
    assert.equal(
      sink.events[0]?.tenantId,
      'acme',
      `[${format}] ./audit does not share the ./tenant AsyncLocalStorage instance (event.tenantId should default from context)`,
    );
  });

  console.log(`verify:dist [${format}] — all public entry points share one singleton. OK.`);
}

// ESM
{
  const { runWithTenant, getCurrentTenantId } = await import('../dist/tenant/index.js');
  const { requireCurrentTenantId } = await import('../dist/index.js');
  const { subjectFromRequestRoles } = await import('../dist/rbac/index.js');
  const { TenantRateLimiter } = await import('../dist/rate-limit/index.js');
  const { AuditLogger, InMemoryAuditSink } = await import('../dist/audit/index.js');
  await checkSingleton('esm', {
    runWithTenant,
    getCurrentTenantId,
    rootRequireTenantId: requireCurrentTenantId,
    subjectFromRequestRoles,
    TenantRateLimiter,
    AuditLogger,
    InMemoryAuditSink,
  });
}

// CJS
{
  const require = createRequire(import.meta.url);
  const { runWithTenant, getCurrentTenantId } = require('../dist/tenant/index.cjs');
  const { requireCurrentTenantId } = require('../dist/index.cjs');
  const { subjectFromRequestRoles } = require('../dist/rbac/index.cjs');
  const { TenantRateLimiter } = require('../dist/rate-limit/index.cjs');
  const { AuditLogger, InMemoryAuditSink } = require('../dist/audit/index.cjs');
  await checkSingleton('cjs', {
    runWithTenant,
    getCurrentTenantId,
    rootRequireTenantId: requireCurrentTenantId,
    subjectFromRequestRoles,
    TenantRateLimiter,
    AuditLogger,
    InMemoryAuditSink,
  });
}
