/**
 * DB-free unit tests for `evaluateExpandNode` (`src/audit/list.ts`) — the
 * pure, synchronous, zero-I/O function `listUsers` is built on. Hand-built
 * `ExpandNode` fixtures, no Postgres, no `expand()` call — mirrors this
 * codebase's own established pattern of unit-testing a pure function in
 * isolation (e.g. `test/unit/schema/rewrite-rules.test.ts` for the
 * compiler, `test/unit/soundness/classify.test.ts` for the fuzz
 * classifier) rather than only ever exercising it indirectly through a
 * real-Postgres integration test.
 *
 * The real-Postgres, brute-force-oracle proof that `listUsers`/`listObjects`
 * agree with an independently computed correct answer — including the
 * "naive tree-flattening would wrongly include an excluded/non-intersecting
 * subject" trap this file's own intersection/exclusion tests below already
 * demonstrate at the unit level — lives in
 * `test/unit/audit/list.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { evaluateExpandNode, type EntityRef } from '../../../src/audit/list.js';
import type { ExpandNode } from '../../../src/audit/expand.js';

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

/** A `relation` leaf with only direct (plain) subjects, no userset members — the simplest possible non-empty node. */
function relationLeaf(object: EntityRef, relation: string, directSubjectIds: string[]): ExpandNode {
  return {
    kind: 'relation',
    object,
    relation,
    directSubjects: directSubjectIds.map((id) => ref('user', id)),
    usersets: [],
  };
}

/** Sorts a `Map<string, EntityRef>`'s values into a stable, comparable array — this file's own test-only helper, deliberately not `listUsers`'s own sort (kept separate so a bug in one can't hide behind a bug in the other). */
function sortedIds(members: Map<string, EntityRef>): string[] {
  return [...members.values()].map((s) => `${s.ns}:${s.id}`).sort();
}

describe('evaluateExpandNode — the pure recursive set-evaluation function listUsers is built on', () => {
  it("relation: unions directSubjects with every usersets[] entry's own recursively-evaluated expansion", () => {
    const node: ExpandNode = {
      kind: 'relation',
      object: ref('document', 'readme'),
      relation: 'viewer',
      directSubjects: [ref('user', 'carol')],
      usersets: [
        {
          userset: ref('group', 'eng'),
          relation: 'member',
          expansion: relationLeaf(ref('group', 'eng'), 'member', ['alice', 'bob']),
        },
      ],
    };
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:alice', 'user:bob', 'user:carol']);
  });

  it("union: the union of every child's own evaluated set", () => {
    const node: ExpandNode = {
      kind: 'union',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'viewer', ['carol']),
        relationLeaf(ref('document', 'readme'), 'editor', ['dave']),
      ],
    };
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:carol', 'user:dave']);
  });

  it("intersection: the INTERSECTION of every child's own evaluated set, not their union — a member of only one branch is excluded", () => {
    const node: ExpandNode = {
      kind: 'intersection',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'editor', ['dave', 'erin']),
        relationLeaf(ref('document', 'readme'), 'owner', ['dave']),
      ],
    };
    // erin is an editor but not an owner — present in exactly one branch,
    // so must be ABSENT from the real intersection. A naive "flatten every
    // leaf regardless of node kind" implementation would wrongly include
    // erin (she appears in the editor branch's own directSubjects) — this
    // assertion is the trap: it fails under that wrong implementation and
    // passes only under the real intersection semantics.
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:dave']);
  });

  it('intersection: three children, only the subject present in ALL THREE survives', () => {
    const node: ExpandNode = {
      kind: 'intersection',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'a', ['x', 'y']),
        relationLeaf(ref('document', 'readme'), 'b', ['x', 'y', 'z']),
        relationLeaf(ref('document', 'readme'), 'c', ['x']),
      ],
    };
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:x']);
  });

  it('intersection: defensively returns the empty set for zero children (compiler-unreachable in practice — see evaluateExpandNode\'s own doc comment) — never silently treats "no branches" as "everyone"', () => {
    const node: ExpandNode = {
      kind: 'intersection',
      object: ref('document', 'readme'),
      children: [],
    };
    expect(evaluateExpandNode(node).size).toBe(0);
  });

  it('exclusion: base minus subtract — a subject in BOTH is correctly absent, not just deduped', () => {
    const node: ExpandNode = {
      kind: 'exclusion',
      object: ref('org', 'acme'),
      base: relationLeaf(ref('org', 'acme'), 'member', ['alice', 'gina']),
      subtract: relationLeaf(ref('org', 'acme'), 'banned', ['gina']),
    };
    // gina is a member AND banned — the real exclusion excludes her. A
    // naive flatten (unioning base's and subtract's own leaves regardless
    // of node kind) would wrongly include her (she's a directSubjects
    // entry on the base branch) — this is the trap for exclusion.
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:alice']);
  });

  it('exclusion: subtract has no overlap with base — base passes through unchanged', () => {
    const node: ExpandNode = {
      kind: 'exclusion',
      object: ref('org', 'acme'),
      base: relationLeaf(ref('org', 'acme'), 'member', ['alice', 'bob']),
      subtract: relationLeaf(ref('org', 'acme'), 'banned', ['zara']),
    };
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:alice', 'user:bob']);
  });

  it("tupleToUserset: unions every followed child's own evaluated expansion, unconditionally (never an intersection across followed objects)", () => {
    const node: ExpandNode = {
      kind: 'tupleToUserset',
      object: ref('document', 'readme'),
      relation: 'parent',
      computedUserset: 'view',
      children: [
        {
          through: ref('folder', 'design'),
          expansion: relationLeaf(ref('folder', 'design'), 'editor', ['alice']),
        },
        {
          through: ref('folder', 'specs'),
          expansion: relationLeaf(ref('folder', 'specs'), 'editor', ['bob']),
        },
      ],
    };
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:alice', 'user:bob']);
  });

  it('cycleGuard, depthLimitReached, and undeclared all evaluate to the empty set — non-membership outcomes, never silently "everyone" or skipped in a way that hides a real answer', () => {
    const cycleGuard: ExpandNode = {
      kind: 'cycleGuard',
      object: ref('group', 'a'),
      name: 'member',
    };
    const depthLimitReached: ExpandNode = {
      kind: 'depthLimitReached',
      object: ref('group', 'a'),
      name: 'member',
    };
    const undeclared: ExpandNode = {
      kind: 'undeclared',
      object: ref('document', 'x'),
      name: 'bogus',
    };
    expect(evaluateExpandNode(cycleGuard).size).toBe(0);
    expect(evaluateExpandNode(depthLimitReached).size).toBe(0);
    expect(evaluateExpandNode(undeclared).size).toBe(0);
  });

  it('a cycleGuard branch inside a union does not poison a real grant reachable through a sibling branch', () => {
    const node: ExpandNode = {
      kind: 'union',
      object: ref('group', 'a'),
      children: [
        relationLeaf(ref('group', 'a'), 'member', ['mabel']),
        { kind: 'cycleGuard', object: ref('group', 'b'), name: 'member' },
      ],
    };
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:mabel']);
  });

  it('dedup: the same subject reachable via two different branches of a union collapses to exactly one entry', () => {
    const node: ExpandNode = {
      kind: 'union',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'viewer', ['alice']),
        relationLeaf(ref('document', 'readme'), 'editor', ['alice']),
      ],
    };
    const members = evaluateExpandNode(node);
    expect(sortedIds(members)).toEqual(['user:alice']);
    expect(members.size).toBe(1);
  });

  it('dedup: the same subject reachable via a direct grant AND a nested userset member collapses to one entry', () => {
    const node: ExpandNode = {
      kind: 'relation',
      object: ref('document', 'readme'),
      relation: 'viewer',
      directSubjects: [ref('user', 'alice')],
      usersets: [
        {
          userset: ref('group', 'eng'),
          relation: 'member',
          expansion: relationLeaf(ref('group', 'eng'), 'member', ['alice', 'bob']),
        },
      ],
    };
    const members = evaluateExpandNode(node);
    expect(sortedIds(members)).toEqual(['user:alice', 'user:bob']);
    expect(members.size).toBe(2);
  });

  it('a realistic three-level tree: union of (relation leaf) and (intersection of two relation leaves) and (exclusion) — the combinators compose correctly, not just in isolation', () => {
    const node: ExpandNode = {
      kind: 'union',
      object: ref('folder', 'design'),
      children: [
        relationLeaf(ref('folder', 'design'), 'viewer', ['carol']),
        {
          kind: 'intersection',
          object: ref('folder', 'design'),
          children: [
            relationLeaf(ref('folder', 'design'), 'editor', ['dave', 'erin']),
            relationLeaf(ref('folder', 'design'), 'sensitive_reviewer', ['dave']),
          ],
        },
        {
          kind: 'exclusion',
          object: ref('org', 'acme'),
          base: relationLeaf(ref('org', 'acme'), 'member', ['frank', 'gina']),
          subtract: relationLeaf(ref('org', 'acme'), 'banned', ['gina']),
        },
      ],
    };
    // carol (direct viewer), dave (in BOTH intersection branches — erin is
    // not), frank (org member, not banned — gina is banned, so excluded).
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:carol', 'user:dave', 'user:frank']);
  });
});
