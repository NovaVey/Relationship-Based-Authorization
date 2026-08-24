/**
 * `POST /list-objects` and `POST /list-users` route wiring in
 * `src/api/server.ts` (post-audit improvement — `src/audit/list.ts`'s
 * `listObjects`/`listUsers`, response-shaped by `src/api/responses.ts`'s
 * `listObjectsResponse`/`listUsersResponse`), plus the route-level wiring of
 * `requireReadAuth`/`checkReadAuth` (`src/api/auth.ts`) across all four
 * gated-read routes (`/check`, `/expand`, `/list-objects`, `/list-users`).
 *
 * Sibling file to `test/unit/api/server.test.ts` rather than a new describe
 * block appended to it — this file's own top-of-file doc comment already
 * establishes its scope/mocking conventions ("`vi.spyOn` on each domain
 * module's own namespace", a plain `{ query: vi.fn() }` fake `pool`,
 * `buildServer(pool, { logger: false })` per test, `env.ADMIN_API_KEY = ...`
 * / restore-in-`afterEach`) — this file follows those same conventions
 * exactly, extended with `env.READONLY_API_KEY` for the second credential
 * tier, without growing that already-large file further.
 *
 * `checkReadAuth`'s own pure-function behavior (the two-credential fallback
 * logic, every `reason` value) is already fully proven in
 * `test/unit/api/auth.test.ts` — this file does not re-derive any of that.
 * What's new here, and what neither existing file covers: does
 * `env.READONLY_API_KEY` alone (with `env.ADMIN_API_KEY` unset) actually let
 * a caller reach these four routes through a *real* Fastify route, and is it
 * still correctly powerless on the three write routes — the wiring, not the
 * comparison logic.
 *
 * Written from `src/api/server.ts`'s own route bodies for `/list-objects`/
 * `/list-users` (request schemas `listObjectsBodySchema`/
 * `listUsersBodySchema`, the exact args each route hands to
 * `listObjects`/`listUsers`) and `requireReadAuth`/`gatedReadPreHandlers`'s
 * own doc comments for which four routes they gate — read directly, per this
 * phase's own brief, rather than assumed from the general shape of
 * `/check`/`/expand`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

import * as checksModule from '../../../src/audit/checks.js';
import * as expandModule from '../../../src/audit/expand.js';
import * as listModule from '../../../src/audit/list.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import * as publishModule from '../../../src/schema/publish.js';
import { encodeToken } from '../../../src/store/tokens.js';

import type { PerformCheckResult } from '../../../src/audit/checks.js';
import type { ExpandNode } from '../../../src/audit/expand.js';
import type { ListObjectsResult, ListUsersResult } from '../../../src/audit/list.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ORIGINAL_READONLY_API_KEY = env.READONLY_API_KEY;
const ADMIN_KEY = 'list-routes-test-admin-key';
const READONLY_KEY = 'list-routes-test-readonly-key';

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
  env.READONLY_API_KEY = ORIGINAL_READONLY_API_KEY;
});

function authHeaders(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

const validListObjectsBody = {
  subject: { ns: 'user', id: 'alice' },
  relation: 'view',
  objectNs: 'document',
};

const validListUsersBody = {
  object: { ns: 'document', id: 'readme' },
  relation: 'view',
};

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

// ---------------------------------------------------------------------------
// 1. Malformed body -> 400 invalid_request, one representative case per
//    shape, per route.
// ---------------------------------------------------------------------------

describe('a structurally malformed /list-objects or /list-users body is rejected with 400 invalid_request', () => {
  it('a-list-objects-body-missing-the-required-objectns-field-is-rejected-and-listobjects-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listObjects');
    const { objectNs: _omit, ...withoutObjectNs } = validListObjectsBody;
    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: withoutObjectNs,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-list-objects-body-with-a-non-string-relation-is-rejected-and-listobjects-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listObjects');
    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: { ...validListObjectsBody, relation: 42 },
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-list-objects-body-with-an-unrecognized-top-level-key-is-rejected-strict-schema-and-listobjects-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listObjects');
    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: { ...validListObjectsBody, extra: 'nope' },
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-list-objects-body-whose-subject-namespace-contains-a-colon-is-rejected-with-400-invalid-request', async () => {
    // Same identifierField() grammar server.ts's own comment documents as
    // shared across every entity-ref field, including this one.
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listObjects');
    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: { ...validListObjectsBody, subject: { ns: 'has:colon', id: 'alice' } },
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-list-users-body-missing-the-required-object-field-is-rejected-and-listusers-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listUsers');
    const { object: _omit, ...withoutObject } = validListUsersBody;
    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: withoutObject,
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-list-users-body-with-a-non-string-relation-is-rejected-and-listusers-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listUsers');
    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: { ...validListUsersBody, relation: null },
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-list-users-body-with-an-unrecognized-top-level-key-is-rejected-strict-schema-and-listusers-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listUsers');
    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: { ...validListUsersBody, atToken: 'listUsers-has-no-such-field' },
      headers: authHeaders(ADMIN_KEY),
    });
    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. /list-objects's atToken field — mirrors /check's own well-formed/
//    malformed atToken handling exactly.
// ---------------------------------------------------------------------------

describe("/list-objects's atToken: a well-formed opaque token decodes and passes through; a malformed one is rejected before listObjects is ever called", () => {
  it('a-well-formed-attoken-decodes-and-is-passed-to-listobjects-as-atToken', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const canned: ListObjectsResult = { objects: [], truncated: false };
    const spy = vi.spyOn(listModule, 'listObjects').mockResolvedValue(canned);
    const opaqueToken = encodeToken(7);

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: { ...validListObjectsBody, atToken: opaqueToken },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      validListObjectsBody.subject,
      validListObjectsBody.relation,
      validListObjectsBody.objectNs,
      { atToken: 7 },
    );
    expect((await parseBody(res)).atToken).toBe(opaqueToken);
  });

  it('a-garbage-attoken-string-on-list-objects-is-rejected-with-400-invalid-request-and-listobjects-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listObjects');

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: { ...validListObjectsBody, atToken: 'not-a-real-token' },
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res.statusCode).toBe(400);
    expect((await parseBody(res)).error.code).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('no-attoken-supplied-calls-listobjects-with-an-empty-options-object-and-the-response-omits-attoken-entirely', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const canned: ListObjectsResult = { objects: [], truncated: false };
    const spy = vi.spyOn(listModule, 'listObjects').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      validListObjectsBody.subject,
      validListObjectsBody.relation,
      validListObjectsBody.objectNs,
      {},
    );
    const body = await parseBody(res);
    expect(body.atToken).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, 'atToken')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Unauthenticated / wrong-key -> 401, domain function never called.
// ---------------------------------------------------------------------------

describe('with ADMIN_API_KEY unset and no READONLY_API_KEY, /list-objects and /list-users reject with 401 and never call their domain function', () => {
  it('with-no-read-credential-configured-post-list-objects-returns-401-and-listobjects-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    env.READONLY_API_KEY = undefined;
    const spy = vi.spyOn(listModule, 'listObjects');

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('with-no-read-credential-configured-post-list-users-returns-401-and-listusers-is-never-called', async () => {
    env.ADMIN_API_KEY = undefined;
    env.READONLY_API_KEY = undefined;
    const spy = vi.spyOn(listModule, 'listUsers');

    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('with ADMIN_API_KEY set, a wrong bearer key on /list-objects or /list-users rejects with 401 and never calls the domain function', () => {
  it('a-wrong-bearer-key-on-post-list-objects-returns-401-and-listobjects-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listObjects');

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
      headers: authHeaders('the-wrong-key'),
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a-wrong-bearer-key-on-post-list-users-returns-401-and-listusers-is-never-called', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const spy = vi.spyOn(listModule, 'listUsers');

    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
      headers: authHeaders('the-wrong-key'),
    });

    expect(res.statusCode).toBe(401);
    expect((await parseBody(res)).error.code).toBe('unauthorized');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. A correct key reaches the domain function and returns its shape
//    verbatim (through listObjectsResponse/listUsersResponse).
// ---------------------------------------------------------------------------

describe('with the correct admin key, /list-objects and /list-users call their domain function with the right arguments and return the result verbatim', () => {
  it('a-correct-admin-key-on-post-list-objects-calls-listobjects-with-subject-relation-and-objectns-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const canned: ListObjectsResult = {
      objects: [
        { ns: 'document', id: 'readme' },
        { ns: 'document', id: 'other' },
      ],
      truncated: true,
    };
    const spy = vi.spyOn(listModule, 'listObjects').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      validListObjectsBody.subject,
      validListObjectsBody.relation,
      validListObjectsBody.objectNs,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(await parseBody(res)).toEqual({
      subject: validListObjectsBody.subject,
      relation: validListObjectsBody.relation,
      objectNs: validListObjectsBody.objectNs,
      objects: canned.objects,
      truncated: canned.truncated,
    });
  });

  it('a-list-objects-result-with-zero-objects-renders-an-empty-array-not-omitted-or-null', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const canned: ListObjectsResult = { objects: [], truncated: false };
    vi.spyOn(listModule, 'listObjects').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
      headers: authHeaders(ADMIN_KEY),
    });

    const body = await parseBody(res);
    expect(Array.isArray(body.objects)).toBe(true);
    expect(body.objects).toEqual([]);
  });

  it('a-correct-admin-key-on-post-list-users-calls-listusers-with-object-and-relation-only-and-returns-its-result-verbatim', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    const canned: ListUsersResult = {
      subjects: [
        { ns: 'user', id: 'alice' },
        { ns: 'user', id: 'bob' },
      ],
    };
    const spy = vi.spyOn(listModule, 'listUsers').mockResolvedValue(canned);

    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    // listUsers takes no options object at all — unlike listObjects, it has
    // no atToken/maxDepth surface on the HTTP body (listUsersBodySchema has
    // no such field), so the route calls it with exactly these two args.
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      validListUsersBody.object,
      validListUsersBody.relation,
    );
    expect(res.statusCode).toBe(200);
    const body = await parseBody(res);
    expect(body).toEqual({
      object: validListUsersBody.object,
      relation: validListUsersBody.relation,
      subjects: canned.subjects,
    });
  });

  it('a-list-users-result-with-zero-subjects-renders-an-empty-array-not-omitted-or-null', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    vi.spyOn(listModule, 'listUsers').mockResolvedValue({ subjects: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
      headers: authHeaders(ADMIN_KEY),
    });

    const body = await parseBody(res);
    expect(Array.isArray(body.subjects)).toBe(true);
    expect(body.subjects).toEqual([]);
  });

  it('a-list-users-response-never-carries-an-attoken-field-at-all-not-even-as-an-explicit-undefined-key', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    vi.spyOn(listModule, 'listUsers').mockResolvedValue({ subjects: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
      headers: authHeaders(ADMIN_KEY),
    });

    const body = await parseBody(res);
    expect(Object.prototype.hasOwnProperty.call(body, 'atToken')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate-limit config wiring — mirrors the exact precedent
//    `test/unit/api/rate-limit.test.ts` already established for /check's own
//    gatedReadRateLimit budget (loop to one past `max`, confirm the (max+1)th
//    request, and only that one, is 429).
// ---------------------------------------------------------------------------

describe('/list-objects and /list-users each enforce their own real gatedReadRateLimit budget (200/minute)', () => {
  it('the-201st-authenticated-request-to-post-list-objects-within-the-window-is-rejected-429-rate-limited', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    vi.spyOn(listModule, 'listObjects').mockResolvedValue({ objects: [], truncated: false });

    for (let i = 0; i < 200; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/list-objects',
        payload: validListObjectsBody,
        headers: authHeaders(ADMIN_KEY),
      });
      expect(res.statusCode).not.toBe(429);
    }

    const res201 = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res201.statusCode).toBe(429);
    expect((await parseBody(res201)).error.code).toBe('rate_limited');
  });

  it('the-201st-authenticated-request-to-post-list-users-within-the-window-is-rejected-429-rate-limited', async () => {
    env.ADMIN_API_KEY = ADMIN_KEY;
    vi.spyOn(listModule, 'listUsers').mockResolvedValue({ subjects: [] });

    for (let i = 0; i < 200; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/list-users',
        payload: validListUsersBody,
        headers: authHeaders(ADMIN_KEY),
      });
      expect(res.statusCode).not.toBe(429);
    }

    const res201 = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
      headers: authHeaders(ADMIN_KEY),
    });

    expect(res201.statusCode).toBe(429);
    expect((await parseBody(res201)).error.code).toBe('rate_limited');
  });
});

// ---------------------------------------------------------------------------
// 6. requireReadAuth / checkReadAuth wiring — the READONLY_API_KEY tier,
//    proven through real routes, not just checkReadAuth's own pure-function
//    unit coverage in test/unit/api/auth.test.ts.
// ---------------------------------------------------------------------------

describe('a caller holding only a valid READONLY_API_KEY (ADMIN_API_KEY unset) reaches every gated-read route successfully', () => {
  it('readonly-api-key-alone-reaches-check-expand-list-objects-and-list-users-and-each-calls-its-real-domain-function', async () => {
    env.ADMIN_API_KEY = undefined;
    env.READONLY_API_KEY = READONLY_KEY;

    const checkSpy = vi
      .spyOn(checksModule, 'performCheck')
      .mockResolvedValue({ allowed: false, depth: 0 } satisfies PerformCheckResult);
    const expandSpy = vi.spyOn(expandModule, 'expand').mockResolvedValue({
      kind: 'relation',
      object: { ns: 'document', id: 'readme' },
      relation: 'view',
      directSubjects: [],
      usersets: [],
    } satisfies ExpandNode);
    const listObjectsSpy = vi
      .spyOn(listModule, 'listObjects')
      .mockResolvedValue({ objects: [], truncated: false } satisfies ListObjectsResult);
    const listUsersSpy = vi
      .spyOn(listModule, 'listUsers')
      .mockResolvedValue({ subjects: [] } satisfies ListUsersResult);

    const checkRes = await app.inject({
      method: 'POST',
      url: '/check',
      payload: validCheckBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(checkRes.statusCode).toBe(200);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    const expandRes = await app.inject({
      method: 'POST',
      url: '/expand',
      payload: validExpandBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(expandRes.statusCode).toBe(200);
    expect(expandSpy).toHaveBeenCalledTimes(1);

    const listObjectsRes = await app.inject({
      method: 'POST',
      url: '/list-objects',
      payload: validListObjectsBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(listObjectsRes.statusCode).toBe(200);
    expect(listObjectsSpy).toHaveBeenCalledTimes(1);

    const listUsersRes = await app.inject({
      method: 'POST',
      url: '/list-users',
      payload: validListUsersBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(listUsersRes.statusCode).toBe(200);
    expect(listUsersSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a caller holding only a valid READONLY_API_KEY is still rejected on every ADMIN_API_KEY-only write route — the read tier never widens write access', () => {
  it('readonly-api-key-alone-is-rejected-401-on-post-tuples-delete-tuples-and-post-schema-publish-and-none-of-their-domain-functions-are-ever-called', async () => {
    env.ADMIN_API_KEY = undefined;
    env.READONLY_API_KEY = READONLY_KEY;

    const writeSpy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockRejectedValue(new Error('writeTuple must not be called for a READONLY_API_KEY caller'));
    const deleteSpy = vi
      .spyOn(tuplesModule, 'deleteTuple')
      .mockRejectedValue(new Error('deleteTuple must not be called for a READONLY_API_KEY caller'));
    const publishSpy = vi
      .spyOn(publishModule, 'publishSchema')
      .mockRejectedValue(
        new Error('publishSchema must not be called for a READONLY_API_KEY caller'),
      );

    const writeRes = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(writeRes.statusCode).toBe(401);
    expect((await parseBody(writeRes)).error.code).toBe('unauthorized');
    expect(writeSpy).not.toHaveBeenCalled();

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/tuples',
      payload: validTupleBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(deleteRes.statusCode).toBe(401);
    expect((await parseBody(deleteRes)).error.code).toBe('unauthorized');
    expect(deleteSpy).not.toHaveBeenCalled();

    const publishRes = await app.inject({
      method: 'POST',
      url: '/schema/publish',
      payload: validSchemaSourceBody,
      headers: authHeaders(READONLY_KEY),
    });
    expect(publishRes.statusCode).toBe(401);
    expect((await parseBody(publishRes)).error.code).toBe('unauthorized');
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe('with neither READONLY_API_KEY nor ADMIN_API_KEY configured, every gated-read route rejects with the specific not-configured reason, never fails open', () => {
  it('with-neither-key-configured-check-expand-list-objects-and-list-users-all-return-401-mentioning-neither-key-is-configured', async () => {
    env.ADMIN_API_KEY = undefined;
    env.READONLY_API_KEY = undefined;

    const checkSpy = vi.spyOn(checksModule, 'performCheck');
    const expandSpy = vi.spyOn(expandModule, 'expand');
    const listObjectsSpy = vi.spyOn(listModule, 'listObjects');
    const listUsersSpy = vi.spyOn(listModule, 'listUsers');

    const routes: Array<{ method: 'POST'; url: string; payload: Record<string, unknown> }> = [
      { method: 'POST', url: '/check', payload: validCheckBody },
      { method: 'POST', url: '/expand', payload: validExpandBody },
      { method: 'POST', url: '/list-objects', payload: validListObjectsBody },
      { method: 'POST', url: '/list-users', payload: validListUsersBody },
    ];

    for (const route of routes) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
      });
      expect(res.statusCode).toBe(401);
      const body = await parseBody(res);
      expect(body.error.code).toBe('unauthorized');
      expect(body.error.message).toContain('READONLY_API_KEY');
      expect(body.error.message).toContain('ADMIN_API_KEY');
    }

    expect(checkSpy).not.toHaveBeenCalled();
    expect(expandSpy).not.toHaveBeenCalled();
    expect(listObjectsSpy).not.toHaveBeenCalled();
    expect(listUsersSpy).not.toHaveBeenCalled();
  });
});

describe('a wrong READONLY_API_KEY (with ADMIN_API_KEY also unset) is rejected on every gated-read route and never reaches the domain function', () => {
  it('a-wrong-readonly-key-returns-401-missing-or-invalid-key-on-check-expand-list-objects-and-list-users', async () => {
    env.ADMIN_API_KEY = undefined;
    env.READONLY_API_KEY = READONLY_KEY;

    const checkSpy = vi.spyOn(checksModule, 'performCheck');
    const expandSpy = vi.spyOn(expandModule, 'expand');
    const listObjectsSpy = vi.spyOn(listModule, 'listObjects');
    const listUsersSpy = vi.spyOn(listModule, 'listUsers');

    const routes: Array<{ method: 'POST'; url: string; payload: Record<string, unknown> }> = [
      { method: 'POST', url: '/check', payload: validCheckBody },
      { method: 'POST', url: '/expand', payload: validExpandBody },
      { method: 'POST', url: '/list-objects', payload: validListObjectsBody },
      { method: 'POST', url: '/list-users', payload: validListUsersBody },
    ];

    for (const route of routes) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
        headers: authHeaders('some-other-wrong-key'),
      });
      expect(res.statusCode).toBe(401);
      expect((await parseBody(res)).error.code).toBe('unauthorized');
    }

    expect(checkSpy).not.toHaveBeenCalled();
    expect(expandSpy).not.toHaveBeenCalled();
    expect(listObjectsSpy).not.toHaveBeenCalled();
    expect(listUsersSpy).not.toHaveBeenCalled();
  });
});
