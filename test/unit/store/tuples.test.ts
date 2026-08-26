/**
 * DB-free unit tests for `src/store/tuples.ts`'s `validateExpiresAt` — the
 * pure, synchronous half of D-144's approved, closed-form time-window
 * condition on a tuple (see `docs/DECISIONS.md` D-144 and
 * `src/store/migrations/0007_relation_tuples_expiry.sql`'s own doc comment
 * for the scope this implements). Mirrors `test/unit/store/tokens.test.ts`'s
 * own established DB-free scoping for this directory: no `Pool`, no
 * Postgres, no container — `validateExpiresAt` never touches `pool` at all,
 * so a fake or unreachable database would prove nothing here that a plain
 * function call doesn't already prove more directly.
 *
 * Written from `tuples.ts`'s own doc comment on `validateExpiresAt` (an
 * `expiresAt` at or in the past is rejected; `undefined` is always valid)
 * rather than from re-deriving the rule independently.
 */
import { describe, expect, it } from 'vitest';

import { validateExpiresAt, type TupleKey } from '../../../src/store/tuples.js';

function tupleWith(overrides: Partial<TupleKey>): TupleKey {
  return {
    objectNs: 'document',
    objectId: 'readme',
    relation: 'viewer',
    subjectNs: 'user',
    subjectId: 'alice',
    ...overrides,
  };
}

describe('validateExpiresAt', () => {
  it('rejects-a-past-timestamp-naming-the-exact-rejected-value', () => {
    const past = new Date(Date.now() - 60_000);
    const errors = validateExpiresAt(tupleWith({ expiresAt: past }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('expires_at_not_in_future');
    expect(errors[0]?.message).toContain(past.toISOString());
  });

  it('rejects-an-exact-now-timestamp-at-or-in-the-past-means-the-boundary-itself-is-rejected-not-only-strictly-past-values', () => {
    // Constructed, not `new Date()` at call time: the function's own
    // documented rule is `<=`, and a `new Date()` built independently a
    // moment before the call could tick forward by the time
    // `validateExpiresAt` reads `Date.now()`, silently turning this into
    // the "past" case above rather than genuinely exercising the exact
    // boundary. Pinning `now` once and handing the identical value to both
    // `expiresAt` and the comparison removes that race.
    const now = new Date();
    const errors = validateExpiresAt(tupleWith({ expiresAt: now }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('expires_at_not_in_future');
    expect(errors[0]?.message).toContain(now.toISOString());
  });

  it('accepts-a-future-timestamp', () => {
    const future = new Date(Date.now() + 60_000);
    const errors = validateExpiresAt(tupleWith({ expiresAt: future }));

    expect(errors).toEqual([]);
  });

  it('accepts-undefined-no-expiresAt-at-all-means-the-tuple-never-expires', () => {
    const errors = validateExpiresAt(tupleWith({}));

    expect(errors).toEqual([]);
  });
});
