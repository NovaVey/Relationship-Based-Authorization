/**
 * `src/store/tokens.ts` — `assertTokenObserved`/`currentToken`, build spec
 * §6.3's consistency-token guarantee ("a check pinned to token T never
 * returns a result that ignores a write with token ≤ T") and full-repo
 * audit finding #9 (MEDIUM, 2026-08-16): `assertTokenObserved` must reject
 * a malformed `token` (`NaN`, a non-integer, a negative integer)
 * *synchronously, before ever querying `pool`* — closing the `NaN >
 * observed`/`NaN < observed` hazard where every JavaScript relational
 * comparison involving `NaN` evaluates to `false`, never `true`, so a
 * malformed token used to silently fall through the "has this been
 * observed" check instead of throwing.
 *
 * DB-free by design, not by convenience: the whole point of `tokens.ts`'s
 * own `Number.isInteger(requested) || requested < 0` guard (added by this
 * finding's fix) is that it fires *before* `currentToken`'s own `pool.query`
 * ever runs — see that file's own doc comment. A fake `Pool` whose `query`
 * throws if actually invoked is therefore not just a fast substitute for a
 * real Postgres connection here, it is the mechanism that proves the guard
 * genuinely short-circuits, rather than merely happening to produce the
 * right answer after querying anyway. Written from `tokens.ts`'s own doc
 * comments (§6.3's guarantee, the `NaN` hazard, the unchanged
 * already-observed/not-yet-observed error text) — this file's actual
 * implementation was not read as the source of what to assert here beyond
 * the two error strings its own doc comment already quotes verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { assertTokenObserved, currentToken } from '../../../src/store/tokens.js';

/**
 * A fake `Pool` whose `query` throws immediately if ever called — the
 * mechanism this file uses to prove `assertTokenObserved`'s malformed-token
 * guard short-circuits before touching the database, not merely that it
 * happens to reach the same conclusion after querying anyway.
 */
function poolThatMustNeverBeQueried(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    throw new Error(
      'poolThatMustNeverBeQueried: pool.query was called — the guard did not short-circuit',
    );
  });
  return { pool: { query } as unknown as Pool, query };
}

/** A fake `Pool` whose `query` resolves with a canned `max_token` row, for exercising the real (post-guard) comparison logic. */
function poolWithMaxToken(maxToken: string | null): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rows: [{ max_token: maxToken }] }));
  return { pool: { query } as unknown as Pool, query };
}

// ---------------------------------------------------------------------------
// 1. A malformed token is rejected synchronously, before `pool.query` is
//    ever called — the exact fix finding #9 describes.
// ---------------------------------------------------------------------------

describe('assertTokenObserved rejects a malformed token before ever querying the database', () => {
  it('a-nan-token-throws-and-pool-query-is-never-called', async () => {
    const { pool, query } = poolThatMustNeverBeQueried();

    await expect(assertTokenObserved(pool, NaN)).rejects.toThrow(
      /is not a valid token — a consistency token must be a non-negative integer/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('a-non-integer-token-throws-and-pool-query-is-never-called', async () => {
    const { pool, query } = poolThatMustNeverBeQueried();

    await expect(assertTokenObserved(pool, 1.5)).rejects.toThrow(
      /is not a valid token — a consistency token must be a non-negative integer/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('a-negative-integer-token-throws-and-pool-query-is-never-called', async () => {
    const { pool, query } = poolThatMustNeverBeQueried();

    await expect(assertTokenObserved(pool, -1)).rejects.toThrow(
      /is not a valid token — a consistency token must be a non-negative integer/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('the-malformed-token-error-message-names-the-exact-malformed-value-via-json-stringify', () => {
    // Not a separate `it.skip`/duplicate of the three above — this pins the
    // exact message shape (`JSON.stringify(token)` embedded verbatim, per
    // `tokens.ts`'s own doc comment) rather than only matching a loose
    // substring, so a future edit that drops the value from the message
    // entirely still fails this test even though the three tests above
    // would keep passing on the shared prefix alone.
    const { pool } = poolThatMustNeverBeQueried();
    return expect(assertTokenObserved(pool, NaN)).rejects.toThrow(
      `consistency token ${JSON.stringify(NaN)} is not a valid token — a consistency token ` +
        `must be a non-negative integer returned by an earlier write or delete`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A valid non-negative integer token reaches the real comparison logic —
//    both branches (observed / not-yet-observed) behave exactly as they did
//    before this fix, including the exact, unchanged not-yet-observed error
//    text.
// ---------------------------------------------------------------------------

describe('assertTokenObserved — a valid token reaches the real, unchanged observed/not-yet-observed comparison', () => {
  it('a-token-at-or-below-the-highest-observed-token-resolves-without-throwing', async () => {
    const { pool, query } = poolWithMaxToken('10');

    await expect(assertTokenObserved(pool, 10)).resolves.toBeUndefined();
    await expect(assertTokenObserved(pool, 0)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('a-token-above-the-highest-observed-token-throws-the-exact-pre-existing-not-yet-observed-message', async () => {
    const { pool } = poolWithMaxToken('10');

    await expect(assertTokenObserved(pool, 11)).rejects.toThrow(
      'consistency token 11 has not been observed by this database (highest known token: 10)',
    );
  });

  it('a-token-requested-against-a-database-with-no-writes-yet-throws-naming-none-no-writes-yet', async () => {
    const { pool } = poolWithMaxToken(null);

    await expect(assertTokenObserved(pool, 0)).rejects.toThrow(
      'consistency token 0 has not been observed by this database (highest known token: none — no writes yet)',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. `currentToken` itself is unaffected by this fix — still works with a
//    fake pool returning `null`/a string `max_token` (the `pg` bigint ->
//    string -> Number(...) coercion this file's own top-of-file doc comment
//    describes).
// ---------------------------------------------------------------------------

describe('currentToken is unaffected by the assertTokenObserved fix', () => {
  it('a-null-max-token-row-resolves-null-no-writes-have-ever-happened', async () => {
    const { pool } = poolWithMaxToken(null);
    await expect(currentToken(pool)).resolves.toBeNull();
  });

  it('a-string-max-token-row-resolves-the-numeric-value-not-the-raw-string', async () => {
    const { pool } = poolWithMaxToken('42');
    const result = await currentToken(pool);
    expect(result).toBe(42);
    expect(typeof result).toBe('number');
  });
});
