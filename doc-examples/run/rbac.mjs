// Mirrors docs/rbac.md's policy-definition and permission-matching
// examples. Keep in sync — see doc-examples/README.md for the convention
// this file is part of.
import assert from 'node:assert/strict';
import { RbacPolicy } from '@novavey/multi-tenant-security-kit/rbac';

const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read', 'reports:read'] },
  { name: 'billing_admin', permissions: ['invoices:*'], inherits: ['viewer'] },
  { name: 'owner', permissions: ['*'] },
]);

// "Permission matching"
assert.equal(policy.can({ tenantId: 'acme', roles: ['billing_admin'] }, 'invoices:write'), true); // via invoices:*
assert.equal(policy.can({ tenantId: 'acme', roles: ['viewer'] }, 'invoices:write'), false);

// Inheritance: billing_admin inherits viewer's permissions too.
assert.equal(policy.can({ tenantId: 'acme', roles: ['billing_admin'] }, 'reports:read'), true);

// Superuser wildcard.
assert.equal(policy.can({ tenantId: 'acme', roles: ['owner'] }, 'anything:at:all'), true);

// assert() throws ForbiddenError rather than returning false.
assert.throws(() => policy.assert({ tenantId: 'acme', roles: ['viewer'] }, 'invoices:write'), {
  name: 'ForbiddenError',
});

// A role name not in the policy contributes no permissions, but doesn't throw.
assert.equal(policy.can({ tenantId: 'acme', roles: ['retired_role'] }, 'invoices:read'), false);

console.log('OK rbac.md: policy definition + permission matching examples');
