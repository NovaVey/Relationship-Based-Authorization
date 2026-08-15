/**
 * Generates Postgres row-level-security (RLS) SQL text and
 * parameterized-query fragments for enforcing tenant isolation at the
 * database layer.
 *
 * This module is deliberately dependency-free with respect to Postgres
 * client libraries (no `pg`, no `postgres`, no ORM): it only ever returns
 * strings. That keeps it usable from any migration tool or query builder
 * regardless of which driver a consumer has chosen, and keeps this package's
 * dependency footprint unchanged for consumers who never touch Postgres.
 *
 * ---
 *
 * SECURITY MODEL — read before modifying this file.
 *
 * Two very different kinds of values flow through this module, and they are
 * handled in opposite ways on purpose:
 *
 * 1. **Identifiers** (table names, column names, policy names, role names,
 *    session-setting/GUC names). These are developer-supplied at
 *    migration-authoring time, not end-user input at request time. Even so,
 *    generated migrations are routinely copy-pasted, re-templated, or built
 *    from config files, so we do not trust that "developer-supplied" implies
 *    "safe to splice into SQL". Every identifier accepted by this module is
 *    validated against a strict `^[a-zA-Z_][a-zA-Z0-9_]*$` allowlist pattern
 *    before it is used, and a failing value causes an immediate
 *    {@link InvalidSqlIdentifierError} naming both the offending value and
 *    which parameter rejected it. Every identifier is *also* double-quoted
 *    in the emitted SQL as defense in depth, so even a hypothetical future
 *    relaxation of the validation still can't be used to inject bare SQL
 *    keywords.
 *
 * 2. **The tenant id value** itself — the thing a real request actually
 *    carries — is genuine runtime user input. It is NEVER interpolated into
 *    any string this module returns. {@link generateSetTenantContextSql}
 *    only ever emits the placeholder `$1`; callers must bind the real tenant
 *    id through their driver's parameterized-query mechanism (e.g.
 *    `client.query(sql, [tenantId])`). This is the load-bearing security
 *    property of this module — do not "simplify" it by accepting the tenant
 *    id as a function parameter and interpolating it.
 *
 * Every OTHER value this module ever splices into a returned SQL string —
 * not just the two categories above — must go through an explicit
 * allowlist/validator before use, with no exceptions for values that merely
 * *look* like they're constrained by a TypeScript type. TS types are erased
 * at runtime and enforce nothing against a caller who bypasses them (an `as`
 * cast, a config file, a non-TS consumer): {@link RlsPolicyOptions.command}
 * previously relied on its `'ALL' | 'SELECT' | ...` union type alone and was
 * spliced directly into a `FOR ${command}` line with no runtime check at
 * all — a real, demonstrated SQL-injection vector, fixed by
 * {@link assertValidCommand}. If you add a new option to this module, ask
 * "what stops a bypassed-type value from reaching the returned string
 * unchecked?" before merging, not after.
 */

import { InvalidSqlIdentifierError } from '../errors.js';
import type { RlsPolicyOptions } from './types.js';

/**
 * Strict allowlist for a single unquoted SQL identifier segment.
 *
 * Exported only so `test/rls/*.fuzz.test.ts` has a real oracle to fuzz
 * against instead of duplicating this pattern (and risking drift) in a test
 * file. Not re-exported from `rls/index.ts`, so it stays out of the
 * package's public API.
 */
export const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Postgres's default `NAMEDATALEN`-derived identifier length limit
 * (`SHOW max_identifier_length`) — verified live against a real Postgres
 * instance. An identifier longer than this isn't rejected by Postgres; it's
 * silently *truncated* to this length with only a `NOTICE`, not an error.
 * Two different intended identifiers sharing the same first 63 characters
 * would silently collide into the same actual table/column/policy name —
 * exactly the kind of silent failure this module's own security-model
 * comment (top of this file) says every interpolated value should be
 * guarded against, not just injection-shaped ones.
 */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Validates that `value` is safe to use as a SQL identifier, throwing an
 * {@link InvalidSqlIdentifierError} that names both the offending value and
 * the parameter it came from if not.
 *
 * This is the single choke point every identifier accepted by this module
 * passes through — table names, column names, policy names, role names, and
 * (via {@link assertValidSessionSetting}) each dot-separated segment of a
 * Postgres GUC name. Centralizing it means the allowlist pattern, length
 * limit, and error shape can't drift between entry points.
 */
function assertValidIdentifier(value: string, paramName: string): void {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER_PATTERN.test(value) ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new InvalidSqlIdentifierError(
      value,
      paramName,
      `Invalid SQL identifier for "${paramName}": ${JSON.stringify(value)}. ` +
        `Identifiers must match ${IDENTIFIER_PATTERN.toString()} and be at most ` +
        `${MAX_IDENTIFIER_LENGTH} characters (Postgres's own identifier length limit — ` +
        `longer values are silently truncated, not rejected, by Postgres itself).`,
    );
  }
}

/**
 * Validates a Postgres session-setting (GUC) name such as
 * `"app.current_tenant_id"`. GUC names are conventionally dot-separated, so
 * this validates each segment independently against the same identifier
 * allowlist rather than allowing dots to widen the pattern globally — a
 * value like `users; DROP TABLE users;--` still has no segment that matches.
 */
function assertValidSessionSetting(value: string, paramName: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidSqlIdentifierError(value, paramName);
  }
  const segments = value.split('.');
  for (const segment of segments) {
    assertValidIdentifier(segment, paramName);
  }
}

/** Double-quotes an already-validated identifier for safe interpolation into SQL text. */
function quoteIdentifier(value: string): string {
  return `"${value}"`;
}

/**
 * Like {@link quoteIdentifier}, but for a role name in a `TO` clause
 * specifically — handling Postgres's `PUBLIC` pseudo-role (meaning "every
 * role") as a special case: it's a keyword, not a regular identifier, and
 * quoting it changes its meaning. `TO PUBLIC` (unquoted) is the pseudo-role;
 * `TO "PUBLIC"` (quoted, this module's normal treatment for every other
 * identifier) instead asks Postgres for an actual role literally named
 * "PUBLIC", which essentially never exists — `CREATE POLICY` then fails at
 * *execution* time with "role \"PUBLIC\" does not exist", not caught by
 * this module's own generation-time validation, since `'PUBLIC'` is a
 * syntactically valid identifier. Verified live against a real Postgres
 * instance — including the easy-to-miss trap that `TO "public"` (quoted,
 * *lowercase*) coincidentally succeeds despite no role named "public"
 * actually existing, which is what makes the uppercase failure so
 * surprising in practice. Recognized case-insensitively, since a caller
 * reasonably intending the pseudo-role could type either casing.
 */
function quoteRoleIdentifier(role: string): string {
  return role.toUpperCase() === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(role);
}

/**
 * The only values Postgres's `CREATE POLICY ... FOR <command>` clause
 * accepts. {@link RlsPolicyOptions.command}'s TS union type restricts this at
 * compile time, but that's erased at runtime — a caller that bypasses the
 * type (a config file, a non-TS consumer, an `as` cast) can otherwise smuggle
 * an arbitrary string straight into the generated SQL text, since `command`
 * is spliced directly into a `FOR ${command}` line with no other validation.
 * Every other value this module accepts goes through {@link assertValidIdentifier}
 * or {@link assertValidSessionSetting} before being interpolated; this is
 * `command`'s equivalent choke point.
 *
 * Exported only so `test/rls/postgres.fuzz.test.ts` has a real oracle to fuzz
 * against instead of duplicating this list (and risking drift) in a test
 * file — same reasoning as {@link IDENTIFIER_PATTERN}. Not re-exported from
 * `rls/index.ts`, so it stays out of the package's public API.
 */
export const VALID_RLS_COMMANDS = new Set(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);

/**
 * Validates that `value` is one of the five values Postgres's `CREATE
 * POLICY ... FOR <command>` clause actually accepts, throwing an
 * {@link InvalidSqlIdentifierError} if not. See {@link VALID_RLS_COMMANDS}.
 */
function assertValidCommand(value: string): void {
  if (typeof value !== 'string' || !VALID_RLS_COMMANDS.has(value)) {
    throw new InvalidSqlIdentifierError(
      value,
      'command',
      `Invalid RLS command: ${JSON.stringify(value)}. Must be one of ${Array.from(VALID_RLS_COMMANDS).join(', ')}.`,
    );
  }
}

/**
 * Generates the SQL to enable *and force* row-level security on `table`.
 *
 * Forcing RLS (`FORCE ROW LEVEL SECURITY`) is easy to forget and is a common
 * multi-tenant footgun: without it, the table owner — which is frequently
 * the same role a migration or admin job connects as — silently bypasses
 * every RLS policy on the table, defeating tenant isolation exactly when
 * it's most likely to matter (privileged batch jobs, ORM migrations,
 * support tooling). This function always emits both statements together so
 * that outcome requires deliberately dropping the second line, not simply
 * forgetting a flag.
 *
 * `FORCE` closes the table-*owner* bypass specifically — it does **not**
 * close every bypass. Postgres superusers, and any role granted the
 * `BYPASSRLS` attribute, skip RLS enforcement unconditionally, `FORCE` or
 * not — verified live against a real Postgres instance. That matters most
 * for exactly the scenario `FORCE` is usually reached for in the first
 * place (a privileged batch job, an admin/support tool, an ORM migration
 * runner): if that connection authenticates as a superuser or a
 * `BYPASSRLS` role, `FORCE ROW LEVEL SECURITY` gives you no protection
 * against it at all, and it's easy to assume otherwise. Connect
 * application/service code as an ordinary role with `BYPASSRLS` *not*
 * granted; reserve superuser/`BYPASSRLS` connections for genuine
 * break-glass administration.
 *
 * @throws {InvalidSqlIdentifierError} if `table` is not a valid SQL identifier.
 */
export function generateEnableRlsSql(table: string): string {
  assertValidIdentifier(table, 'table');
  const quoted = quoteIdentifier(table);
  return `ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY;`;
}

/**
 * Generates a `CREATE POLICY` statement that restricts `options.table` to
 * rows whose tenant column matches the tenant id currently set on
 * `options.sessionSetting` (via {@link generateSetTenantContextSql}).
 *
 * `USING` (which rows are visible/updatable/deletable) and `WITH CHECK`
 * (which rows may be inserted, or the post-update result of a row) are set
 * to the same predicate, so the policy can't be used to read one tenant's
 * rows while writing as another — but Postgres only *accepts* each clause
 * for certain `command` values (`CREATE POLICY ... FOR SELECT ... WITH
 * CHECK ...` is a syntax error, not a no-op), so which clauses actually get
 * emitted depends on `options.command`:
 *
 * | `command`         | `USING` | `WITH CHECK` |
 * | ------------------ | ------- | ------------ |
 * | `ALL` (default)     | yes     | yes          |
 * | `SELECT`            | yes     | —            |
 * | `INSERT`            | —       | yes          |
 * | `UPDATE`            | yes     | yes          |
 * | `DELETE`            | yes     | —            |
 *
 * @throws {InvalidSqlIdentifierError} if `options.table`, `options.tenantColumn`,
 * `options.policyName`, or `options.sessionSetting` is not a valid SQL
 * identifier (or, for `sessionSetting`, dot-separated identifier); if
 * `options.roles` is provided but isn't an array, or any entry of it is not
 * a valid SQL identifier; or if `options.command` is not one of `'ALL' |
 * 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'` — the TS types for `roles` and
 * `command` only restrict this at compile time, and both are spliced
 * directly into the generated SQL, so a caller that bypasses the type (an
 * `as` cast, a config file, a non-TS consumer) is rejected here rather than
 * allowed to inject arbitrary SQL text.
 */
export function generateTenantIsolationPolicySql(options: RlsPolicyOptions): string {
  const table = options.table;
  const tenantColumn = options.tenantColumn ?? 'tenant_id';
  const policyName = options.policyName ?? `${table}_tenant_isolation`;
  const sessionSetting = options.sessionSetting ?? 'app.current_tenant_id';
  const command = options.command ?? 'ALL';

  assertValidIdentifier(table, 'table');
  assertValidIdentifier(tenantColumn, 'tenantColumn');
  assertValidIdentifier(policyName, 'policyName');
  assertValidSessionSetting(sessionSetting, 'sessionSetting');
  assertValidCommand(command);
  if (options.roles !== undefined) {
    // `Array.isArray` first: `RlsPolicyOptions.roles`'s `string[]` type is a
    // compile-time constraint only, bypassable the same way `command`'s
    // union type was (a config file, a non-TS consumer, an `as` cast). A
    // non-array `roles` — a bare string, say — used to reach the `for...of`
    // below directly: a non-iterable value (a number, a plain object) threw
    // a raw, unbranded `TypeError` ("... is not iterable"), and even a
    // *string* silently iterated character-by-character (each character
    // often happens to be a "valid" single-letter identifier) only to throw
    // its own raw `TypeError` later at `.map()`. Neither is this module's
    // documented `InvalidSqlIdentifierError` contract — verified live both
    // ways before this fix.
    if (!Array.isArray(options.roles)) {
      throw new InvalidSqlIdentifierError(
        options.roles,
        'roles',
        `Invalid roles for generateTenantIsolationPolicySql: ${JSON.stringify(options.roles)}. Must be an array of role name strings.`,
      );
    }
    for (const role of options.roles) {
      assertValidIdentifier(role, 'roles');
    }
  }

  const lines = [`CREATE POLICY ${quoteIdentifier(policyName)} ON ${quoteIdentifier(table)}`];

  if (command !== 'ALL') {
    lines.push(`  FOR ${command}`);
  }

  if (options.roles && options.roles.length > 0) {
    lines.push(`  TO ${options.roles.map(quoteRoleIdentifier).join(', ')}`);
  }

  // Postgres rejects USING on an INSERT-only policy and rejects WITH CHECK
  // on a SELECT- or DELETE-only policy — these aren't independent flags,
  // they follow directly from what each clause even means (USING gates
  // which existing rows a statement can see/touch; WITH CHECK gates what a
  // newly-inserted or post-update row is allowed to look like).
  const supportsUsing =
    command === 'ALL' || command === 'SELECT' || command === 'UPDATE' || command === 'DELETE';
  const supportsWithCheck = command === 'ALL' || command === 'INSERT' || command === 'UPDATE';

  const predicate = `${quoteIdentifier(tenantColumn)} = current_setting('${sessionSetting}', true)`;
  if (supportsUsing) {
    lines.push(`  USING (${predicate})`);
  }
  if (supportsWithCheck) {
    lines.push(`  WITH CHECK (${predicate})`);
  }

  return `${lines.join('\n')};`;
}

/**
 * Generates the SQL a request-scoped connection runs (once, typically at
 * the start of a transaction) to make the current tenant id visible to
 * every RLS policy created by {@link generateTenantIsolationPolicySql} for
 * the rest of that transaction/session.
 *
 * The tenant id itself is NEVER interpolated into the returned string —
 * this function only ever emits the placeholder `$1`. Callers must bind the
 * real tenant id through their driver's own parameterized-query mechanism,
 * e.g.:
 *
 * ```ts
 * await client.query(generateSetTenantContextSql(), [tenantId]);
 * ```
 *
 * This is deliberate and load-bearing: the tenant id is genuine per-request
 * user input, so it must go through the same driver-level escaping as any
 * other bound parameter rather than through string concatenation, no matter
 * how well-formed it looks. `set_config`'s third argument (`true`) scopes
 * the setting to the current transaction, so it can't leak onto a pooled
 * connection reused by a later, differently-tenanted request.
 *
 * @throws {InvalidSqlIdentifierError} if `sessionSetting` is not a valid (dot-separated) SQL identifier.
 */
export function generateSetTenantContextSql(sessionSetting = 'app.current_tenant_id'): string {
  assertValidSessionSetting(sessionSetting, 'sessionSetting');
  return `SELECT set_config('${sessionSetting}', $1, true);`;
}

/** The result of {@link tenantWhereClause}: a composable SQL fragment plus the next free placeholder index. */
export interface TenantWhereClauseResult {
  /** A `"<column>" = $<n>` fragment, ready to `AND` into a hand-written `WHERE` clause. */
  clause: string;
  /** The placeholder index the caller should use for its next bound parameter. */
  nextParamIndex: number;
}

/**
 * Builds a composable `"<tenantColumn>" = $<paramIndex>` fragment for
 * hand-written parameterized queries that need to AND-in a tenant filter
 * alongside other conditions, at whatever placeholder position those other
 * conditions have left off at.
 *
 * Like {@link generateSetTenantContextSql}, this never embeds the tenant id
 * *value* — only the column identifier (validated) and a placeholder
 * number. Callers bind the actual tenant id as the `paramIndex`-th
 * parameter of their query.
 *
 * @throws {InvalidSqlIdentifierError} if `tenantColumn` is not a valid SQL
 * identifier, or if `paramIndex` is not a positive integer — `paramIndex`
 * is spliced directly into the returned SQL text (as `$<paramIndex>`), so
 * a non-integer or attacker-shaped value (e.g. a string smuggled through a
 * loosely-typed call site) is exactly as unsafe to leave unvalidated as
 * any other value this module interpolates.
 */
export function tenantWhereClause(
  tenantColumn = 'tenant_id',
  paramIndex = 1,
): TenantWhereClauseResult {
  assertValidIdentifier(tenantColumn, 'tenantColumn');
  if (!Number.isInteger(paramIndex) || paramIndex < 1) {
    throw new InvalidSqlIdentifierError(
      paramIndex,
      'paramIndex',
      `Invalid paramIndex for tenantWhereClause: ${JSON.stringify(paramIndex)}. Must be a positive integer.`,
    );
  }
  return {
    clause: `${quoteIdentifier(tenantColumn)} = $${paramIndex}`,
    nextParamIndex: paramIndex + 1,
  };
}

/**
 * Generates a complete, ready-to-save migration that enables and forces RLS
 * and creates a tenant-isolation policy for every table in `tables`.
 *
 * Each entry may be a bare table name (shorthand for
 * `{ table: name }`, i.e. all-default RLS options) or a full
 * {@link RlsPolicyOptions} object for tables that need a non-default
 * column, policy name, session setting, command, or role list. This mirrors
 * how a real migration usually looks: mostly-default policies for most
 * tables, with a few overridden.
 *
 * @throws {InvalidSqlIdentifierError} if any table's resolved options contain an invalid SQL identifier.
 */
export function generateTenantIsolationMigration(tables: Array<string | RlsPolicyOptions>): string {
  const header =
    '-- Generated by @novavey/multi-tenant-security-kit: tenant RLS isolation migration.';

  const blocks = tables.map((entry) => {
    const options: RlsPolicyOptions = typeof entry === 'string' ? { table: entry } : entry;
    return `${generateEnableRlsSql(options.table)}\n\n${generateTenantIsolationPolicySql(options)}`;
  });

  return [header, ...blocks].join('\n\n');
}
