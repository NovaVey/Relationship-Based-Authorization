/**
 * `GET /metrics` (`src/api/server.ts`, new feature) — fast, DB-free
 * route-wiring tests, mirroring `test/unit/api/check-batch.test.ts`'s own
 * established conventions: a plain `{ query: vi.fn() }` fake `pool` cast
 * to `Pool`, `buildServer(pool, { logger: false })` per test,
 * `resetMetricsForTest()` in `beforeEach` so a prior test's own recorded
 * checks never leak into this one's assertions.
 *
 * This file's own job: the auth gate (unauthenticated → 401, a valid
 * `ADMIN_API_KEY` → 200), the one property specific to this route among
 * every gated route in this codebase (a namespace-scoped DB-backed key is
 * rejected outright, not merely out-of-scope-for-a-namespace — see
 * `src/api/server.ts`'s own doc comment on this route for why), and that
 * the response is genuinely `text/plain` Prometheus exposition carrying
 * real counter values `src/metrics/registry.ts` computed — not
 * `src/metrics/registry.ts`'s own counting logic, which
 * `test/unit/metrics/registry.test.ts` already covers directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';
import { recordCheck, resetMetricsForTest } from '../../../src/metrics/registry.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ADMIN_KEY = 'metrics-test-admin-key';

let app: FastifyInstance;
let poolQuery: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

beforeEach(async () => {
  resetMetricsForTest();
  poolQuery = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  const pool = { query: poolQuery } as unknown as Pool;
  app = await buildServer(pool, { logger: false });
  env.ADMIN_API_KEY = ADMIN_KEY;
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
  resetMetricsForTest();
});

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

describe('GET /metrics — auth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong bearer token with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders('not-the-configured-key'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the configured static ADMIN_API_KEY', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /metrics — namespace-scoped DB-backed key rejected outright', () => {
  it('a namespace-scoped admin-role DB key gets 403, not the counters', async () => {
    poolQuery.mockImplementation(async (text: unknown) => {
      if (typeof text === 'string' && text.includes('from api_keys')) {
        return { rows: [{ id: '1', role: 'admin', scopes: ['document'] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders('a-real-looking-scoped-admin-db-key'),
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('scoped');
  });

  it('an unscoped (scopes: null) admin-role DB key is accepted, exactly like the static key', async () => {
    poolQuery.mockImplementation(async (text: unknown) => {
      if (typeof text === 'string' && text.includes('from api_keys')) {
        return { rows: [{ id: '2', role: 'admin', scopes: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders('a-real-looking-unscoped-admin-db-key'),
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('GET /metrics — response shape', () => {
  it('serves text/plain Prometheus exposition format, not JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
  });

  it('reflects a check actually recorded through src/metrics/registry.ts, not a canned body', async () => {
    recordCheck({ allowed: true, depth: 1, touchedExpiringTuple: false });
    recordCheck({ allowed: false, depth: 1, touchedExpiringTuple: false, certain: true });

    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.payload).toContain('authz_checks_total{allowed="true"} 1');
    expect(res.payload).toContain('authz_checks_total{allowed="false"} 1');
  });
});
