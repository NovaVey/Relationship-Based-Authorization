/**
 * DB-free unit tests for `src/cli/entity-ref.ts`'s pure, synchronous
 * `isValidIdentifier`/`parseEntityArg` — mirrors `test/unit/store/
 * tuples.test.ts`'s own DB-free scoping for this repo: neither function
 * ever touches Postgres, so a fake or unreachable database would prove
 * nothing a plain function call doesn't already prove more directly.
 *
 * D-190 (docs/DECISIONS.md): `parseEntityArg`'s `id` half moved off the
 * strict `isValidIdentifier` schema-symbol grammar onto
 * `isValidDataPlaneId` (`src/store/tuples.ts`) — the same distinction
 * D-187 already drew for `writeTuple`/`deleteTuple`. `ns` stays on
 * `isValidIdentifier`, unchanged. These tests exercise both halves
 * directly and in isolation; `test/unit/cli/check.test.ts`/`expand.test.ts`
 * separately prove the two CLI commands that call `parseEntityArg` behave
 * correctly end to end.
 */
import { describe, expect, it } from 'vitest';

import { isValidIdentifier, parseEntityArg } from '../../../src/cli/entity-ref.js';
import { MAX_IDENTIFIER_LENGTH } from '../../../src/schema/dsl/types.js';
import { MAX_DATA_PLANE_ID_LENGTH } from '../../../src/store/tuples.js';

describe('isValidIdentifier', () => {
  it('accepts-lowercase-snake-case-starting-with-a-letter', () => {
    expect(isValidIdentifier('document')).toBe(true);
    expect(isValidIdentifier('has_underscore')).toBe(true);
    expect(isValidIdentifier('a')).toBe(true);
  });

  it('rejects-a-leading-digit-uppercase-a-hyphen-and-empty', () => {
    expect(isValidIdentifier('1document')).toBe(false);
    expect(isValidIdentifier('Document')).toBe(false);
    expect(isValidIdentifier('has-hyphen')).toBe(false);
    expect(isValidIdentifier('')).toBe(false);
  });

  it('accepts-exactly-max-identifier-length-and-rejects-one-character-over', () => {
    const atLimit = 'a' + 'a'.repeat(MAX_IDENTIFIER_LENGTH - 1);
    const oneOver = atLimit + 'a';
    expect(atLimit.length).toBe(MAX_IDENTIFIER_LENGTH);
    expect(isValidIdentifier(atLimit)).toBe(true);
    expect(isValidIdentifier(oneOver)).toBe(false);
  });
});

describe('parseEntityArg', () => {
  it('splits-namespace-and-id-on-the-first-colon', () => {
    expect(parseEntityArg('document:readme')).toEqual({ ns: 'document', id: 'readme' });
  });

  it('rejects-no-colon-a-leading-colon-and-a-trailing-colon', () => {
    expect(parseEntityArg('not-a-reference')).toBeUndefined();
    expect(parseEntityArg(':readme')).toBeUndefined();
    expect(parseEntityArg('document:')).toBeUndefined();
  });

  it('rejects-a-malformed-namespace-half-even-when-the-id-half-is-fine', () => {
    expect(parseEntityArg('Uppercase:readme')).toBeUndefined();
    expect(parseEntityArg('1leading-digit:readme')).toBeUndefined();
    expect(parseEntityArg('has space:readme')).toBeUndefined();
  });

  // D-190: the actual behavior change — an id half that would have been
  // rejected under the old, shared IDENTIFIER_PATTERN grammar now parses
  // fine, since the ns/id split still happens on the first colon and ns
  // itself is unaffected.
  it('accepts-a-colon-containing-id-half-the-exact-principal-graph-shape-this-fix-is-for', () => {
    expect(parseEntityArg('document:github:owner/repo')).toEqual({
      ns: 'document',
      id: 'github:owner/repo',
    });
    expect(parseEntityArg('document:arn:aws:iam::123456789012:role/example-role')).toEqual({
      ns: 'document',
      id: 'arn:aws:iam::123456789012:role/example-role',
    });
  });

  it('accepts-an-id-half-with-uppercase-digits-leading-hyphens-and-slashes-none-of-which-isValidIdentifier-would-ever-accept', () => {
    expect(parseEntityArg('document:Some-ID_123/path')).toEqual({
      ns: 'document',
      id: 'Some-ID_123/path',
    });
  });

  it('accepts-an-id-half-up-to-max-data-plane-id-length-well-past-the-63-character-schema-symbol-limit', () => {
    const longId = 'x'.repeat(MAX_DATA_PLANE_ID_LENGTH);
    expect(parseEntityArg(`document:${longId}`)).toEqual({ ns: 'document', id: longId });
  });

  it('still-rejects-an-id-half-containing-a-hash-at-sign-or-control-character-the-tuple-wire-delimiters', () => {
    expect(parseEntityArg('document:evil#hack')).toBeUndefined();
    expect(parseEntityArg('document:evil@hack')).toBeUndefined();
    expect(parseEntityArg('document:evil\thack')).toBeUndefined();
    expect(parseEntityArg('document:evil\x00hack')).toBeUndefined();
  });

  it('still-rejects-an-id-half-over-the-data-plane-length-limit', () => {
    const tooLong = 'x'.repeat(MAX_DATA_PLANE_ID_LENGTH + 1);
    expect(parseEntityArg(`document:${tooLong}`)).toBeUndefined();
  });
});
