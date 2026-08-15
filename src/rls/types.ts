/**
 * Options controlling the SQL generated for a single table's Postgres
 * row-level-security (RLS) tenant-isolation policy.
 *
 * These are developer-supplied at migration-authoring time (table names,
 * column names, policy names, role lists come from your schema/config, not
 * from an end user's HTTP request) — but see the security note in
 * `postgres.ts` for why every identifier is still validated strictly before
 * being interpolated into generated SQL text.
 */
export interface RlsPolicyOptions {
  /** The table the policy is created on. */
  table: string;
  /**
   * The column on `table` that holds the owning tenant's id.
   *
   * **Must be a `text`-compatible column type** (`text`, `varchar`, `citext`,
   * ...). The generated policy compares this column against
   * `current_setting(...)`, which always returns `text` — Postgres has no
   * implicit cast from `text` to `uuid`/`integer`/etc. for `=`, so
   * `CREATE POLICY` itself fails outright (loudly, at migration time — not
   * a silent isolation gap) for a non-text-typed column. If your tenant id
   * is naturally a `uuid` or `integer`, either store it in a `text`
   * column, or add an explicit cast in your own SQL rather than relying on
   * this module's generated predicate (see "Non-text tenant columns" in
   * `docs/row-level-security.md`).
   *
   * @defaultValue `'tenant_id'`
   */
  tenantColumn?: string;
  /**
   * The name given to the `CREATE POLICY` statement.
   * @defaultValue `` `${table}_tenant_isolation` ``
   */
  policyName?: string;
  /**
   * The Postgres session GUC (set via `set_config`/`current_setting`, see
   * {@link https://www.postgresql.org/docs/current/sql-set.html | SET}) that
   * carries the current request's tenant id. Must match what
   * `generateSetTenantContextSql` is called with for the same deployment.
   * @defaultValue `'app.current_tenant_id'`
   */
  sessionSetting?: string;
  /**
   * Which statement types the policy governs. Postgres's own default when a
   * `CREATE POLICY` statement omits `FOR` is `ALL`, so that's also this
   * option's default.
   * @defaultValue `'ALL'`
   */
  command?: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  /**
   * Postgres roles the policy applies `TO`. Omit (or pass an empty array —
   * both are treated identically) to leave off the `TO` clause entirely,
   * which makes the policy apply to every role querying the table
   * (Postgres's default when `TO` is not specified).
   */
  roles?: string[];
}
