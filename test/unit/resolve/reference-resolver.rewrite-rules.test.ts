/**
 * Reference resolver (Phase 3) tests — §10's
 * `matches-the-hand-derived-examples-for-every-rewrite-rule-kind`.
 *
 * Written from `.claude/commands/build-authz-service.md` §5 (the DSL
 * grammar and rewrite-rule semantics: `|` union, `&` intersection, `-`
 * exclusion meaning "in a, not in b", `->` tuple-to-userset meaning "follow
 * the named relation, then recurse into the named computed userset on
 * whatever it points to"), §6.2 (why the reference resolver must be
 * verified against hand-derived examples before being trusted as an
 * oracle), and the interface contract handed down for this task. Every
 * expected result below is derived by hand from those rules and the tuple
 * sets constructed in each test, not from reading
 * `src/resolve/reference/resolver.ts` — per §14 delegation rule 5, that
 * file was deliberately NOT read while writing these tests.
 *
 * Each combinator gets at least one case where the *combinator itself* is
 * the reason for a denial (only one branch of an intersection satisfied;
 * an exclusion tuple added on top of an otherwise-satisfied base), not just
 * a case where no tuple exists anywhere — a resolver that only distinguishes
 * "fully satisfied" from "totally empty" could still have the combinator
 * logic backwards and these tests wouldn't know it.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { referenceCheck } from '../../../src/resolve/reference/resolver.js';
import type { EntityRef, ReferenceTuple } from '../../../src/resolve/reference/resolver.js';

/** Compiles `source` and fails the test (with the formatted errors) if it doesn't compile. */
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
  subjectRelation?: string,
): ReferenceTuple {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

// One schema exercising union, intersection, and exclusion on `document`,
// plus tuple-to-userset on `folder` — mirrors §5's own worked shapes
// (`viewer | editor | owner`, `editor & owner`-style intersection,
// `viewer - banned`-style exclusion, `parent->view`) without needing
// group-nested subject types, which aren't relevant to combinator
// semantics and are covered separately (see reference-resolver.edge-cases
// and reference-resolver.graph-shape test files).
const SOURCE = [
  'namespace document {',
  '  relation owner: user',
  '  relation editor: user',
  '  relation viewer: user',
  '  relation banned: user',
  '',
  '  permission any_access = viewer | editor',
  '  permission trusted_edit = editor & owner',
  '  permission unbanned_view = viewer - banned',
  '}',
  '',
  'namespace folder {',
  '  relation parent: folder',
  '  relation editor: user',
  '',
  '  permission view = editor | parent->view',
  '}',
].join('\n');

describe('matches-the-hand-derived-examples-for-every-rewrite-rule-kind', () => {
  describe('union: any_access = viewer | editor', () => {
    it('a-union-rewrite-rule-grants-through-the-viewer-branch-alone', () => {
      const schema = compileOk(SOURCE);
      const tuples = [tuple('document', 'readme', 'viewer', 'user', 'alice')];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('document', 'readme'),
        'any_access',
      );
      expect(result.allowed).toBe(true);
    });

    it('a-union-rewrite-rule-grants-through-the-editor-branch-alone-with-no-viewer-tuple-present', () => {
      const schema = compileOk(SOURCE);
      const tuples = [tuple('document', 'readme', 'editor', 'user', 'carol')];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'carol'),
        ref('document', 'readme'),
        'any_access',
      );
      expect(result.allowed).toBe(true);
    });

    it('a-union-rewrite-rule-denies-a-subject-satisfying-neither-branch', () => {
      const schema = compileOk(SOURCE);
      const tuples = [tuple('document', 'readme', 'viewer', 'user', 'alice')];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'bob'),
        ref('document', 'readme'),
        'any_access',
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('intersection: trusted_edit = editor & owner', () => {
    it('an-intersection-rewrite-rule-denies-when-only-the-editor-branch-is-satisfied', () => {
      const schema = compileOk(SOURCE);
      // dave is an editor but never an owner — a union would grant this,
      // an intersection must not.
      const tuples = [tuple('document', 'proposal', 'editor', 'user', 'dave')];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'dave'),
        ref('document', 'proposal'),
        'trusted_edit',
      );
      expect(result.allowed).toBe(false);
    });

    it('an-intersection-rewrite-rule-denies-when-only-the-owner-branch-is-satisfied', () => {
      const schema = compileOk(SOURCE);
      const tuples = [tuple('document', 'other', 'owner', 'user', 'erin')];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'erin'),
        ref('document', 'other'),
        'trusted_edit',
      );
      expect(result.allowed).toBe(false);
    });

    it('an-intersection-rewrite-rule-allows-once-both-branches-are-independently-satisfied', () => {
      const schema = compileOk(SOURCE);
      const tuples = [
        tuple('document', 'proposal', 'editor', 'user', 'dave'),
        tuple('document', 'proposal', 'owner', 'user', 'dave'),
      ];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'dave'),
        ref('document', 'proposal'),
        'trusted_edit',
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('exclusion: unbanned_view = viewer - banned ("in viewer, not in banned")', () => {
    it('an-exclusion-rewrite-rule-allows-a-subject-in-the-base-set-who-is-not-in-the-subtracted-set', () => {
      const schema = compileOk(SOURCE);
      const tuples = [tuple('document', 'secret', 'viewer', 'user', 'frank')];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'frank'),
        ref('document', 'secret'),
        'unbanned_view',
      );
      expect(result.allowed).toBe(true);
    });

    it('an-exclusion-rewrite-rule-denies-a-subject-once-the-subtracted-branch-tuple-is-added-even-though-the-base-tuple-still-grants', () => {
      const schema = compileOk(SOURCE);
      // frank is still a viewer — the base branch alone would grant this
      // under a union. Adding the `banned` tuple must flip the answer:
      // this is the combinator doing the work, not an absence of tuples.
      const tuples = [
        tuple('document', 'secret', 'viewer', 'user', 'frank'),
        tuple('document', 'secret', 'banned', 'user', 'frank'),
      ];
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'frank'),
        ref('document', 'secret'),
        'unbanned_view',
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('tuple-to-userset: view = editor | parent->view, three-level parent chain', () => {
    // folder:a --parent--> folder:b --parent--> folder:c, editor granted
    // only on folder:c. Checking `view` on folder:a requires following
    // `parent` twice and recursing into `view` on folder:c each time.
    const chainTuples = [
      tuple('folder', 'a', 'parent', 'folder', 'b'),
      tuple('folder', 'b', 'parent', 'folder', 'c'),
      tuple('folder', 'c', 'editor', 'user', 'grace'),
    ];

    it('a-tuple-to-userset-rewrite-rule-resolves-through-a-three-level-parent-chain-for-a-subject-reachable-at-the-end', () => {
      const schema = compileOk(SOURCE);
      const result = referenceCheck(
        schema,
        chainTuples,
        ref('user', 'grace'),
        ref('folder', 'a'),
        'view',
      );
      expect(result.allowed).toBe(true);
    });

    it('a-tuple-to-userset-rewrite-rule-denies-a-subject-not-reachable-through-any-hop-of-the-chain', () => {
      const schema = compileOk(SOURCE);
      const result = referenceCheck(
        schema,
        chainTuples,
        ref('user', 'henry'),
        ref('folder', 'a'),
        'view',
      );
      expect(result.allowed).toBe(false);
    });

    it('a-tuple-to-userset-rewrite-rule-grants-directly-without-traversal-when-the-union-editor-branch-is-satisfied-on-the-object-itself', () => {
      const schema = compileOk(SOURCE);
      const tuples = [...chainTuples, tuple('folder', 'a', 'editor', 'user', 'ivy')];
      const result = referenceCheck(schema, tuples, ref('user', 'ivy'), ref('folder', 'a'), 'view');
      expect(result.allowed).toBe(true);
    });
  });
});
