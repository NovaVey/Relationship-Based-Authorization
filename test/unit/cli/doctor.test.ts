/**
 * Regression test for a real bug: `authz doctor` reporting `Migrations:
 * 0/0 applied` — and exiting 0, `doctor: OK` — on Windows, because
 * `src/cli/commands/doctor.ts` used to compute `MIGRATIONS_DIR` via
 * `new URL('../../store/migrations', import.meta.url).pathname`.
 *
 * A `file://` URL's `.pathname` on a Windows path keeps the leading `/`
 * in front of the drive letter (`file:///C:/Users/...` ->
 * `/C:/Users/...`) — not a valid Windows filesystem path. `existsSync` on
 * that bogus path returns false, and `discoverMigrations` (deliberately
 * lenient about a missing directory — see its own doc comment, for the
 * legitimate case of a fresh clone before Phase 2's first migration ever
 * existed) reports zero total migrations with no error at all. The
 * failure is silent and looks identical to success — no exception, no
 * nonzero exit code, just an empty database nobody can `check` or
 * `expand` against.
 *
 * `src/config/env.ts` already got this right (`fileURLToPath`, not
 * `.pathname`) — this test doesn't re-test `doctor.ts` end to end (that's
 * `doctor: OK` printing correctly on this Linux CI runner, which the fix
 * doesn't change), it pins the actual mechanism of the platform-specific
 * bug directly, since nothing here runs on real Windows to catch a
 * regression the ordinary way. `fileURLToPath`'s `windows` option (Node
 * 20+, this project requires Node >=22 — see `package.json`) forces the
 * Windows code path deterministically on any host, which is what makes
 * this reproducible on Linux CI at all.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';

import { env } from '../../../src/config/env.js';
import { doctor } from '../../../src/cli/commands/doctor.js';
import * as clientModule from '../../../src/store/client.js';
import * as migrateModule from '../../../src/store/migrate.js';

describe('file:// URL -> filesystem path conversion on Windows', () => {
  const windowsFileUrl = new URL(
    'file:///C:/Users/dev/Relationship-Based-Authorization/dist/cli/commands/doctor.js',
  );

  it('`.pathname` leaves an invalid leading slash before the drive letter — the actual bug', () => {
    expect(windowsFileUrl.pathname).toBe(
      '/C:/Users/dev/Relationship-Based-Authorization/dist/cli/commands/doctor.js',
    );
  });

  it('`fileURLToPath` with the Windows code path forced strips it correctly — the fix', () => {
    expect(fileURLToPath(windowsFileUrl, { windows: true })).toBe(
      'C:\\Users\\dev\\Relationship-Based-Authorization\\dist\\cli\\commands\\doctor.js',
    );
  });
});

/**
 * Full-repo audit finding #4 (MEDIUM, third audit, 2026-08-17): `doctor()`
 * used to wrap the connectivity probe and `runMigrations` in one try/catch,
 * so a `runMigrations` failure printed the exact same "Postgres:
 * unreachable ... Check DATABASE_URL in .env" framing as a genuine
 * connection failure — self-contradictory (a "reachable" line immediately
 * followed by "unreachable") and actively misleading, since it points an
 * operator at the one thing (DATABASE_URL) already proven fine by the
 * "reachable" line above it. Mirrors D-073's identical fix for `/health`.
 *
 * DB-free: `getPool`/`closePool`/`runMigrations` are all mocked via
 * `vi.spyOn` on their own module namespace, this project's own established
 * pattern (`test/unit/cli/soundness.test.ts`'s `runSoundnessFuzz` mocking,
 * `test/unit/api/server.test.ts`'s domain-function mocking) — no real
 * Postgres or Docker needed to prove which message each failure produces.
 */
describe('authz doctor — a runMigrations failure is never blamed on Postgres reachability (finding #4)', () => {
  const ORIGINAL_DATABASE_URL = env.DATABASE_URL;

  afterEach(() => {
    vi.restoreAllMocks();
    env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    process.exitCode = undefined;
  });

  it('a-runMigrations-failure-reports-migrations-failed-to-apply-never-postgres-unreachable-or-database-url', async () => {
    env.DATABASE_URL = 'postgres://placeholder/db'; // getPool is mocked below — never a real connection
    const fakePool = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ current_database: 'authz', server_version: '16.4' }] }),
    };
    vi.spyOn(clientModule, 'getPool').mockReturnValue(fakePool as unknown as Pool);
    vi.spyOn(clientModule, 'closePool').mockResolvedValue(undefined);
    vi.spyOn(migrateModule, 'runMigrations').mockRejectedValue(
      new Error('migration 0002_add_checks failed: syntax error at or near "selct"'),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await doctor();

    expect(process.exitCode).toBe(3);
    const logs = logSpy.mock.calls.map((call) => String(call[0]));
    const errors = errorSpy.mock.calls.map((call) => String(call[0]));
    // The connectivity probe genuinely succeeded — that line must still
    // print, unaffected by the later migrations failure.
    expect(logs.some((line) => line.startsWith('Postgres: reachable'))).toBe(true);
    // The migrations failure gets its own, distinctly-attributed message —
    // never the connectivity-failure framing, never a DATABASE_URL pointer.
    expect(
      errors.some((line) =>
        line.includes('Migrations: failed to apply — migration 0002_add_checks failed'),
      ),
    ).toBe(true);
    expect(errors.some((line) => line.includes('unreachable'))).toBe(false);
    expect(errors.some((line) => line.includes('DATABASE_URL'))).toBe(false);
  });

  it('a-genuine-connectivity-failure-still-produces-the-original-postgres-unreachable-message-unchanged', async () => {
    env.DATABASE_URL = 'postgres://placeholder/db'; // getPool is mocked below — never a real connection
    const fakePool = { query: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    vi.spyOn(clientModule, 'getPool').mockReturnValue(fakePool as unknown as Pool);
    vi.spyOn(clientModule, 'closePool').mockResolvedValue(undefined);
    const migrationsSpy = vi.spyOn(migrateModule, 'runMigrations');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await doctor();

    expect(process.exitCode).toBe(3);
    // A connectivity failure must never even attempt runMigrations.
    expect(migrationsSpy).not.toHaveBeenCalled();
    const errors = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(errors.some((line) => line === 'Postgres: unreachable — ECONNREFUSED')).toBe(true);
    expect(errors.some((line) => line.includes('Check DATABASE_URL in .env'))).toBe(true);
  });
});
