/**
 * `authz serve` — build spec §7/§9 Phase 8. Starts the Fastify server
 * (`src/api/server.ts`) on `env.PORT`, exposing `check`/`expand`/`write`/
 * `schema` over HTTP with `ADMIN_API_KEY`-gated writes.
 */
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { buildServer } from '../../api/server.js';

/**
 * Binds `0.0.0.0`, not the Fastify default `127.0.0.1` — this command
 * exists to be reached from outside the process (a container, a platform
 * like Railway per build spec §2's own hosting note), where a loopback-only
 * bind would make the server unreachable from anywhere but itself.
 */
const BIND_HOST = '0.0.0.0';

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

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
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
