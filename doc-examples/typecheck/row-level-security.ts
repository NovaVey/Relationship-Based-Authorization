// Mirrors docs/row-level-security.md's client.query() pseudocode (pg-shaped)
// samples — the pure SQL-generation samples are executable and live in
// doc-examples/run/row-level-security.mjs instead, with exact-string
// assertions against the doc's own comments. Keep both in sync — see
// doc-examples/README.md for the convention this file is part of.
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  generateSetTenantContextSql,
  tenantWhereClause,
} from '@novavey/multi-tenant-security-kit/rls';

declare const client: { query(sql: string, params?: unknown[]): Promise<unknown> };
declare const tenantId: string;
declare const status: string;

// "Setting the tenant for a connection/transaction"
await client.query('BEGIN');
await client.query(generateSetTenantContextSql(), [tenantId]);
// ... every query in this transaction is now scoped by the RLS policy ...
await client.query('COMMIT');

// "Using an ORM (Prisma, Drizzle)" — "Prisma"
//
// @prisma/client's PrismaClient type only exists after `prisma generate`
// (codegen), so this repo can't import it for real without checking in or
// generating a client just for this doc. This structural type mirrors the
// exact $transaction/$executeRawUnsafe signatures verified against a real
// generated Prisma Client v7 (see the PR that added this section) — it's
// what `PrismaClient` looks like from this function's point of view.
declare const prisma: {
  $transaction<T>(fn: (tx: typeof prisma) => Promise<T>): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

async function withTenantScopePrisma<T>(fn: (tx: typeof prisma) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(generateSetTenantContextSql(), tenantId);
    return fn(tx);
  });
}
void withTenantScopePrisma;

// "Using an ORM (Prisma, Drizzle)" — "Drizzle"
declare const drizzleDb: NodePgDatabase;

async function withTenantScopeDrizzle<T>(fn: (tx: NodePgDatabase) => Promise<T>): Promise<T> {
  return drizzleDb.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
void withTenantScopeDrizzle;

// "Composing a tenant filter into a hand-written query"
{
  const { clause, nextParamIndex } = tenantWhereClause('tenant_id', 2); // e.g. after $1 is already used
  void nextParamIndex;
  const sql = `SELECT * FROM invoices WHERE status = $1 AND ${clause}`; // "tenant_id" = $2
  await client.query(sql, [status, tenantId]);
}
