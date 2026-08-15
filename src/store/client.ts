/**
 * The single Postgres connection pool for this process. Phase 0 scaffolding
 * — the tuple store itself (reads/writes against relation_tuples,
 * write_log, etc.) is Phase 2 — but `doctor` and the migration runner both
 * need a real pool now to prove connectivity end to end, so it's built
 * once, here, rather than duplicated per caller.
 *
 * A short `connectionTimeoutMillis` is deliberate: `authz doctor` exists to
 * fail fast with a specific reason (§7's exit code 3, "infrastructure
 * failure") when Postgres is unreachable, not to hang indefinitely on a
 * dead connection string.
 */
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

import { env } from '../config/env.js';

let pool: Pool | undefined;

export function getPool(config: PoolConfig = {}): Pool {
  if (!env.DATABASE_URL) {
    // Defensive — every caller in this codebase is expected to check
    // env.DATABASE_URL itself first and report a command-specific message
    // (see src/cli/commands/doctor.ts). Reaching this means a new caller
    // skipped that check; fail loud rather than let `pg` produce a
    // confusing "no connection string" error of its own further down.
    throw new Error('DATABASE_URL is not set — see .env.example.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      ...config,
    });
  }
  return pool;
}

/** For tests and graceful shutdown — closes the pool and clears the singleton. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
