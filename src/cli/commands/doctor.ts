/**
 * `authz doctor` — proves the one thing every later phase depends on:
 * that DATABASE_URL actually points at a reachable Postgres. Reports
 * success with what it connected to, or a specific failure reason and
 * exits 3 (infrastructure failure, per §7's exit code table) — never a
 * bare stack trace, and never a silent hang on a dead connection string.
 */
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../../store/client.js';
import { discoverMigrations, runMigrations } from '../../store/migrate.js';
import { env } from '../../config/env.js';

// fileURLToPath, not `new URL(...).pathname` — the latter leaves a leading
// `/` in front of a Windows drive letter (`/C:/Users/...`), which isn't a
// valid filesystem path on Windows. `existsSync` on that bogus path quietly
// returns false, and `discoverMigrations` (deliberately lenient — see its
// own doc comment, a missing dir is "zero migrations", not an error, for
// the legitimate case of a fresh clone before Phase 2's first migration
// existed) reports 0 total migrations with no error at all: `doctor` prints
// "Migrations: 0/0 applied" and exits 0, looking identical to success.
// `src/config/env.ts` already gets this right; this mirrors that.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../store/migrations', import.meta.url));

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
    // Two independent try/catches, deliberately — not one wrapping both the
    // connectivity probe and `runMigrations` (full-repo audit finding #4,
    // MEDIUM, third audit, 2026-08-17; the identical shape D-073 already
    // found and fixed for `/health`'s connectivity-probe-vs-namespace-
    // listing-query split — see docs/DECISIONS.md). Before this fix, a
    // single try/catch around both steps meant a `runMigrations` failure
    // (a real migration-content problem — a broken .sql file, a conflicting
    // concurrent migration run, a permissions error on the migrations
    // table) printed the exact same "Postgres: unreachable ... Check
    // DATABASE_URL in .env" framing as a genuine connection failure, even
    // though the "Postgres: reachable" line immediately above it had
    // already printed — self-contradictory output that sends an operator
    // debugging a real migration problem toward the one thing already
    // proven fine. Each step now reports its own distinct outcome; only the
    // connectivity probe's failure is ever described as "unreachable" or
    // points at DATABASE_URL.
    let row: { current_database: string; server_version: string } | undefined;
    try {
      const result = await pool.query<{ current_database: string; server_version: string }>(
        "select current_database(), current_setting('server_version') as server_version",
      );
      row = result.rows[0];
    } catch (err) {
      console.error(`Postgres: unreachable — ${(err as Error).message}`);
      console.error('Check DATABASE_URL in .env — see .env.example.');
      process.exitCode = 3;
      return;
    }
    console.log(
      `Postgres: reachable — database "${row?.current_database}", server ${row?.server_version}`,
    );

    try {
      const total = discoverMigrations(MIGRATIONS_DIR).length;
      const { applied, alreadyApplied } = await runMigrations(pool, MIGRATIONS_DIR);
      const nowApplied = alreadyApplied.length + applied.length;
      console.log(
        `Migrations: ${nowApplied}/${total} applied` +
          (applied.length > 0
            ? ` (${applied.length} newly applied this run: ${applied.join(', ')})`
            : ''),
      );
    } catch (err) {
      // Connectivity is fine (the probe above already succeeded) — this is
      // `runMigrations` itself failing, a different, distinctly reported
      // diagnosis. Never "unreachable", never a DATABASE_URL pointer: those
      // claims would simply be false here.
      console.error(`Migrations: failed to apply — ${(err as Error).message}`);
      process.exitCode = 3;
      return;
    }

    console.log('doctor: OK');
  } finally {
    await closePool();
  }
}
