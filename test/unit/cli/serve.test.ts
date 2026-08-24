/**
 * `authz serve` (`src/cli/commands/serve.ts`) — full-repo audit finding #6
 * (MEDIUM, fourth audit): this file had zero direct or indirect unit test
 * coverage, unlike every sibling CLI command (`doctor.ts`, `check.ts`,
 * `tuple.ts`, `expand.ts`, `schema.ts`, `soundness.ts`), each of which has
 * its own dedicated test file exercising its exported function directly —
 * `test/unit/cli/exit-code-remap.test.ts`'s own doc comment already
 * confirms this pattern-break explicitly.
 *
 * DB-free, mirroring `test/unit/cli/doctor.test.ts`'s own established
 * pattern: `getPool`/`closePool` mocked via `vi.spyOn` on their own module
 * namespace, `buildServer` mocked the same way (`test/unit/api/server.test.ts`
 * already establishes that `buildServer` itself is the unit worth mocking
 * at this boundary, never a raw `pg.Pool`). `process.on`/`process.exit`
 * are also mocked — this file must never register a real, persistent
 * `SIGINT`/`SIGTERM` handler on the actual test-runner process, and must
 * never actually terminate it.
 *
 * Three distinct, previously-uncovered behaviors, all from `serve.ts`'s
 * own doc comment and exported shape:
 * 1. `DATABASE_URL` unset -> exit 3, no stack trace (pre-existing code,
 *    never tested).
 * 2. A `buildServer` failure -> exit 3, `Postgres/server:` prefix,
 *    `closePool` still runs — the try/catch this same finding adds
 *    (full-repo audit finding #9, LOW, fourth audit: this call was
 *    unguarded before, breaking this file's own established convention).
 * 3. An `app.listen` failure -> exit 3, `Postgres/server:` prefix,
 *    `closePool` still runs — this catch already existed; only its test
 *    coverage was missing.
 * 4. SIGINT triggers the graceful-shutdown path: `app.close()` then
 *    `closePool()` then `process.exit(0)`, and the `shuttingDown` guard
 *    makes a second signal a no-op.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

import { env } from '../../../src/config/env.js';
import { serve } from '../../../src/cli/commands/serve.js';
import * as clientModule from '../../../src/store/client.js';
import * as serverModule from '../../../src/api/server.js';

const ORIGINAL_DATABASE_URL = env.DATABASE_URL;

function fakeFastifyInstance(overrides: Partial<FastifyInstance> = {}): FastifyInstance {
  return {
    log: { info: vi.fn() },
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as FastifyInstance;
}

afterEach(() => {
  vi.restoreAllMocks();
  env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  process.exitCode = undefined;
});

describe('authz serve — DATABASE_URL unset (pre-existing, previously untested)', () => {
  it('reports-postgres-not-set-and-exits-3-without-ever-calling-getPool-or-buildServer', async () => {
    env.DATABASE_URL = '';
    const getPoolSpy = vi.spyOn(clientModule, 'getPool');
    const buildServerSpy = vi.spyOn(serverModule, 'buildServer');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await serve();

    expect(process.exitCode).toBe(3);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL is not set'));
    expect(getPoolSpy).not.toHaveBeenCalled();
    expect(buildServerSpy).not.toHaveBeenCalled();
  });
});

describe('authz serve — a buildServer failure is reported and closes the pool, never a bare stack trace (finding #9)', () => {
  it('a-thrown-buildServer-error-reports-postgres-server-prefix-exits-3-and-still-closes-the-pool', async () => {
    env.DATABASE_URL = 'postgres://placeholder/db'; // getPool is mocked below — never a real connection
    const fakePool = { query: vi.fn() } as unknown as Pool;
    vi.spyOn(clientModule, 'getPool').mockReturnValue(fakePool);
    const closePoolSpy = vi.spyOn(clientModule, 'closePool').mockResolvedValue(undefined);
    vi.spyOn(serverModule, 'buildServer').mockRejectedValue(
      new Error('simulated Fastify plugin-registration failure'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    await serve();

    expect(process.exitCode).toBe(3);
    expect(errorSpy).toHaveBeenCalledWith(
      'Postgres/server: simulated Fastify plugin-registration failure',
    );
    expect(closePoolSpy).toHaveBeenCalledTimes(1);
    // Never reaches the point of registering shutdown signal handlers —
    // there is no `app` to attach them to.
    expect(onSpy).not.toHaveBeenCalledWith('SIGINT', expect.anything());
    expect(onSpy).not.toHaveBeenCalledWith('SIGTERM', expect.anything());
  });
});

describe('authz serve — an app.listen failure is reported and closes the pool, never a bare stack trace', () => {
  it('a-thrown-listen-error-reports-postgres-server-prefix-exits-3-and-still-closes-the-pool', async () => {
    env.DATABASE_URL = 'postgres://placeholder/db';
    vi.spyOn(clientModule, 'getPool').mockReturnValue({ query: vi.fn() } as unknown as Pool);
    const closePoolSpy = vi.spyOn(clientModule, 'closePool').mockResolvedValue(undefined);
    const fakeApp = fakeFastifyInstance({
      listen: vi.fn().mockRejectedValue(new Error('EADDRINUSE: address already in use')),
    });
    vi.spyOn(serverModule, 'buildServer').mockResolvedValue(fakeApp);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(() => process); // don't register real signal handlers

    await serve();

    expect(process.exitCode).toBe(3);
    expect(errorSpy).toHaveBeenCalledWith('Postgres/server: EADDRINUSE: address already in use');
    expect(closePoolSpy).toHaveBeenCalledTimes(1);
  });
});

describe('authz serve — SIGINT/SIGTERM trigger a graceful shutdown exactly once (pre-existing, previously untested)', () => {
  it('SIGINT-closes-the-app-and-the-pool-then-exits-0-and-a-second-signal-is-a-no-op', async () => {
    env.DATABASE_URL = 'postgres://placeholder/db';
    vi.spyOn(clientModule, 'getPool').mockReturnValue({ query: vi.fn() } as unknown as Pool);
    const closePoolSpy = vi.spyOn(clientModule, 'closePool').mockResolvedValue(undefined);
    const fakeApp = fakeFastifyInstance();
    vi.spyOn(serverModule, 'buildServer').mockResolvedValue(fakeApp);
    // Capture the real handler serve() registers instead of letting it
    // attach to the actual process object — invoked directly below,
    // exactly as if that signal had really fired.
    const handlers = new Map<string | symbol, () => void>();
    vi.spyOn(process, 'on').mockImplementation((signal: string | symbol, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await serve();
    expect(fakeApp.listen).toHaveBeenCalledWith(
      expect.objectContaining({ host: '0.0.0.0', port: env.PORT }),
    );

    const sigintHandler = handlers.get('SIGINT');
    expect(sigintHandler).toBeDefined();
    sigintHandler?.();
    // The handler's own body is async (`void shutdown(...)`) — let its
    // promise chain settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(fakeApp.close).toHaveBeenCalledTimes(1);
    expect(closePoolSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // A second signal (even the other one) is a no-op — the
    // `shuttingDown` guard, not a second full shutdown sequence.
    const sigtermHandler = handlers.get('SIGTERM');
    sigtermHandler?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeApp.close).toHaveBeenCalledTimes(1);
    expect(closePoolSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
