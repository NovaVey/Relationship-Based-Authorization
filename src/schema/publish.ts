/**
 * Publishing a compiled schema into `namespace_configs` — the bridge
 * between Phase 1 (pure, zero-I/O compilation) and Phase 2 (the tuple
 * store, which validates writes against whatever's actually published; see
 * `src/schema/dsl/types.ts`'s own doc comment). Nothing in `src/schema/dsl/`
 * touches Postgres — this file is where that boundary is deliberately
 * crossed, and only here.
 */
import type { Pool } from 'pg';

import { compileSchema } from './dsl/compiler.js';
import { formatSchemaError } from './dsl/errors.js';
import type { NamespaceConfig } from './dsl/types.js';

export interface PublishedNamespace {
  namespace: string;
  version: number;
}

export type PublishResult =
  { ok: true; published: PublishedNamespace[] } | { ok: false; errors: string[] };

/**
 * Compiles `sourceDsl` (one or more `namespace { ... }` blocks — see build
 * spec §5) and, for every namespace it produces, inserts the next version
 * for that namespace into `namespace_configs`. `source_dsl` stores the
 * *entire* input text verbatim against every namespace's row, even when
 * one call publishes several namespaces at once — simpler and always
 * sufficient for audit ("what source produced this config"), rather than
 * trying to re-slice per-namespace source substrings back out of a shared
 * AST. Versions are per-namespace and monotonic, starting at 1.
 *
 * A compile failure publishes nothing — every namespace in the source is
 * published together or not at all, in one transaction, so a caller never
 * ends up with only some of a multi-namespace file's namespaces live.
 */
export async function publishSchema(pool: Pool, sourceDsl: string): Promise<PublishResult> {
  const compiled = compileSchema(sourceDsl);
  if (!compiled.ok) {
    return { ok: false, errors: compiled.errors.map(formatSchemaError) };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const published: PublishedNamespace[] = [];
    for (const config of Object.values(compiled.schema.namespaces)) {
      const version = await publishOne(client, config, sourceDsl);
      published.push({ namespace: config.namespace, version });
    }
    await client.query('COMMIT');
    return { ok: true, published };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function publishOne(
  client: { query: Pool['query'] },
  config: NamespaceConfig,
  sourceDsl: string,
): Promise<number> {
  const { rows } = await client.query<{ next_version: number }>(
    `select coalesce(max(version), 0) + 1 as next_version
     from namespace_configs where namespace = $1`,
    [config.namespace],
  );
  const version = rows[0]?.next_version ?? 1;
  await client.query(
    `insert into namespace_configs (namespace, version, config, source_dsl)
     values ($1, $2, $3, $4)`,
    [config.namespace, version, JSON.stringify(config), sourceDsl],
  );
  return version;
}

/**
 * Fetches the latest published `NamespaceConfig` for `namespace`, or
 * `undefined` if nothing has ever been published for it — the lookup
 * `src/store/tuples.ts`'s write-time validation depends on.
 */
export async function getLatestNamespaceConfig(
  pool: Pool,
  namespace: string,
): Promise<NamespaceConfig | undefined> {
  const { rows } = await pool.query<{ config: NamespaceConfig }>(
    `select config from namespace_configs
     where namespace = $1
     order by version desc
     limit 1`,
    [namespace],
  );
  return rows[0]?.config;
}

/**
 * Deletes exactly one `namespace_configs` row by `(namespace, version)`.
 *
 * A narrow, deliberate exception to this table's normal shape: every
 * other piece of this system treats a published namespace version as
 * permanent, append-only history — `publishOne` never overwrites a
 * version, nothing anywhere else in `src/` ever deletes a row here, and
 * `docs/RELATIONS.md`/`docs/CONSISTENCY.md` describe schema versions the
 * same way §4 does, as a record, not a mutable current-state table. This
 * function exists for exactly one caller: `src/soundness/runner.ts`'s
 * `dryRun` cleanup (D-063), which publishes a fuzz-generated schema,
 * proves the differential comparison against it, and then must leave
 * *no trace* — the row it deletes was synthetic fuzz-fixture data,
 * created and destroyed within the same `runSoundnessFuzz` call, never
 * observed as real schema history by anything in between. This is not a
 * general "unpublish a namespace" feature and must not be reached for
 * that purpose — nothing in the CLI or API surface exposes it.
 */
export async function deletePublishedNamespaceVersion(
  pool: Pool,
  namespace: string,
  version: number,
): Promise<void> {
  await pool.query(`delete from namespace_configs where namespace = $1 and version = $2`, [
    namespace,
    version,
  ]);
}

/**
 * Every namespace that has ever been published, each at its own latest
 * version — the Phase 8 `/health` route's own requirement (build spec §9
 * Phase 8: "reports ... current namespace config versions"), and the reason
 * this exists alongside `getLatestNamespaceConfig`: that function only ever
 * answers for one namespace named in advance (what a tuple write validates
 * against), while `/health` needs to enumerate every namespace this
 * deployment actually knows about, with no namespace named up front.
 *
 * `distinct on (namespace) ... order by namespace, version desc` picks
 * exactly one row per namespace — its highest version — in one query
 * rather than N (one `getLatestNamespaceConfig` call per known namespace),
 * which would also require already knowing every namespace name to ask
 * for. Ordered by namespace name for deterministic, stable output (a
 * health payload that reorders itself between two calls with no
 * underlying change would be a spurious diff for anything diffing it).
 */
export async function listLatestNamespaceVersions(pool: Pool): Promise<PublishedNamespace[]> {
  const { rows } = await pool.query<{ namespace: string; version: number }>(
    `select distinct on (namespace) namespace, version
     from namespace_configs
     order by namespace, version desc`,
  );
  return rows.map((row) => ({ namespace: row.namespace, version: row.version }));
}
