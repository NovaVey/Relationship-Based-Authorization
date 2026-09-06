/**
 * `POST /tuples/batch` (`src/api/server.ts`, new feature) — fast, DB-free
 * route-wiring tests, mirroring `test/unit/api/check-batch.test.ts`'s own
 * established conventions exactly: `writeTuple` mocked via `vi.spyOn` on
 * its own module namespace, a plain `{ query: vi.fn() }` fake `pool` cast
 * to `Pool`, `buildServer(pool, { logger: false })` per test.
 *
 * This file's own job: order preservation, the size cap, all-or-nothing
 * pre-validation (a malformed `expiresAt` anywhere, an out-of-scope
 * namespace anywhere) before any write runs, and — the property specific
 * to this route among the batch endpoints in this codebase — that one
 * item's own validation failure never sinks any other item's write,
 * unlike `/check/batch`'s pre-validation-only all-or-nothing shape. Does
 * not re-derive `writeTuple`/`tupleWriteResponse`'s own already-tested
 * behavior (`test/unit/store/tuples.test.ts`, `test/unit/api/
 * server.test.ts`) — every write result here is a canned mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

import * as tuplesModule from '../../../src/store/tuples.js';
import type { WriteTupleResult } from '../../../src/store/tuples.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ADMIN_KEY = 'tuple-batch-test-admin-key';

let app: FastifyInstance;
let poolQuery: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

beforeEach(async () => {
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
});

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

function tupleItem(overrides: Record<string, unknown> = {}) {
  return {
    objectNs: 'document',
    objectId: 'readme',
    relation: 'viewer',
    subjectNs: 'user',
    subjectId: 'alice',
    ...overrides,
  };
}

function okResult(token: number, created = true): WriteTupleResult {
  return { ok: true, token, created };
}

describe('POST /tuples/batch — auth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: { tuples: [tupleItem()] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /tuples/batch — size cap', () => {
  it('rejects a batch of 51 tuples with 400, before any write runs', async () => {
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockRejectedValue(new Error('writeTuple must not be called for an oversized batch'));

    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: { tuples: Array.from({ length: 51 }, (_, i) => tupleItem({ objectId: `doc${i}` })) },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(400);
    const body = await parseBody(res);
    expect(body.error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts exactly 50 tuples', async () => {
    vi.spyOn(tuplesModule, 'writeTuple').mockImplementation(async () => okResult(1));

    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: { tuples: Array.from({ length: 50 }, (_, i) => tupleItem({ objectId: `doc${i}` })) },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body.results).toHaveLength(50);
  });
});

describe('POST /tuples/batch — order preservation', () => {
  it('returns one result per input tuple, in the same order supplied, regardless of settle order', async () => {
    vi.spyOn(tuplesModule, 'writeTuple').mockImplementation(async (_pool, tuple) => {
      // Deliberately resolve out of input order (the last item first) —
      // proves ordering comes from the pre-computed index, not completion
      // order, the same property runCheckBatch's own tests already pin.
      const delayMs = tuple.objectId === 'a' ? 10 : 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return okResult(Number(tuple.objectId.codePointAt(0)));
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: {
        tuples: [
          tupleItem({ objectId: 'a' }),
          tupleItem({ objectId: 'b' }),
          tupleItem({ objectId: 'c' }),
        ],
      },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body.results.map((r: { objectId: string }) => r.objectId)).toEqual(['a', 'b', 'c']);
  });
});

describe('POST /tuples/batch — all-or-nothing pre-validation', () => {
  it('a malformed expiresAt anywhere in the batch rejects the whole request before any write runs', async () => {
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockRejectedValue(new Error('writeTuple must not be called once expiresAt fails to parse'));

    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: {
        tuples: [tupleItem(), tupleItem({ objectId: 'other', expiresAt: 'not-a-real-date' })],
      },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(400);
    const body = await parseBody(res);
    expect(body.error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('an out-of-scope namespace anywhere in the batch rejects the whole request with 403, before any write runs', async () => {
    poolQuery.mockImplementation(async (text: unknown) => {
      if (typeof text === 'string' && text.includes('from api_keys')) {
        return { rows: [{ id: '1', role: 'admin', scopes: ['document'] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockRejectedValue(new Error('writeTuple must not be called once the batch is out of scope'));

    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: {
        tuples: [
          tupleItem({ objectNs: 'document' }), // in scope
          tupleItem({ objectNs: 'folder' }), // out of scope — sinks the whole batch
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
});

describe('POST /tuples/batch — one item’s failure never sinks another item’s write', () => {
  it('a batch with one invalid tuple still writes every other tuple, and reports the failure per-item', async () => {
    vi.spyOn(tuplesModule, 'writeTuple').mockImplementation(async (_pool, tuple) => {
      if (tuple.objectId === 'bad') {
        return {
          ok: false,
          errors: [{ code: 'undeclared_relation', message: "relation 'viewer' is not declared" }],
        };
      }
      return okResult(1);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tuples/batch',
      payload: {
        tuples: [
          tupleItem({ objectId: 'good1' }),
          tupleItem({ objectId: 'bad' }),
          tupleItem({ objectId: 'good2' }),
        ],
      },
      headers: authHeaders(ADMIN_KEY),
    });

    // Always 200 at the batch level — see tupleBatchResponse's own doc comment.
    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body.results).toHaveLength(3);
    expect(body.results[0]).toMatchObject({ objectId: 'good1', created: true });
    expect(body.results[1].error.code).toBe('tuple_validation_failed');
    expect(body.results[2]).toMatchObject({ objectId: 'good2', created: true });
  });
});
