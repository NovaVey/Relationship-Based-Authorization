/**
 * `authz serve` — build spec §7/§9 Phase 8. Starts the Fastify server
 * (`src/api/server.ts`) on `env.PORT`, exposing `check`/`expand`/`write`/
 * `schema` over HTTP with `ADMIN_API_KEY`-gated writes.
 */
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { buildServer } from '../../api/server.js';
import { rebuildRelationMembershipIndex } from '../../store/relation-index.js';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

/**
 * Binds `0.0.0.0`, not the Fastify default `127.0.0.1` — this command
 * exists to be reached from outside the process (a container, a platform
 * like Railway per build spec §2's own hosting note), where a loopback-only
 * bind would make the server unreachable from anywhere but itself.
 */
const BIND_HOST = '0.0.0.0';

/**
 * The Leopard index's own "optional in-process interval" trigger
 * (`docs/LEOPARD-INDEX-PROPOSAL.md`'s "Refresh trigger" section,
 * `env.ts`'s own `LEOPARD_INDEX_REFRESH_INTERVAL_MS` comment): `> 0` makes
 * `authz serve` run this rebuild on a timer, in addition to (never instead
 * of) any external scheduler an operator also has running `authz leopard
 * refresh` — both funnel through the same
 * `pg_try_advisory_xact_lock`-guarded `rebuildRelationMembershipIndex`, so
 * layering both is safe, only possibly redundant; a still-running previous
 * call (from this timer or an external cron) simply loses the try-lock and
 * returns `lockAcquired: false`, not an error. `0` (the parsed default)
 * disables this — `authz serve` never triggers a rebuild on its own,
 * matching the pre-existing behavior this fixes the gap in.
 *
 * Deliberately NOT gated on `LEOPARD_INDEX_ENABLED`, matching `authz
 * leopard refresh`'s own CLI doc comment ("runnable regardless of
 * `LEOPARD_INDEX_ENABLED`... what makes 'pre-warm before enabling'
 * possible") — an operator who sets a nonzero interval before flipping the
 * enabled flag gets a warm index the moment they do, rather than the first
 * `maxDepth`-pinned check after enabling paying a cold-rebuild's own
 * latency inline.
 *
 * A rejected rebuild is logged and swallowed, never allowed to become an
 * unhandled rejection or to crash the server process — a background
 * maintenance job's own failure must never take down request serving,
 * the same posture `serve()`'s own `buildServer`/`app.listen` catches
 * already establish for startup-time failures.
 */
function startLeopardRefreshLoop(pool: Pool, log: FastifyInstance['log']): NodeJS.Timeout | null {
  const intervalMs = env.LEOPARD_INDEX_REFRESH_INTERVAL_MS ?? 0;
  if (intervalMs <= 0) return null;
  return setInterval(() => {
    rebuildRelationMembershipIndex(pool, { dryRun: false }).catch((err: unknown) => {
      log.error({ err }, `leopard index background refresh failed: ${(err as Error).message}`);
    });
  }, intervalMs);
}

export async function serve(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  let app;
  try {
    app = await buildServer(pool);
  } catch (err) {
    // Mirrors this function's own `app.listen` catch below (full-repo
    // audit finding #9, LOW, fourth audit) — every sibling CLI command
    // (`doctor.ts`, `check.ts`, `tuple.ts`, `schema.ts`, `expand.ts`,
    // `soundness.ts`) wraps its own DB/infra calls the same way, "never a
    // bare stack trace" per `doctor.ts`'s own doc comment. Without this,
    // a future rejection inside `buildServer` (e.g. a Fastify
    // plugin-registration regression) would propagate uncaught into
    // `index.ts`'s top-level handler — a raw stack trace and Node's
    // default exit code 1, not this project's documented exit code 3 —
    // and leave `pool` open, since `closePool()` is otherwise only
    // reached via this catch, the `app.listen` catch below, or the
    // SIGINT/SIGTERM path, none of which run if `buildServer` itself
    // never returns an `app` to attach them to.
    console.error(`Postgres/server: ${(err as Error).message}`);
    process.exitCode = 3;
    await closePool();
    return;
  }

  const refreshTimer = startLeopardRefreshLoop(pool, app.log);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (refreshTimer) clearInterval(refreshTimer);
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await app.listen({ port: env.PORT, host: BIND_HOST });
  } catch (err) {
    console.error(`Postgres/server: ${(err as Error).message}`);
    process.exitCode = 3;
    await closePool();
  }
}
