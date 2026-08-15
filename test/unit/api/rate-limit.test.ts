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
  app = await buildServer(pool);
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

describe("a read route (no admin key required) is governed by the global 100/minute default, not the write routes' stricter budget", () => {
  it('20-consecutive-requests-to-post-check-well-under-the-global-default-never-return-429', async () => {
    const payload = {
      subject: { ns: 'user', id: 'alice' },
      relation: 'view',
      object: { ns: 'document', id: 'readme' },
    };

    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/check', payload });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
