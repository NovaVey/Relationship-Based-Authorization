/**
 * Property-based tests for the RLS module's identifier validation, using
 * IDENTIFIER_PATTERN (exported from src/rls/postgres.ts for exactly this
 * purpose - see the comment there) as the oracle, plus a curated corpus of
 * classic SQL-injection-shaped payloads that must always be rejected
 * regardless of the pattern's fine print.
 *
 * test/rls/postgres.test.ts covers the hand-picked cases and exact-string
 * assertions; this file exists to sweep the input space that file can't
 * hand-enumerate.
 *
 * Non-printable/control characters below are built with
 * String.fromCharCode() rather than embedded as literal source bytes or
 * backslash escapes, so this file stays plain, unambiguous ASCII text.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { InvalidSqlIdentifierError } from '../../src/errors.js';
import {
  IDENTIFIER_PATTERN,
  VALID_RLS_COMMANDS,
  generateEnableRlsSql,
  generateSetTenantContextSql,
  generateTenantIsolationPolicySql,
  tenantWhereClause,
} from '../../src/rls/postgres.js';

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

// None of these are valid bare identifiers under any reasonable reading, so
// every single-segment identifier parameter must reject all of them.
const SINGLE_SEGMENT_INJECTION_PAYLOADS = [
  'users; DROP TABLE users; --',
  'users" OR "1"="1',
  "users' OR '1'='1",
  'users/*',
  '--',
  'users' + NUL,
  'users' + NEWLINE,
  'users' + TAB,
  ' users',
  'users ',
  '"users"',
  "'users'",
  'users;',
  '1users', // starts with a digit
  '',
  ' ',
  'users-table',
  'users.table', // dots are only ever allowed in sessionSetting, not here
  'users' + LINE_SEPARATOR,
];

describe('RLS SQL generation — injection-payload corpus', () => {
  it('single-segment identifier parameters reject every payload in the corpus', () => {
    for (const bad of SINGLE_SEGMENT_INJECTION_PAYLOADS) {
      expect(() => generateEnableRlsSql(bad)).toThrow(InvalidSqlIdentifierError);
      expect(() => tenantWhereClause(bad)).toThrow(InvalidSqlIdentifierError);
      expect(() => generateTenantIsolationPolicySql({ table: bad })).toThrow(
        InvalidSqlIdentifierError,
      );
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', tenantColumn: bad }),
      ).toThrow(InvalidSqlIdentifierError);
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', policyName: bad }),
      ).toThrow(InvalidSqlIdentifierError);
      expect(() => generateTenantIsolationPolicySql({ table: 'invoices', roles: [bad] })).toThrow(
        InvalidSqlIdentifierError,
      );
    }
  });

  it('generateTenantIsolationPolicySql() rejects every injection payload as a command value too', () => {
    // Regression (CRITICAL): command was the one field in this module that
    // reached the returned SQL text with no validation at all — see the
    // dedicated regression block in postgres.test.ts. Every payload that
    // must be rejected as an identifier must equally be rejected as a
    // command, since it's spliced into the exact same kind of position
    // (`FOR ${command}`) with no quoting to fall back on as defense in depth.
    for (const bad of SINGLE_SEGMENT_INJECTION_PAYLOADS) {
      expect(() =>
        generateTenantIsolationPolicySql({ table: 'invoices', command: bad as never }),
      ).toThrow(InvalidSqlIdentifierError);
    }
  });

  it('generateSetTenantContextSql() rejects injection payloads, dot-segments notwithstanding', () => {
    const dotAwarePayloads = [
      // 'users.table' is deliberately excluded here: every one of its
      // dot-separated segments IS a valid identifier, so it's actually
      // accepted by this dot-permitting function — that's correct behavior,
      // not a payload this test should expect rejected.
      ...SINGLE_SEGMENT_INJECTION_PAYLOADS.filter((payload) => payload !== 'users.table'),
      'app.current_tenant_id; DROP TABLE users; --',
      'app..current_tenant_id', // empty middle segment
      '.app',
      'app.',
    ];
    for (const bad of dotAwarePayloads) {
      expect(() => generateSetTenantContextSql(bad)).toThrow(InvalidSqlIdentifierError);
    }
  });
});

describe('RLS SQL generation — fuzzing against IDENTIFIER_PATTERN', () => {
  it('generateEnableRlsSql(): accepts iff the input matches IDENTIFIER_PATTERN, and quotes it exactly once with no interpolation surprises', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (table) => {
        if (!IDENTIFIER_PATTERN.test(table)) {
          expect(() => generateEnableRlsSql(table)).toThrow(InvalidSqlIdentifierError);
          return;
        }
        expect(generateEnableRlsSql(table)).toBe(
          `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;\n` +
            `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("generateSetTenantContextSql(): accepts iff every dot-separated segment matches IDENTIFIER_PATTERN, and never interpolates the tenant id's value", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (sessionSetting) => {
        const segments = sessionSetting.split('.');
        const shouldAccept = segments.every((segment) => IDENTIFIER_PATTERN.test(segment));
        if (!shouldAccept) {
          expect(() => generateSetTenantContextSql(sessionSetting)).toThrow(
            InvalidSqlIdentifierError,
          );
          return;
        }
        const sql = generateSetTenantContextSql(sessionSetting);
        expect(sql).toBe(`SELECT set_config('${sessionSetting}', $1, true);`);
        // The one non-negotiable invariant: the tenant id *value* never
        // appears here as anything but the $1 placeholder.
        expect(sql).not.toContain('$2');
      }),
      { numRuns: 2000 },
    );
  });

  it('tenantWhereClause(): accepts iff tenantColumn matches IDENTIFIER_PATTERN', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.integer({ min: 1, max: 50 }),
        (tenantColumn, paramIndex) => {
          if (!IDENTIFIER_PATTERN.test(tenantColumn)) {
            expect(() => tenantWhereClause(tenantColumn, paramIndex)).toThrow(
              InvalidSqlIdentifierError,
            );
            return;
          }
          const { clause, nextParamIndex } = tenantWhereClause(tenantColumn, paramIndex);
          expect(clause).toBe(`"${tenantColumn}" = $${paramIndex}`);
          expect(nextParamIndex).toBe(paramIndex + 1);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('generateTenantIsolationPolicySql(): accepts a command iff it is one of VALID_RLS_COMMANDS', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (command) => {
        const call = () =>
          generateTenantIsolationPolicySql({ table: 'invoices', command: command as never });
        if (!VALID_RLS_COMMANDS.has(command)) {
          expect(call).toThrow(InvalidSqlIdentifierError);
        } else {
          expect(call).not.toThrow();
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('generateTenantIsolationPolicySql(): rejects if any role is invalid, no matter how many valid roles surround it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        (roles) => {
          const call = () => generateTenantIsolationPolicySql({ table: 'invoices', roles });
          if (roles.some((role) => !IDENTIFIER_PATTERN.test(role))) {
            expect(call).toThrow(InvalidSqlIdentifierError);
          } else {
            expect(call).not.toThrow();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
