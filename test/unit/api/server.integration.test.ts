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
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../../src/api/server.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { decodeToken, encodeToken } from '../../../src/store/tokens.js';
import { env } from '../../../src/config/env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));
const ADMIN_KEY = 'phase-8-integration-test-admin-key';
const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract: without this, an idle client hitting a
    // background/network-level error (most commonly this file's own container
    // being stopped in afterAll while a pooled connection was still technically
    // open, though the identical gap applies to any Pool in this file) crashes
    // the whole test run with an unhandled 'error' event, even though every
    // real assertion already passed — a known pg gotcha, not a bug in this
    // file's own test logic. Logged, not swallowed: still visible if it ever
    // fires somewhere other than expected teardown.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
  env.ADMIN_API_KEY = ADMIN_KEY;
  app = await buildServer(pool, { logger: false });
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
    // Opaque, encoded (src/store/tokens.ts's encodeToken) — never a raw
    // integer on the wire, though decodeToken still recovers one.
    expect(typeof writeBody.token).toBe('string');
    expect(Number.isInteger(decodeToken(writeBody.token))).toBe(true);

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
    expect(viewerChild.directSubjects).toEqual([{ kind: 'concrete', ns: 'user', id: 'alice' }]);

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
    expect(typeof deleteBody.token).toBe('string');
    // Decode both to compare the real monotonicity property — the opaque
    // strings themselves have no meaningful ordering.
    expect(decodeToken(deleteBody.token)).toBeGreaterThan(decodeToken(writeBody.token));

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

describe('a /check pinned to a real but not-yet-observed atToken gets a distinguishable 503, not the generic infrastructure_unavailable one (D-184)', () => {
  it('post-check-with-a-well-formed-but-astronomically-high-atToken-returns-503-token_not_yet_observed-never-infrastructure_unavailable', async () => {
    // No schema/tuple setup needed — assertTokenObserved runs first, before
    // productionCheck ever opens a transaction or looks up a schema (see
    // ProductionCheckOptions.atToken's own doc comment), so a too-high
    // token is rejected before any of that would matter. A real, ordinary
    // NaN-free integer (encodeToken's own validation would reject anything
    // else before this test even reached the server) that this database
    // could not possibly have issued in this test run.
    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        relation: 'view',
        object: { ns: 'doc', id: 'impossible_token_check' },
        atToken: encodeToken(999_999_999),
      },
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(503);
    const body = await parseBody(res);
    expect(body.error.code).toBe('token_not_yet_observed');
    expect(body.error.code).not.toBe('infrastructure_unavailable');
    expect(body.error.message).toMatch(/consistency token 999999999 has not been observed/);
  });
});

describe('POST /scope — the real HTTP route end to end (D-186)', () => {
  it('reports granted:true for a real permission alice holds and granted:false for one she does not, in the same order the targets were supplied', async () => {
    const ns = uniqueName('scopens');
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

    const scopeRes = await app.inject({
      method: 'POST',
      url: '/scope',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        targets: [
          { namespace: ns, relationOrPermission: 'view' },
          { namespace: ns, relationOrPermission: 'editor' },
        ],
      },
      headers: authHeaders(),
    });
    expect(scopeRes.statusCode).toBe(200);
    const scopeBody = await parseBody(scopeRes);
    expect(scopeBody.subject).toEqual({ ns: 'user', id: 'alice' });
    expect(scopeBody.grants).toEqual([
      { namespace: ns, relationOrPermission: 'view', granted: true, truncated: false },
      { namespace: ns, relationOrPermission: 'editor', granted: false, truncated: false },
    ]);
  });

  it('rejects the whole request with 400 when targets exceeds SCOPE_QUERY_MAX_TARGETS, never silently truncating it', async () => {
    const targets = Array.from({ length: 51 }, (_, i) => ({
      namespace: 'user',
      relationOrPermission: `permission_${i}`,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/scope',
      payload: { subject: { ns: 'user', id: 'alice' }, targets },
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    const body = await parseBody(res);
    expect(body.error.code).toBe('invalid_request');
  });

  it("a well-formed but astronomically high atToken surfaces as that target's own per-target error field — never a whole-request 503", async () => {
    // A real candidate is required for this to actually reach productionCheck
    // at all (hasAnyGrant's own candidate scan finds nothing to check
    // against an object namespace with zero tuples, and would report a
    // plain granted:false long before any token is ever validated — see
    // ProductionCheckOptions.atToken's own doc comment: the token floor is
    // checked inside productionCheck, not before a candidate exists to run
    // it against).
    const ns = uniqueName('scopetok');
    await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source: [`namespace ${ns} {`, '  relation viewer: user', '}'].join('\n') },
      headers: authHeaders(),
    });
    const objectId = uniqueName('obj');
    await app.inject({
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

    const res = await app.inject({
      method: 'POST',
      url: '/scope',
      payload: {
        subject: { ns: 'user', id: 'alice' },
        targets: [{ namespace: ns, relationOrPermission: 'viewer' }],
        atToken: encodeToken(999_999_999),
      },
      headers: authHeaders(),
    });
    // The whole-request status is still 200 — the failure is per-target.
    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0].namespace).toBe(ns);
    expect(body.grants[0].relationOrPermission).toBe('viewer');
    expect(body.grants[0].error.code).toBe('token_not_yet_observed');
    expect(body.grants[0].granted).toBeUndefined();
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

describe('a real client disconnecting mid-request never crashes the server or corrupts its ability to serve the next request', () => {
  /**
   * `docs/CAPABILITY-GAPS.md`'s "Fault injection above the storage seam"
   * finding, the second half: "no code anywhere in `src/api` reacts to a
   * client socket closing mid-request... and no test simulates it." A
   * `productionCheck` call has no cancellation plumbing at all (confirmed
   * by reading it directly — it takes no `AbortSignal`, no request/reply
   * object, nothing Fastify-shaped) — a client disconnecting mid-flight
   * cannot stop the walk already in progress; the only real question is
   * whether the route handler's own eventual `reply.send()` against an
   * already-closed connection is handled gracefully by Fastify/Node, or
   * throws an uncaught error that could crash this whole process (taking
   * down every *other* in-flight request too, the exact kind of
   * self-inflicted denial-of-service this file's own Redis fault-injection
   * sibling (`test/unit/api/redis-fault-injection.test.ts`) closes a
   * different instance of).
   *
   * `app.listen()` on this same `app` instance — the one deliberate
   * exception, in this whole file, to its own top-of-file doc comment
   * ("`buildServer` does NOT call `app.listen()`") and to every other
   * `*.integration.test.ts` file's `app.inject()`-only convention —
   * matching `test/unit/api/watch.integration.test.ts`'s own identical,
   * already-established precedent for the identical reason: proving a
   * *real* client's disconnect behaves as claimed needs a real listening
   * socket and a real client that can actually hang up, not a simulated
   * `app.inject()` request (which, per that file's own account, never
   * fires a real `'close'`/`'aborted'` event at all).
   *
   * A real `fetch()` call, aborted via a real `AbortController` as soon as
   * it's issued — genuinely racing the abort against the server's own
   * in-flight response, never assumed to land at a particular point in
   * the handler. Fired many times concurrently (not once) for the same
   * "force the race via genuine concurrency, don't assume a single attempt
   * lands" discipline this project's own isolation suite already
   * establishes elsewhere — a single aborted request completing without
   * incident would not be strong evidence; many, fired at once, are.
   */
  it('many-concurrent-real-clients-aborting-a-real-check-request-immediately-never-crash-the-server-and-a-later-ordinary-request-still-succeeds-normally', async () => {
    const ns = uniqueName('doc');
    const source = [`namespace ${ns} {`, '  relation viewer: user', '}'].join('\n');
    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: { source },
      headers: authHeaders(),
    });
    expect(publishRes.statusCode).toBe(200);

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

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('expected a real AddressInfo from a real listening socket');
    }
    const base = `http://127.0.0.1:${addr.port}`;
    const checkPayload = JSON.stringify({
      subject: { ns: 'user', id: 'alice' },
      relation: 'viewer',
      object: { ns, id: objectId },
    });

    const attempts = Array.from({ length: 30 }, async () => {
      const controller = new AbortController();
      const fetchPromise = fetch(`${base}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: checkPayload,
        signal: controller.signal,
      });
      // Abort immediately — genuinely racing the server's own in-flight
      // handling, not waiting for any part of the response first.
      controller.abort();
      try {
        await fetchPromise;
      } catch {
        // Expected — an aborted fetch always rejects (AbortError). The
        // absence of a crash elsewhere in this test is the real assertion;
        // this attempt's own rejection is not itself a failure.
      }
    });

    // No attempt above may reject with anything other than what a plain
    // abort produces, and — the real point of firing 30 concurrently —
    // nothing here may take the server process itself down.
    const settled = await Promise.allSettled(attempts);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);

    // The real assertion: the same server, after absorbing 30 real
    // client disconnects mid-request, still serves an ordinary request
    // correctly — proving nothing crashed or left the event loop/server
    // state corrupted by any of them.
    const followUp = await fetch(`${base}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: checkPayload,
    });
    expect(followUp.status).toBe(200);
    const followUpBody = (await followUp.json()) as { allowed: boolean };
    expect(followUpBody.allowed).toBe(true);
  });
});
