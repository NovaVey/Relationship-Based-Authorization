/**
 * `buildServer` (`src/api/server.ts`) against a real, ephemeral Postgres —
 * no mocks anywhere in this file. This is the genuinely end-to-end proof of
 * build spec `.claude/commands/build-authz-service.md` §9 Phase 8's exit
 * criterion's two literal clauses this test-author brief calls out:
 * "`/health` reports green" and "an unauthenticated write attempt is
 * rejected" — both proved here against a real database, not a mocked
 * `pool.query`, closing the gap `test/unit/api/server.test.ts`'s own
 * top-of-file doc comment explicitly leaves open (route-wiring proof there,
 * real end-to-end proof here).
 *
 * Also exercises the full `publish -> write -> check -> expand -> delete ->
 * re-check` cycle through the real HTTP surface (`app.inject`, no listening
 * socket — matches `src/api/server.ts`'s own doc comment: "`buildServer`
 * does NOT call `app.listen()`") to confirm the API surface is a genuine,
 * correct second entry point into the same domain functions the CLI already
 * calls, not a parallel reimplementation of any of it. Field spot-checks
 * only on `check`/`expand` responses (a `directGrant`/`union` shape,
 * `subject`/`object` identity) — full resolution-path correctness is
 * already exhaustively proven elsewhere (`test/unit/resolve/production/
 * production-resolution-path.integration.test.ts`,
 * `test/unit/audit/expand.integration.test.ts`); re-deriving that here
 * would test the same claim twice without adding evidence about what this
 * file actually exists to check — that the HTTP layer around those
 * functions is wired correctly.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030 (every `*.integration.test.ts` file
 * starts its own container; never a hardcoded local connection string).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../../src/api/server.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';

const MIGRATIONS_DIR = new URL('../../../src/store/migrations', import.meta.url).pathname;
const ADMIN_KEY = 'phase-8-integration-test-admin-key';
const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, MIGRATIONS_DIR);
  env.ADMIN_API_KEY = ADMIN_KEY;
  app = await buildServer(pool);
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

function authHeaders(): { authorization: string } {
  return { authorization: `Bearer ${ADMIN_KEY}` };
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

describe('an unauthenticated write attempt is rejected — real server, real Postgres, no mocks', () => {
  it('an-unauthenticated-post-tuples-attempt-against-a-real-server-is-rejected-and-writes-nothing-to-real-postgres', async () => {
    const ns = uniqueName('doc');
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '',
      '  permission view = viewer',
      '}',
    ].join('\n');
    // A real, valid namespace exists — if auth were somehow bypassed, this
    // write would actually succeed against real Postgres, not fail for an
    // unrelated reason (no published schema) that would mask an auth bug.
    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source },
      headers: authHeaders(),
    });
    expect(publishRes.statusCode).toBe(200);

    const objectId = uniqueName('obj');
    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      // deliberately no Authorization header
    });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(401);
    expect(body.error.code).toBe('unauthorized');

    const { rows } = await pool.query(
      `select 1 from relation_tuples where object_ns = $1 and object_id = $2`,
      [ns, objectId],
    );
    expect(rows).toHaveLength(0);
  });

  it('a-wrong-admin-key-on-a-real-server-is-also-rejected-and-writes-nothing-to-real-postgres', async () => {
    const ns = uniqueName('doc');
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '',
      '  permission view = viewer',
      '}',
    ].join('\n');
    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source },
      headers: authHeaders(),
    });
    expect(publishRes.statusCode).toBe(200);

    const objectId = uniqueName('obj');
    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      headers: { authorization: 'Bearer definitely-the-wrong-key' },
    });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(401);
    expect(body.error.code).toBe('unauthorized');

    const { rows } = await pool.query(
      `select 1 from relation_tuples where object_ns = $1 and object_id = $2`,
      [ns, objectId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the full publish -> write -> check -> expand -> delete -> re-check cycle round-trips through the real HTTP API', () => {
  it('a-real-grant-written-through-post-tuples-is-visible-to-post-check-and-post-expand-and-disappears-after-delete-tuples', async () => {
    const ns = uniqueName('doc');
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '  relation editor: user',
      '',
      '  permission view = viewer | editor',
      '}',
    ].join('\n');

    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source },
      headers: authHeaders(),
    });
    expect(publishRes.statusCode).toBe(200);
    expect((await parseBody(publishRes)).published).toEqual([{ namespace: ns, version: 1 }]);

    const objectId = uniqueName('obj');
    const writeRes = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      headers: authHeaders(),
    });
    expect(writeRes.statusCode).toBe(200);
    const writeBody = await parseBody(writeRes);
    expect(writeBody.created).toBe(true);
    expect(typeof writeBody.token).toBe('number');

    // check — pinned to the write's own token (§6.3: a check pinned to a
    // token observes that write).
    const checkRes = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns, id: objectId },
        atToken: writeBody.token,
      },
      headers: authHeaders(),
    });
    expect(checkRes.statusCode).toBe(200);
    const checkBody = await parseBody(checkRes);
    expect(checkBody.allowed).toBe(true);
    expect(checkBody.subject).toEqual({ ns: 'user', id: 'alice' });
    expect(checkBody.object).toEqual({ ns, id: objectId });
    expect(checkBody.atToken).toBe(writeBody.token);
    expect(checkBody.path).toBeDefined();
    expect(checkBody.path.kind).toBe('union');
    expect(checkBody.path.branch.kind).toBe('directGrant');
    expect(checkBody.path.branch.relation).toBe('viewer');
    expect(checkBody.path.branch.subject).toEqual({ ns: 'user', id: 'alice' });

    // expand — the viewer branch must surface alice as a direct subject.
    const expandRes = await app.inject({
      method: 'POST',
      url: '/expand',
      payload: { object: { ns, id: objectId }, relation: 'view' },
      headers: authHeaders(),
    });
    expect(expandRes.statusCode).toBe(200);
    const expandBody = await parseBody(expandRes);
    expect(expandBody.tree.kind).toBe('union');
    const viewerChild = (expandBody.tree.children as any[]).find(
      (c) => c.kind === 'relation' && c.relation === 'viewer',
    );
    expect(viewerChild).toBeDefined();
    expect(viewerChild.directSubjects).toEqual([{ ns: 'user', id: 'alice' }]);

    // delete — revocation must be immediately effective on the next check.
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/tuples',
      payload: {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      headers: authHeaders(),
    });
    expect(deleteRes.statusCode).toBe(200);
    const deleteBody = await parseBody(deleteRes);
    expect(deleteBody.deleted).toBe(true);
    expect(typeof deleteBody.token).toBe('number');
    expect(deleteBody.token).toBeGreaterThan(writeBody.token);

    const recheckRes = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns, id: objectId },
        atToken: deleteBody.token,
      },
      headers: authHeaders(),
    });
    expect(recheckRes.statusCode).toBe(200);
    const recheckBody = await parseBody(recheckRes);
    expect(recheckBody.allowed).toBe(false);
    expect(recheckBody.path).toBeUndefined();
  });
});

describe('/health reports green against a real, reachable Postgres and reflects the real published namespace state', () => {
  it('health-returns-200-status-ok-database-reachable-true-and-includes-the-namespace-just-published-at-its-real-version', async () => {
    const ns = uniqueName('healthns');
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '',
      '  permission view = viewer',
      '}',
    ].join('\n');

    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source },
      headers: authHeaders(),
    });
    expect(publishRes.statusCode).toBe(200);

    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    const healthBody = await parseBody(healthRes);

    expect(healthRes.statusCode).toBe(200);
    expect(healthBody.status).toBe('ok');
    expect(healthBody.database).toEqual({ reachable: true });
    // `namespaces` is `HealthNamespaceListStatus` (docs/DECISIONS.md D-073),
    // not a bare array — `{ ok: true, namespaces: [...] }` here since both
    // the connectivity probe and the listing query genuinely succeeded.
    expect(healthBody.namespaces.ok).toBe(true);
    const nsEntry = (healthBody.namespaces.namespaces as any[]).find((n) => n.namespace === ns);
    expect(nsEntry).toEqual({ namespace: ns, version: 1 });

    // Publish a second version of the same namespace — /health must report
    // the LATEST version, not the first one it ever saw.
    const source2 = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '  relation editor: user',
      '',
      '  permission view = viewer | editor',
      '}',
    ].join('\n');
    const publishRes2 = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source: source2 },
      headers: authHeaders(),
    });
    expect(publishRes2.statusCode).toBe(200);
    expect((await parseBody(publishRes2)).published).toEqual([{ namespace: ns, version: 2 }]);

    const healthRes2 = await app.inject({ method: 'GET', url: '/health' });
    const healthBody2 = await parseBody(healthRes2);
    expect(healthBody2.namespaces.ok).toBe(true);
    const nsEntry2 = (healthBody2.namespaces.namespaces as any[]).find((n) => n.namespace === ns);
    expect(nsEntry2).toEqual({ namespace: ns, version: 2 });
  });
});
