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
      // Explicit, validated, and env-configurable (env.PG_POOL_MAX,
      // src/config/env.ts) rather than left to `pg`'s own unstated library
      // default — this project's `authz doctor` needs a real, known number
      // to check against `MAX_CONCURRENCY` (see env.ts's own doc comment on
      // PG_POOL_MAX and docs/DECISIONS.md D-140/D-143). Defaults to 10,
      // matching `pg`'s own undocumented-here default exactly, so a
      // deployment that never sets PG_POOL_MAX sees no behavior change from
      // before this field existed.
      max: env.PG_POOL_MAX,
      ...config,
    });
    // pg's own documented contract: the pool emits 'error' on behalf of any
    // IDLE client that hits a background/network-level error (the server
    // restarting, a network blip, a load balancer resetting a connection).
    // Node's default behavior for an EventEmitter's unhandled 'error' event
    // is to throw — with no listener here, a single idle connection's
    // transient error would crash this entire process, not just fail one
    // request. The pool itself already recovers on its own (a fresh
    // connection opens for the next query); this listener only stops that
    // recovery from taking the whole process down with it. Confirmed this
    // is a real, previously-unguarded gap, not a defensive-by-habit
    // addition: the identical missing listener is what caused every
    // `test-integration` CI job's intermittent "Unhandled Errors" failure
    // (see `docs/DECISIONS.md`) — this is the same fix, applied to the one
    // place it matters most.
    pool.on('error', (err) => {
      console.error(`Postgres pool: an idle client encountered an error — ${err.message}`);
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
