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
  const app = buildServer(pool);

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
