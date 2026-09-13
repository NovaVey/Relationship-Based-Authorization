/**
 * DB-free unit tests for `src/store/tuples.ts`'s pure, synchronous
 * validators. Mirrors `test/unit/store/tokens.test.ts`'s own established
 * DB-free scoping for this directory: no `Pool`, no Postgres, no container —
 * none of the functions tested here ever touch `pool` at all, so a fake or
 * unreachable database would prove nothing that a plain function call
 * doesn't already prove more directly.
 *
 * `validateExpiresAt` — D-144's approved, closed-form time-window condition
 * on a tuple (see `docs/DECISIONS.md` D-144 and `src/store/migrations/
 * 0007_relation_tuples_expiry.sql`'s own doc comment for the scope this
 * implements). Written from `tuples.ts`'s own doc comment on
 * `validateExpiresAt` (an `expiresAt` at or in the past is rejected;
 * `undefined` is always valid) rather than from re-deriving the rule
 * independently.
 *
 * `invalidDataPlaneIdReason`/`isValidDataPlaneId` — the data-plane id
 * grammar `objectId`/`subjectId` moved onto (Principal-Graph interop fix):
 * a length cap, no control characters, no `#`/`@`. Written from `tuples.ts`'s
 * own doc comment on `invalidDataPlaneIdReason` the same way. The fuller,
 * end-to-end proof that `writeTuple`/`deleteTuple` actually apply this
 * grammar to `objectId`/`subjectId` (and the still-strict `IDENTIFIER_PATTERN`
 * to every other field) lives in `test/isolation/identifier-and-tuple-
 * validation.fuzz.test.ts` — these tests exercise the two exported
 * functions directly and in isolation, the smallest unit that can prove
 * their own boundary behavior.
 */
import { describe, expect, it } from 'vitest';

import {
  validateExpiresAt,
  invalidDataPlaneIdReason,
  isValidDataPlaneId,
  MAX_DATA_PLANE_ID_LENGTH,
  type TupleKey,
} from '../../../src/store/tuples.js';

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

describe('invalidDataPlaneIdReason / isValidDataPlaneId', () => {
  it('rejects-an-empty-string', () => {
    expect(invalidDataPlaneIdReason('')).toBe('must not be empty');
    expect(isValidDataPlaneId('')).toBe(false);
  });

  it('accepts-an-id-at-exactly-the-length-limit-and-rejects-one-character-over', () => {
    const atLimit = 'a'.repeat(MAX_DATA_PLANE_ID_LENGTH);
    const oneOver = 'a'.repeat(MAX_DATA_PLANE_ID_LENGTH + 1);

    expect(invalidDataPlaneIdReason(atLimit)).toBeNull();
    expect(isValidDataPlaneId(atLimit)).toBe(true);

    expect(invalidDataPlaneIdReason(oneOver)).toContain('exceeds the maximum data-plane id length');
    expect(isValidDataPlaneId(oneOver)).toBe(false);
  });

  it('rejects-every-ascii-control-character-c0-and-c1-including-nul-tab-and-newline', () => {
    // C0 (0x00-0x1F) + DEL (0x7F) + C1 (0x80-0x9F) — the full "control
    // character" range, not just the handful an ad-hoc test might think to
    // name individually.
    for (let code = 0x00; code <= 0x1f; code += 1) {
      const value = `id${String.fromCharCode(code)}id`;
      expect(invalidDataPlaneIdReason(value), `code point 0x${code.toString(16)}`).toBe(
        'must not contain control characters',
      );
    }
    expect(invalidDataPlaneIdReason(`id${String.fromCharCode(0x7f)}id`)).toBe(
      'must not contain control characters',
    );
    for (let code = 0x80; code <= 0x9f; code += 1) {
      const value = `id${String.fromCharCode(code)}id`;
      expect(invalidDataPlaneIdReason(value), `code point 0x${code.toString(16)}`).toBe(
        'must not contain control characters',
      );
    }
  });

  it('rejects-a-hash-or-at-sign-anywhere-in-the-id-the-two-reserved-tuple-wire-delimiters', () => {
    expect(invalidDataPlaneIdReason('has#hash')).toContain("must not contain '#' or '@'");
    expect(invalidDataPlaneIdReason('has@at')).toContain("must not contain '#' or '@'");
    expect(invalidDataPlaneIdReason('#leading')).toContain("must not contain '#' or '@'");
    expect(invalidDataPlaneIdReason('trailing@')).toContain("must not contain '#' or '@'");
  });

  it('accepts-a-colon-anywhere-in-the-id-unlike-the-strict-schema-symbol-grammar-a-colon-is-not-a-tuple-wire-delimiter-for-the-id-half', () => {
    // Exactly the shapes Principal-Graph's own exporter and a real AWS ARN
    // produce — see this fix's own motivation.
    expect(invalidDataPlaneIdReason('github:owner/repo')).toBeNull();
    expect(invalidDataPlaneIdReason('arn:aws:iam::123456789012:role/example-role')).toBeNull();
    expect(isValidDataPlaneId('github:owner/repo')).toBe(true);
  });

  it('accepts-a-200-character-external-id-well-past-the-old-63-character-schema-symbol-limit', () => {
    const longId = 'x'.repeat(200);
    expect(invalidDataPlaneIdReason(longId)).toBeNull();
    expect(isValidDataPlaneId(longId)).toBe(true);
  });

  it('accepts-digits-leading-hyphens-slashes-and-most-other-printable-punctuation-none-of-which-a-schema-symbol-may-ever-contain', () => {
    for (const id of ['1document', 'document-type', 'a/b/c', 'a.b.c', 'a b c', 'a\'b"c']) {
      expect(invalidDataPlaneIdReason(id), id).toBeNull();
    }
  });
});
