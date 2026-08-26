/**
 * Reference resolver (Phase 3) tests — D-144's closed-form tuple expiry
 * (`ReferenceTuple.expiresAt`, `ReferenceCheckOptions.now`).
 *
 * Written from `docs/DECISIONS.md` D-144 ("a written tuple may optionally
 * carry a validity window... checked by the resolver as a plain comparison
 * against the current time at query time") and the `ReferenceTuple`/
 * `ReferenceCheckOptions` interfaces handed down for this task: an expired
 * tuple is treated as though it were never in the tuple array at all — the
 * same "this tuple simply isn't a current fact" semantic a real DELETE
 * would have, with no disproof entry recorded for it either. Per §14
 * delegation rule 5, `src/resolve/reference/resolver.ts` was deliberately
 * NOT read while writing these tests beyond the exported types/doc
 * comments this task's interface contract already describes.
 *
 * Every test below passes an explicit, fixed `now` — never the real wall
 * clock — so the fixture is fully deterministic regardless of when the
 * suite runs.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { referenceCheck } from '../../../src/resolve/reference/resolver.js';
import type { EntityRef, ReferenceTuple } from '../../../src/resolve/reference/resolver.js';

function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  opts: { subjectRelation?: string; expiresAt?: Date } = {},
): ReferenceTuple {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(opts.subjectRelation !== undefined ? { subjectRelation: opts.subjectRelation } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
}

// A fixed synthetic instant — never the real wall clock (see this file's
// own top-of-file doc comment).
const NOW = new Date('2026-06-15T12:00:00.000Z');
const PAST = new Date('2026-06-15T11:59:59.000Z'); // 1 second before NOW
const FUTURE = new Date('2026-06-15T12:00:01.000Z'); // 1 second after NOW

const SOURCE = [
  'namespace group {',
  '  relation member: user',
  '}',
  '',
  'namespace folder {',
  '  relation parent: folder',
  '  relation editor: user',
  '',
  '  permission view = editor | parent->view',
  '}',
  '',
  'namespace document {',
  '  relation viewer: user | group#member',
  '}',
].join('\n');

describe('a-plain-grant-tuple-with-a-past-expiresAt-is-treated-as-denied-exactly-as-if-it-did-not-exist', () => {
  it('a-plain-grant-tuple-with-a-past-expiresAt-is-treated-as-denied-exactly-as-if-it-did-not-exist', () => {
    const schema = compileOk(SOURCE);
    const tuples = [tuple('document', 'readme', 'viewer', 'user', 'alice', { expiresAt: PAST })];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
  });

  it('the-denial-disproof-shape-is-identical-to-a-genuinely-absent-tuple-it-must-not-reference-the-expired-tuple-at-all', () => {
    // The disproof for an object with zero *live* tuples on `viewer` must be
    // an empty `relationDisproof` — the expired tuple contributes no
    // `tupleDisproofs` entry, exactly as if it had never been written at
    // all (this file's own top-of-file doc comment). We can't inspect the
    // disproof directly (per this file's own top-of-file doc comment, a
    // `ReferenceCheckResult` never carries a "path to a no"), so this is
    // proven by comparing the two `allowed`-and-structurally-observable
    // outcomes of an expired-tuple graph against a genuinely-empty one via
    // an enclosing exclusion, whose *positive* path's own `subtractDisproof`
    // IS inspectable.
    const schema = compileOk(
      [
        'namespace document {',
        '  relation owner: user',
        '  relation viewer: user',
        '',
        '  permission unviewed_owner = owner - viewer',
        '}',
      ].join('\n'),
    );
    const expiredTuples: ReferenceTuple[] = [
      tuple('document', 'readme', 'owner', 'user', 'alice'),
      tuple('document', 'readme', 'viewer', 'user', 'alice', { expiresAt: PAST }),
    ];
    const emptyTuples: ReferenceTuple[] = [tuple('document', 'readme', 'owner', 'user', 'alice')];

    const expiredResult = referenceCheck(
      schema,
      expiredTuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'unviewed_owner',
      { now: NOW },
    );
    const emptyResult = referenceCheck(
      schema,
      emptyTuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'unviewed_owner',
      { now: NOW },
    );

    expect(expiredResult.allowed).toBe(true);
    expect(emptyResult.allowed).toBe(true);
    if (
      !expiredResult.path ||
      expiredResult.path.kind !== 'exclusion' ||
      !emptyResult.path ||
      emptyResult.path.kind !== 'exclusion'
    ) {
      throw new Error('expected both results to carry an exclusion path');
    }
    // Structurally identical: the expired-tuple graph's subtractDisproof
    // must be byte-for-byte the same shape as the genuinely-tuple-free
    // graph's own — proving the expired tuple left no trace, not merely
    // that it happened not to change the boolean.
    expect(expiredResult.path.subtractDisproof).toEqual(emptyResult.path.subtractDisproof);
    if (expiredResult.path.subtractDisproof.kind === 'relationDisproof') {
      expect(expiredResult.path.subtractDisproof.tupleDisproofs).toHaveLength(0);
    }
  });
});

describe('a-plain-grant-tuple-with-a-future-expiresAt-is-treated-as-allowed-exactly-as-an-un-expiring-tuple-would-be', () => {
  it('a-plain-grant-tuple-with-a-future-expiresAt-is-treated-as-allowed-exactly-as-an-un-expiring-tuple-would-be', () => {
    const schema = compileOk(SOURCE);
    const tuples = [tuple('document', 'readme', 'viewer', 'user', 'alice', { expiresAt: FUTURE })];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path || result.path.kind !== 'directGrant') {
      throw new Error('expected a directGrant path');
    }
    expect(result.path.subject).toEqual(ref('user', 'alice'));
  });

  it('an-un-expiring-tuple-produces-the-identical-allowed-result-and-path-shape-as-a-not-yet-expired-one', () => {
    const schema = compileOk(SOURCE);
    const futureTuples = [
      tuple('document', 'readme', 'viewer', 'user', 'alice', { expiresAt: FUTURE }),
    ];
    const neverExpiringTuples = [tuple('document', 'readme', 'viewer', 'user', 'alice')];

    const futureResult = referenceCheck(
      schema,
      futureTuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    const neverExpiringResult = referenceCheck(
      schema,
      neverExpiringTuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    expect(futureResult).toEqual(neverExpiringResult);
  });
});

describe('a-userset-subject-tuple-with-a-past-expiresAt-does-not-get-followed-at-all', () => {
  it('a-userset-subject-tuple-with-a-past-expiresAt-does-not-get-followed-at-all', () => {
    const schema = compileOk(SOURCE);
    // document:readme's viewer relation names group:eng#member as a
    // userset subject, but that grant tuple itself has already expired —
    // bob's real, live membership in group:eng must never even be
    // consulted, because the expired tuple is never followed in the first
    // place (not "followed but denied").
    const tuples: ReferenceTuple[] = [
      tuple('document', 'readme', 'viewer', 'group', 'eng', {
        subjectRelation: 'member',
        expiresAt: PAST,
      }),
      tuple('group', 'eng', 'member', 'user', 'bob'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'bob'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
  });

  it('control-the-identical-userset-subject-tuple-with-a-future-expiresAt-is-followed-and-allows', () => {
    // Proves the previous test's denial is genuinely caused by expiry, not
    // by some unrelated mistake in the fixture (e.g. a typo in the
    // relation name) that would deny regardless of expiresAt.
    const schema = compileOk(SOURCE);
    const tuples: ReferenceTuple[] = [
      tuple('document', 'readme', 'viewer', 'group', 'eng', {
        subjectRelation: 'member',
        expiresAt: FUTURE,
      }),
      tuple('group', 'eng', 'member', 'user', 'bob'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'bob'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('a-tupleToUserset-rules-own-followed-tuple-with-a-past-expiresAt-is-not-followed', () => {
  it('a-tupleToUserset-rules-own-followed-tuple-with-a-past-expiresAt-is-not-followed', () => {
    const schema = compileOk(SOURCE);
    // folder:child's `parent` tuple to folder:root has already expired —
    // `view = editor | parent->view` must never follow it, even though
    // folder:root genuinely grants `editor` to carol.
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'child', 'parent', 'folder', 'root', { expiresAt: PAST }),
      tuple('folder', 'root', 'editor', 'user', 'carol'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'carol'),
      ref('folder', 'child'),
      'view',
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
  });

  it('control-the-identical-tupleToUserset-followed-tuple-with-a-future-expiresAt-is-followed-and-allows', () => {
    const schema = compileOk(SOURCE);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'child', 'parent', 'folder', 'root', { expiresAt: FUTURE }),
      tuple('folder', 'root', 'editor', 'user', 'carol'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'carol'),
      ref('folder', 'child'),
      'view',
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    // `view = editor | parent->view` — the winning branch is reached via
    // the union's `parent->view` child (no `editor` tuple on folder:child
    // itself), so the top-level step is `union` wrapping `tupleToUserset`.
    if (
      !result.path ||
      result.path.kind !== 'union' ||
      result.path.branch.kind !== 'tupleToUserset'
    ) {
      throw new Error('expected a union path wrapping a tupleToUserset branch');
    }
    expect(result.path.branch.through).toEqual(ref('folder', 'root'));
  });
});

describe('an-expiresAt-exactly-equal-to-now-is-already-expired-a-half-open-window', () => {
  // D-144 states a plain comparison against the current time — this
  // resolver implements it as a strict `>` (expiresAt must be strictly
  // after now to still be live), so the boundary instant itself is already
  // expired, not live. Pinned down explicitly here rather than left as an
  // implicit assumption of the PAST/FUTURE constants above.
  it('a-tuple-whose-expiresAt-exactly-equals-now-is-treated-as-expired', () => {
    const schema = compileOk(SOURCE);
    const tuples = [tuple('document', 'readme', 'viewer', 'user', 'alice', { expiresAt: NOW })];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
  });
});
