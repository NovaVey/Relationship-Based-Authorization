# Postgres row-level security (RLS)

`@novavey/multi-tenant-security-kit/rls`

Application-level checks (`assertTenantMatches`, `scopeToTenant`, RBAC) are
only as strong as the code path that runs them — a missed check on one
route is a real leak. This module generates SQL for a second, independent
layer of enforcement: Postgres row-level security, so the database itself
refuses to return or write another tenant's rows, even if application code
forgets to filter by tenant.

**This module has no Postgres client dependency.** It only ever returns SQL
strings — you execute them with whichever driver, ORM, or migration tool you
already use.

## Security model — read this before using generated SQL in production

Two very different kinds of values flow through this module, handled in
opposite ways on purpose:

1. **Identifiers** (table/column/policy/role/session-setting names) are
   developer-supplied at migration-authoring time, not end-user request
   input. Even so, this module validates every one of them against a strict
   `^[a-zA-Z_][a-zA-Z0-9_]*$` allowlist **and a 63-character length limit** —
   Postgres's own default `max_identifier_length` — before using it, and
   double-quotes it in the output as defense in depth — generated migrations
   get copy-pasted and re-templated often enough that "developer-supplied"
   shouldn't imply "safe to splice into SQL" unconditionally. The length
   limit matters because Postgres doesn't reject an over-long identifier, it
   silently _truncates_ it (with only a `NOTICE`, verified live) — two
   different intended identifiers sharing the same first 63 characters would
   silently collide into the same actual table/column/policy name. An
   invalid identifier throws an `InvalidSqlIdentifierError`
   (`code: 'INVALID_SQL_IDENTIFIER'`) naming the offending value and
   parameter — like every error this package throws, it extends the shared
   `SecurityKitError` base. `command` gets the same treatment even though
   it isn't identifier-shaped: it's checked against an explicit allowlist of
   the five values Postgres's `CREATE POLICY` grammar accepts (`'ALL' |
'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'`) before being interpolated,
   since its TypeScript union type only constrains callers who are
   type-checked — a config file, a plain-JS consumer, or an `as` cast can
   bypass it otherwise. `roles` gets the same treatment for the _array_
   shape itself, not just each entry: a non-array `roles` (bypassing its
   `string[]` type the same way) is rejected explicitly rather than reaching
   a raw `TypeError`.
2. **The tenant id value** is genuine runtime, per-request user input, and it
   is **never** interpolated into any string this module returns.
   `generateSetTenantContextSql` only ever emits the placeholder `$1` —
   callers bind the real value through their driver's parameterized-query
   mechanism. This is the load-bearing security property of this module.

## Setting up a table

```ts
import {
  generateEnableRlsSql,
  generateTenantIsolationPolicySql,
} from '@novavey/multi-tenant-security-kit/rls';

console.log(generateEnableRlsSql('invoices'));
// ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
// ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;

console.log(generateTenantIsolationPolicySql({ table: 'invoices' }));
// CREATE POLICY "invoices_tenant_isolation" ON "invoices"
//   USING ("tenant_id" = current_setting('app.current_tenant_id', true))
//   WITH CHECK ("tenant_id" = current_setting('app.current_tenant_id', true));
```

`FORCE ROW LEVEL SECURITY` is easy to forget and a common multi-tenant
footgun: without it, the table owner — often the same role a migration or
admin job connects as — silently bypasses every policy on the table.
`generateEnableRlsSql` always emits both statements together.

**`FORCE` doesn't close every bypass, though.** Postgres superusers, and any
role granted the `BYPASSRLS` attribute, skip RLS enforcement entirely —
`FORCE` or not — verified live against a real Postgres instance. That's
exactly the scenario `FORCE` is usually reached for (a privileged batch job,
an admin/support tool, an ORM migration runner), so it's easy to assume
`FORCE` protects you there when it doesn't. Connect application/service code
as an ordinary role with `BYPASSRLS` **not** granted; reserve
superuser/`BYPASSRLS` connections for genuine break-glass administration
that's meant to see every tenant's rows.

`USING` (read/update/delete visibility) and `WITH CHECK` (insert / the
post-update row) use the same predicate, so the policy can't be used to read
one tenant's rows while writing as another — but Postgres only _accepts_
each clause for certain `command` values (it's a syntax error otherwise),
so which ones actually get emitted depends on `command`:

| `command`       | `USING` | `WITH CHECK` |
| --------------- | ------- | ------------ |
| `ALL` (default) | yes     | yes          |
| `SELECT`        | yes     | —            |
| `INSERT`        | —       | yes          |
| `UPDATE`        | yes     | yes          |
| `DELETE`        | yes     | —            |

### Customizing the policy

```ts
generateTenantIsolationPolicySql({
  table: 'invoices',
  tenantColumn: 'org_id', // default: 'tenant_id'
  policyName: 'invoices_org_scope', // default: '<table>_tenant_isolation'
  sessionSetting: 'app.current_org_id', // default: 'app.current_tenant_id'
  command: 'SELECT', // default: 'ALL'
  roles: ['app_user'], // default: no TO clause (applies to all roles)
});
```

`roles: ['PUBLIC']` (Postgres's own pseudo-role, meaning "every role" — case-insensitive) is recognized and emitted unquoted (`TO PUBLIC`), the only way Postgres treats it as the pseudo-role rather than an actual role literally named "PUBLIC". You can mix it with real role names in the same list.

### Non-text tenant columns

`tenantColumn` **must be a `text`-compatible column** (`text`, `varchar`,
`citext`, ...). The generated predicate compares it against
`current_setting(...)`, which always returns `text` — Postgres has no
implicit cast from `text` to `uuid`/`integer`/etc. for `=`, so
`CREATE POLICY` fails outright with something like
`operator does not exist: uuid = text` if your tenant column is one of
those types. This is a loud failure at migration-authoring time, not a
silent isolation gap — but it's easy to hit with a realistic schema (a
`uuid` primary-key-style tenant id is common), so it's worth knowing
about before you're debugging it live.

If your tenant id is a `uuid` or `integer`, either:

- Store it in a `text` column instead (or add `citext` if you also want
  case-insensitive comparisons), or
- Don't use `generateTenantIsolationPolicySql` for that table — write the
  `CREATE POLICY` statement yourself with an explicit cast, e.g.
  `USING ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid)`,
  applying the same identifier-validation discipline this module uses if
  any part of that statement is ever built from a variable.

## Setting the tenant for a connection/transaction

Run this once per request-scoped connection (typically at the start of a
transaction), binding the real tenant id as a parameter — never
concatenated into the SQL string:

```ts
import { generateSetTenantContextSql } from '@novavey/multi-tenant-security-kit/rls';

await client.query('BEGIN');
await client.query(generateSetTenantContextSql(), [tenantId]);
// ... every query in this transaction is now scoped by the RLS policy ...
await client.query('COMMIT');
```

`set_config`'s third argument (`true`, baked into the generated SQL) scopes
the setting to the current transaction, so it can't leak onto a pooled
connection that gets reused by a later, differently-tenanted request.

## Using an ORM (Prisma, Drizzle)

The same rule applies with an ORM: `set_config(..., true)` is scoped to the
current **transaction**, so the tenant-context call and every tenant-scoped
query after it must run inside the same interactive transaction — never as
two separate pool-borrowed queries, which could each land on a different
pooled connection (or the same connection after it's already been handed to
a different tenant's request).

### Prisma

Prisma's raw-query methods accept the exact `$1`-placeholder convention
`generateSetTenantContextSql()` already generates, so it drops in directly
inside `$transaction`'s interactive-transaction callback:

```ts
import type { PrismaClient } from '@prisma/client';
import { generateSetTenantContextSql } from '@novavey/multi-tenant-security-kit/rls';

async function withTenantScope<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(generateSetTenantContextSql(), tenantId);
    return fn(tx);
  });
}
```

`$executeRawUnsafe` (not `$executeRaw`) is required here specifically
because `generateSetTenantContextSql()` returns a plain SQL string rather
than a `Prisma.sql` tagged template — the tenant id itself still goes
through Prisma's normal parameter binding as the second argument, so it's
never concatenated into the query text.

### Drizzle

Drizzle's `db.execute()` does **not** accept a raw string plus a separate
params array the way `pg` and Prisma's `$executeRawUnsafe` do — it only
takes a Drizzle `SQL` object, built with Drizzle's own `sql` tagged
template. `generateSetTenantContextSql()`'s pre-built `$1`-placeholder
string can't be passed to it directly; use `sql` to build the equivalent
call instead, letting Drizzle bind the tenant id as its own parameter:

```ts
import type { NodePgDatabase as DrizzleClient } from 'drizzle-orm/node-postgres'; // or whichever driver you use
import { sql } from 'drizzle-orm';

async function withTenantScope<T>(db: DrizzleClient, fn: (tx: DrizzleClient) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

The session-setting name (`'app.current_tenant_id'`) is a SQL identifier,
not a value — Drizzle's `${}` interpolation, like `generateSetTenantContextSql`'s
own security model (see the top of this page), only ever binds _values_,
never identifiers, so it's written as a literal here rather than passed in.
If you customized `sessionSetting` when calling `generateTenantIsolationPolicySql`,
hardcode that same name in this string.

## Composing a tenant filter into a hand-written query

```ts
import { tenantWhereClause } from '@novavey/multi-tenant-security-kit/rls';

const { clause, nextParamIndex } = tenantWhereClause('tenant_id', 2); // e.g. after $1 is already used
const sql = `SELECT * FROM invoices WHERE status = $1 AND ${clause}`; // "tenant_id" = $2
await client.query(sql, [status, tenantId]);
```

Like `generateSetTenantContextSql`, this never embeds the tenant id _value_
— only the (validated) column identifier and a placeholder number.

## Generating a full migration

```ts
import { generateTenantIsolationMigration } from '@novavey/multi-tenant-security-kit/rls';

const migrationSql = generateTenantIsolationMigration([
  'invoices', // shorthand for { table: 'invoices' }
  'line_items',
  { table: 'audit_events', command: 'SELECT' }, // per-table override
]);
```

Each entry may be a bare table name (all-default options) or a full
`RlsPolicyOptions` object — mirroring how a real migration usually looks:
mostly-default policies for most tables, with a few overridden.

## API reference

| Export                                          | Kind     | Summary                                                                                        |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `RlsPolicyOptions`                              | type     | `{ table, tenantColumn?, policyName?, sessionSetting?, command?, roles? }`                     |
| `generateEnableRlsSql(table)`                   | function | `ENABLE` + `FORCE ROW LEVEL SECURITY` statements                                               |
| `generateTenantIsolationPolicySql(options)`     | function | `CREATE POLICY` statement                                                                      |
| `generateSetTenantContextSql(sessionSetting?)`  | function | Session/transaction-scoped `set_config`, tenant id as `$1`                                     |
| `TenantWhereClauseResult`                       | type     | `{ clause, nextParamIndex }`                                                                   |
| `tenantWhereClause(tenantColumn?, paramIndex?)` | function | Composable `"<column>" = $<n>` fragment                                                        |
| `generateTenantIsolationMigration(tables)`      | function | Full migration for a list of tables                                                            |
| `SecurityKitError`                              | class    | Base class every error in this package extends; carries a stable `.code`                       |
| `InvalidSqlIdentifierError`                     | class    | Thrown for an invalid identifier, `command`, or `paramIndex`; `code: 'INVALID_SQL_IDENTIFIER'` |
