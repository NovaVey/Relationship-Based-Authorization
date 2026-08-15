import { describe, expect, it } from 'vitest';

import { InvalidSqlIdentifierError, SecurityKitError } from '../../src/errors.js';
import {
  generateEnableRlsSql,
  generateSetTenantContextSql,
  generateTenantIsolationMigration,
  generateTenantIsolationPolicySql,
  tenantWhereClause,
} from '../../src/rls/postgres.js';

/** SQL-injection-shaped and otherwise-invalid identifier inputs shared across entry points. */
const INVALID_IDENTIFIERS = [
  'users; DROP TABLE users;--',
  'users"; --',
  'my table',
  '',
  'a.b.c',
  '1users',
  'users-table',
  "users' OR '1'='1",
];

/**
 * Invalid inputs for `sessionSetting` params specifically. Unlike table/column/policy
 * names, `sessionSetting` legitimately allows dots (Postgres GUC names are
 * dot-separated, e.g. "app.current_tenant_id"), so "a.b.c" — otherwise on the
 * shared invalid list — is a *valid* sessionSetting and is excluded here in favor
 * of a dedicated invalid-multi-segment case.
 */
const INVALID_SESSION_SETTINGS = [
  ...INVALID_IDENTIFIERS.filter((value) => value !== 'a.b.c'),
  'app.1nvalid',
  'app.my column',
  'app..double_dot',
];

describe('generateEnableRlsSql', () => {
  it('produces the exact expected two-statement SQL for a valid table name', () => {
    expect(generateEnableRlsSql('invoices')).toBe(
      'ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;\n' +
        'ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;',
    );
  });

  it('quotes the table identifier', () => {
    expect(generateEnableRlsSql('accounts')).toContain('"accounts"');
  });

  for (const bad of INVALID_IDENTIFIERS) {
    it(`rejects invalid table name ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() => generateEnableRlsSql(bad)).toThrow(InvalidSqlIdentifierError);
    });

    it(`error message for invalid table name ${JSON.stringify(bad)} names the offending value and parameter`, () => {
      try {
        generateEnableRlsSql(bad);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidSqlIdentifierError);
        expect(err).toBeInstanceOf(SecurityKitError);
        const error = err as InvalidSqlIdentifierError;
        expect(error.code).toBe('INVALID_SQL_IDENTIFIER');
        expect(error.paramName).toBe('table');
        expect(error.message).toContain('table');
        expect(error.message).toContain(JSON.stringify(bad));
      }
    });
  }
});

// Regression (LOW): identifiers were validated for character shape only,
// never length — but Postgres's own default max_identifier_length is 63
// (verified live: `SHOW max_identifier_length`), and a longer identifier
// isn't rejected by Postgres, it's silently *truncated* to 63 characters
// with only a NOTICE. Two different intended identifiers sharing the same
// first 63 characters would silently collide into the same actual
// table/column/policy name, live-verified before this fix.
describe("identifier length limit (63 bytes, Postgres's own default)", () => {
  it('accepts an identifier at exactly the 63-character limit', () => {
    const exactly63 = 'a'.repeat(63);
    expect(() => generateEnableRlsSql(exactly63)).not.toThrow();
  });

  it('rejects an identifier one character over the limit (64 characters)', () => {
    const oneOver = 'a'.repeat(64);
    expect(() => generateEnableRlsSql(oneOver)).toThrow(InvalidSqlIdentifierError);
  });

  it('rejects a much longer identifier that Postgres would otherwise silently truncate', () => {
    const wayOver = 'a'.repeat(70);
    expect(() => generateEnableRlsSql(wayOver)).toThrow(InvalidSqlIdentifierError);
  });

  it('applies the same limit to each segment of a multi-segment sessionSetting', () => {
    const longSegment = 'a'.repeat(64);
    expect(() =>
      generateTenantIsolationPolicySql({ table: 'invoices', sessionSetting: `app.${longSegment}` }),
    ).toThrow(InvalidSqlIdentifierError);
  });

  it('applies the same limit to role names', () => {
    const longRole = 'a'.repeat(64);
    expect(() =>
      generateTenantIsolationPolicySql({ table: 'invoices', roles: [longRole] }),
    ).toThrow(InvalidSqlIdentifierError);
  });
});

describe('generateTenantIsolationPolicySql', () => {
  it('produces exact expected SQL using all defaults', () => {
    expect(generateTenantIsolationPolicySql({ table: 'invoices' })).toBe(
      [
        'CREATE POLICY "invoices_tenant_isolation" ON "invoices"',
        '  USING ("tenant_id" = current_setting(\'app.current_tenant_id\', true))',
        '  WITH CHECK ("tenant_id" = current_setting(\'app.current_tenant_id\', true));',
      ].join('\n'),
    );
  });

  it('omits the FOR clause when command is ALL (explicitly)', () => {
    const sql = generateTenantIsolationPolicySql({ table: 'invoices', command: 'ALL' });
    expect(sql).not.toContain('FOR ALL');
    expect(sql).not.toContain('  FOR');
  });

  it('includes a FOR clause for a non-ALL command', () => {
    expect(generateTenantIsolationPolicySql({ table: 'invoices', command: 'SELECT' })).toBe(
      [
        'CREATE POLICY "invoices_tenant_isolation" ON "invoices"',
        '  FOR SELECT',
        '  USING ("tenant_id" = current_setting(\'app.current_tenant_id\', true));',
      ].join('\n'),
    );
  });

  for (const command of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    it(`includes "FOR ${command}" for command ${command}`, () => {
      expect(generateTenantIsolationPolicySql({ table: 'invoices', command })).toContain(
        `  FOR ${command}`,
      );
    });
  }

  // Postgres itself rejects USING on an INSERT-only policy and rejects WITH
  // CHECK on a SELECT- or DELETE-only policy — `CREATE POLICY ... FOR
  // SELECT ... WITH CHECK (...)` is a syntax error, not a harmless no-op.
  // These lock in exactly which clause(s) each `command` value emits;
  // test/integration/rls-postgres.integration.test.ts proves the generated
  // SQL for every command actually *executes* against real Postgres.
  it('SELECT emits only USING, never WITH CHECK', () => {
    const sql = generateTenantIsolationPolicySql({ table: 'invoices', command: 'SELECT' });
    expect(sql).toContain('USING (');
    expect(sql).not.toContain('WITH CHECK');
  });

  it('DELETE emits only USING, never WITH CHECK', () => {
    const sql = generateTenantIsolationPolicySql({ table: 'invoices', command: 'DELETE' });
    expect(sql).toContain('USING (');
    expect(sql).not.toContain('WITH CHECK');
  });

  it('INSERT emits only WITH CHECK, never USING', () => {
    const sql = generateTenantIsolationPolicySql({ table: 'invoices', command: 'INSERT' });
    expect(sql).toContain('WITH CHECK (');
    expect(sql).not.toContain('USING');
  });

  it('UPDATE emits both USING and WITH CHECK', () => {
    const sql = generateTenantIsolationPolicySql({ table: 'invoices', command: 'UPDATE' });
    expect(sql).toContain('USING (');
    expect(sql).toContain('WITH CHECK (');
  });

  it('ALL (default) emits both USING and WITH CHECK', () => {
    const sql = generateTenantIsolationPolicySql({ table: 'invoices' });
    expect(sql).toContain('USING (');
    expect(sql).toContain('WITH CHECK (');
  });

  it('produces exact expected SQL with a roles list', () => {
    expect(
      generateTenantIsolationPolicySql({ table: 'invoices', roles: ['app_user', 'app_readonly'] }),
    ).toBe(
      [
        'CREATE POLICY "invoices_tenant_isolation" ON "invoices"',
        '  TO "app_user", "app_readonly"',
        '  USING ("tenant_id" = current_setting(\'app.current_tenant_id\', true))',
        '  WITH CHECK ("tenant_id" = current_setting(\'app.current_tenant_id\', true));',
      ].join('\n'),
    );
  });

  it('omits the TO clause when roles is an empty array', () => {
    expect(generateTenantIsolationPolicySql({ table: 'invoices', roles: [] })).not.toContain('TO ');
  });

  // Regression (LOW): the PUBLIC pseudo-role (Postgres's "every role"
  // keyword) used to get the same double-quoting treatment as every other
  // identifier — but PUBLIC is a keyword, not a regular identifier, and
  // quoting it changes its meaning: `TO "PUBLIC"` asks Postgres for an
  // actual role literally named "PUBLIC", which essentially never exists,
  // so CREATE POLICY fails at *execution* time ("role \"PUBLIC\" does not
  // exist") — not caught by this module's own validation, since 'PUBLIC'
  // is a syntactically valid identifier. Verified live against a real
  // Postgres instance both ways, including the surprising fact that
  // lowercase "public" (quoted) coincidentally succeeds despite no role
  // named "public" actually existing.
  describe('the PUBLIC pseudo-role', () => {
    it('emits TO PUBLIC unquoted, not TO "PUBLIC"', () => {
      const sql = generateTenantIsolationPolicySql({ table: 'invoices', roles: ['PUBLIC'] });
      expect(sql).toContain('TO PUBLIC');
      expect(sql).not.toContain('"PUBLIC"');
    });

    it('recognizes PUBLIC case-insensitively', () => {
      const sql = generateTenantIsolationPolicySql({ table: 'invoices', roles: ['public'] });
      expect(sql).toContain('TO PUBLIC');
      expect(sql).not.toContain('"public"');
    });

    it('mixes PUBLIC (unquoted) with real quoted role names in the same TO clause', () => {
      const sql = generateTenantIsolationPolicySql({
        table: 'invoices',
        roles: ['app_user', 'PUBLIC', 'app_readonly'],
      });
      expect(sql).toContain('TO "app_user", PUBLIC, "app_readonly"');
    });
  });

  it('respects a custom tenantColumn, policyName, and sessionSetting', () => {
    const sql = generateTenantIsolationPolicySql({
      table: 'orders',
      tenantColumn: 'org_id',
      policyName: 'orders_isolation_policy',
      sessionSetting: 'app.org_id',
    });
    expect(sql).toContain('CREATE POLICY "orders_isolation_policy" ON "orders"');
    expect(sql).toContain('"org_id" = current_setting(\'app.org_id\', true)');
  });

  it('combines command and roles together', () => {
    const sql = generateTenantIsolationPolicySql({
      table: 'invoices',
      command: 'UPDATE',
      roles: ['app_user'],
    });
    expect(sql).toBe(
      [
        'CREATE POLICY "invoices_tenant_isolation" ON "invoices"',
        '  FOR UPDATE',
        '  TO "app_user"',
        '  USING ("tenant_id" = current_setting(\'app.current_tenant_id\', true))',
        '  WITH CHECK ("tenant_id" = current_setting(\'app.current_tenant_id\', true));',
      ].join('\n'),
    );
  });

  for (const bad of INVALID_IDENTIFIERS) {
    it(`rejects invalid table ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() => generateTenantIsolationPolicySql({ table: bad })).toThrow(
        InvalidSqlIdentifierError,
      );
    });

    it(`rejects invalid tenantColumn ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', tenantColumn: bad }),
      ).toThrow(InvalidSqlIdentifierError);
    });

    it(`rejects invalid policyName ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', policyName: bad }),
      ).toThrow(InvalidSqlIdentifierError);
    });
  }

  for (const bad of INVALID_SESSION_SETTINGS) {
    it(`rejects invalid sessionSetting ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', sessionSetting: bad }),
      ).toThrow(InvalidSqlIdentifierError);
    });
  }

  it('rejects an invalid role name in roles with an InvalidSqlIdentifierError', () => {
    expect(() =>
      generateTenantIsolationPolicySql({
        table: 'invoices',
        roles: ['app_user', 'users; DROP TABLE users;--'],
      }),
    ).toThrow(InvalidSqlIdentifierError);
  });

  // Regression (MEDIUM): `roles` is typed `string[]`, but that's erased at
  // runtime the same way `command`'s union type was — a caller bypassing it
  // (an `as` cast, a config file, a non-TS consumer) could previously reach
  // a raw, unbranded `TypeError` instead of this module's documented
  // `InvalidSqlIdentifierError`: a non-iterable `roles` (a number, a plain
  // object) threw "... is not iterable" straight out of the `for...of` loop,
  // and even a bare *string* silently iterated character-by-character
  // (mostly "valid" single-letter identifiers) only to throw its own raw
  // TypeError later at `.map()`. Verified live both ways before this fix.
  describe('non-array roles', () => {
    const nonArrayRoles = ['app_user', 42, { role: 'app_user' }, true];

    for (const roles of nonArrayRoles) {
      it(`rejects roles = ${JSON.stringify(roles)} with InvalidSqlIdentifierError, not a raw TypeError`, () => {
        expect(() =>
          generateTenantIsolationPolicySql({
            table: 'invoices',
            roles: roles as unknown as string[],
          }),
        ).toThrow(InvalidSqlIdentifierError);
      });
    }

    it('names the roles param on the thrown error', () => {
      try {
        generateTenantIsolationPolicySql({
          table: 'invoices',
          roles: 'admin' as unknown as string[],
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidSqlIdentifierError);
        expect((err as InvalidSqlIdentifierError).paramName).toBe('roles');
      }
    });

    it('still accepts a real array of valid roles (sanity check the validation is not overly strict)', () => {
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', roles: ['app_user'] }),
      ).not.toThrow();
      expect(() => generateTenantIsolationPolicySql({ table: 'invoices' })).not.toThrow();
    });
  });

  it('accepts a multi-segment sessionSetting where every segment is valid', () => {
    expect(() =>
      generateTenantIsolationPolicySql({
        table: 'invoices',
        sessionSetting: 'app.current_tenant_id',
      }),
    ).not.toThrow();
  });

  // Regression (CRITICAL): unlike every other field this function accepts,
  // `command` was spliced directly into the returned SQL (`  FOR ${command}`)
  // with no runtime validation at all — only the TS union type
  // `'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'` constrained it, and
  // that's erased at runtime. A caller bypassing the type (an `as` cast, a
  // config file, a non-TS consumer — exactly the "generated migrations are
  // routinely copy-pasted, re-templated, or built from config files"
  // scenario this module's own security-model comment already warns about
  // for identifiers) could inject arbitrary SQL text, e.g.
  // `'SELECT;\nDROP TABLE victim;--'` producing a working multi-statement
  // injection. `command` now goes through the same allowlist-or-reject
  // pattern as every other interpolated value.
  for (const bad of [
    'SELECT; DROP TABLE users;--',
    'SELECT;\nDROP TABLE victim;--',
    'select', // valid keyword, but wrong case — Postgres's grammar and this module's allowlist are both case-sensitive here
    'ALL; --',
    '',
    'TRUNCATE',
    'SELECT OR TRUE',
  ]) {
    it(`rejects invalid command ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', command: bad as never }),
      ).toThrow(InvalidSqlIdentifierError);
    });
  }

  it('the injection-shaped command is rejected before it ever reaches the returned SQL text', () => {
    const injected = 'SELECT;\nDROP TABLE victim;--';
    let sql: string | undefined;
    try {
      sql = generateTenantIsolationPolicySql({ table: 'invoices', command: injected as never });
    } catch {
      // expected
    }
    expect(sql).toBeUndefined();
  });

  it('error for an invalid command names the "command" parameter', () => {
    try {
      generateTenantIsolationPolicySql({ table: 'invoices', command: 'DROP' as never });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSqlIdentifierError);
      const error = err as InvalidSqlIdentifierError;
      expect(error.paramName).toBe('command');
    }
  });

  it('still accepts every documented command value after the validation fix', () => {
    for (const command of ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
      expect(() => generateTenantIsolationPolicySql({ table: 'invoices', command })).not.toThrow();
    }
  });
});

describe('generateSetTenantContextSql', () => {
  it('returns the expected SQL with the default session setting', () => {
    expect(generateSetTenantContextSql()).toBe(
      "SELECT set_config('app.current_tenant_id', $1, true);",
    );
  });

  it('returns the expected SQL with a custom session setting', () => {
    expect(generateSetTenantContextSql('app.org_id')).toBe(
      "SELECT set_config('app.org_id', $1, true);",
    );
  });

  it('never interpolates a tenant id value into the returned string — only the $1 placeholder appears', () => {
    // generateSetTenantContextSql intentionally takes no tenant-id argument at all;
    // this test documents and locks in that the *only* per-request marker in the
    // output is the parameter placeholder, never a literal value.
    const sql = generateSetTenantContextSql();
    expect(sql).toContain('$1');
    expect(sql).not.toMatch(/\$1.*\$1/); // exactly one placeholder, not accidentally duplicated
    // Simulate a caller mistakenly checking for injected tenant-id-shaped values.
    const suspiciousTenantIds = ['tenant-123', "'; DROP TABLE users; --", 'a-real-uuid-0000'];
    for (const tenantId of suspiciousTenantIds) {
      expect(sql).not.toContain(tenantId);
    }
  });

  it('accepts a multi-segment sessionSetting where every segment is valid (dots are allowed for GUC names)', () => {
    expect(() => generateSetTenantContextSql('a.b.c')).not.toThrow();
    expect(generateSetTenantContextSql('a.b.c')).toBe("SELECT set_config('a.b.c', $1, true);");
  });

  for (const bad of INVALID_SESSION_SETTINGS) {
    it(`rejects invalid sessionSetting ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() => generateSetTenantContextSql(bad)).toThrow(InvalidSqlIdentifierError);
    });
  }
});

describe('tenantWhereClause', () => {
  it('returns the correct clause and next index at paramIndex 1 (default)', () => {
    expect(tenantWhereClause()).toEqual({ clause: '"tenant_id" = $1', nextParamIndex: 2 });
  });

  it('returns the correct clause and next index at a later paramIndex', () => {
    expect(tenantWhereClause('tenant_id', 3)).toEqual({
      clause: '"tenant_id" = $3',
      nextParamIndex: 4,
    });
  });

  it('respects a custom tenantColumn', () => {
    expect(tenantWhereClause('org_id', 1)).toEqual({ clause: '"org_id" = $1', nextParamIndex: 2 });
  });

  it('is composable: nextParamIndex can be fed into a subsequent call', () => {
    const first = tenantWhereClause('tenant_id', 1);
    const second = tenantWhereClause('org_id', first.nextParamIndex);
    expect(second).toEqual({ clause: '"org_id" = $2', nextParamIndex: 3 });
  });

  for (const bad of INVALID_IDENTIFIERS) {
    it(`rejects invalid tenantColumn ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() => tenantWhereClause(bad)).toThrow(InvalidSqlIdentifierError);
    });
  }

  // Regression: paramIndex was spliced directly into the returned SQL text
  // (`$${paramIndex}`) with no validation at all — a non-integer value
  // (e.g. a crafted string reaching this call through a loosely-typed
  // integration) could inject arbitrary SQL text into the placeholder
  // position, e.g. paramIndex = '5 OR 1=1 --' producing
  // `"tenant_id" = $5 OR 1=1 --`.
  for (const bad of [0, -1, -100, 1.5, NaN, Infinity, -Infinity, '5 OR 1=1 --']) {
    it(`rejects invalid paramIndex ${JSON.stringify(bad)} with an InvalidSqlIdentifierError`, () => {
      expect(() => tenantWhereClause('tenant_id', bad as unknown as number)).toThrow(
        InvalidSqlIdentifierError,
      );
    });
  }

  it('the injection-shaped paramIndex is rejected before it ever reaches the returned SQL text', () => {
    expect(() => tenantWhereClause('tenant_id', '5 OR 1=1 --' as unknown as number)).toThrow(
      InvalidSqlIdentifierError,
    );
  });
});

describe('generateTenantIsolationMigration', () => {
  it('combines multiple tables (mix of bare strings and options objects) correctly', () => {
    const migration = generateTenantIsolationMigration([
      'invoices',
      { table: 'orders', tenantColumn: 'org_id', command: 'SELECT' },
    ]);

    // Header comment identifies this as a generated migration.
    expect(migration.startsWith('-- Generated')).toBe(true);

    // Contains the enable/force RLS + policy SQL for the bare-string table, using defaults.
    expect(migration).toContain('ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;');
    expect(migration).toContain('CREATE POLICY "invoices_tenant_isolation" ON "invoices"');

    // Contains the enable/force RLS + policy SQL for the options-object table, using overrides.
    expect(migration).toContain('ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('CREATE POLICY "orders_tenant_isolation" ON "orders"');
    expect(migration).toContain('  FOR SELECT');
    expect(migration).toContain('"org_id" = current_setting');

    // Table order is preserved: invoices block appears before orders block.
    expect(migration.indexOf('"invoices"')).toBeLessThan(migration.indexOf('"orders"'));
  });

  it('separates each enable/force + policy pair with a blank line', () => {
    const migration = generateTenantIsolationMigration(['invoices']);
    const enableSql = generateEnableRlsSql('invoices');
    const policySql = generateTenantIsolationPolicySql({ table: 'invoices' });
    expect(migration).toContain(`${enableSql}\n\n${policySql}`);
  });

  it('handles a single-table array', () => {
    const migration = generateTenantIsolationMigration(['invoices']);
    expect(migration).toContain('"invoices"');
    expect(migration.split('CREATE POLICY').length - 1).toBe(1);
  });

  it('handles an empty array by returning just the header', () => {
    expect(generateTenantIsolationMigration([])).toBe(
      '-- Generated by @novavey/multi-tenant-security-kit: tenant RLS isolation migration.',
    );
  });

  it('propagates an InvalidSqlIdentifierError when any table entry has an invalid identifier', () => {
    expect(() =>
      generateTenantIsolationMigration(['invoices', 'users; DROP TABLE users;--']),
    ).toThrow(InvalidSqlIdentifierError);
  });

  it('propagates an InvalidSqlIdentifierError when an options-object entry has an invalid tenantColumn', () => {
    expect(() =>
      generateTenantIsolationMigration([{ table: 'orders', tenantColumn: 'my column' }]),
    ).toThrow(InvalidSqlIdentifierError);
  });

  it('propagates an InvalidSqlIdentifierError when an options-object entry has an invalid command', () => {
    expect(() =>
      generateTenantIsolationMigration([
        { table: 'orders', command: 'SELECT;\nDROP TABLE victim;--' as never },
      ]),
    ).toThrow(InvalidSqlIdentifierError);
  });
});
