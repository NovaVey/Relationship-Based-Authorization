/**
 * The check-result cache's end-to-end wiring in `src/api/server.ts` (closes
 * `docs/DECISIONS.md` D-028) — proven through real HTTP routes, DB-free.
 *
 * `src/resolve/production/cache.ts` (`CheckCache`/`createCheckCache`) and its
 * wiring into `src/audit/checks.ts`'s `performCheck` already have thorough
 * DB-free unit coverage (`test/unit/resolve/production/cache.test.ts`, the
 * epoch-fence race; `test/unit/audit/checks.test.ts`, the audit-insert-
 * before-cache-set ordering) — nothing here re-derives either. What's
 * genuinely new: `src/api/server.ts` itself now constructs one `CheckCache`
 * per `buildServer` call (`createCheckCache(CHECK_CACHE_MAX_ENTRIES,
 * env.CHECK_CACHE_TTL_MS)`), threads it into `POST /check`'s own
 * `performCheck` call, and calls `checkCache?.clear()` on a *successful*
 * `POST /tuples`, `DELETE /tuples`, and `POST /schema/publish` — this file
 * proves that wiring is real and reachable through the actual routes, not
 * merely present in the source.
 *
 * **Why `productionModule.productionCheck` is mocked, not
 * `checksModule.performCheck`.** Mocking `performCheck` itself would mean
 * this file proves nothing about the cache at all — `performCheck` IS where
 * the cache logic lives. Mocking `productionCheck` (the one genuinely
 * expensive call `performCheck` wraps) lets the real `performCheck`, and
 * therefore the real `CheckCache`, run for real on every `/check` request;
 * only the graph walk itself is stubbed out.
 *
 * **Why `tuplesModule.writeTuple`/`deleteTuple` and
 * `publishModule.publishSchema` are mocked too, rather than routing real SQL
 * through a fake `pool.query`.** This file's own scope is "does `/check`'s
 * cache get cleared when a mutation route succeeds", not "do writeTuple/
 * deleteTuple/publishSchema themselves work" (already covered elsewhere,
 * DB-free via their own unit suites and via real Postgres integration tests)
 * — mocking them here isolates exactly the one wiring path this file cares
 * about, matching this project's own established `server.test.ts` precedent
 * of mocking every domain function via `vi.spyOn` on its own module
 * namespace. The fake `pool.query` therefore only ever needs to answer
 * `performCheck`'s own `insert into checks` statement — anything else
 * reaching it is a signal this file's own isolation assumption broke, so it
 * throws rather than silently returning something plausible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

import * as productionModule from '../../../src/resolve/production/resolver.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import * as publishModule from '../../../src/schema/publish.js';

import type { ProductionCheckResult } from '../../../src/resolve/production/resolver.js';
import type { WriteTupleResult, DeleteTupleResult, TupleError } from '../../../src/store/tuples.js';
import type { PublishResult } from '../../../src/schema/publish.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ORIGINAL_CHECK_CACHE_TTL_MS = env.CHECK_CACHE_TTL_MS;
const ADMIN_KEY = 'check-cache-wiring-test-admin-key';

const ALICE = { ns: 'user', id: 'alice' };
const README = { ns: 'document', id: 'readme' };

const ALLOWED: ProductionCheckResult = {
  allowed: true,
  path: { kind: 'directGrant', object: README, relation: 'view', subject: ALICE },
  depth: 1,
  touchedExpiringTuple: false,
};

const validCheckBody = { subject: ALICE, relation: 'view', object: README };
const validTupleBody = {
  objectNs: 'document',
  objectId: 'readme',
  relation: 'viewer',
  subjectNs: 'user',
  subjectId: 'alice',
};
const validSchemaSourceBody = {
  source: [
    'namespace document {',
    '  relation viewer: user',
    '',
    '  permission view = viewer',
    '}',
  ].join('\n'),
};

/** The one query shape performCheck's own audit insert issues — anything else reaching this pool is a sign of a broken isolation assumption in this file. */
// insertCheckRow (src/audit/checks.ts, the hash-chained audit log) now opens
// its own connection and transaction — BEGIN, the chain lock, a tip-read
// SELECT, the INSERT, COMMIT — rather than one bare pool.query call. This
// fake models that exact sequence on the connected client; pool.query itself
// is never called by insertCheckRow any more, so it throws if reached at all.
function fakeClient(): { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async (sql: unknown) => {
      if (typeof sql !== 'string') {
        throw new Error(
          `check-cache-wiring test's fake client got a non-string query: ${String(sql)}`,
        );
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('select row_hash from checks')) {
        // Empty chain tip — insertCheckRow falls back to its own genesis
        // constant, exactly like a fresh table. This file's own scope is
        // cache wiring, not the hash chain itself (see checks-hash-chain.test.ts).
        return { rows: [] };
      }
      if (sql.includes('insert into checks')) {
        return { rows: [] };
      }
      throw new Error(
        `check-cache-wiring test's fake client got an unexpected query: ${String(sql)}`,
      );
    }),
    release: vi.fn(),
  };
}

function fakePool(): Pool {
  return {
    connect: vi.fn(async () => fakeClient()),
    query: vi.fn(async (sql: unknown) => {
      throw new Error(
        `check-cache-wiring test's fake pool got an unexpected direct query (insertCheckRow ` +
          `should only ever use pool.connect() now): ${String(sql)}`,
      );
    }),
  } as unknown as Pool;
}

async function buildApp(): Promise<FastifyInstance> {
  return buildServer(fakePool(), { logger: false });
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

afterEach(() => {
  vi.restoreAllMocks();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
  env.CHECK_CACHE_TTL_MS = ORIGINAL_CHECK_CACHE_TTL_MS;
});

describe('with CHECK_CACHE_TTL_MS enabled, two identical POST /check requests hit the cache — productionCheck runs only once', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    env.CHECK_CACHE_TTL_MS = 60_000;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('two-identical-check-requests-call-productioncheck-exactly-once-the-second-is-a-cache-hit', async () => {
    const spy = vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);

    const first = await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((await parseBody(first)).allowed).toBe(true);
    expect((await parseBody(second)).allowed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('a successful mutation route clears the check cache — the next /check is a fresh miss again', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    env.CHECK_CACHE_TTL_MS = 60_000;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('a-successful-post-tuples-between-two-check-requests-clears-the-cache-so-productioncheck-runs-again', async () => {
    const checkSpy = vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);
    const writeResult: WriteTupleResult = { ok: true, token: 1, created: true };
    vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue(writeResult);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(1);

    const writeRes = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(writeRes.statusCode).toBe(200);
    expect((await parseBody(writeRes)).created).toBe(true);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(2);
  });

  it('a-successful-delete-tuples-between-two-check-requests-clears-the-cache-so-productioncheck-runs-again', async () => {
    const checkSpy = vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);
    const deleteResult: DeleteTupleResult = { ok: true, token: 2, deleted: true };
    vi.spyOn(tuplesModule, 'deleteTuple').mockResolvedValue(deleteResult);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(1);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(deleteRes.statusCode).toBe(200);
    expect((await parseBody(deleteRes)).deleted).toBe(true);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(2);
  });

  it('a-successful-schema-publish-between-two-check-requests-clears-the-cache-so-productioncheck-runs-again', async () => {
    const checkSpy = vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);
    const publishResult: PublishResult = {
      ok: true,
      published: [{ namespace: 'document', version: 2 }],
    };
    vi.spyOn(publishModule, 'publishSchema').mockResolvedValue(publishResult);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(1);

    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: validSchemaSourceBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(publishRes.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(2);
  });
});

describe('a mutation route that fails validation never clears the cache — the if (result.ok) guard is real, not unconditional', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    env.CHECK_CACHE_TTL_MS = 60_000;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('a-post-tuples-that-fails-domain-validation-ok-false-between-two-check-requests-does-not-clear-the-cache-productioncheck-still-runs-only-once', async () => {
    const checkSpy = vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);
    const validationFailure: WriteTupleResult = {
      ok: false,
      errors: [
        { code: 'no_published_schema', message: 'namespace not published' } satisfies TupleError,
      ],
    };
    vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue(validationFailure);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(checkSpy).toHaveBeenCalledTimes(1);

    const writeRes = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(ADMIN_KEY),
    });
    // Still a normal 400 (tuple_validation_failed) — writeTuple's own
    // ok:false branch, nothing thrown.
    expect(writeRes.statusCode).toBe(400);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    // If the cache had been cleared, this would be a second call — it must
    // still be exactly one: the failed write never touched checkCache.clear().
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('with CHECK_CACHE_TTL_MS at its default (0, disabled), two identical /check requests both call productionCheck — regression guard for the default-off behavior', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    env.CHECK_CACHE_TTL_MS = 0;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('two-identical-check-requests-both-call-productioncheck-when-the-cache-is-disabled-by-default', async () => {
    const spy = vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);

    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });
    await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
