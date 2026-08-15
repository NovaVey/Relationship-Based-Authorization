// Mirrors docs/tenant-isolation.md's core context-propagation example.
// Keep in sync — see doc-examples/README.md for the convention this file
// is part of.
import assert from 'node:assert/strict';
import { runWithTenant, getCurrentTenantId } from '@novavey/multi-tenant-security-kit/tenant';

async function someAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

await runWithTenant({ tenantId: 'acme' }, async () => {
  assert.equal(getCurrentTenantId(), 'acme');
  await someAsyncWork();
  assert.equal(getCurrentTenantId(), 'acme'); // still 'acme' — propagated across the await
});

assert.equal(getCurrentTenantId(), undefined); // the context ends when runWithTenant returns

console.log('OK tenant-isolation.md: core context propagation example');
