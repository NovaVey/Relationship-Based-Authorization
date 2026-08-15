import { CrossTenantAccessError } from '../errors.js';
import { requireCurrentTenantId } from './context.js';
import type { TenantScoped } from './types.js';

/**
 * Asserts that `actualTenantId` matches `expectedTenantId`.
 *
 * This is the low-level primitive every other isolation helper in this file
 * is built on. Prefer {@link assertTenantMatches} or {@link scopeToTenant}
 * in application code — they read the "current" tenant for you and are
 * harder to misuse.
 *
 * @throws {CrossTenantAccessError} if the ids differ.
 */
export function assertSameTenant(expectedTenantId: string, actualTenantId: string): void {
  if (expectedTenantId !== actualTenantId) {
    throw new CrossTenantAccessError(expectedTenantId, actualTenantId);
  }
}

/**
 * Asserts that `resource.tenantId` belongs to the currently active tenant.
 *
 * Call this immediately after loading any record by primary key (e.g. after
 * `db.invoices.findById(id)`) and before returning or mutating it — primary
 * key lookups are the classic multi-tenant leak: nothing about the query
 * itself stops tenant A from requesting tenant B's row id.
 *
 * Deliberately typed as `Pick<TenantScoped, 'tenantId'>` rather than plain
 * `TenantScoped`: `TenantScoped`'s index signature (needed so
 * {@link scopeToTenant} accepts a plain object literal — see that
 * function's own type parameter) means only a value that *also* has an
 * index signature can satisfy it, and a real, named domain type (an
 * `Invoice` interface, a Prisma/Drizzle model) never does — the same
 * TypeScript footgun this package already hit once for `MinimalRequest`
 * (see `src/http/types.ts`). `Pick` strips the index signature back off, so
 * `assertTenantMatches(invoice)` type-checks against any object that merely
 * *has* a `tenantId: string` field, with no cast required.
 *
 * @throws {TenantContextError} if no tenant context is active.
 * @throws {CrossTenantAccessError} if the resource belongs to another tenant.
 */
export function assertTenantMatches(resource: Pick<TenantScoped, 'tenantId'>): void {
  const currentTenantId = requireCurrentTenantId();
  assertSameTenant(currentTenantId, resource.tenantId);
}

/**
 * Merges the current tenant id into `query`, guarding against a caller (or
 * an upstream bug) accidentally passing a `tenantId` for a *different*
 * tenant.
 *
 * Use this when building a query/filter object so every read is
 * tenant-scoped by construction rather than by convention:
 *
 * ```ts
 * const rows = await db.invoices.find(scopeToTenant({ status: 'open' }));
 * ```
 *
 * @throws {TenantContextError} if no tenant context is active.
 * @throws {CrossTenantAccessError} if `query.tenantId` is already set to a
 * different tenant than the active one.
 */
export function scopeToTenant<T extends Partial<TenantScoped>>(query: T): T & TenantScoped {
  const currentTenantId = requireCurrentTenantId();
  if (query.tenantId !== undefined) {
    assertSameTenant(currentTenantId, query.tenantId);
  }
  return { ...query, tenantId: currentTenantId };
}
