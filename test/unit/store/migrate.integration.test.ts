/**
 * Real-Postgres integration test for `runMigrations`'s own documented
 * idempotent-rerun contract — `src/store/migrate.ts`'s doc comment on
 * `runMigrations` states this plainly: "Idempotent: re-running with
 * nothing new to apply reports an empty `applied` list." That claim rests
 * on a real mechanism (a `schema_migrations` tracking table, `select id
 * from schema_migrations` filtering out what's already recorded) that only
 * a real database can actually exercise — `test/unit/migrate.test.ts`
 * (the DB-free sibling) says as much in its own top-of-file doc comment:
 * "`runMigrations` itself needs a real Postgres connection ... a
 * real-Postgres integration test for it can be added once Phase 2 gives it
 * actual migration content to run" — full-repo audit finding #31: that
 * content has existed since Phase 2 landed (four real `.sql` files under
 * `src/store/migrations/`), but nothing ever came back to add the test its
 * own sibling file's comment anticipated.
 *
 * Runs against a real, ephemeral Postgres container (`@testcontainers/
 * postgresql`, already a devDependency) — the same `beforeAll`/`afterAll`/
 * `runMigrations` boilerplate every other `*.integration.test.ts` file in
 * this project already establishes (see `docs/DECISIONS.md` D-019/D-030;
 * `test/unit/store/tuple-store.integration.test.ts` is the closest
 * sibling). Deliberately does NOT call `runMigrations` in `beforeAll` here
 * — this file's whole point is to control both calls itself, back to back,
 * against a container it knows started with zero migrations applied.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { discoverMigrations, runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

/** Every table name currently in the `public` schema, sorted for a stable diff. */
async function tableNames(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public'
     order by table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Every column of `table`, as `"name type"`, sorted — a coarse but effective schema fingerprint. */
async function columnFingerprint(table: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
     where table_schema = 'public' and table_name = $1
     order by column_name`,
    [table],
  );
  return rows.map((r) => `${r.column_name} ${r.data_type}`);
}

describe('runMigrations is idempotent on rerun — a second call against an already-migrated database applies nothing and changes nothing', () => {
  it('the-first-call-applies-every-discovered-migration-and-the-second-call-back-to-back-applies-none-of-them-again', async () => {
    const totalMigrations = discoverMigrations(MIGRATIONS_DIR).length;
    expect(totalMigrations).toBeGreaterThan(0); // sanity: this file has real migration content to run

    const first = await runMigrations(pool, MIGRATIONS_DIR);
    expect(first.applied).toHaveLength(totalMigrations);
    expect(first.alreadyApplied).toHaveLength(0);

    const second = await runMigrations(pool, MIGRATIONS_DIR);
    // The literal claim from migrate.ts's own doc comment: "re-running
    // with nothing new to apply reports an empty `applied` list."
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(totalMigrations);
    expect(new Set(second.alreadyApplied)).toEqual(new Set(first.applied));
  });

  it('schema_migrations-records-exactly-one-row-per-migration-not-a-duplicate-row-per-call', async () => {
    // Ran twice already by the test above (this file shares one container/
    // pool across its own describe block, matching this project's own
    // no-truncation-between-tests discipline) — a tracking table that
    // re-inserted a row on every rerun rather than genuinely skipping
    // already-applied migrations would show duplicates here.
    const totalMigrations = discoverMigrations(MIGRATIONS_DIR).length;
    const { rows } = await pool.query<{ id: string; count: string }>(
      `select id, count(*)::text as count from schema_migrations group by id`,
    );
    expect(rows).toHaveLength(totalMigrations);
    for (const row of rows) {
      expect(row.count).toBe('1');
    }
  });

  it('the-table-and-column-shape-after-the-second-call-is-byte-identical-to-the-shape-after-the-first', async () => {
    // Direct proof of "leaves the schema in the identical state," not just
    // "reported nothing applied": every table this project's own
    // migrations create, and every column on each, fingerprinted before and
    // after a third, additional rerun — a migration re-applying itself
    // (e.g. a non-idempotent `create table` without `if not exists`, or a
    // duplicate `alter table add column`) would either throw here or change
    // one of these fingerprints; catching only the exception would miss a
    // silent structural drift.
    const tablesBefore = await tableNames();
    const fingerprintsBefore = new Map<string, string[]>();
    for (const table of tablesBefore) {
      fingerprintsBefore.set(table, await columnFingerprint(table));
    }

    await runMigrations(pool, MIGRATIONS_DIR);

    const tablesAfter = await tableNames();
    expect(tablesAfter).toEqual(tablesBefore);
    for (const table of tablesAfter) {
      expect(await columnFingerprint(table)).toEqual(fingerprintsBefore.get(table));
    }
  });
});

/**
 * Full-repo audit finding #14 (LOW, third audit, 2026-08-17): `runMigrations`
 * used to read `schema_migrations`, compute what's pending, and apply it
 * with nothing serializing that read-then-apply sequence against a second,
 * genuinely concurrent call — the identical "read pending state, then
 * write, unserialized" shape D-080 already found and fixed for `publishOne`
 * and D-083 fixed for `writeTuple`/`deleteTuple`, but never extended to
 * `schema_migrations` itself. Closed by `MIGRATIONS_LOCK_CLASSID`/
 * `MIGRATIONS_LOCK_OBJID` (`src/store/migrate.ts`) — see that constant
 * pair's own doc comment for the exact mechanism and why it is
 * session-scoped (`pg_advisory_lock`), not transaction-scoped like D-080's
 * and D-083's own locks.
 *
 * A dedicated fresh container/pool for this describe block, deliberately
 * separate from the one the idempotent-rerun tests above share — this test
 * needs a database that genuinely has zero migrations applied yet at the
 * moment both calls fire, which the shared container above no longer is by
 * the time this file reaches this point.
 *
 * Mirrors `test/unit/store/tuple-store.integration.test.ts`'s own real-race
 * testing idiom (two real, independently-driven operations racing against
 * the same real Postgres, not a mock) — here, `Promise.all` on the same
 * pool is enough to get two real, concurrent connections/transactions
 * racing each other, since `runMigrations` itself calls `pool.connect()`
 * for its own lock-holding connection; unlike that file's own
 * inverted-commit-order regression test, this one doesn't need to
 * *control* the exact interleaving (hold one side open while asserting the
 * other blocks) — it only needs to confirm the outcome of two calls that
 * are genuinely racing, which firing both concurrently already provides.
 *
 * Before this fix, this exact scenario reproduced a real, unhandled
 * catalog-conflict error live against real Postgres — confirmed directly,
 * not assumed, by temporarily reverting the fix and re-running: both calls'
 * near-simultaneous `create table if not exists schema_migrations` (the
 * DDL originally ran unlocked, before this fix moved it inside the lock
 * too — see `runMigrations`'s own doc comment) raced a real
 * `pg_type_typname_nsp_index` unique-constraint violation from Postgres's
 * own `pg_catalog`, 100% reproducible across repeated runs. Restored
 * immediately after confirming the fail-check, never left reverted.
 */
describe('two genuinely concurrent runMigrations calls against the same fresh database never race — finding #14', () => {
  let raceContainer: StartedPostgreSqlContainer;
  let racePool: Pool;

  beforeAll(async () => {
    raceContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    racePool = new Pool({ connectionString: raceContainer.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await racePool.end();
    await raceContainer.stop();
  });

  it('one-call-applies-every-migration-the-other-applies-none-and-neither-throws-an-unhandled-catalog-conflict-error', async () => {
    const totalMigrations = discoverMigrations(MIGRATIONS_DIR).length;
    expect(totalMigrations).toBeGreaterThan(0); // sanity: real migration content to race over

    const [a, b] = await Promise.all([
      runMigrations(racePool, MIGRATIONS_DIR),
      runMigrations(racePool, MIGRATIONS_DIR),
    ]);

    // The lock fully serializes the two calls, so exactly one side does the
    // real work and the other — whichever acquires the lock second — always
    // finds nothing left pending by the time it gets to look.
    const appliedCounts = [a.applied.length, b.applied.length].sort((x, y) => x - y);
    expect(appliedCounts).toEqual([0, totalMigrations]);

    const { rows } = await racePool.query<{ id: string; count: string }>(
      `select id, count(*)::text as count from schema_migrations group by id`,
    );
    expect(rows).toHaveLength(totalMigrations);
    for (const row of rows) {
      expect(row.count).toBe('1');
    }
  });
});
