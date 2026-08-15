/**
 * The identity of a tenant. Kept intentionally minimal — everything else
 * (roles, plan, feature flags) lives in `extra` so this stays a stable,
 * serializable core that every other module can depend on.
 */
export interface TenantContext<Extra extends Record<string, unknown> = Record<string, unknown>> {
  readonly tenantId: string;
  readonly extra?: Extra;
}

/**
 * Anything that is scoped to a tenant and can be checked against one.
 *
 * The index signature is deliberate: it's what lets {@link scopeToTenant}
 * accept a plain object literal (`scopeToTenant({ status: 'open' })`)
 * against its `T extends Partial<TenantScoped>` constraint. It comes with a
 * real cost, though — TypeScript only lets a *declared* type (a named
 * `Invoice` interface, a Prisma/Drizzle model) satisfy a target type that
 * has an index signature if the declared type also has a matching one, and
 * real domain types essentially never do. `assertTenantMatches`
 * deliberately does NOT take `TenantScoped` directly for this reason — see
 * its own doc comment in `guard.ts`.
 */
export interface TenantScoped {
  tenantId: string;
  [key: string]: unknown;
}
