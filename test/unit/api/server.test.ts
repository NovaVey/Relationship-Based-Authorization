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

import { buildServer, trustExactlyOneRealProxyHop } from '../../../src/api/server.js';
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

beforeEach(async () => {
  poolQuery = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const pool = { query: poolQuery } as unknown as Pool;
  app = await buildServer(pool, { logger: false });
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
    env.ADMIN_API_KEY = CORRECT_KEY;
    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {},
      headers: authHeaders(CORRECT_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
  });

  it('a-structurally-malformed-expand-body-is-rejected-with-400-invalid-request', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const res = await app.inject({
      method: 'POST',
      url: '/expand',
      payload: {},
      headers: authHeaders(CORRECT_KEY),
    });
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
// 1b. Full-repo audit finding #3 (MEDIUM, third audit, 2026-08-17): a
//     structurally *valid* body whose `ns`/`id`/`relation` violates the
//     identifier grammar (`IDENTIFIER_PATTERN`) is rejected too, the same
//     400 a malformed tuple write already gets from `validateIdentifiers` —
//     companion coverage for finding #13 (the test gap this closes).
// ---------------------------------------------------------------------------

describe('a well-formed but grammar-invalid identifier is rejected with 400 invalid_request too (finding #3)', () => {
  it('a-check-body-whose-subject-namespace-contains-a-colon-is-rejected-with-400-invalid-request', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi.spyOn(checksModule, 'performCheck');
    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: { ...validCheckBody, subject: { ns: 'has:colon', id: 'alice' } },
      headers: authHeaders(CORRECT_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('an-expand-body-whose-object-namespace-contains-a-colon-is-rejected-with-400-invalid-request', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi.spyOn(expandModule, 'expand');
    const res = await app.inject({
      method: 'POST',
      url: '/expand',
      payload: { ...validExpandBody, object: { ns: 'has:colon', id: 'readme' } },
      headers: authHeaders(CORRECT_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The core exit-criterion claim: the auth gate short-circuits BEFORE the
//    domain call, not just before the response.
// ---------------------------------------------------------------------------

describe('with ADMIN_API_KEY unset, every gated route rejects with 401 and never calls its domain function', () => {
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

  it('with-admin-api-key-unset-post-check-returns-401-and-performcheck-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockRejectedValue(new Error('performCheck must not be called when ADMIN_API_KEY is unset'));

    const res = await app.inject({ method: 'POST', url: '/check', payload: validCheckBody });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('with-admin-api-key-unset-post-expand-returns-401-and-expand-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    const spy = vi
      .spyOn(expandModule, 'expand')
      .mockRejectedValue(new Error('expand must not be called when ADMIN_API_KEY is unset'));

    const res = await app.inject({ method: 'POST', url: '/expand', payload: validExpandBody });

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

  it('a-wrong-bearer-key-on-post-check-returns-401-and-performcheck-is-never-called', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi
      .spyOn(checksModule, 'performCheck')
      .mockRejectedValue(new Error('performCheck must not be called with a wrong key'));

    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders('the-wrong-key'),
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-wrong-bearer-key-on-post-expand-returns-401-and-expand-is-never-called', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const spy = vi
      .spyOn(expandModule, 'expand')
      .mockRejectedValue(new Error('expand must not be called with a wrong key'));

    const res = await app.inject({
      method: 'POST',
      url: '/expand',
      payload: validExpandBody,
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

describe('with the correct admin key, each gated route calls its domain function and returns its result verbatim', () => {
  it('a-correct-admin-key-on-post-check-calls-performcheck-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: PerformCheckResult = { allowed: false, depth: 0 };
    const spy = vi.spyOn(checksModule, 'performCheck').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(CORRECT_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((await parseBody(res)).allowed).toBe(false);
  });

  it('a-correct-admin-key-on-post-expand-calls-expand-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const canned: ExpandNode = {
      kind: 'relation',
      object: { ns: 'document', id: 'readme' },
      relation: 'viewer',
      directSubjects: [{ ns: 'user', id: 'alice' }],
      usersets: [],
    };
    const spy = vi.spyOn(expandModule, 'expand').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/expand',
      payload: validExpandBody,
      headers: authHeaders(CORRECT_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((await parseBody(res)).tree).toEqual(canned);
  });

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
// 4. schema-compile requires no auth at all — the only route left that
//    doesn't, since D-064 gated check/expand alongside the write routes.
//    check/expand's own auth-required behavior is covered above, in
//    sections 2/3 alongside the write routes they now share a gate with.
// ---------------------------------------------------------------------------

describe('schema/compile requires no admin key', () => {
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
// 4.5. Second full-repo audit finding #7 (MEDIUM, 2026-08-22) — neither the
//      server-wide `bodyLimit` (256 KiB, `buildServer`) nor the tighter,
//      field-specific `schemaSourceBodySchema.source` cap (64 KiB) — nor the
//      `setErrorHandler` branch that preserves a real 413 instead of
//      flattening it to 400 — had any test coverage anywhere in this repo,
//      despite `PROGRESS.md` itself recording that the 413->400 flattening
//      was "a companion bug ... found and fixed" once already (a documented
//      history of an easy-to-reintroduce regression at this exact spot).
// ---------------------------------------------------------------------------

describe('the two request-body-size ceilings (bodyLimit 256 KiB, schemaSourceBodySchema.source 64 KiB) are both real and distinguishable', () => {
  it('a-body-over-the-256-kib-bodylimit-returns-413-not-400-before-any-route-handler-or-zod-validation-runs', async () => {
    // 262,145 bytes of `source` alone (before JSON-wrapping overhead) is
    // already one byte past bodyLimit — comfortably past the field-specific
    // 64 KiB cap too, so this proves bodyLimit itself is what's firing:
    // Fastify's own content-type-parsing layer, before schemaSourceBodySchema
    // ever runs, per this file's own doc comment on the ordering.
    const oversizedSource = 'a'.repeat(262_145);
    const res = await app.inject({
      method: 'POST',
      url: '/schema/compile',
      payload: { source: oversizedSource },
    });

    expect(res.statusCode).toBe(413);
    const body = await parseBody(res);
    expect(body.error.code).toBe('invalid_request');
  });

  it('a-source-field-over-64-kib-but-under-the-whole-body-256-kib-limit-returns-400-with-the-field-specific-message', async () => {
    // 70,000 bytes: past schemaSourceBodySchema's own 64 KiB (65,536) cap,
    // comfortably under the whole-body 256 KiB bodyLimit — isolates the
    // field-specific Zod rejection from the blunter whole-body one.
    const oversizedSource = 'a'.repeat(70_000);
    const res = await app.inject({
      method: 'POST',
      url: '/schema/compile',
      payload: { source: oversizedSource },
    });

    expect(res.statusCode).toBe(400);
    const body = await parseBody(res);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('64 KiB');
  });

  it('a-source-field-at-exactly-64-kib-is-accepted-not-off-by-one-rejected', async () => {
    // The boundary itself: exactly MAX (65,536 chars) must pass Zod's own
    // .max(65_536) check — only content past it, in the test above, may be
    // rejected for size.
    const exactlyAtLimitSource = 'a'.repeat(65_536);
    const res = await app.inject({
      method: 'POST',
      url: '/schema/compile',
      payload: { source: exactlyAtLimitSource },
    });

    // Not the size ceiling under test here — this source is nonsense DSL,
    // so compileSchema itself rejects it (still 400, but for a schema
    // reason). What matters is it must NOT be schemaSourceBodySchema's own
    // '64 KiB' size-limit message.
    const body = await parseBody(res);
    expect(body.error.message).not.toContain('64 KiB');
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
    // `body.namespaces` is `HealthNamespaceListStatus`
    // (`src/api/responses.ts`), not a bare array — full-repo audit finding
    // #22 (a separate, concurrently-landed fix, not one of this phase's own
    // assigned findings — see `test/unit/api/responses.test.ts`, already
    // updated for it): the namespace-listing query's own success/failure is
    // now reported independently of the connectivity probe, so a real
    // success is always wrapped `{ ok: true, namespaces: [...] }`.
    expect(body.namespaces).toEqual({
      ok: true,
      namespaces: [{ namespace: 'document', version: 3 }],
    });
  });

  it('an-unreachable-pool-produces-503-status-unavailable-and-a-not-attempted-namespace-listing-failure', async () => {
    poolQuery.mockRejectedValue(new Error('connection refused'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.database.reachable).toBe(false);
    // See the sibling reachable-pool test above for why this is a wrapped
    // `HealthNamespaceListStatus`, not a bare `[]`, since finding #22 —
    // `reachable: false` always forces `{ ok: false, error: ... }` here,
    // stating plainly that the listing query was never attempted.
    expect(body.namespaces).toEqual({ ok: false, error: expect.any(String) });

    // Full-repo audit finding #15 (MEDIUM, 2026-08-16): the raw Postgres
    // driver error must never reach the wire — this route is deliberately
    // unauthenticated (load-balancer/uptime-monitor convention, see
    // server.ts's own doc comment on GET /health), so any network caller
    // could previously read whatever internal hostname/port/username text
    // happened to be in the real connection error. Proven as a real
    // security property, not a renamed string match: the raw thrown
    // message must not appear ANYWHERE in the response body — not just
    // absent from `body.database.error`, the one field a narrower
    // assertion would think to check — and `body.database.error` must be a
    // fixed, non-empty, generic string instead.
    expect(JSON.stringify(body)).not.toContain('connection refused');
    expect(typeof body.database.error).toBe('string');
    expect(body.database.error.length).toBeGreaterThan(0);
  });

  it('an-unreachable-pool-produces-the-same-fixed-database-error-text-regardless-of-what-the-real-driver-error-says', async () => {
    // The generic message must be genuinely fixed — not merely "doesn't
    // contain THIS error's text" (which a message that echoed some OTHER
    // substring of the real error could still pass) — proven by triggering
    // two structurally different real failures and confirming the wire
    // response is byte-identical either way.
    poolQuery.mockRejectedValue(new Error('connection refused'));
    const first = await app.inject({ method: 'GET', url: '/health' });
    const firstBody = await parseBody(first);

    poolQuery.mockRejectedValue(
      new Error('password authentication failed for user "internal_admin" at host 10.0.4.12'),
    );
    const second = await app.inject({ method: 'GET', url: '/health' });
    const secondBody = await parseBody(second);

    expect(JSON.stringify(secondBody)).not.toContain('internal_admin');
    expect(JSON.stringify(secondBody)).not.toContain('10.0.4.12');
    expect(secondBody.database.error).toBe(firstBody.database.error);
  });
});

// ---------------------------------------------------------------------------
// 6. A route's own thrown/rejected domain call maps to 503
//    infrastructure_unavailable, not 500.
// ---------------------------------------------------------------------------

describe('an infrastructure failure inside a route handler maps to 503 infrastructure_unavailable, never a bare 500', () => {
  it('performcheck-rejecting-maps-to-503-infrastructure-unavailable', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    vi.spyOn(checksModule, 'performCheck').mockRejectedValue(new Error('connection terminated'));

    const res = await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(CORRECT_KEY),
    });
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

// ---------------------------------------------------------------------------
// 8. D-065's actual claim, proven directly rather than just by reading
//    `requireAdminAuth`'s doc comment: a flood of *failed*-auth requests
//    against a gated route can never exhaust that route's own rate-limit
//    budget, because `requireAdminAuth` (in the route's `preHandler` array,
//    ahead of `@fastify/rate-limit`'s own appended handler — see that
//    function's doc comment) rejects and short-circuits the hook chain
//    before the rate-limit handler ever runs. If auth ran *after*
//    rate-limit counting instead, this test's 21st request — one past
//    `writeRateLimit`'s own `max: 20` — would already be a `429`, and the
//    genuine admin's request right after it would be locked out too.
// ---------------------------------------------------------------------------

describe("D-065: failed-auth requests never consume a gated route's rate-limit budget", () => {
  it('twenty-five-wrong-key-requests-to-post-tuples-all-return-401-and-a-correct-key-request-immediately-after-still-succeeds', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const writeSpy = vi.spyOn(tuplesModule, 'writeTuple');

    // One more than writeRateLimit's own `max: 20` — if rate-limit counting
    // ran before auth, request #21 here would already be a 429, not a 401.
    const FLOOD_SIZE = 25;
    for (let i = 0; i < FLOOD_SIZE; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/tuples',
        payload: validTupleBody,
        headers: authHeaders('wrong-key'),
      });
      expect(res.statusCode).toBe(401);
    }
    expect(writeSpy).not.toHaveBeenCalled();

    const canned: WriteTupleResult = { ok: true, token: 99, created: true };
    writeSpy.mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(CORRECT_KEY),
    });

    expect(res.statusCode).toBe(200);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await parseBody(res)).toEqual({ token: 99, created: true });
  });
});

// ---------------------------------------------------------------------------
// 8b. Full-repo audit finding #10 (MEDIUM, third audit, 2026-08-17) —
//     `authFloodGuard`'s own doc comment: D-065's fix (above) correctly
//     stops `writeRateLimit`/`gatedReadRateLimit`'s own after-auth counting
//     from ever seeing a failed-auth request, but that means nothing
//     else counted one either — a sustained flood of wrong-key requests
//     was, by design of D-065's own fix, entirely unbounded. This second,
//     independent, much coarser limiter (positioned BEFORE
//     `requireAdminAuth`) closes that gap without reintroducing D-065's
//     own self-DoS problem.
// ---------------------------------------------------------------------------

describe("finding #10: a second, independent, coarser flood guard bounds a sustained flood of failed-auth requests D-065's own after-auth counting never sees", () => {
  it('a-sustained-flood-of-wrong-key-requests-eventually-returns-429-rate-limited-once-past-the-flood-guards-own-1000-per-minute-threshold', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    const writeSpy = vi.spyOn(tuplesModule, 'writeTuple');

    // One more than authFloodGuard's own max: 1000. writeRateLimit's own
    // max: 20 never runs here at all — requireAdminAuth always rejects
    // first — so before this fix, nothing bounded this flood.
    let sawRateLimited = false;
    for (let i = 0; i < 1005; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/tuples',
        payload: validTupleBody,
        headers: authHeaders('wrong-key'),
      });
      if (res.statusCode === 429) {
        sawRateLimited = true;
        const body = await parseBody(res);
        expect(body.error.code).toBe('rate_limited');
        break;
      }
      expect(res.statusCode).toBe(401);
    }
    expect(sawRateLimited).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('a-normal-small-number-of-wrong-key-requests-well-under-the-flood-guards-threshold-still-all-return-401-never-429-not-a-regression-of-d-065', async () => {
    env.ADMIN_API_KEY = CORRECT_KEY;
    // Comfortably under authFloodGuard's own max: 1000 — a legitimate
    // operator retrying a handful of times must never see 429 from this
    // new, coarser guard.
    for (let i = 0; i < 100; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/tuples',
        payload: validTupleBody,
        headers: authHeaders('wrong-key'),
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Full-repo audit findings #13/#14 (MEDIUM, 2026-08-16) — server.ts's own
//    `setNotFoundHandler({ preHandler: app.rateLimit() }, ...)` doc comment:
//    before this fix, a request to an unmatched path/method never ran any
//    route's own `onRoute` hook (which is how `@fastify/rate-limit` wires
//    itself in), so it was rate-limited by nothing at all, AND it returned
//    Fastify's own raw default 404 body (`{ statusCode, error, message }`,
//    `error` a bare string) instead of this API's one documented
//    `{ error: { code, message } }` envelope every other response uses.
// ---------------------------------------------------------------------------

describe("finding #14: an unmatched route returns this API's own documented 404 envelope, never Fastify's raw default 404 body", () => {
  it('a-request-to-a-path-matching-no-registered-route-returns-404-with-the-error-code-not-found-message-envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/this-route-does-not-exist' });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(404);
    expect(body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('a-request-to-an-unmatched-route-never-carries-fastifys-own-raw-default-404-shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/another-path-nothing-registers' });
    const body = await parseBody(res);

    // Fastify's own default 404 body is `{ statusCode, error, message }`
    // with `error` a bare string (e.g. `"Not Found"`) — neither key/shape
    // may appear once this API's own `notFoundError`-built envelope is
    // wired in via `setNotFoundHandler`.
    expect(body).not.toHaveProperty('statusCode');
    expect(typeof body.error).toBe('object');
    expect(typeof body.error).not.toBe('string');
  });

  it('an-unmatched-route-404-also-applies-to-a-method-with-no-handler-on-an-otherwise-real-path', async () => {
    // `/check` is a real path, but only POST is registered on it — PUT
    // matches no route either, and must hit the exact same handler as a
    // wholly unknown path.
    const res = await app.inject({ method: 'PUT', url: '/check' });
    const body = await parseBody(res);

    expect(res.statusCode).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('finding #13: an unmatched route is rate-limited by the same global budget a real route gets, never an unbounded stream of 404s', () => {
  it('slightly-more-than-100-consecutive-requests-to-a-bogus-path-eventually-return-429-not-404-forever', async () => {
    // The global default registered in buildServer is `max: 100,
    // timeWindow: '1 minute'` — this loop deliberately goes slightly past
    // that ceiling. Before this fix, none of these 105 requests would ever
    // return anything but 404 (the audit's own reproduction: "150
    // consecutive requests to a non-existent path never hit a 429").
    let sawRateLimited = false;
    for (let i = 0; i < 105; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/yet-another-bogus-path-for-rate-limit-flooding',
      });
      if (res.statusCode === 429) {
        sawRateLimited = true;
        const body = await parseBody(res);
        expect(body.error.code).toBe('rate_limited');
        break;
      }
      expect(res.statusCode).toBe(404);
    }
    expect(sawRateLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Full-repo audit finding #3 / "trustProxy" (HIGH, 2026-08-16) —
//     `trustProxy: true` (the original D-065 fix) trusts every hop an
//     `X-Forwarded-For` header claims, including hops the *client itself*
//     prepends ahead of the one real proxy-appended hop — so a caller could
//     send a fresh, fabricated address on every request and get a brand new
//     rate-limit budget each time, defeating the limit entirely.
//     `trustProxy: 1` (this fix) trusts exactly one hop from the right —
//     the address the real, single reverse proxy this deployment sits
//     behind actually appended — never a client-supplied prefix. See
//     `docs/DECISIONS.md` D-065's "Update:" note for the full history.
// ---------------------------------------------------------------------------

describe('finding #3: a spoofed X-Forwarded-For prefix cannot obtain a fresh rate-limit budget', () => {
  it('a-fresh-fabricated-forwarded-for-address-on-every-request-still-shares-one-rate-limit-budget-not-a-new-one-each-time', async () => {
    // The global default is `max: 100, timeWindow: '1 minute'`. Every
    // request below claims a DIFFERENT fabricated client address ahead of
    // the same real proxy hop (127.0.0.1, `.inject()`'s own default peer)
    // — under the pre-fix `trustProxy: true`, each fabricated address would
    // resolve to a distinct `request.ip`, so every request would land in
    // its own separate, always-empty rate-limit bucket and never hit 429
    // no matter how many requests were sent. Under `trustProxy: 1`, all of
    // them resolve to the one real proxy-appended address (127.0.0.1) and
    // correctly share a single budget.
    let sawRateLimited = false;
    for (let i = 0; i < 105; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/this-route-does-not-exist-either',
        headers: { 'x-forwarded-for': `203.0.113.${i % 255}, 127.0.0.1` },
      });
      if (res.statusCode === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.statusCode).toBe(404);
    }
    expect(sawRateLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. D-104 — Fastify 5.12.1 silently removed numeric `trustProxy` support
//     at the runtime level (not just its types): `trustProxy: 1` on that
//     version stops honoring `X-Forwarded-For` at all, always resolving
//     `request.ip` to the raw socket peer. `trustExactlyOneRealProxyHop`
//     (`src/api/server.ts`) reimplements the identical "trust exactly one
//     hop" semantics as the `TrustProxyFunction` form Fastify 5.12.1 still
//     accepts — live-verified (see that function's own doc comment) against
//     real listening servers on both Fastify versions before this test was
//     written; this pins the same properties down permanently. The
//     "spoofed prefix never wins" property itself is already covered
//     end-to-end through a real server by finding #3 above (unmodified
//     since D-104 — it still passes against this function exactly as it
//     did against the literal `trustProxy: 1`); these tests pin down the
//     pure function's own hop-by-hop decisions directly.
// ---------------------------------------------------------------------------

describe('D-104: trustExactlyOneRealProxyHop reimplements trustProxy: 1 as a TrustProxyFunction', () => {
  it('trusts-only-hop-0-the-socket-itself-never-a-second-hop', () => {
    // hop 0 is always the socket's own peer address -- trusting it as a
    // proxy (continue walking past it) is exactly "trust one real hop."
    expect(trustExactlyOneRealProxyHop('127.0.0.1', 0)).toBe(true);
    // Any hop past the socket must never itself be trusted as a further
    // proxy -- otherwise a client could chain fabricated addresses ahead of
    // the real one and still have one of them trusted.
    expect(trustExactlyOneRealProxyHop('9.9.9.9', 1)).toBe(false);
    expect(trustExactlyOneRealProxyHop('6.6.6.6', 2)).toBe(false);
    expect(trustExactlyOneRealProxyHop('1.1.1.1', 5)).toBe(false);
  });

  it('never-trusts-hop-0-when-the-socket-address-itself-is-empty-fails-closed-not-open', () => {
    // Fastify 5.12.1's own behavior change was motivated by exactly this
    // case (documented upstream as an IISNode-on-Windows edge case: a
    // socket whose remoteAddress is undefined/null). If we don't know who's
    // connected to us, we have no basis to trust what they claim about
    // anyone upstream either -- matching Fastify's own hardened built-in
    // behavior for this case, not the pre-5.12.1 behavior it replaced.
    expect(trustExactlyOneRealProxyHop('', 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. D-105 — full-repo-audit finding #1, HIGH: authFloodGuard's own
//     `authFloodState` was a plain `Map<request.ip, ...>` with no size cap
//     or eviction. `trustExactlyOneRealProxyHop` stops header-based
//     spoofing, but an unauthenticated caller who controls a routable IPv6
//     /64 can trivially present an effectively unlimited number of
//     distinct *real* source addresses -- growing that Map forever, one
//     permanent entry per address ever seen, for the life of the process.
//     `authFloodState` is now a `toad-cache` `LruMap` with a real entry
//     cap; `BuildServerOptions.authFloodStateMaxEntries` (test-only,
//     mirrors the existing `logger` override) lets this test drive real
//     LRU eviction with a handful of requests instead of the real
//     50,000-entry production cap.
// ---------------------------------------------------------------------------

describe('D-105: authFloodState is a bounded LruMap, not an unbounded plain Map', () => {
  it('an-ip-evicted-from-the-flood-guards-own-cache-by-newer-distinct-ips-gets-a-fresh-window-its-old-count-does-not-survive', async () => {
    const boundedPoolQuery = vi.fn<(...args: unknown[]) => Promise<unknown>>();
    const boundedApp = await buildServer({ query: boundedPoolQuery } as unknown as Pool, {
      logger: false,
      authFloodStateMaxEntries: 2,
    });
    try {
      env.ADMIN_API_KEY = CORRECT_KEY;
      const sendFrom = (remoteAddress: string) =>
        boundedApp.inject({
          method: 'POST',
          url: '/tuples',
          payload: validTupleBody,
          headers: authHeaders('wrong-key'),
          remoteAddress,
        });

      // 'A' builds up 999 requests in its own window -- one more than 1000
      // total would trip authFloodGuard's own 429, so this alone proves
      // nothing yet; it exists to give 'A' a real, non-trivial count to
      // lose if eviction works. Every one of these calls also touches (and
      // so LRU-bumps) 'A''s own cache entry.
      for (let i = 0; i < 999; i += 1) {
        const res = await sendFrom('198.51.100.1');
        expect(res.statusCode).toBe(401);
      }

      // Two more distinct IPs, 'B' then 'C'. With a real cap of 2 entries,
      // adding 'C' as a third distinct key must evict the least-recently-
      // used entry -- 'A' (repeatedly bumped by its own 999 requests, but
      // never touched again after 'B' was inserted) -- not silently grow
      // to a third entry the way the old unbounded Map did.
      expect((await sendFrom('198.51.100.2')).statusCode).toBe(401);
      expect((await sendFrom('198.51.100.3')).statusCode).toBe(401);

      // If 'A' were still evicted-never (the old, unbounded behavior), two
      // more requests from 'A' would land at count 1001/1002 -- past
      // authFloodGuard's own max: 1000 -- and the second would 429. If 'A'
      // was correctly evicted above, this is a brand-new entry starting a
      // fresh window at count 1/2, and neither request is rate-limited.
      expect((await sendFrom('198.51.100.1')).statusCode).toBe(401);
      expect((await sendFrom('198.51.100.1')).statusCode).toBe(401);
    } finally {
      await boundedApp.close();
    }
  }, 30_000);
});
