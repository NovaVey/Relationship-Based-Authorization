/**
 * `buildServer` (`src/api/server.ts`) — fast, DB-free route-wiring tests for
 * build spec `.claude/commands/build-authz-service.md` §9 Phase 8: "Fastify
 * server exposing check/expand/write/schema per the CLI's own operations,
 * `ADMIN_API_KEY`-gated writes, `/health` reporting DB connectivity and the
 * current namespace config versions" and its exit criterion ("an
 * unauthenticated write attempt is rejected").
 *
 * Written from `src/api/server.ts`'s own top-of-file doc comment and the
 * exported shapes of the domain modules it wires together
 * (`performCheck`/`expand`/`writeTuple`/`deleteTuple`/`compileSchema`/
 * `publishSchema`/`listLatestNamespaceVersions`), plus `src/api/errors.ts`
 * and `src/api/responses.ts`'s own already-established contracts (status
 * codes, error shape, "present iff" rules) — not by reading `server.ts`'s
 * route bodies first.
 *
 * **Scope.** This file is deliberately *not* re-testing:
 * - Zod's own validation logic (`invalid_request` malformed-body coverage
 *   here is one representative case per route, matching this project's own
 *   "not re-testing Zod itself" scoping precedent elsewhere).
 * - `src/api/responses.ts`/`errors.ts`'s own pure response-shaping logic —
 *   no `responses.test.ts`/`errors.test.ts` exists yet in this repo (see
 *   this phase's own test-author report); that is a real, separate gap,
 *   not something this file's wiring-only tests substitute for.
 * - The domain functions themselves (`performCheck`, `expand`, `writeTuple`,
 *   `deleteTuple`, `compileSchema`, `publishSchema`,
 *   `listLatestNamespaceVersions`) — every one is mocked here via
 *   `vi.spyOn` on its own module namespace, the same established pattern
 *   `test/unit/cli/soundness-format.test.ts` already uses for
 *   `runSoundnessFuzz`. What IS this file's job: does the right domain
 *   function get called with the right auth gate in front of it, and does
 *   its result flow through to the HTTP response unmodified.
 *
 * **The mocked `pool`.** No file in this repo mocks a `pg.Pool` directly
 * yet (every other DB-touching test in this project uses a real, ephemeral
 * `PostgreSqlContainer` — see `docs/DECISIONS.md` D-019/D-030). That
 * approach is deliberately not used here: this file's whole point is
 * proving *route wiring* (which function gets called, in what order,
 * relative to the auth gate) fast and without Docker, which is exactly what
 * `test/unit/api/server.integration.test.ts` (real Postgres, no mocks)
 * exists to prove end to end instead. A plain `{ query: vi.fn() }` object
 * cast `as unknown as Pool` is therefore this file's own minimal necessary
 * fixture — `buildServer` only ever threads `pool` through to the domain
 * functions (themselves mocked out below) or to `pool.query` directly for
 * `/health`, so nothing beyond a callable `query` is ever exercised against
 * it here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

import * as checksModule from '../../../src/audit/checks.js';
import * as expandModule from '../../../src/audit/expand.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import * as compilerModule from '../../../src/schema/dsl/compiler.js';
import * as publishModule from '../../../src/schema/publish.js';

import type { PerformCheckResult } from '../../../src/audit/checks.js';
import type { ExpandNode } from '../../../src/audit/expand.js';
import type { WriteTupleResult, DeleteTupleResult } from '../../../src/store/tuples.js';
import type { SchemaCompileResult } from '../../../src/schema/dsl/errors.js';
import type { PublishResult } from '../../../src/schema/publish.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const CORRECT_KEY = 'server-test-correct-admin-key';

// Typed as an async function explicitly (not the untyped `vi.fn()`
// default) so `mockImplementation`/`mockRejectedValue` below are given an
// async-returning callback signature to match, rather than one the
// type-checker infers as `void`-returning.
let app: FastifyInstance;
let poolQuery: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

beforeEach(() => {
  poolQuery = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const pool = { query: poolQuery } as unknown as Pool;
  app = buildServer(pool);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
});

// ---------------------------------------------------------------------------
// Fixtures — structurally valid request bodies for each route.
// ---------------------------------------------------------------------------

const validCheckBody = {
  subject: { ns: 'user', id: 'alice' },
  relation: 'view',
  object: { ns: 'document', id: 'readme' },
};

const validExpandBody = {
  object: { ns: 'document', id: 'readme' },
  relation: 'view',
};

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

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

// ---------------------------------------------------------------------------
// 1. Malformed body -> 400 invalid_request — one case per route.
// ---------------------------------------------------------------------------

describe('a structurally malformed request body is rejected with 400 invalid_request, per route', () => {
  it('a-structurally-malformed-check-body-is-rejected-with-400-invalid-request', async () => {
    const res = await app.inject({ method: 'POST', url: '/check', payload: {} });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });

  it('a-structurally-malformed-expand-body-is-rejected-with-400-invalid-request', async () => {
    const res = await app.inject({ method: 'POST', url: '/expand', payload: {} });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });

  it('a-structurally-malformed-tuple-write-body-is-rejected-with-400-invalid-request', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: {},
      headers: authHeaders(CORRECT_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });

  it('a-structurally-malformed-tuple-delete-body-is-rejected-with-400-invalid-request', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const res = await app.inject({
      method: 'DELETE',
      url: '/tuples',
      payload: {},
      headers: authHeaders(CORRECT_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });

  it('a-structurally-malformed-schema-compile-body-is-rejected-with-400-invalid-request', async () => {
    const res = await app.inject({ method: 'POST', url: '/schema/compile', payload: {} });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });

  it('a-structurally-malformed-schema-publish-body-is-rejected-with-400-invalid-request', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const res = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: {},
      headers: authHeaders(CORRECT_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });
});

// ---------------------------------------------------------------------------
// 2. The core exit-criterion claim: the auth gate short-circuits BEFORE the
//    domain call, not just before the response.
// ---------------------------------------------------------------------------

describe('with ADMIN_API_KEY unset, every gated write route rejects with 401 and never calls its domain function', () => {
  it('with-admin-api-key-unset-post-tuples-returns-401-and-writetuple-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockRejectedValue(new Error('writeTuple must not be called when ADMIN_API_KEY is unset'));

    const res = await app.inject({ method: 'POST', url: '/tuples', payload: validTupleBody });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('with-admin-api-key-unset-delete-tuples-returns-401-and-deletetuple-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    const spy = vi
      .spyOn(tuplesModule, 'deleteTuple')
      .mockRejectedValue(new Error('deleteTuple must not be called when ADMIN_API_KEY is unset'));

    const res = await app.inject({ method: 'DELETE', url: '/tuples', payload: validTupleBody });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('with-admin-api-key-unset-post-schema-publish-returns-401-and-publishschema-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    const spy = vi
      .spyOn(publishModule, 'publishSchema')
      .mockRejectedValue(new Error('publishSchema must not be called when ADMIN_API_KEY is unset'));

    const res = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: validSchemaSourceBody,
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('with ADMIN_API_KEY set, a wrong bearer key rejects with 401 and never calls the domain function', () => {
  it('a-wrong-bearer-key-on-post-tuples-returns-401-and-writetuple-is-never-called', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockRejectedValue(new Error('writeTuple must not be called with a wrong key'));

    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders('the-wrong-key'),
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-wrong-bearer-key-on-delete-tuples-returns-401-and-deletetuple-is-never-called', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi
      .spyOn(tuplesModule, 'deleteTuple')
      .mockRejectedValue(new Error('deleteTuple must not be called with a wrong key'));

    const res = await app.inject({
      method: 'DELETE',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders('the-wrong-key'),
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-wrong-bearer-key-on-post-schema-publish-returns-401-and-publishschema-is-never-called', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi
      .spyOn(publishModule, 'publishSchema')
      .mockRejectedValue(new Error('publishSchema must not be called with a wrong key'));

    const res = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: validSchemaSourceBody,
      headers: authHeaders('the-wrong-key'),
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. A correct key reaches the domain function and returns its shape
//    verbatim.
// ---------------------------------------------------------------------------

describe('with the correct admin key, each gated write route calls its domain function and returns its result verbatim', () => {
  it('a-correct-admin-key-on-post-tuples-calls-writetuple-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: WriteTupleResult = { ok: true, token: 42, created: true };
    const spy = vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(CORRECT_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(await parseBody(res)).toEqual({ token: 42, created: true });
  });

  it('a-correct-admin-key-on-delete-tuples-calls-deletetuple-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: DeleteTupleResult = { ok: true, token: 43, deleted: true };
    const spy = vi.spyOn(tuplesModule, 'deleteTuple').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'DELETE',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(CORRECT_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(await parseBody(res)).toEqual({ token: 43, deleted: true });
  });

  it('a-correct-admin-key-on-post-schema-publish-calls-publishschema-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: PublishResult = { ok: true, published: [{ namespace: 'document', version: 3 }] };
    const spy = vi.spyOn(publishModule, 'publishSchema').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: validSchemaSourceBody,
      headers: authHeaders(CORRECT_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(await parseBody(res)).toEqual({ published: [{ namespace: 'document', version: 3 }] });
  });
});

// ---------------------------------------------------------------------------
// 4. check/expand/schema-compile require no auth at all.
// ---------------------------------------------------------------------------

describe('check, expand, and schema/compile require no admin key', () => {
  it('post-check-with-no-authorization-header-reaches-performcheck-and-succeeds', async () => {
    // Deliberately configured (not unset) — proves the absence of an
    // Authorization header is fine specifically because this route is
    // unauthenticated by design, not because no key happens to be set.
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: PerformCheckResult = { allowed: false, depth: 0 };
    const spy = vi.spyOn(checksModule, 'performCheck').mockResolvedValue(canned);

    const res = await app.inject({ method: 'POST', url: '/check', payload: validCheckBody });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((await parseBody(res)).allowed).toBe(false);
  });

  it('post-expand-with-no-authorization-header-reaches-expand-and-succeeds', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: ExpandNode = {
      kind: 'relation',
      object: { ns: 'document', id: 'readme' },
      relation: 'viewer',
      directSubjects: [{ ns: 'user', id: 'alice' }],
      usersets: [],
    };
    const spy = vi.spyOn(expandModule, 'expand').mockResolvedValue(canned);

    const res = await app.inject({ method: 'POST', url: '/expand', payload: validExpandBody });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((await parseBody(res)).tree).toEqual(canned);
  });

  it('post-schema-compile-with-no-authorization-header-reaches-compileschema-and-succeeds', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: SchemaCompileResult = {
      ok: true,
      schema: {
        namespaces: {
          document: {
            namespace: 'document',
            relations: {
              viewer: { kind: 'relation', name: 'viewer', subjectTypes: [{ namespace: 'user' }] },
            },
            permissions: {
              view: {
                kind: 'permission',
                name: 'view',
                rewrite: { kind: 'computedUserset', name: 'viewer' },
              },
            },
          },
        },
      },
    };
    const spy = vi.spyOn(compilerModule, 'compileSchema').mockReturnValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/schema/compile',
      payload: validSchemaSourceBody,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((await parseBody(res)).schema).toEqual(canned.schema);
  });
});

// ---------------------------------------------------------------------------
// 5. GET /health — server.ts's own wiring of healthResponse, not
//    healthResponse's own logic (see this file's own top-of-file scope
//    note).
// ---------------------------------------------------------------------------

describe('GET /health wires pool.query and listLatestNamespaceVersions into healthResponse', () => {
  it('a-reachable-pool-produces-200-status-ok-and-carries-through-the-real-namespace-list', async () => {
    poolQuery.mockImplementation(async (text: unknown) => {
      if (typeof text === 'string' && text.toLowerCase().includes('distinct on')) {
        return { rows: [{ namespace: 'document', version: 3 }] };
      }
      return { rows: [{ '?column?': 1 }] }; // `select 1`
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.database).toEqual({ reachable: true });
    expect(body.namespaces).toEqual([{ namespace: 'document', version: 3 }]);
  });

  it('an-unreachable-pool-produces-503-status-unavailable-and-an-empty-namespaces-array', async () => {
    poolQuery.mockRejectedValue(new Error('connection refused'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.database.reachable).toBe(false);
    expect(body.database.error).toContain('connection refused');
    expect(body.namespaces).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. A route's own thrown/rejected domain call maps to 503
//    infrastructure_unavailable, not 500.
// ---------------------------------------------------------------------------

describe('an infrastructure failure inside a route handler maps to 503 infrastructure_unavailable, never a bare 500', () => {
  it('performcheck-rejecting-maps-to-503-infrastructure-unavailable', async () => {
    vi.spyOn(checksModule, 'performCheck').mockRejectedValue(new Error('connection terminated'));

    const res = await app.inject({ method: 'POST', url: '/check', payload: validCheckBody });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(503);
    expect(body.error.code).toBe('infrastructure_unavailable');
    expect(body.error.message).toContain('connection terminated');
  });
});

// ---------------------------------------------------------------------------
// 7. Malformed (syntactically invalid) JSON -> 400, via the framework-level
//    setErrorHandler path, never a bare 500.
// ---------------------------------------------------------------------------

describe('a syntactically invalid JSON body is rejected with 400 invalid_request, never a 500', () => {
  it('raw-non-json-payload-with-a-json-content-type-is-rejected-with-400-invalid-request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: '{this is not valid json',
      headers: { 'content-type': 'application/json' },
    });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe('invalid_request');
  });
});
