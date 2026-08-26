/**
 * The real, mintable, DB-backed API-key credential tier
 * (`src/api/db-api-keys.ts`, `src/api/auth.ts`'s `checkAdminAuthDb`/
 * `checkReadAuthDb`, migration `0008_api_keys.sql`) proven end to end
 * against a real, ephemeral Postgres via the real Fastify HTTP surface
 * (`app.inject`, no listening socket — matches `src/api/server.ts`'s own
 * doc comment). No mocks anywhere in this file — `test/unit/api/
 * db-api-keys.test.ts`/`test/unit/api/auth-db.test.ts` already cover the
 * pure logic and the mocked-pool wiring; this file exists specifically to
 * prove the full real story a mock can't: a real row in a real `api_keys`
 * table, hashed and looked up for real, actually gating a real route.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030 (every `*.integration.test.ts` file
 * starts its own container; never a hardcoded local connection string).
 *
 * The one real story this file proves:
 *  1. A scoped, non-expiring `admin`-role key restricted to one namespace
 *     can `/check` and write against that namespace, but gets a real 403
 *     against a different one.
 *  2. A key with `expires_at` in the past — inserted directly via SQL,
 *     since `createApiKey` itself rejects an already-past expiry at
 *     creation time (`src/api/db-api-keys.ts`'s own doc comment) — is
 *     rejected outright.
 *  3. A previously-valid key is immediately rejected the instant
 *     `revokeApiKey` revokes it — no caching, no delay.
 *  4. The static `ADMIN_API_KEY` env var keeps working completely
 *     unaffected by any of the above — the real regression guard this
 *     whole feature's "zero behavior change for a deployment that never
 *     uses it" claim rests on.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../../src/api/server.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { createApiKey, revokeApiKey, hashApiKey } from '../../../src/api/db-api-keys.js';
import { env } from '../../../src/config/env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));
const STATIC_ADMIN_KEY = 'db-api-keys-integration-test-static-admin-key';
const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // See test/unit/api/server.integration.test.ts's identical comment —
    // a known pg gotcha during container teardown, not a bug in this
    // file's own test logic.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
  env.ADMIN_API_KEY = STATIC_ADMIN_KEY;
  app = await buildServer(pool, { logger: false });

  // Two real namespaces — "namespace A" and "namespace B" — published once,
  // shared by every test in this file. A scoped key restricted to one must
  // reach the other's routes with a real, live 403, not merely "no schema
  // published for it."
  const source = [
    'namespace nsa {',
    '  relation viewer: user',
    '',
    '  permission view = viewer',
    '}',
    '',
    'namespace nsb {',
    '  relation viewer: user',
    '',
    '  permission view = viewer',
    '}',
  ].join('\n');
  const publishRes = await app.inject({
    method: 'POST',
    url: '/schema/publish',
    payload: { source },
    headers: { authorization: `Bearer ${STATIC_ADMIN_KEY}` },
  });
  expect(publishRes.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
});

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

describe('a scoped, non-expiring admin key restricted to one namespace works against it and is rejected against another', () => {
  it('the-key-can-check-and-write-against-its-own-namespace-but-gets-403-against-the-other-real-namespace', async () => {
    const { rawKey } = await createApiKey(pool, {
      name: 'scoped-admin-key-nsa-only',
      role: 'admin',
      scopes: ['nsa'],
    });

    // /check against the IN-scope namespace succeeds (200 — a real,
    // authenticated, successfully-answered question, whether the answer
    // itself is allowed or denied).
    const checkInScope = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc1' },
      },
      headers: authHeaders(rawKey),
    });
    expect(checkInScope.statusCode).toBe(200);

    // Write against the IN-scope namespace succeeds for real, against real
    // Postgres.
    const writeInScope = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: 'nsa',
        objectId: 'doc1',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      headers: authHeaders(rawKey),
    });
    expect(writeInScope.statusCode).toBe(200);

    // Confirm the write actually happened and the permission now resolves
    // ALLOWED — this scoped key granted a real, live permission, not just
    // a 200 status.
    const recheckInScope = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc1' },
      },
      headers: authHeaders(rawKey),
    });
    expect((await parseBody(recheckInScope)).allowed).toBe(true);

    // /check against the OUT-OF-scope namespace is a real, live 403 —
    // never a 200 { allowed: false }, which would mean the engine ran the
    // check at all; scope enforcement must reject BEFORE that.
    const checkOutOfScope = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsb', id: 'doc1' },
      },
      headers: authHeaders(rawKey),
    });
    expect(checkOutOfScope.statusCode).toBe(403);
    expect((await parseBody(checkOutOfScope)).error.code).toBe('forbidden');

    // A write against the OUT-OF-scope namespace is rejected the same way,
    // and — the actual security property that matters — nothing was
    // written to real Postgres.
    const writeOutOfScope = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: 'nsb',
        objectId: 'doc1',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      headers: authHeaders(rawKey),
    });
    expect(writeOutOfScope.statusCode).toBe(403);

    const { rows } = await pool.query(
      `select 1 from relation_tuples where object_ns = 'nsb' and object_id = 'doc1'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('an already-expired key is rejected outright', () => {
  it('a-key-whose-expires_at-is-in-the-past-inserted-directly-via-sql-since-createApiKey-itself-refuses-an-already-past-expiry-is-rejected', async () => {
    // createApiKey itself throws for a non-future expiresAt (src/api/
    // db-api-keys.ts's own doc comment) — this is the deliberately
    // untestable-through-the-normal-API case the task calls out
    // explicitly, so the row is inserted directly, bypassing that guard,
    // to prove validateDbApiKey's own WHERE-clause enforcement rather than
    // createApiKey's creation-time guard.
    const rawKey = 'directly-inserted-already-expired-key';
    const keyHash = hashApiKey(rawKey);
    await pool.query(
      `insert into api_keys (name, key_hash, role, expires_at)
       values ($1, $2, 'admin', now() - interval '1 hour')`,
      ['already-expired-key', keyHash],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc1' },
      },
      headers: authHeaders(rawKey),
    });
    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
  });
});

describe('revoking a valid key rejects it immediately, on the very next request', () => {
  it('a-key-that-worked-a-moment-ago-is-rejected-the-instant-after-revokeApiKey-runs', async () => {
    const { id, rawKey } = await createApiKey(pool, {
      name: 'will-be-revoked',
      role: 'admin',
    });

    const before = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc1' },
      },
      headers: authHeaders(rawKey),
    });
    expect(before.statusCode).toBe(200);

    const revoked = await revokeApiKey(pool, id);
    expect(revoked).toBe(true);

    const after = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc1' },
      },
      headers: authHeaders(rawKey),
    });
    expect(after.statusCode).toBe(401);
    expect((await parseBody(after)).error.code).toBe('unauthorized');

    // Revoking the same key a second time is a real no-op, not a second
    // (later, wrong) revocation timestamp.
    expect(await revokeApiKey(pool, id)).toBe(false);
  });
});

describe('the static ADMIN_API_KEY env var keeps working completely unaffected — a real regression guard', () => {
  it('the-static-admin-key-still-authorizes-check-and-write-against-both-namespaces-unscoped-exactly-as-before-this-feature-existed', async () => {
    const checkA = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'zzz_regression_guard' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc_regression' },
      },
      headers: authHeaders(STATIC_ADMIN_KEY),
    });
    expect(checkA.statusCode).toBe(200);

    const checkB = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'zzz_regression_guard' },
        relation: 'view',
        object: { ns: 'nsb', id: 'doc_regression' },
      },
      headers: authHeaders(STATIC_ADMIN_KEY),
    });
    expect(checkB.statusCode).toBe(200);

    const writeB = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: 'nsb',
        objectId: 'doc_regression',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'zzz_regression_guard',
      },
      headers: authHeaders(STATIC_ADMIN_KEY),
    });
    expect(writeB.statusCode).toBe(200);
  });

  it('a-wrong-key-still-gets-a-plain-401-exactly-as-before-this-feature-existed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'nsa', id: 'doc1' },
      },
      headers: authHeaders('some-key-that-has-never-been-minted-anywhere'),
    });
    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
  });
});
