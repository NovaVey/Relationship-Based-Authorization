/**
 * `checkAdminAuth` (`src/api/auth.ts`) — build spec
 * `.claude/commands/build-authz-service.md` §9 Phase 8's exit criterion ("an
 * unauthenticated write attempt is rejected") at its narrowest, most
 * fundamental unit: the pure comparison function every write route's
 * `preHandler` calls, with no Fastify and no database involved at all.
 *
 * Written from `src/api/auth.ts`'s own exported types and top-of-file doc
 * comment, which is this file's whole spec for this phase: `Authorization:
 * Bearer <key>`, a length check ahead of `timingSafeEqual` (an unequal-
 * length pair can never reach it), and — the load-bearing security
 * invariant this file exists to hold a line under — an unconfigured
 * `ADMIN_API_KEY` fails every caller, never opens the gate.
 *
 * Every case here compares against `AdminAuthResult`'s own two-branch shape
 * (`{authorized:true}` or `{authorized:false, reason:...}`) with
 * `toEqual`, never just a truthy/falsy check — a bug that returned
 * `authorized:false` with the *wrong* `reason` (e.g. reporting
 * `missing_or_invalid_key` when the real problem is an unconfigured key, or
 * vice versa) would matter to a caller trying to distinguish "this
 * deployment has no admin key at all" from "you supplied the wrong one",
 * and a loose assertion would never catch that swap.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { checkAdminAuth } from '../../../src/api/auth.js';
import { env } from '../../../src/config/env.js';

const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;

afterEach(() => {
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
});

describe('an unconfigured ADMIN_API_KEY rejects every caller, never fails open', () => {
  it('with-admin-api-key-unset-a-missing-authorization-header-is-rejected-as-not-configured', () => {
    env.ADMIN_API_KEY = undefined;
    expect(checkAdminAuth(undefined)).toEqual({
      authorized: false,
      reason: 'admin_api_key_not_configured',
    });
  });

  it('with-admin-api-key-unset-even-a-syntactically-well-formed-bearer-header-is-rejected-as-not-configured-not-treated-as-a-wrong-key', () => {
    env.ADMIN_API_KEY = undefined;
    // No key is configured to compare against at all — this must never be
    // classified as "the caller supplied the wrong key" (a different,
    // narrower failure than "this deployment has no key configured").
    expect(checkAdminAuth('Bearer anything-at-all')).toEqual({
      authorized: false,
      reason: 'admin_api_key_not_configured',
    });
  });
});

describe('with a configured ADMIN_API_KEY, only the exact correct bearer token authorizes', () => {
  const REAL_KEY = 'the-real-admin-key-0123456789';

  it('a-missing-authorization-header-is-rejected-as-missing-or-invalid-key', () => {
    env.ADMIN_API_KEY = REAL_KEY;
    expect(checkAdminAuth(undefined)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('a-header-present-but-not-bearer-prefixed-is-rejected-as-missing-or-invalid-key', () => {
    env.ADMIN_API_KEY = REAL_KEY;
    expect(checkAdminAuth(REAL_KEY)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
    expect(checkAdminAuth(`Basic ${REAL_KEY}`)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
    // The scheme name itself is case-sensitive per this file's own stated
    // scheme ("Bearer <key>") — a lowercase "bearer" is a different header
    // shape, not a case-insensitive match of the same scheme.
    expect(checkAdminAuth(`bearer ${REAL_KEY}`)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('bearer-with-an-empty-token-is-rejected-as-missing-or-invalid-key', () => {
    env.ADMIN_API_KEY = REAL_KEY;
    expect(checkAdminAuth('Bearer ')).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('bearer-with-the-wrong-key-is-rejected-as-missing-or-invalid-key', () => {
    env.ADMIN_API_KEY = REAL_KEY;
    expect(checkAdminAuth('Bearer the-wrong-admin-key-9876543210')).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('bearer-with-the-exact-correct-key-is-authorized', () => {
    env.ADMIN_API_KEY = REAL_KEY;
    expect(checkAdminAuth(`Bearer ${REAL_KEY}`)).toEqual({ authorized: true });
  });

  it('a-supplied-key-that-is-a-strict-prefix-of-the-real-key-is-rejected-not-accepted-as-a-partial-match', () => {
    // This is the case that would catch a broken length check ahead of the
    // constant-time comparison (this file's own doc comment: an
    // unequal-length pair can never reach `timingSafeEqual`) — a naive
    // `startsWith`-shaped comparison bug would wrongly accept this.
    env.ADMIN_API_KEY = REAL_KEY;
    const prefix = REAL_KEY.slice(0, REAL_KEY.length - 1);
    expect(checkAdminAuth(`Bearer ${prefix}`)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('a-supplied-key-that-is-the-real-key-plus-trailing-extra-characters-is-rejected-not-accepted-as-a-loose-match', () => {
    env.ADMIN_API_KEY = REAL_KEY;
    expect(checkAdminAuth(`Bearer ${REAL_KEY}extra-trailing-junk`)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });

  it('a-supplied-key-differing-from-the-real-key-only-in-the-very-last-character-is-still-rejected', () => {
    // Guards against a comparison that only checks length and a handful of
    // leading bytes — same length, differs only at the very end.
    env.ADMIN_API_KEY = REAL_KEY;
    const almost = `${REAL_KEY.slice(0, REAL_KEY.length - 1)}X`;
    expect(almost).toHaveLength(REAL_KEY.length);
    expect(checkAdminAuth(`Bearer ${almost}`)).toEqual({
      authorized: false,
      reason: 'missing_or_invalid_key',
    });
  });
});
