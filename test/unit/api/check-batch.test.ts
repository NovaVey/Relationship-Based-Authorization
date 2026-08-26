/**
 * `POST /check/batch` (new feature, `src/api/server.ts`) — fast, DB-free
 * route-wiring tests, mirroring `test/unit/api/server.test.ts`'s own
 * established conventions exactly: `performCheck` mocked via `vi.spyOn` on
 * its own module namespace, a plain `{ query: vi.fn() }` fake `pool` cast
 * to `Pool`, `buildServer(pool, { logger: false })` per test. This file's
 * own job: does the batch route call `performCheck` once per item with the
 * right arguments, does it preserve input order in the response, does the
 * size cap actually reject an oversized batch, and — the property specific
 * to a namespace-scoped credential — does an out-of-scope item anywhere in
 * the batch reject the WHOLE batch before any individual check runs.
 *
 * Does not re-derive `performCheck`/`checkResponse`'s own already-tested
 * behavior (`test/unit/audit/checks.test.ts`, `test/unit/api/
 * responses.test.ts`) — every check result here is a canned mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

import * as checksModule from '../../../src/audit/checks.js';
import type { PerformCheckResult } from '../../../src/audit/checks.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ORIGINAL_READONLY_API_KEY = env.READONLY_API_KEY;
const ADMIN_KEY = 'check-batch-test-admin-key';

let app: FastifyInstance;
let poolQuery: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

beforeEach(async () => {
  poolQuery = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  // Default: no row in `api_keys` matches — see `test/unit/api/server.test.ts`'s
  // own `beforeEach` for the full reasoning (`checkReadAuthDb`'s DB fallback
  // really does query this pool whenever a supplied bearer token doesn't
  // match the configured static key).
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  const pool = { query: poolQuery } as unknown as Pool;
  app = await buildServer(pool, { logger: false });
  env.ADMIN_API_KEY = ADMIN_KEY;
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
  env.READONLY_API_KEY = ORIGINAL_READONLY_API_KEY;
});

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

const CHECK_BATCH_MAX_SIZE = 50;

describe('POST /check/batch — several checks in one call get correct, independent, order-preserving per-item results', () => {
  it('a-mix-of-allowed-and-denied-checks-returns-one-result-per-item-in-the-same-order-as-the-request', async () => {
    const spy = vi.spyOn(checksModule, 'performCheck');
    // Deterministic per-item outcome keyed by subject id, so the test can
    // assert the RIGHT answer landed at the RIGHT index, not just "some
    // mix of true/false came back somewhere."
    spy.mockImplementation(async (_pool, subject): Promise<PerformCheckResult> => {
      const allowed = (subject as { id: string }).id === 'alice';
      return allowed
        ? { allowed: true, depth: 1, touchedExpiringTuple: false }
        : { allowed: false, depth: 1, touchedExpiringTuple: false };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: {
        checks: [
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'a' },
          },
          {
            subject: { ns: 'user', id: 'bob' },
            relation: 'view',
            object: { ns: 'document', id: 'b' },
          },
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'c' },
          },
        ],
      },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body.results).toHaveLength(3);
    expect(body.results[0]).toMatchObject({
      allowed: true,
      subject: { ns: 'user', id: 'alice' },
      object: { ns: 'document', id: 'a' },
    });
    expect(body.results[1]).toMatchObject({
      allowed: false,
      subject: { ns: 'user', id: 'bob' },
      object: { ns: 'document', id: 'b' },
    });
    expect(body.results[2]).toMatchObject({
      allowed: true,
      subject: { ns: 'user', id: 'alice' },
      object: { ns: 'document', id: 'c' },
    });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('each-results-entry-is-shaped-exactly-like-a-single-check-response-body-including-depth-and-path', async () => {
    const spy = vi.spyOn(checksModule, 'performCheck');
    spy.mockResolvedValue({
      allowed: true,
      depth: 4,
      touchedExpiringTuple: false,
      path: {
        kind: 'directGrant',
        subject: { ns: 'user', id: 'alice' },
        object: { ns: 'document', id: 'readme' },
        relation: 'viewer',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: {
        checks: [
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'readme' },
          },
        ],
      },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body.results[0]).toEqual({
      allowed: true,
      subject: { ns: 'user', id: 'alice' },
      relation: 'view',
      object: { ns: 'document', id: 'readme' },
      depth: 4,
      path: {
        kind: 'directGrant',
        subject: { ns: 'user', id: 'alice' },
        object: { ns: 'document', id: 'readme' },
        relation: 'viewer',
      },
    });
  });
});

describe('POST /check/batch — size cap', () => {
  it(`a-batch-of-exactly-${CHECK_BATCH_MAX_SIZE}-checks-is-accepted-not-off-by-one-rejected`, async () => {
    const spy = vi.spyOn(checksModule, 'performCheck').mockResolvedValue({
      allowed: false,
      depth: 0,
      touchedExpiringTuple: false,
    });

    const checks = Array.from({ length: CHECK_BATCH_MAX_SIZE }, (_, i) => ({
      subject: { ns: 'user', id: `user${i}` },
      relation: 'view',
      object: { ns: 'document', id: `doc${i}` },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: { checks },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(CHECK_BATCH_MAX_SIZE);
  });

  it(`a-batch-of-${CHECK_BATCH_MAX_SIZE + 1}-checks-is-rejected-with-400-invalid-request-and-performcheck-is-never-called`, async () => {
    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockRejectedValue(new Error('performCheck must not be called for an oversized batch'));

    const checks = Array.from({ length: CHECK_BATCH_MAX_SIZE + 1 }, (_, i) => ({
      subject: { ns: 'user', id: `user${i}` },
      relation: 'view',
      object: { ns: 'document', id: `doc${i}` },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: { checks },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(400);
    const body = await parseBody(res);
    expect(body.error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('an-empty-checks-array-is-rejected-with-400-invalid-request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: { checks: [] },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });
});

describe('POST /check/batch — auth and rate limiting are wired exactly like /check', () => {
  it('with-admin-api-key-unset-the-batch-route-returns-401-and-performcheck-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockRejectedValue(new Error('performCheck must not be called when unauthorized'));

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: {
        checks: [
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'a' },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-malformed-atToken-on-one-batch-item-is-rejected-with-400-and-performcheck-is-never-called-for-any-item', async () => {
    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockRejectedValue(
        new Error('performCheck must not be called when a batch item fails to decode'),
      );

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: {
        checks: [
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'a' },
          },
          {
            subject: { ns: 'user', id: 'bob' },
            relation: 'view',
            object: { ns: 'document', id: 'b' },
            atToken: 'not-a-real-token',
          },
        ],
      },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /check/batch — a namespace-scoped DB-backed key rejects the whole batch at the auth layer, before any check runs', () => {
  it('one-out-of-scope-namespace-anywhere-in-the-batch-returns-403-and-performcheck-is-never-called-for-any-item', async () => {
    // Static ADMIN_API_KEY stays configured but this request presents a
    // DIFFERENT bearer token — `checkReadAuthDb` (`src/api/auth.ts`) falls
    // through to `validateDbApiKey`, which this test's own `poolQuery` mock
    // answers with a real-shaped row: a `readonly`-role key scoped to only
    // `document` — never `folder`.
    poolQuery.mockImplementation(async (text: unknown) => {
      if (typeof text === 'string' && text.includes('from api_keys')) {
        return { rows: [{ id: '1', role: 'readonly', scopes: ['document'] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockRejectedValue(
        new Error('performCheck must not be called for any item once the batch is out of scope'),
      );

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: {
        checks: [
          // In scope.
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'a' },
          },
          // Out of scope — this one lone item must sink the entire batch.
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'folder', id: 'b' },
          },
        ],
      },
      headers: authHeaders('a-real-looking-scoped-db-key'),
    });

    expect(res.statusCode).toBe(403);
    const body = await parseBody(res);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('folder');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-batch-entirely-within-a-scoped-keys-namespaces-succeeds-normally', async () => {
    poolQuery.mockImplementation(async (text: unknown) => {
      if (typeof text === 'string' && text.includes('from api_keys')) {
        return { rows: [{ id: '1', role: 'readonly', scopes: ['document'] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockResolvedValue({ allowed: true, depth: 1, touchedExpiringTuple: false });

    const res = await app.inject({
      method: 'POST',
      url: '/check/batch',
      payload: {
        checks: [
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'a' },
          },
          {
            subject: { ns: 'user', id: 'alice' },
            relation: 'view',
            object: { ns: 'document', id: 'b' },
          },
        ],
      },
      headers: authHeaders('a-real-looking-scoped-db-key'),
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
