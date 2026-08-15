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
