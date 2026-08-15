/**
 * `authz doctor` — proves the one thing every later phase depends on:
 * that DATABASE_URL actually points at a reachable Postgres. Reports
 * success with what it connected to, or a specific failure reason and
 * exits 3 (infrastructure failure, per §7's exit code table) — never a
 * bare stack trace, and never a silent hang on a dead connection string.
 */
import { getPool, closePool } from '../../store/client.js';
import { discoverMigrations, runMigrations } from '../../store/migrate.js';
import { env } from '../../config/env.js';

const MIGRATIONS_DIR = new URL('../../store/migrations', import.meta.url).pathname;

export async function doctor(): Promise<void> {
  console.log(`authz doctor — NODE_ENV=${env.NODE_ENV}`);

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set.');
    console.error('Copy .env.example to .env and fill in DATABASE_URL, then retry.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await pool.query<{ current_database: string; server_version: string }>(
      "select current_database(), current_setting('server_version') as server_version",
    );
    const row = result.rows[0];
    console.log(
      `Postgres: reachable — database "${row?.current_database}", server ${row?.server_version}`,
    );

    const total = discoverMigrations(MIGRATIONS_DIR).length;
    const { applied, alreadyApplied } = await runMigrations(pool, MIGRATIONS_DIR);
    const nowApplied = alreadyApplied.length + applied.length;
    console.log(
      `Migrations: ${nowApplied}/${total} applied` +
        (applied.length > 0
          ? ` (${applied.length} newly applied this run: ${applied.join(', ')})`
          : ''),
    );

    console.log('doctor: OK');
  } catch (err) {
    console.error(`Postgres: unreachable — ${(err as Error).message}`);
    console.error('Check DATABASE_URL in .env — see .env.example.');
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
