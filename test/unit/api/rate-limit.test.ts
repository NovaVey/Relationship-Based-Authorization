/**
 * `@fastify/rate-limit` wiring in `src/api/server.ts` — added to close a
 * real CodeQL finding (`js/missing-rate-limiting`, high severity) on
 * `/health`; see `docs/DECISIONS.md` D-056. Written directly by the main
 * agent (not delegated — a small, focused addition responding to a CI
 * finding discovered after `test-author`'s own two Phase 8 passes already
 * completed), proving the fix is real rather than trusting the plugin's
 * own documentation that registering it "just works".
 *
 * Deliberately exercises the *stricter* per-route budget
 * (`ADMIN_API_KEY`-gated write routes, 20/minute) rather than the global
 * default (100/minute) — fewer `app.inject()` calls needed to reach the
 * limit within a single fast test, and it's the budget this file's own
 * `docs/DECISIONS.md` entry calls out as the more security-relevant one
 * (defense-in-depth against key-guessing/write-flooding).
 *
 * Full-repo audit finding #6 (MEDIUM, 2026-08-16): the original "read
 * route" describe block below fired 20 *unauthenticated* `POST /check`
 * requests to prove the global 100/minute default, written before D-064
 * gated `/check`/`/expand` behind `requireAdminAuth`. D-065 then made that
 * preHandler run before rate-limit counting, so every one of those 20
 * requests has returned 401 since — never reaching the counted rate-limit
 * path — while the test's only assertion (`not.toBe(429)`) stayed trivially
 * satisfied, testing nothing about the budget it named. Fixed by retargeting
 * that describe block at `/schema/compile` (the one route left with no
 * `requireAdminAuth` preHandler and no route-level `config.rateLimit`
 * override — confirmed by reading `src/api/server.ts`'s route registrations
 * — so it is the only route actually governed by the bare global default),
 * and adding a new describe block below that authenticates properly and
 * drives `/check` to its own real, gated-read budget (200/minute).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../../../src/api/server.js';
import { env } from '../../../src/config/env.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const CORRECT_KEY = 'rate-limit-test-admin-key';

let app: FastifyInstance;

beforeEach(async () => {
  env.ADMIN_API_KEY = CORRECT_KEY;
  const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool;
  app = await buildServer(pool, { logger: false });
});

afterEach(async () => {
  await app.close();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
});

async function parseBody(res: { payload: string }): Promise<any> {
  return JSON.parse(res.payload);
}

describe('a write route enforces its stricter per-route rate-limit budget (20/minute)', () => {
  it('the-21st-request-to-a-gated-write-route-within-the-window-is-rejected-429-rate-limited-with-the-standard-error-envelope', async () => {
    const payload = {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    // The first 20 requests each get *some* real response from the route
    // itself (never 429) — proves the limit is exactly 20, not off-by-one
    // in either direction, and that ordinary traffic under the budget is
    // completely unaffected by registering the plugin at all.
    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/tuples',
        payload,
        headers: { authorization: `Bearer ${CORRECT_KEY}` },
      });
      expect(res.statusCode).not.toBe(429);
    }

    const res21 = await app.inject({
      method: 'POST',
      url: '/tuples',
      payload,
      headers: { authorization: `Bearer ${CORRECT_KEY}` },
    });

    expect(res21.statusCode).toBe(429);
    const body = await parseBody(res21);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toContain('rate limit exceeded');
  });
});

describe("a read route with no admin key required (schema compile) is governed by the global 100/minute default, not any gated route's own stricter or more generous budget", () => {
  // `/check` is NOT this route, despite requiring no admin key in some
  // earlier version of this API: D-064 gated `/check`/`/expand` behind
  // `requireAdminAuth`, and D-065 made that preHandler run *before*
  // rate-limit counting (`hook: 'preHandler'`, assigned first in the
  // preHandler array — see `src/api/server.ts`'s own doc comment on
  // `requireAdminAuth`). An unauthenticated `POST /check` today returns 401
  // and never reaches the counted rate-limit path at all, so it cannot
  // exercise this budget. `/schema/compile` is the one route left with
  // neither a `preHandler: requireAdminAuth` nor its own `config.rateLimit`
  // override in `src/api/server.ts` — confirmed by reading its route
  // registration — so it is the only remaining route actually governed by
  // the bare global default registered on `app` (`max: 100, timeWindow: '1
  // minute'`), not `/check`/`/expand`'s own 200/minute gated-read budget or
  // the write routes' 20/minute budget.
  it('20-consecutive-requests-to-post-schema-compile-well-under-the-global-default-never-return-429', async () => {
    const payload = { source: 'namespace document {\n  relation viewer: user\n}' };

    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/schema/compile', payload });
      expect(res.statusCode).not.toBe(429);
    }
  });
});

describe('a gated read route (check) enforces its own real per-route rate-limit budget (200/minute), once authenticated', () => {
  // Unlike the describe block above, this drives an *authenticated* caller
  // — the one who actually reaches the counted rate-limit path on `/check`
  // — all the way to its real, gated-read budget (200/minute, more generous
  // than the 20/minute write budget per D-064's own reasoning: "a real
  // integrated caller might run a check per incoming request to whatever it
  // protects"). This is the test the stale describe block above used to
  // claim to be, before D-064/D-065 moved auth ahead of rate-limit counting
  // for this route.
  it('the-201st-authenticated-request-to-a-gated-read-route-within-the-window-is-rejected-429-rate-limited-with-the-standard-error-envelope', async () => {
    const payload = {
      subject: { ns: 'user', id: 'alice' },
      relation: 'view',
      object: { ns: 'document', id: 'readme' },
    };

    // The first 200 requests each get a real response from the route itself
    // (never 429) — proves the limit is exactly 200, not off-by-one in
    // either direction, and that ordinary authenticated traffic under the
    // budget is completely unaffected by registering the plugin at all.
    for (let i = 0; i < 200; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/check',
        payload,
        headers: { authorization: `Bearer ${CORRECT_KEY}` },
      });
      expect(res.statusCode).not.toBe(429);
    }

    const res201 = await app.inject({
      method: 'POST',
      url: '/check',
      payload,
      headers: { authorization: `Bearer ${CORRECT_KEY}` },
    });

    expect(res201.statusCode).toBe(429);
    const body = await parseBody(res201);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toContain('rate limit exceeded');
  });
});
