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
 *
 * D-171 (public/wildcard subjects) added a second correctness trap this
 * file now also covers at the unit level: a wildcard subject
 * (`{kind:'wildcard', ns}`) must be tracked as NAMESPACE coverage, not a
 * literal key, so it correctly excludes a concrete subject reached via a
 * DIFFERENT branch of an exclusion's own `subtract` — see the "wildcard in
 * subtract" tests below, and `src/audit/list.ts`'s own `subtractMemberSets`
 * doc comment for the one genuinely co-finite shape that refuses instead of
 * approximating.
 *
 * D-175 (reverse-lookup accelerant, `docs/REVERSE-LOOKUP-PROPOSAL.md`) added
 * a third block, at the bottom of this file: DB-free coverage for
 * `listObjects`'s own gates 1 (env/per-call override), 4 (schema lookup —
 * undeclared namespace, or a permission rather than a bare relation), and 5
 * (a wildcard-capable subject type) — the three gates that own function
 * `tryReverseIndexCandidates` deliberately keeps in *this* file rather than
 * `src/store/relation-index.ts` (see that function's own doc comment for
 * the dependency-direction reasoning). Gates 2 and 3 (freshness,
 * empty/error-is-a-miss) are `fetchReverseIndexCandidates`'s own concern and
 * are covered where that function lives —
 * `test/unit/store/dst/relation-index-reverse-lookup.dst.test.ts`. Follows
 * `test/unit/audit/checks.test.ts`'s own established `vi.spyOn`-on-module-
 * namespace pattern: `productionCheck`, `getLatestNamespaceConfig`, and
 * `fetchReverseIndexCandidates` are each mocked at their own module
 * boundary, `listObjects` itself is real and unmocked, and a tiny fake
 * `ConnectionSource` stands in for Postgres only for the one raw query
 * `listObjects` can still issue directly when the accelerant doesn't engage
 * (`fetchCandidateObjectIds`'s own namespace-wide scan).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateExpandNode,
  isUnenumerable,
  listObjects,
  hasAnyGrant,
  type EntityRef,
  type EvaluateExpandResult,
  type MemberSet,
  type SubjectRef,
} from '../../../src/audit/list.js';
import type { ExpandNode } from '../../../src/audit/expand.js';
import * as productionModule from '../../../src/resolve/production/resolver.js';
import type { ProductionCheckResult } from '../../../src/resolve/production/resolver.js';
import * as publishModule from '../../../src/schema/publish.js';
import * as relationIndexModule from '../../../src/store/relation-index.js';
import type { ConnectionSource, QueryResultLike } from '../../../src/store/query-executor.js';
import type { NamespaceConfig } from '../../../src/schema/dsl/types.js';
import { env } from '../../../src/config/env.js';

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function concrete(ns: string, id: string): SubjectRef {
  return { kind: 'concrete', ns, id };
}

function wildcard(ns: string): SubjectRef {
  return { kind: 'wildcard', ns };
}

/** Unwraps an `EvaluateExpandResult`, asserting it's the enumerable `MemberSet` shape (fails the test loudly if it's an `Unenumerable` refusal instead — never silently treated as empty). */
function asMemberSet(result: EvaluateExpandResult): MemberSet {
  if (isUnenumerable(result)) {
    throw new Error(`expected an enumerable MemberSet, got unenumerable (ns=${result.ns})`);
  }
  return result;
}

/** Sorts a `MemberSet`'s concrete values into a stable, comparable array of `"ns:id"` strings — this file's own test-only helper, deliberately not `listUsers`'s own sort (kept separate so a bug in one can't hide behind a bug in the other). */
function sortedIds(result: EvaluateExpandResult): string[] {
  const set = asMemberSet(result);
  return [...set.concrete.values()].map((s) => `${s.ns}:${s.id}`).sort();
}

/** Sorts a `MemberSet`'s wildcard-covered namespaces into a stable array. */
function sortedWildcardNs(result: EvaluateExpandResult): string[] {
  return [...asMemberSet(result).wildcardNs].sort();
}

/** A `relation` leaf with only direct (concrete) subjects, no userset members, no wildcard — the simplest possible non-empty node. */
function relationLeaf(object: EntityRef, relation: string, directSubjectIds: string[]): ExpandNode {
  return {
    kind: 'relation',
    object,
    relation,
    directSubjects: directSubjectIds.map((id) => concrete('user', id)),
    usersets: [],
  };
}

/** A `relation` leaf granting an entire namespace by wildcard (`<ns>:*`, D-171) — no concrete subjects, no userset members. */
function wildcardLeaf(object: EntityRef, relation: string, ns: string): ExpandNode {
  return { kind: 'relation', object, relation, directSubjects: [wildcard(ns)], usersets: [] };
}

describe('evaluateExpandNode — the pure recursive set-evaluation function listUsers is built on', () => {
  it("relation: unions directSubjects with every usersets[] entry's own recursively-evaluated expansion", () => {
    const node: ExpandNode = {
      kind: 'relation',
      object: ref('document', 'readme'),
      relation: 'viewer',
      directSubjects: [concrete('user', 'carol')],
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
    const set = asMemberSet(evaluateExpandNode(node));
    expect(set.concrete.size).toBe(0);
    expect(set.wildcardNs.size).toBe(0);
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
    expect(asMemberSet(evaluateExpandNode(cycleGuard)).concrete.size).toBe(0);
    expect(asMemberSet(evaluateExpandNode(depthLimitReached)).concrete.size).toBe(0);
    expect(asMemberSet(evaluateExpandNode(undeclared)).concrete.size).toBe(0);
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
    const set = asMemberSet(evaluateExpandNode(node));
    expect(sortedIds(set)).toEqual(['user:alice']);
    expect(set.concrete.size).toBe(1);
  });

  it('dedup: the same subject reachable via a direct grant AND a nested userset member collapses to one entry', () => {
    const node: ExpandNode = {
      kind: 'relation',
      object: ref('document', 'readme'),
      relation: 'viewer',
      directSubjects: [concrete('user', 'alice')],
      usersets: [
        {
          userset: ref('group', 'eng'),
          relation: 'member',
          expansion: relationLeaf(ref('group', 'eng'), 'member', ['alice', 'bob']),
        },
      ],
    };
    const set = asMemberSet(evaluateExpandNode(node));
    expect(sortedIds(set)).toEqual(['user:alice', 'user:bob']);
    expect(set.concrete.size).toBe(2);
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

  // -------------------------------------------------------------------------
  // D-171 — wildcard ("public") subjects.
  // -------------------------------------------------------------------------

  it('relation: a wildcard directSubjects entry is tracked as namespace coverage, not a literal key', () => {
    const node = wildcardLeaf(ref('document', 'readme'), 'viewer', 'user');
    const set = asMemberSet(evaluateExpandNode(node));
    expect(set.concrete.size).toBe(0);
    expect(sortedWildcardNs(evaluateExpandNode(node))).toEqual(['user']);
  });

  it('relation: a concrete entry made redundant by a wildcard on the SAME leaf is dropped', () => {
    const node: ExpandNode = {
      kind: 'relation',
      object: ref('document', 'readme'),
      relation: 'viewer',
      directSubjects: [concrete('user', 'alice'), wildcard('user')],
      usersets: [],
    };
    const set = asMemberSet(evaluateExpandNode(node));
    expect(set.concrete.size).toBe(0);
    expect([...set.wildcardNs]).toEqual(['user']);
  });

  it('union: a wildcard branch absorbs a concrete entry from a SIBLING branch of the same namespace', () => {
    const node: ExpandNode = {
      kind: 'union',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'viewer', ['alice']),
        wildcardLeaf(ref('document', 'readme'), 'editor', 'user'),
      ],
    };
    const set = asMemberSet(evaluateExpandNode(node));
    expect(set.concrete.size).toBe(0);
    expect([...set.wildcardNs]).toEqual(['user']);
  });

  it('intersection: a namespace wildcard-covered in EVERY branch stays wildcard-covered in the result', () => {
    const node: ExpandNode = {
      kind: 'intersection',
      object: ref('document', 'readme'),
      children: [
        wildcardLeaf(ref('document', 'readme'), 'viewer', 'user'),
        wildcardLeaf(ref('document', 'readme'), 'editor', 'user'),
      ],
    };
    const set = asMemberSet(evaluateExpandNode(node));
    expect([...set.wildcardNs]).toEqual(['user']);
    expect(set.concrete.size).toBe(0);
  });

  it('intersection: a namespace wildcard-covered in only ONE branch falls back to per-subject coverage against every branch', () => {
    const node: ExpandNode = {
      kind: 'intersection',
      object: ref('document', 'readme'),
      children: [
        wildcardLeaf(ref('document', 'readme'), 'viewer', 'user'), // everyone
        relationLeaf(ref('document', 'readme'), 'owner', ['dave']), // only dave, concretely
      ],
    };
    // dave is covered by BOTH (viewer's wildcard covers him; owner names
    // him concretely) — the real intersection is exactly {dave}, not the
    // empty set (which a naive "wildcardNs must appear in every branch, so
    // there is no namespace-level wildcard, so treat non-wildcard branches
    // as the whole answer" bug would produce) and not "everyone" (which a
    // naive "any branch wildcards this namespace, so the result does too"
    // bug would produce).
    expect(sortedIds(evaluateExpandNode(node))).toEqual(['user:dave']);
    expect(sortedWildcardNs(evaluateExpandNode(node))).toEqual([]);
  });

  it("exclusion: wildcard in subtract excludes a concrete base member of the SAME namespace, even though it wasn't named directly — the core D-171 listUsers trap", () => {
    const node: ExpandNode = {
      kind: 'exclusion',
      object: ref('document', 'readme'),
      base: relationLeaf(ref('document', 'readme'), 'viewer', ['alice']),
      subtract: wildcardLeaf(ref('document', 'readme'), 'banned', 'user'),
    };
    // alice is a viewer; banned wildcards ALL users, so she is banned too,
    // even though no tuple names her directly on the banned side. A naive
    // literal-key-only exclusion (the pre-D-171 implementation) would find
    // no key in subtract equal to alice's and wrongly still list her —
    // exactly the divergence from check()'s own correct denial this
    // property exists to close.
    const set = asMemberSet(evaluateExpandNode(node));
    expect(set.concrete.size).toBe(0);
    expect(set.wildcardNs.size).toBe(0);
  });

  it('exclusion: wildcard base minus a wildcard subtract of the SAME namespace is exactly empty (fully enumerable, not a refusal)', () => {
    const node: ExpandNode = {
      kind: 'exclusion',
      object: ref('document', 'readme'),
      base: wildcardLeaf(ref('document', 'readme'), 'viewer', 'user'),
      subtract: wildcardLeaf(ref('document', 'readme'), 'banned', 'user'),
    };
    const set = asMemberSet(evaluateExpandNode(node));
    expect(set.concrete.size).toBe(0);
    expect(set.wildcardNs.size).toBe(0);
  });

  it('exclusion: wildcard base minus a DIFFERENT namespace subtract passes the wildcard through unchanged (no overlap to worry about)', () => {
    const node: ExpandNode = {
      kind: 'exclusion',
      object: ref('document', 'readme'),
      base: wildcardLeaf(ref('document', 'readme'), 'viewer', 'user'),
      subtract: relationLeaf(ref('document', 'readme'), 'banned', ['zara']),
    };
    // 'banned' here names a subject of namespace 'group', not 'user' — a
    // genuinely disjoint namespace from the one 'viewer' wildcards, so
    // there is no co-finite ambiguity: the wildcard passes through intact.
    const disjointNode: ExpandNode = {
      ...node,
      subtract: {
        kind: 'relation',
        object: ref('document', 'readme'),
        relation: 'banned',
        directSubjects: [concrete('group', 'zara')],
        usersets: [],
      },
    };
    const set = asMemberSet(evaluateExpandNode(disjointNode));
    expect([...set.wildcardNs]).toEqual(['user']);
    expect(set.concrete.size).toBe(0);
  });

  it('exclusion: a wildcard base minus finitely many CONCRETE exceptions of the SAME namespace is genuinely co-finite — refuses rather than approximating', () => {
    const node: ExpandNode = {
      kind: 'exclusion',
      object: ref('document', 'readme'),
      base: wildcardLeaf(ref('document', 'readme'), 'viewer', 'user'),
      subtract: relationLeaf(ref('document', 'readme'), 'banned', ['zara']),
    };
    const result = evaluateExpandNode(node);
    expect(isUnenumerable(result)).toBe(true);
    if (isUnenumerable(result)) {
      expect(result.ns).toBe('user');
    }
  });

  it('unenumerable propagates through a containing union — one unenumerable branch refuses the whole call', () => {
    const node: ExpandNode = {
      kind: 'union',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'viewer', ['carol']),
        {
          kind: 'exclusion',
          object: ref('document', 'readme'),
          base: wildcardLeaf(ref('document', 'readme'), 'editor', 'user'),
          subtract: relationLeaf(ref('document', 'readme'), 'banned', ['zara']),
        },
      ],
    };
    expect(isUnenumerable(evaluateExpandNode(node))).toBe(true);
  });

  it('unenumerable propagates through a containing intersection', () => {
    const node: ExpandNode = {
      kind: 'intersection',
      object: ref('document', 'readme'),
      children: [
        relationLeaf(ref('document', 'readme'), 'viewer', ['carol']),
        {
          kind: 'exclusion',
          object: ref('document', 'readme'),
          base: wildcardLeaf(ref('document', 'readme'), 'editor', 'user'),
          subtract: relationLeaf(ref('document', 'readme'), 'banned', ['zara']),
        },
      ],
    };
    expect(isUnenumerable(evaluateExpandNode(node))).toBe(true);
  });

  it('tupleToUserset: a wildcard-covered followed object contributes namespace coverage, unioned with a sibling followed object', () => {
    const node: ExpandNode = {
      kind: 'tupleToUserset',
      object: ref('document', 'readme'),
      relation: 'parent',
      computedUserset: 'view',
      children: [
        {
          through: ref('folder', 'design'),
          expansion: wildcardLeaf(ref('folder', 'design'), 'editor', 'user'),
        },
        {
          through: ref('folder', 'specs'),
          expansion: relationLeaf(ref('folder', 'specs'), 'editor', ['bob']),
        },
      ],
    };
    const set = asMemberSet(evaluateExpandNode(node));
    expect([...set.wildcardNs]).toEqual(['user']);
    // bob is redundant once 'user' is wildcard-covered, dropped by the
    // same cleanup unionMemberSets already performs.
    expect(set.concrete.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listObjects — gates 1, 4, 5 of the reverse-lookup accelerant (D-175).
// See this file's own top-of-file doc comment for why these three, and not
// gates 2/3, belong here.
// ---------------------------------------------------------------------------

const ALICE: EntityRef = { ns: 'user', id: 'alice' };
const DOCUMENT_NS = 'document';
const VIEWER = 'viewer';

const ALLOWED = (id: string): ProductionCheckResult => ({
  allowed: true,
  path: { kind: 'directGrant', object: { ns: DOCUMENT_NS, id }, relation: VIEWER, subject: ALICE },
  depth: 1,
  touchedExpiringTuple: false,
});

function bareRelationConfig(subjectTypes: NamespaceConfig['relations'][string]['subjectTypes']) {
  const config: NamespaceConfig = {
    namespace: DOCUMENT_NS,
    relations: { [VIEWER]: { kind: 'relation', name: VIEWER, subjectTypes } },
    permissions: {},
  };
  return config;
}

/**
 * A fake `ConnectionSource` standing in for Postgres, used only for the one
 * raw query `listObjects` can still issue directly — `fetchCandidateObjectIds`'s
 * own namespace-wide scan, exercised whenever a gate below stops the
 * accelerant from engaging. Every call is counted (`calls`) so a test can
 * assert this fallback scan did or didn't run, matching this codebase's own
 * "prove the negative, don't just assume it" discipline (`checks.test.ts`'s
 * own `fakePool` doc comment). `.connect()` throws — `listObjects` never
 * needs a dedicated connection, only plain `.query()`.
 */
function fakePool(candidateObjectIds: string[]): ConnectionSource & { calls: number } {
  const pool = {
    calls: 0,
    async query<Row = Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
      pool.calls++;
      const rows = candidateObjectIds.map((object_id) => ({ object_id }));
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    },
    async connect(): Promise<never> {
      throw new Error('fakePool.connect() should never be called by listObjects');
    },
  };
  return pool;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listObjects — gate 1 (env/per-call useRelationIndex override)', () => {
  it('useRelationIndex:false skips the accelerant entirely — getLatestNamespaceConfig and fetchReverseIndexCandidates are never called', async () => {
    const getConfigSpy = vi.spyOn(publishModule, 'getLatestNamespaceConfig');
    const fetchCandidatesSpy = vi.spyOn(relationIndexModule, 'fetchReverseIndexCandidates');
    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async (_pool, _subj, object) =>
      ALLOWED(object.id),
    );
    const pool = fakePool(['doc1']);

    const result = await listObjects(pool, ALICE, VIEWER, DOCUMENT_NS, { useRelationIndex: false });

    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(fetchCandidatesSpy).not.toHaveBeenCalled();
    expect(pool.calls).toBe(1); // the raw fallback scan did run
    expect(result).toEqual({ objects: [{ ns: DOCUMENT_NS, id: 'doc1' }], truncated: false });
  });
});

describe('listObjects — gate 4 (schema lookup: undeclared namespace, or a permission rather than a bare relation)', () => {
  it('useRelationIndex:true but no published schema for the namespace — a miss, never calls fetchReverseIndexCandidates', async () => {
    vi.spyOn(publishModule, 'getLatestNamespaceConfig').mockResolvedValue(undefined);
    const fetchCandidatesSpy = vi.spyOn(relationIndexModule, 'fetchReverseIndexCandidates');
    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async (_pool, _subj, object) =>
      ALLOWED(object.id),
    );
    const pool = fakePool(['doc1']);

    const result = await listObjects(pool, ALICE, VIEWER, DOCUMENT_NS, { useRelationIndex: true });

    expect(fetchCandidatesSpy).not.toHaveBeenCalled();
    expect(pool.calls).toBe(1);
    expect(result).toEqual({ objects: [{ ns: DOCUMENT_NS, id: 'doc1' }], truncated: false });
  });

  it('useRelationIndex:true, but the name is a permission, not a bare relation (permissions and relations are separate maps — a permission name is never in `relations`) — a miss, never calls fetchReverseIndexCandidates', async () => {
    const config: NamespaceConfig = {
      namespace: DOCUMENT_NS,
      relations: {},
      permissions: {
        view: {
          kind: 'permission',
          name: 'view',
          rewrite: { kind: 'computedUserset', name: VIEWER },
        },
      },
    };
    vi.spyOn(publishModule, 'getLatestNamespaceConfig').mockResolvedValue(config);
    const fetchCandidatesSpy = vi.spyOn(relationIndexModule, 'fetchReverseIndexCandidates');
    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async (_pool, _subj, object) =>
      ALLOWED(object.id),
    );
    const pool = fakePool(['doc1']);

    const result = await listObjects(pool, ALICE, 'view', DOCUMENT_NS, { useRelationIndex: true });

    expect(fetchCandidatesSpy).not.toHaveBeenCalled();
    expect(pool.calls).toBe(1);
    expect(result).toEqual({ objects: [{ ns: DOCUMENT_NS, id: 'doc1' }], truncated: false });
  });
});

describe('listObjects — gate 5 (a wildcard-capable subject type always misses the accelerant)', () => {
  it('the relation accepts a wildcard subject type — a miss, never calls fetchReverseIndexCandidates', async () => {
    vi.spyOn(publishModule, 'getLatestNamespaceConfig').mockResolvedValue(
      bareRelationConfig([{ namespace: 'user', wildcard: true }]),
    );
    const fetchCandidatesSpy = vi.spyOn(relationIndexModule, 'fetchReverseIndexCandidates');
    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async (_pool, _subj, object) =>
      ALLOWED(object.id),
    );
    const pool = fakePool(['doc1']);

    const result = await listObjects(pool, ALICE, VIEWER, DOCUMENT_NS, { useRelationIndex: true });

    expect(fetchCandidatesSpy).not.toHaveBeenCalled();
    expect(pool.calls).toBe(1);
    expect(result).toEqual({ objects: [{ ns: DOCUMENT_NS, id: 'doc1' }], truncated: false });
  });

  it('a relation with only non-wildcard subject types passes gate 5 and does call fetchReverseIndexCandidates', async () => {
    vi.spyOn(publishModule, 'getLatestNamespaceConfig').mockResolvedValue(
      bareRelationConfig([{ namespace: 'user' }]),
    );
    const fetchCandidatesSpy = vi
      .spyOn(relationIndexModule, 'fetchReverseIndexCandidates')
      .mockResolvedValue({ hit: false });
    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async (_pool, _subj, object) =>
      ALLOWED(object.id),
    );
    const pool = fakePool(['doc1']);

    const result = await listObjects(pool, ALICE, VIEWER, DOCUMENT_NS, { useRelationIndex: true });

    expect(fetchCandidatesSpy).toHaveBeenCalledTimes(1);
    // Gate 2/3 (fetchReverseIndexCandidates itself) missed here, so
    // listObjects still falls back to the raw scan — proving gate 5 alone
    // doesn't block the call, only a *wildcard* subject type does.
    expect(pool.calls).toBe(1);
    expect(result).toEqual({ objects: [{ ns: DOCUMENT_NS, id: 'doc1' }], truncated: false });
  });
});

describe('listObjects — the accelerant actually engaging (all five gates pass)', () => {
  it('a fetchReverseIndexCandidates hit replaces the raw candidate scan entirely — the raw scan never runs, and its own truncated flag propagates unchanged', async () => {
    vi.spyOn(publishModule, 'getLatestNamespaceConfig').mockResolvedValue(
      bareRelationConfig([{ namespace: 'user' }]),
    );
    vi.spyOn(relationIndexModule, 'fetchReverseIndexCandidates').mockResolvedValue({
      hit: true,
      objectIds: ['doc1', 'doc2'],
      truncated: true,
    });
    const productionCheckSpy = vi
      .spyOn(productionModule, 'productionCheck')
      .mockImplementation(async (_pool, _subj, object) => ALLOWED(object.id));
    const pool = fakePool(['some-other-doc-the-raw-scan-would-have-found']);

    const result = await listObjects(pool, ALICE, VIEWER, DOCUMENT_NS, { useRelationIndex: true });

    expect(pool.calls).toBe(0); // the raw scan never ran at all
    expect(productionCheckSpy).toHaveBeenCalledTimes(2);
    const checkedIds = productionCheckSpy.mock.calls.map(([, , object]) => object.id).sort();
    expect(checkedIds).toEqual(['doc1', 'doc2']);
    expect(result).toEqual({
      objects: [
        { ns: DOCUMENT_NS, id: 'doc1' },
        { ns: DOCUMENT_NS, id: 'doc2' },
      ],
      truncated: true, // the accelerant's own value, not recomputed
    });
  });
});

// ---------------------------------------------------------------------------
// hasAnyGrant (D-186) — the early-exit sibling driving src/audit/scope.ts's
// queryScope. These DB-free unit tests prove the one thing the real-Postgres
// integration tests (test/unit/audit/list.integration.test.ts) can't easily
// observe directly: that a further batch is never even dispatched once an
// earlier one already found a hit — a real call-count assertion, not just a
// correct final answer that could coincidentally also be produced by
// checking every candidate. Reuses this file's own fakePool/ALLOWED/
// bareRelationConfig helpers exactly as listObjects's own gate tests above do.
// ---------------------------------------------------------------------------

const DENIED: ProductionCheckResult = { allowed: false, depth: 1, touchedExpiringTuple: false };

describe('hasAnyGrant — early-exit aggregation, a real call-count proof', () => {
  const ORIGINAL_MAX_CONCURRENCY = env.MAX_CONCURRENCY;

  afterEach(() => {
    env.MAX_CONCURRENCY = ORIGINAL_MAX_CONCURRENCY;
  });

  it('stops dispatching further batches the moment an earlier batch finds a hit — later candidates are never even checked', async () => {
    env.MAX_CONCURRENCY = 2; // deterministic batch size: [c1,c2], [c3,c4], [c5,c6]
    const pool = fakePool(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    const productionCheckSpy = vi
      .spyOn(productionModule, 'productionCheck')
      .mockImplementation(async (_pool, _subj, object) =>
        object.id === 'c2' ? ALLOWED(object.id) : DENIED,
      );

    const result = await hasAnyGrant(pool, ALICE, VIEWER, DOCUMENT_NS);

    expect(result).toEqual({ granted: true, truncated: false });
    // Only the first batch (c1, c2) was ever dispatched — c3 through c6
    // (the second and third batches) are never checked at all.
    expect(productionCheckSpy).toHaveBeenCalledTimes(2);
    const checkedIds = productionCheckSpy.mock.calls.map(([, , object]) => object.id).sort();
    expect(checkedIds).toEqual(['c1', 'c2']);
  });

  it('every candidate denied — checks all of them (no early exit possible), granted false, truncated false (a fully proven negative, the candidate scan itself was not capped)', async () => {
    env.MAX_CONCURRENCY = 2;
    const pool = fakePool(['c1', 'c2', 'c3']);
    const productionCheckSpy = vi
      .spyOn(productionModule, 'productionCheck')
      .mockResolvedValue(DENIED);

    const result = await hasAnyGrant(pool, ALICE, VIEWER, DOCUMENT_NS);

    expect(result).toEqual({ granted: false, truncated: false });
    expect(productionCheckSpy).toHaveBeenCalledTimes(3);
  });

  it('truncated is always false when granted is true, even if the underlying candidate scan itself reported truncated:true — one real hit is a complete, exhaustively proven answer regardless of what was left unexamined', async () => {
    vi.spyOn(publishModule, 'getLatestNamespaceConfig').mockResolvedValue(
      bareRelationConfig([{ namespace: 'user' }]),
    );
    vi.spyOn(relationIndexModule, 'fetchReverseIndexCandidates').mockResolvedValue({
      hit: true,
      objectIds: ['doc1'],
      truncated: true, // the accelerant itself says "more exist, unexamined"
    });
    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async (_pool, _subj, object) =>
      ALLOWED(object.id),
    );
    const pool = fakePool([]);

    const result = await hasAnyGrant(pool, ALICE, VIEWER, DOCUMENT_NS, { useRelationIndex: true });

    expect(result).toEqual({ granted: true, truncated: false });
  });
});
