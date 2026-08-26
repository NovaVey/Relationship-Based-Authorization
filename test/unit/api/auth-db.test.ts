/**
 * `checkAdminAuthDb`/`checkReadAuthDb` (`src/api/auth.ts`) — the async,
 * DB-aware counterparts of `checkAdminAuth`/`checkReadAuth`
 * (`test/unit/api/auth.test.ts` already fully covers those two, unchanged,
 * synchronous functions; this file does not re-derive any of that). A
 * plain `{ query: vi.fn() }` fake pool, matching `test/unit/api/
 * server.test.ts`'s own established "prove the wiring, not a real
 * database" fixture shape — no real Postgres anywhere in this file. The
 * one real-Postgres proof of the full story lives in
 * `test/unit/store/api-keys.integration.test.ts`.
 *
 * Written from `checkAdminAuthDb`/`checkReadAuthDb`'s own exported types
 * and top-of-file doc comment in `src/api/auth.ts` — the fallback shape
 * (static check first, DB only on failure, never on a header carrying no
 * bearer token at all), role enforcement, and the reason-normalization
 * rule are all asserted here exactly as that doc comment states them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkAdminAuthDb, checkReadAuthDb } from '../../../src/api/auth.js';
import { hashApiKey } from '../../../src/api/db-api-keys.js';
import { env } from '../../../src/config/env.js';
import type { QueryExecutor } from '../../../src/store/query-executor.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ORIGINAL_READONLY_API_KEY = env.READONLY_API_KEY;

afterEach(() => {
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
  env.READONLY_API_KEY = ORIGINAL_READONLY_API_KEY;
});

function poolReturning(rows: unknown[]): QueryExecutor & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

function poolThatThrows(message: string): QueryExecutor & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockRejectedValue(new Error(message)) };
}

// ---------------------------------------------------------------------------
// checkAdminAuthDb
// ---------------------------------------------------------------------------

describe('checkAdminAuthDb — a matching static ADMIN_API_KEY short-circuits, never touching the database', () => {
  it('the-correct-static-admin-key-authorizes-with-scopes-null-and-pool-query-is-never-called', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([]);
    await expect(checkAdminAuthDb(pool, 'Bearer the-real-admin-key-0123456789ab')).resolves.toEqual(
      { authorized: true, scopes: null },
    );
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('checkAdminAuthDb — no bearer token at all short-circuits to the static result, never touching the database', () => {
  it('a-missing-authorization-header-never-queries-the-database', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([]);
    await expect(checkAdminAuthDb(pool, undefined)).resolves.toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('with-admin-api-key-unset-and-no-header-at-all-reports-not-configured-without-querying-the-database', async () => {
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([]);
    await expect(checkAdminAuthDb(pool, undefined)).resolves.toEqual({
      authorized: false,
      reason: 'admin_api_key_not_configured',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('checkAdminAuthDb — a supplied bearer token that does not match the static key falls back to a real DB lookup', () => {
  it('a-matching-admin-role-db-key-authorizes-and-returns-its-own-scopes', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([{ id: '1', role: 'admin', scopes: ['document'] }]);
    await expect(checkAdminAuthDb(pool, 'Bearer some-db-backed-key')).resolves.toEqual({
      authorized: true,
      scopes: ['document'],
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('a-matching-admin-role-db-key-with-no-scopes-null-authorizes-as-unscoped', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([{ id: '1', role: 'admin', scopes: null }]);
    await expect(checkAdminAuthDb(pool, 'Bearer some-db-backed-key')).resolves.toEqual({
      authorized: true,
      scopes: null,
    });
  });

  it('a-matching-readonly-role-db-key-must-never-pass-an-admin-check', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([{ id: '2', role: 'readonly', scopes: null }]);
    await expect(checkAdminAuthDb(pool, 'Bearer some-readonly-db-key')).resolves.toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('no-matching-db-row-at-all-is-rejected-as-missing_or_invalid_key-never-admin_api_key_not_configured', async () => {
    // Reason-normalization rule (src/api/auth.ts's own doc comment): once a
    // real DB lookup was attempted and came back empty, this must never
    // fall back to claiming the deployment has "no configured secret" —
    // it has one (the static key), this particular credential just didn't
    // match either tier.
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([]);
    await expect(checkAdminAuthDb(pool, 'Bearer totally-unknown-key')).resolves.toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('with-admin-api-key-unset-a-real-admin-role-db-key-still-authorizes', async () => {
    // The DB tier works entirely independently of whether ADMIN_API_KEY is
    // configured at all.
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([{ id: '3', role: 'admin', scopes: null }]);
    await expect(checkAdminAuthDb(pool, 'Bearer some-db-backed-key')).resolves.toEqual({
      authorized: true,
      scopes: null,
    });
  });

  it('with-admin-api-key-unset-and-no-matching-db-row-either-reports-not-configured-since-the-static-check-never-ran-past-the-header-less-fast-path', async () => {
    // Distinguishes the "a header WAS supplied, DB was consulted, nothing
    // matched" case (missing_or_invalid_key, tested above) from "no header
    // at all" (admin_api_key_not_configured, tested in the earlier describe
    // block) — this case supplies a header, so the DB genuinely gets
    // consulted, and still correctly collapses to missing_or_invalid_key,
    // not the static check's own original reason.
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([]);
    await expect(checkAdminAuthDb(pool, 'Bearer totally-unknown-key')).resolves.toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('looks-up-by-the-hash-of-the-supplied-bearer-token-not-the-raw-token-itself', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool: QueryExecutor = { query };
    await checkAdminAuthDb(pool, 'Bearer raw-supplied-key');
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(hashApiKey('raw-supplied-key'));
  });
});

describe('checkAdminAuthDb — a genuine infrastructure failure propagates, never silently authorized or silently denied', () => {
  it('a-thrown-pool-error-during-the-db-fallback-rejects-rather-than-resolving-to-either-branch', async () => {
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolThatThrows('connection refused');
    await expect(checkAdminAuthDb(pool, 'Bearer some-key')).rejects.toThrow('connection refused');
  });
});

// ---------------------------------------------------------------------------
// checkReadAuthDb
// ---------------------------------------------------------------------------

describe('checkReadAuthDb — a matching static key (either tier) short-circuits, never touching the database', () => {
  it('the-correct-static-readonly-key-authorizes-with-scopes-null-and-pool-query-is-never-called', async () => {
    env.READONLY_API_KEY = 'the-real-readonly-key-0123456789';
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([]);
    await expect(checkReadAuthDb(pool, 'Bearer the-real-readonly-key-0123456789')).resolves.toEqual(
      { authorized: true, scopes: null },
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('the-correct-static-admin-key-also-authorizes-a-read-and-pool-query-is-never-called', async () => {
    env.READONLY_API_KEY = undefined;
    env.ADMIN_API_KEY = 'the-real-admin-key-0123456789ab';
    const pool = poolReturning([]);
    await expect(checkReadAuthDb(pool, 'Bearer the-real-admin-key-0123456789ab')).resolves.toEqual({
      authorized: true,
      scopes: null,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('checkReadAuthDb — a supplied bearer token that matches neither static key falls back to a real DB lookup, accepting EITHER role', () => {
  it('a-matching-readonly-role-db-key-authorizes-a-read', async () => {
    env.READONLY_API_KEY = 'the-real-readonly-key-0123456789';
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([{ id: '1', role: 'readonly', scopes: ['document'] }]);
    await expect(checkReadAuthDb(pool, 'Bearer some-db-backed-key')).resolves.toEqual({
      authorized: true,
      scopes: ['document'],
    });
  });

  it('a-matching-admin-role-db-key-also-authorizes-a-read-mirroring-the-static-admin-key-doing-the-same', async () => {
    env.READONLY_API_KEY = 'the-real-readonly-key-0123456789';
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([{ id: '2', role: 'admin', scopes: null }]);
    await expect(checkReadAuthDb(pool, 'Bearer some-admin-db-key')).resolves.toEqual({
      authorized: true,
      scopes: null,
    });
  });

  it('no-matching-db-row-is-rejected-as-missing_or_invalid_key', async () => {
    env.READONLY_API_KEY = 'the-real-readonly-key-0123456789';
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([]);
    await expect(checkReadAuthDb(pool, 'Bearer totally-unknown-key')).resolves.toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });
});

describe('checkReadAuthDb — no bearer token at all short-circuits, never touching the database', () => {
  it('with-neither-static-key-configured-and-no-header-reports-no-read-credential-configured-without-querying-the-database', async () => {
    env.READONLY_API_KEY = undefined;
    env.ADMIN_API_KEY = undefined;
    const pool = poolReturning([]);
    await expect(checkReadAuthDb(pool, undefined)).resolves.toEqual({
      authorized: false,
      reason: 'no_read_credential_configured',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('checkReadAuthDb — a genuine infrastructure failure propagates', () => {
  it('a-thrown-pool-error-during-the-db-fallback-rejects', async () => {
    env.READONLY_API_KEY = 'the-real-readonly-key-0123456789';
    env.ADMIN_API_KEY = undefined;
    const pool = poolThatThrows('connection refused');
    await expect(checkReadAuthDb(pool, 'Bearer some-key')).rejects.toThrow('connection refused');
  });
});
