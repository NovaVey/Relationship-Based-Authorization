/**
 * Proves the RLS module's SQL actually enforces tenant isolation when run
 * against a real Postgres — not just that it produces the expected SQL
 * *text* (that's what test/rls/postgres.test.ts covers).
 *
 * Needs Docker; runs in its own vitest project (see vitest.integration.config.ts)
 * via `npm run test:integration`, kept separate from the default `npm test`
 * so contributors without Docker aren't blocked on the fast unit suite.
 *
 * Deliberately runs the app-level queries as a **non-superuser role that
 * owns the table**, not the container's default (superuser) role.
 * Postgres superusers bypass row-level security unconditionally, regardless
 * of `FORCE ROW LEVEL SECURITY` — testing as one would silently prove
 * nothing about the actual policy. Table ownership is the specific case
 * `FORCE` exists for (owners are otherwise exempt from RLS on their own
 * tables), so this is also the most direct test of that behavior.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import {
  generateEnableRlsSql,
  generateSetTenantContextSql,
  generateTenantIsolationPolicySql,
  tenantWhereClause,
} from '../../src/rls/postgres.js';

describe('RLS SQL enforces real tenant isolation in Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let adminClient: Client;
  let appClient: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    adminClient = new Client({ connectionString: container.getConnectionUri() });
    await adminClient.connect();

    await adminClient.query(`CREATE ROLE app_role LOGIN PASSWORD 'app_role_password'`);

    await adminClient.query(`
      CREATE TABLE invoices (
        id serial PRIMARY KEY,
        tenant_id text NOT NULL,
        note text
      );
    `);
    // Ownership (not a GRANT) is what makes app_role's later privileges
    // implicit, and what makes FORCE ROW LEVEL SECURITY meaningful to test.
    await adminClient.query(`ALTER TABLE invoices OWNER TO app_role`);

    // Exactly what this package generates — nothing hand-tweaked here.
    await adminClient.query(generateEnableRlsSql('invoices'));
    await adminClient.query(generateTenantIsolationPolicySql({ table: 'invoices' }));

    // Seeded as the admin (superuser) role, which is the one place in this
    // file that's *supposed* to see/write every tenant's rows regardless of
    // the policy.
    await adminClient.query(
      `INSERT INTO invoices (tenant_id, note) VALUES ('acme', 'acme-1'), ('acme', 'acme-2'), ('globex', 'globex-1')`,
    );

    appClient = new Client({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'app_role',
      password: 'app_role_password',
    });
    await appClient.connect();
  }, 120_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
    await container?.stop();
  });

  // Every app_role-facing test runs inside its own transaction, rolled back
  // afterward — set_config(..., true) (the `true` = is_local) scopes the
  // session tenant context to the enclosing transaction, matching exactly
  // how docs/row-level-security.md documents real usage (BEGIN, set the
  // context, run queries, COMMIT). Rolling back instead of committing also
  // keeps every test's mutations from leaking into the next.
  beforeEach(async () => {
    await appClient.query('BEGIN');
  });

  afterEach(async () => {
    await appClient.query('ROLLBACK');
  });

  it('a tenant only sees its own rows', async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    const result = await appClient.query('SELECT tenant_id, note FROM invoices ORDER BY note');
    expect(result.rows).toEqual([
      { tenant_id: 'acme', note: 'acme-1' },
      { tenant_id: 'acme', note: 'acme-2' },
    ]);
  });

  it('switching the session tenant id changes what is visible, same connection', async () => {
    await appClient.query(generateSetTenantContextSql(), ['globex']);
    const result = await appClient.query('SELECT tenant_id, note FROM invoices');
    expect(result.rows).toEqual([{ tenant_id: 'globex', note: 'globex-1' }]);
  });

  it('fails closed: no rows are visible when no tenant context has been set', async () => {
    // No generateSetTenantContextSql() call at all. current_setting(...,
    // true) returns NULL when unset, and "tenant_id" = NULL is never true
    // under SQL's three-valued logic — this is the secure-by-default
    // property the missing_ok=true argument is there for.
    const result = await appClient.query('SELECT * FROM invoices');
    expect(result.rows).toEqual([]);
  });

  it("blocks writes to another tenant's rows, even with no WHERE clause at all", async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    const result = await appClient.query(`UPDATE invoices SET note = 'tampered'`);
    // Only acme's 2 rows were ever visible to the UPDATE's USING clause.
    expect(result.rowCount).toBe(2);

    const check = await adminClient.query(`SELECT note FROM invoices WHERE tenant_id = 'globex'`);
    expect(check.rows[0]?.note).toBe('globex-1'); // untouched
  });

  it('rejects inserting a row for a different tenant than the active session context', async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    await expect(
      appClient.query(`INSERT INTO invoices (tenant_id, note) VALUES ('globex', 'sneaky')`),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tenantWhereClause() composes a correct, working filter into a hand-written query', async () => {
    const { clause, nextParamIndex } = tenantWhereClause('tenant_id', 2);
    expect(nextParamIndex).toBe(3);

    // Deliberately the admin (RLS-bypassing) connection here, so this test
    // is isolated to tenantWhereClause()'s own correctness rather than
    // double-counting the policy's enforcement.
    const result = await adminClient.query(
      `SELECT note FROM invoices WHERE note LIKE $1 AND ${clause} ORDER BY note`,
      ['%-%', 'acme'],
    );
    expect(result.rows.map((row: { note: string }) => row.note)).toEqual(['acme-1', 'acme-2']);
  });
});

/**
 * Regression coverage for a real bug: `generateTenantIsolationPolicySql`
 * used to emit `USING` and `WITH CHECK` unconditionally regardless of
 * `command`, but Postgres rejects `WITH CHECK` on a SELECT/DELETE-only
 * policy and rejects `USING` on an INSERT-only policy — so the SQL this
 * module generated for anything other than `ALL`/`UPDATE` failed outright
 * against a real database. Executing all three `CREATE POLICY` statements
 * below without throwing *is* the regression test; the enforcement
 * assertions after that prove the narrowed policies still work correctly.
 */
describe('per-command (SELECT/INSERT/DELETE-only) policies execute against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let adminClient: Client;
  let appClient: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    adminClient = new Client({ connectionString: container.getConnectionUri() });
    await adminClient.connect();

    await adminClient.query(`CREATE ROLE app_role LOGIN PASSWORD 'app_role_password'`);

    await adminClient.query(`
      CREATE TABLE command_scoped (
        id serial PRIMARY KEY,
        tenant_id text NOT NULL,
        note text
      );
    `);
    await adminClient.query(`ALTER TABLE command_scoped OWNER TO app_role`);
    await adminClient.query(generateEnableRlsSql('command_scoped'));

    // Each command gets its own policy (distinct policyName — Postgres
    // policy names must be unique per table) so each one is scoped to
    // exactly the command Postgres will only accept USING/WITH CHECK for.
    await adminClient.query(
      generateTenantIsolationPolicySql({
        table: 'command_scoped',
        command: 'SELECT',
        policyName: 'command_scoped_select',
      }),
    );
    await adminClient.query(
      generateTenantIsolationPolicySql({
        table: 'command_scoped',
        command: 'INSERT',
        policyName: 'command_scoped_insert',
      }),
    );
    await adminClient.query(
      generateTenantIsolationPolicySql({
        table: 'command_scoped',
        command: 'DELETE',
        policyName: 'command_scoped_delete',
      }),
    );

    await adminClient.query(
      `INSERT INTO command_scoped (tenant_id, note) VALUES ('acme', 'acme-a'), ('acme', 'acme-b'), ('globex', 'globex-a')`,
    );

    appClient = new Client({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'app_role',
      password: 'app_role_password',
    });
    await appClient.connect();
  }, 120_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await appClient.query('BEGIN');
  });

  afterEach(async () => {
    await appClient.query('ROLLBACK');
  });

  it('SELECT-only policy: a tenant only sees its own rows', async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    const result = await appClient.query(
      'SELECT tenant_id, note FROM command_scoped ORDER BY note',
    );
    expect(result.rows).toEqual([
      { tenant_id: 'acme', note: 'acme-a' },
      { tenant_id: 'acme', note: 'acme-b' },
    ]);
  });

  it('INSERT-only policy: allows inserting a row for your own tenant', async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    await expect(
      appClient.query(
        `INSERT INTO command_scoped (tenant_id, note) VALUES ('acme', 'new-acme-row')`,
      ),
    ).resolves.toBeDefined();
  });

  it('INSERT-only policy: rejects inserting a row for a different tenant', async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    await expect(
      appClient.query(`INSERT INTO command_scoped (tenant_id, note) VALUES ('globex', 'sneaky')`),
    ).rejects.toThrow(/row-level security/i);
  });

  it('DELETE-only policy: only deletes rows belonging to the active tenant, even with no WHERE clause', async () => {
    await appClient.query(generateSetTenantContextSql(), ['acme']);
    const result = await appClient.query(`DELETE FROM command_scoped`);
    // Only acme's 2 rows were ever visible to the DELETE's USING clause.
    expect(result.rowCount).toBe(2);

    const check = await adminClient.query(
      `SELECT note FROM command_scoped WHERE tenant_id = 'globex'`,
    );
    expect(check.rows[0]?.note).toBe('globex-a'); // untouched
  });
});
