/**
 * Migration runner. Phase 0 wiring — the actual table definitions from §4
 * (namespace_configs, relation_tuples, write_log, checks, soundness_runs)
 * are Phase 2's job and land as .sql files under `migrations/`. This file
 * exists now so that mechanism is proven end to end (a real connection, a
 * real transaction, a real tracking table) against zero migrations, rather
 * than being built for the first time under the pressure of Phase 2's own
 * exit criteria.
 *
 * `discoverMigrations` is a pure function — no I/O beyond a directory
 * listing, no database — specifically so it's unit-testable without a
 * Postgres connection, per this project's own preference for testing pure
 * logic in isolation before it's entangled with I/O (see
 * .claude/commands/build-authz-service.md §9 Phase 1's reasoning, applied
 * here at smaller scale).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

export interface MigrationFile {
  /** Filename without the .sql extension — also the schema_migrations primary key. */
  id: string;
  filename: string;
  path: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Lists `*.sql` files in `dir`, sorted lexicographically by filename — the
 * standard "NNNN_description.sql" convention makes lexicographic order the
 * intended apply order. A missing directory is treated as zero migrations,
 * not an error: a fresh clone has no `migrations/` directory at all until
 * Phase 2 commits its first one, and `authz doctor` must not fail just
 * because nothing has been written yet.
 */
export function discoverMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      id: filename.slice(0, -'.sql'.length),
      filename,
      path: join(dir, filename),
    }));
}

const MIGRATIONS_TABLE_DDL = `
  create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  );
`;

/**
 * Applies every migration in `dir` not already recorded in
 * `schema_migrations`, each in its own transaction (one migration's SQL
 * fails without touching the ones before it). Idempotent: re-running with
 * nothing new to apply reports an empty `applied` list.
 */
export async function runMigrations(pool: Pool, dir: string): Promise<MigrationResult> {
  await pool.query(MIGRATIONS_TABLE_DDL);

  const { rows } = await pool.query<{ id: string }>('select id from schema_migrations');
  const alreadyApplied = new Set(rows.map((row) => row.id));

  const pending = discoverMigrations(dir).filter((migration) => !alreadyApplied.has(migration.id));
  const applied: string[] = [];

  for (const migration of pending) {
    const sql = readFileSync(migration.path, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('insert into schema_migrations (id) values ($1)', [migration.id]);
      await client.query('COMMIT');
      applied.push(migration.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${migration.id} failed: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      client.release();
    }
  }

  return { applied, alreadyApplied: [...alreadyApplied] };
}
