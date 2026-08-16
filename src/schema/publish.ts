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

/**
 * `select max(version)+1, then insert` is a read-then-write race: two
 * concurrent `publishSchema` calls targeting the *same* namespace can both
 * read the same `next_version` before either inserts, and the loser's
 * `INSERT` then dies on `namespace_configs`'s own uniqueness constraint —
 * a raw Postgres error thrown out of `publishSchema` instead of its own
 * `{ ok: false, errors: [...] }` shape. `pg_advisory_xact_lock(hashtext($1))`
 * closes that window by serializing every `publishOne` call for a given
 * `namespace` string: the first transaction to reach this line for a
 * namespace holds the lock until it commits or rolls back, so a second,
 * concurrent transaction publishing the same namespace blocks *before* it
 * ever reads `max(version)`, and always computes the next version after the
 * first one's insert (or its rollback) is visible — never in a lost-update
 * race with it.
 *
 * Two alternatives considered and rejected in favor of this one:
 *  - `SELECT ... FOR UPDATE`: needs a row to lock, and there may be none
 *    yet — a namespace's very first publish has no existing
 *    `namespace_configs` row, so a row lock can't close the race for
 *    exactly the case (`coalesce(max(version), 0)` defaulting to 0) where
 *    it matters as much as any later one.
 *  - Catch the `INSERT`'s unique-constraint violation and retry the whole
 *    select-then-insert cycle: works, but adds a real retry loop (bounded
 *    attempts, and code to distinguish *this* constraint violation from any
 *    other reason the insert could fail) to handle a narrow, admin-gated,
 *    already-low-probability race after the fact. An advisory lock makes
 *    the race structurally impossible instead, for less code.
 *
 * `hashtext($1)` (int4) rather than `hashtextextended($1, 0)` (bigint,
 * wider hash space, no implicit cast needed): the task this lock closes is
 * serializing writes to *this specific, small, admin-curated set of
 * namespace names* — collisions are already vanishingly unlikely at 32
 * bits for that population, and even a hash collision between two
 * different namespace names would only ever cost a spurious lock wait
 * (briefly, harmlessly serializing two unrelated namespaces' publishes),
 * never a correctness bug — so `hashtext`'s narrower hash space isn't worth
 * `hashtextextended`'s marginally less obvious call shape here.
 * `pg_advisory_xact_lock` is transaction-scoped and needs no matching
 * unlock call: Postgres releases it automatically at this transaction's own
 * `COMMIT` or `ROLLBACK` (confirmed against the Postgres advisory-locks
 * docs, not assumed), which exactly matches `publishSchema`'s own
 * `BEGIN`/`COMMIT`/`ROLLBACK` transaction wrapping every `publishOne` call
 * in its loop — no separate release path to remember or leak.
 *
 * Multiple namespaces published together (one `pg_advisory_xact_lock` call
 * per loop iteration in `publishSchema`, one per namespace) could in
 * principle deadlock against another concurrent multi-namespace publish
 * that acquires the same two namespaces' locks in the opposite order —
 * Postgres's own deadlock detector would resolve that by aborting one side
 * with an ordinary error (the same failure class `ROLLBACK` already handles
 * here, not a hang). Namespace lock order here is exactly each source DSL
 * text's own namespace declaration order (`compileParsedNamespaces` builds
 * `CompiledSchema.namespaces` by iterating parsed namespaces in that order,
 * and object key insertion order is what `Object.values` in
 * `publishSchema`'s loop walks), so this only bites two *different* source
 * texts publishing the same overlapping namespaces in reversed order at the
 * same time — narrow on top of already-narrow (admin-gated), and left
 * undefended rather than adding lock-order normalization (e.g. sorting
 * namespaces before acquiring locks) that would also reorder
 * `PublishResult.published`, a behavior change out of scope for this fix.
 */
async function publishOne(
  client: { query: Pool['query'] },
  config: NamespaceConfig,
  sourceDsl: string,
): Promise<number> {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [config.namespace]);
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
 *
 * That "must not" was, until now, enforced only by this comment — nothing
 * structurally stopped a future caller from `import`ing this function from
 * anywhere else in `src/` and calling it (full-repo audit finding #26, low
 * severity: real but narrow, since it requires a future developer to both
 * ignore this doc comment and reach for a function whose name and doc
 * comment both say not to). `eslint.config.js` now closes this: a
 * `no-restricted-imports` block restricting
 * `importNames: ['deletePublishedNamespaceVersion']` for every file under
 * `src/**\/*.ts` except `src/soundness/runner.ts` (that config object's own
 * `ignores`) — a future non-`runner.ts` caller fails `npx eslint .`, not
 * just a code review that happened to notice this comment. It matches via
 * `patterns` (gitignore-style, e.g. `**\/schema/publish.js`, plus a second
 * unanchored `publish.js` entry for a same-directory `./publish.js` import
 * from a hypothetical future file added directly inside src/schema/ itself)
 * rather than `paths` (exact string) because ESLint's import rules see each
 * importer's own literal specifier text, not a resolved module path —
 * `paths` would need one exact entry per distinct `../` depth every current
 * and future importer happens to use, `patterns`' glob matches all of them
 * uniformly (verified directly against the `ignore` package this rule uses
 * internally, across every real specifier shape in this repo plus that one
 * same-directory case, not assumed). Scoped to `src/**` only, deliberately not
 * `test/**`: `test/unit/soundness/runner-dry-run-cleanup-failure.test.ts`
 * legitimately does `import * as publishModule from '.../schema/publish.js'`
 * and then `vi.spyOn(publishModule, 'deletePublishedNamespaceVersion')` to
 * test this exact cleanup path, and `no-restricted-imports` flags *any*
 * namespace (`import * as x`) import of a path once one of its named
 * exports is restricted — regardless of which properties are actually read
 * off that namespace object — so a `test/**` rule would need its own
 * per-file exemption for that test too, for no benefit: the risk this
 * closes is a future *production* caller, not a test mocking the one
 * sanctioned one.
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
