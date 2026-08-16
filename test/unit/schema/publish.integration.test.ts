/**
 * `publishSchema`'s own documented all-or-nothing transaction claim
 * (`src/schema/publish.ts`'s top-of-file doc comment: "A compile failure
 * publishes nothing — every namespace in the source is published together
 * or not at all, in one transaction, so a caller never ends up with only
 * some of a multi-namespace file's namespaces live.") — full-repo audit
 * finding #17: nothing forced a *second* namespace's own insert to fail
 * mid-loop and asserted the *first* namespace's already-inserted row rolled
 * back too. `src/schema/publish.ts` was read here only as it stood at the
 * time of this task (read-only — this file does not modify it; it is
 * being actively edited elsewhere for an unrelated fix, per this task's own
 * instruction).
 *
 * **On the suggested "pre-insert a colliding `(namespace, version)` row"
 * mechanism, and why this file does something different:** `publishOne`
 * computes `version` as `coalesce(max(version), 0) + 1` for the namespace
 * being published — by construction, that value can never already exist as
 * a row for that namespace, however many rows are pre-inserted beforehand
 * (a pre-inserted row only pushes the computed next version higher, never
 * onto an existing one). Forcing a genuine `(namespace, version)` unique-
 * constraint collision therefore requires a real write landing in the
 * narrow window between `publishOne`'s own `SELECT` and `INSERT` for that
 * namespace — precisely the race `publishOne`'s own
 * `pg_advisory_xact_lock(hashtext($1))` (see that function's doc comment)
 * now closes for any two calls that both go through `publishOne`, and
 * reproducing it from *outside* that lock (a raw, lock-unaware write
 * timed to land in that exact window) is a genuine, timing-dependent race,
 * not the deterministic failure this test needs. Confirmed by direct
 * reasoning about the SQL before writing this file, not assumed.
 *
 * This test forces the same class of failure — `publishOne`'s own `INSERT`
 * throwing a real Postgres error partway through `publishSchema`'s loop —
 * deterministically instead, with a `CHECK` constraint added (via this
 * file's own dedicated container, never touching the shared local fixture
 * other integration tests use) that unconditionally rejects any row insert
 * naming one specific, pre-chosen namespace. The property under test is
 * identical either way: a real Postgres error thrown by the second
 * `publishOne` call in `publishSchema`'s loop must roll back the first
 * one's already-executed `INSERT` too, in the same transaction.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = new URL('../../../src/store/migrations', import.meta.url).pathname;

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uniqueCounter}`;
}

function twoNamespaceSource(nsA: string, nsB: string): string {
  return [
    `namespace ${nsA} {`,
    '  relation owner: user',
    '}',
    '',
    `namespace ${nsB} {`,
    '  relation owner: user',
    '}',
  ].join('\n');
}

async function countRows(namespace: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from namespace_configs where namespace = $1`,
    [namespace],
  );
  return Number(rows[0]?.count ?? '0');
}

describe('publishSchema is all-or-nothing across a multi-namespace source: a second namespaces insert failing mid-loop rolls back the first namespaces insert too', () => {
  it('when-the-second-namespaces-insert-is-forced-to-fail-neither-namespace-has-any-row-afterward', async () => {
    const nsA = uniqueName('ns_a');
    const nsB = uniqueName('ns_b');
    const source = twoNamespaceSource(nsA, nsB);

    // Deterministically reject any row naming nsB, at the database level —
    // see this file's own top-of-file doc comment for why this stands in
    // for the originally-suggested "colliding pre-inserted version" trick,
    // which cannot actually collide given `publishOne`'s own
    // `max(version) + 1` computation.
    const constraintName = `reject_${nsB}`;
    await pool.query(
      `alter table namespace_configs add constraint ${constraintName} check (namespace <> '${nsB}')`,
    );

    try {
      // nsA is declared first in the source, so `publishSchema`'s loop
      // (`Object.values(compiled.schema.namespaces)`, which walks
      // namespaces in source declaration order) inserts nsA successfully
      // BEFORE it ever reaches nsB — the load-bearing ordering this test
      // depends on to prove a genuine rollback of an already-executed
      // statement, not merely "the whole call failed before writing
      // anything."
      await expect(publishSchema(pool, source)).rejects.toThrow();

      // The actual claim: nsA's insert, which really ran inside the same
      // transaction before nsB's own insert threw, must not have survived
      // the transaction's ROLLBACK. Checking BOTH namespaces directly
      // against `namespace_configs` — not just the one that failed — is
      // the point; a caller who only checked nsB could not tell an "all
      // rolled back" outcome apart from a "only the failing one was
      // rejected, the other one silently committed" outcome, which is
      // exactly the defect this test exists to catch.
      expect(await countRows(nsA)).toBe(0);
      expect(await countRows(nsB)).toBe(0);
    } finally {
      await pool.query(`alter table namespace_configs drop constraint ${constraintName}`);
    }
  });

  it('control-with-nothing-forced-to-fail-the-identical-two-namespace-source-persists-both-namespaces-rows', async () => {
    // Without this control, the test above alone could not rule out a
    // resolver that simply never persists anything, ever — proving the
    // rollback above is a genuine transactional consequence of the forced
    // failure, not an artifact of a harness that publishes nothing
    // regardless.
    const nsA = uniqueName('ns_a_ok');
    const nsB = uniqueName('ns_b_ok');
    const source = twoNamespaceSource(nsA, nsB);

    const result = await publishSchema(pool, source);
    expect(result.ok).toBe(true);

    expect(await countRows(nsA)).toBe(1);
    expect(await countRows(nsB)).toBe(1);
  });
});
