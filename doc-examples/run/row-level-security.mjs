// Mirrors docs/row-level-security.md's pure SQL-generation code samples —
// asserts the actual output matches the doc's own comments *exactly*, so a
// doc edit that silently drifts from real output fails CI. Keep in sync
// with the doc — see doc-examples/README.md for the convention this file
// is part of.
import assert from 'node:assert/strict';
import {
  generateEnableRlsSql,
  generateTenantIsolationPolicySql,
  generateTenantIsolationMigration,
  InvalidSqlIdentifierError,
  SecurityKitError,
} from '@novavey/multi-tenant-security-kit/rls';

// "Setting up a table"
assert.equal(
  generateEnableRlsSql('invoices'),
  'ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;\n' +
    'ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;',
);

assert.equal(
  generateTenantIsolationPolicySql({ table: 'invoices' }),
  'CREATE POLICY "invoices_tenant_isolation" ON "invoices"\n' +
    '  USING ("tenant_id" = current_setting(\'app.current_tenant_id\', true))\n' +
    '  WITH CHECK ("tenant_id" = current_setting(\'app.current_tenant_id\', true));',
);

// "Customizing the policy" — just needs to not throw, and to actually use
// every option (the doc doesn't show the output for this one).
generateTenantIsolationPolicySql({
  table: 'invoices',
  tenantColumn: 'org_id',
  policyName: 'invoices_org_scope',
  sessionSetting: 'app.current_org_id',
  command: 'SELECT',
  roles: ['app_user'],
});

// "Generating a full migration" — just needs to not throw.
generateTenantIsolationMigration([
  'invoices',
  'line_items',
  { table: 'audit_events', command: 'SELECT' },
]);

// "Security model" — an invalid identifier throws InvalidSqlIdentifierError
// (a SecurityKitError, code INVALID_SQL_IDENTIFIER), not a bare TypeError.
assert.throws(
  () => generateEnableRlsSql('users; DROP TABLE users;--'),
  (err) => {
    assert.ok(err instanceof InvalidSqlIdentifierError);
    assert.ok(err instanceof SecurityKitError);
    assert.equal(err.code, 'INVALID_SQL_IDENTIFIER');
    assert.equal(err.paramName, 'table');
    return true;
  },
);

console.log('OK row-level-security.md: SQL generation examples match the doc comments exactly');
