/**
 * The guaranteed deep chain (D-070, `docs/DECISIONS.md`) — a fast, DB-free
 * unit test asserting `generateFixture`'s own output actually contains the
 * exact, hand-derivable chain `buildGuaranteedDeepChain`
 * (`src/soundness/generators.ts`) claims to build, for a fixed seed, not
 * merely that the generator *runs* without throwing. No Postgres, no
 * production resolver — every assertion here is either a direct tuple/query
 * shape check against `generateFixture`'s own return value, or a call to the
 * *reference* resolver (`referenceCheck`, pure, in-memory, no I/O), which is
 * enough to confirm the chain is a real, findable path (not a phantom one)
 * without needing the production engine at all — see this file's own
 * top-of-file doc comment on why Postgres-backed verification of the
 * *production* resolver's specific depth-budget behavior against this exact
 * chain lives elsewhere (a throwaway, never-committed LOCALVERIFY probe, per
 * this task's own delegation — not a repeatable committed test, since it
 * would require deliberately reintroducing a real resolver bug at test-run
 * time, which this project's own established discipline treats as unsafe
 * for a committed test file; see `differential-soundness.fuzz.test.ts`'s own
 * doc comment making the identical argument for its "fuzz harness has
 * power" tests).
 *
 * Per `.claude/commands/build-authz-service.md` §6.8 and this file's own
 * sibling `differential-soundness.fuzz.test.ts`, `generateFixture` must stay
 * a pure, deterministic function of `(seed, queryCount)` — every assertion
 * below is checked across several distinct seeds specifically so this test
 * cannot pass by coincidence of one seed's own random draws.
 */
import { describe, expect, it } from 'vitest';

import {
  generateFixture,
  DEEP_CHAIN_HIER_HOPS,
  DEEP_CHAIN_ISOLATED_HOP,
  DEEP_CHAIN_INTERMEDIATE_HOP,
  DEEP_CHAIN_GROUP_HOPS_INSIDE,
  DEEP_CHAIN_GROUP_HOPS_OUTSIDE,
  DEEP_CHAIN_DIRECT_GRANT_USER,
  DEEP_CHAIN_COMBO_INSIDE_USER,
  DEEP_CHAIN_COMBO_OUTSIDE_USER,
  EXCLUSION_DEEP_CHAIN_REACHABLE_HOPS,
  EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS,
  EXCLUSION_DEEP_CHAIN_UNPROVABLE_WITNESS_USER,
  EXCLUSION_DEEP_CHAIN_BOUNDARY_WITNESS_USER,
  EXCLUSION_DEEP_CHAIN_CLEAN_WITNESS_USER,
  type GeneratedFixture,
  type GeneratedTuple,
} from '../../../src/soundness/generators.js';
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import { referenceCheck } from '../../../src/resolve/reference/resolver.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';

const SEEDS = [
  'deep-chain-structure-seed-1',
  'deep-chain-structure-seed-2',
  'deep-chain-structure-seed-42',
  'deep-chain-structure-seed-zzz',
  'deep-chain-structure-seed-öäü', // non-ASCII, matching this project's own identifier-fuzz discipline of not assuming ASCII-only seeds
];
const QUERY_COUNT = 50;

function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected fixture schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

/** `namespaces[0]` is always the group-shaped namespace, `namespaces[1]` always the hierarchical one, `namespaces[2]` always the resource one — `generators.ts`'s own stated, tested guarantee (see `buildGroupNamespaceSource`/`buildHierNamespaceSource`/`buildResourceNamespaceSource`'s doc comments). */
function namespaces(fixture: GeneratedFixture): {
  groupNs: string;
  hierNs: string;
  resourceNs: string;
} {
  const groupNs = fixture.namespaces[0]?.namespace;
  const hierNs = fixture.namespaces[1]?.namespace;
  const resourceNs = fixture.namespaces[2]?.namespace;
  if (!groupNs || !hierNs || !resourceNs) throw new Error('expected at least three namespaces');
  return { groupNs, hierNs, resourceNs };
}

function findTuple(
  tuples: readonly GeneratedTuple[],
  match: Partial<GeneratedTuple>,
): GeneratedTuple | undefined {
  return tuples.find((t) =>
    (Object.keys(match) as Array<keyof GeneratedTuple>).every((k) => t[k] === match[k]),
  );
}

function tuplesOnObject(
  tuples: readonly GeneratedTuple[],
  ns: string,
  id: string,
): GeneratedTuple[] {
  return tuples.filter((t) => t.objectNs === ns && t.objectId === id);
}

describe('the guaranteed deep chain (D-070) — generateFixture always builds it, deterministically, regardless of seed', () => {
  it.each(SEEDS)(
    'seed=%s: the hier parent chain (dc_h0..dc_h%i) is exactly DEEP_CHAIN_HIER_HOPS hops long, every edge present',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { hierNs } = namespaces(fixture);

      for (let i = 1; i <= DEEP_CHAIN_HIER_HOPS; i += 1) {
        const edge = findTuple(fixture.tuples, {
          objectNs: hierNs,
          objectId: `dc_h${i}`,
          relation: 'parent',
          subjectNs: hierNs,
          subjectId: `dc_h${i - 1}`,
        });
        expect(edge, `expected a real dc_h${i} -> dc_h${i - 1} parent edge`).toBeDefined();
      }

      // No edge one hop past the guaranteed chain's own length — the chain's
      // length is exactly DEEP_CHAIN_HIER_HOPS, not "at least".
      const oneTooFar = findTuple(fixture.tuples, {
        objectNs: hierNs,
        objectId: `dc_h${DEEP_CHAIN_HIER_HOPS + 1}`,
        relation: 'parent',
      });
      expect(oneTooFar).toBeUndefined();
    },
  );

  it.each(SEEDS)(
    "seed=%s: dc_h0 carries exactly the two hand-placed editor tuples — a direct grant and the userset edge into the group chain's root",
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs, hierNs } = namespaces(fixture);

      const directGrant = findTuple(fixture.tuples, {
        objectNs: hierNs,
        objectId: 'dc_h0',
        relation: 'editor',
        subjectNs: 'user',
        subjectId: DEEP_CHAIN_DIRECT_GRANT_USER,
      });
      expect(directGrant).toBeDefined();

      const usersetEdge = findTuple(fixture.tuples, {
        objectNs: hierNs,
        objectId: 'dc_h0',
        relation: 'editor',
        subjectNs: groupNs,
        subjectId: 'dc_g0',
        subjectRelation: 'member',
      });
      expect(usersetEdge).toBeDefined();

      // Exactly these two — no stray extra tuple on dc_h0's own editor relation.
      const editorTuples = tuplesOnObject(fixture.tuples, hierNs, 'dc_h0').filter(
        (t) => t.relation === 'editor',
      );
      expect(editorTuples).toHaveLength(2);
    },
  );

  it.each(SEEDS)(
    'seed=%s: the nested group chain (dc_g0..dc_g%i) is exactly DEEP_CHAIN_GROUP_HOPS_OUTSIDE groups, with plain grants at exactly the "inside" and "outside" depths',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs } = namespaces(fixture);

      for (let i = 0; i < DEEP_CHAIN_GROUP_HOPS_OUTSIDE - 1; i += 1) {
        const edge = findTuple(fixture.tuples, {
          objectNs: groupNs,
          objectId: `dc_g${i}`,
          relation: 'member',
          subjectNs: groupNs,
          subjectId: `dc_g${i + 1}`,
          subjectRelation: 'member',
        });
        expect(edge, `expected a real dc_g${i} -> dc_g${i + 1}#member edge`).toBeDefined();
      }

      const insideGrant = findTuple(fixture.tuples, {
        objectNs: groupNs,
        objectId: `dc_g${DEEP_CHAIN_GROUP_HOPS_INSIDE - 1}`,
        relation: 'member',
        subjectNs: 'user',
        subjectId: DEEP_CHAIN_COMBO_INSIDE_USER,
      });
      expect(insideGrant).toBeDefined();

      const outsideGrant = findTuple(fixture.tuples, {
        objectNs: groupNs,
        objectId: `dc_g${DEEP_CHAIN_GROUP_HOPS_OUTSIDE - 1}`,
        relation: 'member',
        subjectNs: 'user',
        subjectId: DEEP_CHAIN_COMBO_OUTSIDE_USER,
      });
      expect(outsideGrant).toBeDefined();
    },
  );

  it.each(SEEDS)(
    'seed=%s: no deep-chain object ever receives an additional, randomly drawn tuple on top of the hand-placed ones — the chain\'s real length is exact, not "at least"',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs, hierNs } = namespaces(fixture);

      // A representative interior hier-chain node: exactly one tuple (its own
      // `parent` edge to the previous node) — never an extra `editor`/`parent`
      // tuple `assignRandomTuples` might otherwise have drawn.
      const interiorHier = tuplesOnObject(fixture.tuples, hierNs, 'dc_h5');
      expect(interiorHier).toHaveLength(1);
      expect(interiorHier[0]?.relation).toBe('parent');

      // A representative interior group-chain node: exactly one tuple (its
      // own `member` edge to the next node).
      const interiorGroup = tuplesOnObject(fixture.tuples, groupNs, 'dc_g5');
      expect(interiorGroup).toHaveLength(1);
      expect(interiorGroup[0]?.relation).toBe('member');

      // dc_g11 ("inside") and dc_g12 ("outside") each carry exactly two
      // tuples: dc_g11 has its own chain edge to dc_g12 AND its plain grant;
      // dc_g12 (the chain's last node) has only its plain grant.
      const insideNode = tuplesOnObject(
        fixture.tuples,
        groupNs,
        `dc_g${DEEP_CHAIN_GROUP_HOPS_INSIDE - 1}`,
      );
      expect(insideNode).toHaveLength(2);
      const outsideNode = tuplesOnObject(
        fixture.tuples,
        groupNs,
        `dc_g${DEEP_CHAIN_GROUP_HOPS_OUTSIDE - 1}`,
      );
      expect(outsideNode).toHaveLength(1);
    },
  );

  it.each(SEEDS)(
    'seed=%s: the four reserved deep-chain queries (indices 2-5) are present, in order, with the exact hand-derived subject/object/relation shape',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { hierNs } = namespaces(fixture);

      expect(fixture.queries[2]).toEqual({
        subject: { ns: 'user', id: DEEP_CHAIN_DIRECT_GRANT_USER },
        object: { ns: hierNs, id: `dc_h${DEEP_CHAIN_ISOLATED_HOP}` },
        relationOrPermission: 'view',
      });
      expect(fixture.queries[3]).toEqual({
        subject: { ns: 'user', id: DEEP_CHAIN_DIRECT_GRANT_USER },
        object: { ns: hierNs, id: `dc_h${DEEP_CHAIN_HIER_HOPS}` },
        relationOrPermission: 'view',
      });
      expect(fixture.queries[4]).toEqual({
        subject: { ns: 'user', id: DEEP_CHAIN_COMBO_INSIDE_USER },
        object: { ns: hierNs, id: `dc_h${DEEP_CHAIN_INTERMEDIATE_HOP}` },
        relationOrPermission: 'view',
      });
      expect(fixture.queries[5]).toEqual({
        subject: { ns: 'user', id: DEEP_CHAIN_COMBO_OUTSIDE_USER },
        object: { ns: hierNs, id: `dc_h${DEEP_CHAIN_INTERMEDIATE_HOP}` },
        relationOrPermission: 'view',
      });
    },
  );

  it.each(SEEDS)(
    'seed=%s: all four reserved deep-chain queries are real, findable paths — the reference resolver (generous 1000-hop ceiling) allows every one of them',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const schema = compileOk(fixture.schemaSource);

      for (const index of [2, 3, 4, 5]) {
        const query = fixture.queries[index];
        expect(query, `expected a reserved query at index ${index}`).toBeDefined();
        if (!query) continue;
        const result = referenceCheck(
          schema,
          fixture.tuples,
          query.subject,
          query.object,
          query.relationOrPermission,
        );
        expect(
          result.allowed,
          `expected reference resolver to allow reserved query index ${index} (a real, hand-built chain)`,
        ).toBe(true);
      }
    },
  );

  it.each(SEEDS)(
    'seed=%s: the deep chain does not disturb the two pre-existing cyclic reserved queries (indices 0-1) or the guaranteed cycle/coverage invariants',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs } = namespaces(fixture);

      expect(fixture.queries[1]).toEqual({
        subject: { ns: 'user', id: expect.any(String) },
        object: { ns: groupNs, id: 'cycle_a' },
        relationOrPermission: 'view',
      });
      expect(fixture.coverage.hasCycle).toBe(true);
      expect(fixture.coverage.ok).toBe(true);
    },
  );

  it('is a pure function of (seed, queryCount) — replaying the same seed reproduces the exact same deep-chain tuples and reserved queries, byte-identical', () => {
    const seed = 'deep-chain-reproducibility-seed';
    const first = generateFixture(seed, QUERY_COUNT);
    const second = generateFixture(seed, QUERY_COUNT);

    const { hierNs: hierNs1 } = namespaces(first);
    const { hierNs: hierNs2 } = namespaces(second);
    expect(hierNs2).toBe(hierNs1);

    const deepChainTuples1 = first.tuples.filter(
      (t) => t.objectId.startsWith('dc_h') || t.objectId.startsWith('dc_g'),
    );
    const deepChainTuples2 = second.tuples.filter(
      (t) => t.objectId.startsWith('dc_h') || t.objectId.startsWith('dc_g'),
    );
    expect(deepChainTuples2).toEqual(deepChainTuples1);
    expect(second.queries.slice(2, 6)).toEqual(first.queries.slice(2, 6));
  });

  it('a queryCount below 6 omits whichever reserved deep-chain queries do not fit, without throwing — the same graceful-degradation shape the two pre-existing cyclic reserved queries already have', () => {
    for (let queryCount = 0; queryCount <= 6; queryCount += 1) {
      const fixture = generateFixture('deep-chain-small-query-count-seed', queryCount);
      expect(fixture.queries.length).toBe(queryCount <= 6 ? queryCount : 6);
    }
  });
});

/**
 * The guaranteed exclusion-subtract deep chain (closing D-159/D-160's own
 * disclosed follow-up gap, `docs/DECISIONS.md`) — the same discipline as
 * the D-070 suite above: every assertion is either a direct tuple/query
 * shape check against `generateFixture`'s own return value, or a call to
 * the *reference* resolver at an EXPLICIT `maxDepth` matching what
 * `runSoundnessFuzz`'s own standard invocation actually resolves
 * (`env.CHECK_MAX_DEPTH`'s documented default, 25 — D-071 unifies this
 * across both resolvers), never the reference resolver's own generous
 * `DEFAULT_REFERENCE_MAX_DEPTH` default, which would silently prove the
 * wrong thing here (this construct's whole point depends on the DEPTH
 * ACTUALLY USED, not "is there eventually a real path somewhere").
 * Postgres-backed verification of the *production* resolver's specific
 * behavior against this exact chain, and the D-159-bug-reintroduced
 * catch-rate at the real standard fuzz configuration, lives elsewhere (a
 * throwaway, never-committed LOCALVERIFY probe — see this file's own
 * top-of-file doc comment for the identical argument applied to D-070's
 * construct).
 */
describe('the guaranteed exclusion-subtract deep chain (D-159/D-160 follow-up) — generateFixture always builds it, deterministically, regardless of seed', () => {
  const STANDARD_MAX_DEPTH = 25; // env.CHECK_MAX_DEPTH's documented default (.env.example, src/config/env.ts) — see EXCLUSION_DEEP_CHAIN_* constants' own doc comment for the full derivation this depends on.

  it.each(SEEDS)(
    'seed=%s: the banned-membership chain (edc_g1..edc_g%i) is exactly EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS groups, every edge present, resource#banned wired into edc_g1',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs, resourceNs } = namespaces(fixture);

      const seedEdge = findTuple(fixture.tuples, {
        objectNs: resourceNs,
        objectId: 'edc_resource',
        relation: 'banned',
        subjectNs: groupNs,
        subjectId: 'edc_g1',
        subjectRelation: 'member',
      });
      expect(seedEdge, 'expected a real resource#banned -> edc_g1#member edge').toBeDefined();

      for (let i = 1; i < EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS; i += 1) {
        const edge = findTuple(fixture.tuples, {
          objectNs: groupNs,
          objectId: `edc_g${i}`,
          relation: 'member',
          subjectNs: groupNs,
          subjectId: `edc_g${i + 1}`,
          subjectRelation: 'member',
        });
        expect(edge, `expected a real edc_g${i} -> edc_g${i + 1}#member edge`).toBeDefined();
      }

      // No edge one hop past the chain's own length — the chain's length is
      // exactly EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS, not "at least".
      const oneTooFar = findTuple(fixture.tuples, {
        objectNs: groupNs,
        objectId: `edc_g${EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS}`,
        relation: 'member',
        subjectRelation: 'member',
      });
      expect(oneTooFar).toBeUndefined();
    },
  );

  it.each(SEEDS)(
    'seed=%s: edc_g%i (the reachable boundary) carries a real plain grant to the boundary witness; edc_g%i (one hop past it) carries the real plain grant to the unprovable witness',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs } = namespaces(fixture);

      const boundaryGrant = findTuple(fixture.tuples, {
        objectNs: groupNs,
        objectId: `edc_g${EXCLUSION_DEEP_CHAIN_REACHABLE_HOPS}`,
        relation: 'member',
        subjectNs: 'user',
        subjectId: EXCLUSION_DEEP_CHAIN_BOUNDARY_WITNESS_USER,
      });
      expect(boundaryGrant).toBeDefined();

      const unprovableGrant = findTuple(fixture.tuples, {
        objectNs: groupNs,
        objectId: `edc_g${EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS}`,
        relation: 'member',
        subjectNs: 'user',
        subjectId: EXCLUSION_DEEP_CHAIN_UNPROVABLE_WITNESS_USER,
      });
      expect(unprovableGrant).toBeDefined();
    },
  );

  it.each(SEEDS)(
    'seed=%s: no exclusion-deep-chain object ever receives an additional, randomly drawn tuple on top of the hand-placed ones — the chain\'s real length is exact, not "at least"',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { groupNs, resourceNs } = namespaces(fixture);

      // A representative interior chain node: exactly one tuple (its own
      // `member` edge to the next node).
      const interior = tuplesOnObject(fixture.tuples, groupNs, 'edc_g5');
      expect(interior).toHaveLength(1);
      expect(interior[0]?.relation).toBe('member');

      // edc_g24 ("reachable boundary") carries exactly two tuples: its own
      // chain edge to edc_g25 AND its plain grant to the boundary witness.
      const boundaryNode = tuplesOnObject(
        fixture.tuples,
        groupNs,
        `edc_g${EXCLUSION_DEEP_CHAIN_REACHABLE_HOPS}`,
      );
      expect(boundaryNode).toHaveLength(2);

      // edc_g25 (the chain's last node) carries exactly one tuple: its own
      // plain grant to the unprovable witness — no further chain edge.
      const unreachableNode = tuplesOnObject(
        fixture.tuples,
        groupNs,
        `edc_g${EXCLUSION_DEEP_CHAIN_UNREACHABLE_HOPS}`,
      );
      expect(unreachableNode).toHaveLength(1);

      // `edc_resource` carries exactly three tuples: the one `banned` seed
      // edge into the chain, plus two direct `viewer` grants (unprovable
      // and boundary witnesses only — the clean witness lives on a SEPARATE
      // object, see buildExclusionSubtractDeepChain's own doc comment).
      const resourceTuples = tuplesOnObject(fixture.tuples, resourceNs, 'edc_resource');
      expect(resourceTuples).toHaveLength(3);

      // `edc_resource_clean` carries exactly one tuple: the clean witness's
      // own direct `viewer` grant — zero `banned` tuples, by construction.
      const cleanResourceTuples = tuplesOnObject(fixture.tuples, resourceNs, 'edc_resource_clean');
      expect(cleanResourceTuples).toHaveLength(1);
      expect(cleanResourceTuples[0]?.relation).toBe('viewer');
      const cleanBannedTuples = cleanResourceTuples.filter((t) => t.relation === 'banned');
      expect(cleanBannedTuples).toHaveLength(0);
    },
  );

  it.each(SEEDS)(
    'seed=%s: the three reserved exclusion-deep-chain queries (indices 6-8) are present, in order, with the exact hand-derived subject/object/relation shape',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { resourceNs } = namespaces(fixture);

      expect(fixture.queries[6]).toEqual({
        subject: { ns: 'user', id: EXCLUSION_DEEP_CHAIN_UNPROVABLE_WITNESS_USER },
        object: { ns: resourceNs, id: 'edc_resource' },
        relationOrPermission: 'unbanned_view',
      });
      expect(fixture.queries[7]).toEqual({
        subject: { ns: 'user', id: EXCLUSION_DEEP_CHAIN_BOUNDARY_WITNESS_USER },
        object: { ns: resourceNs, id: 'edc_resource' },
        relationOrPermission: 'unbanned_view',
      });
      expect(fixture.queries[8]).toEqual({
        subject: { ns: 'user', id: EXCLUSION_DEEP_CHAIN_CLEAN_WITNESS_USER },
        object: { ns: resourceNs, id: 'edc_resource_clean' },
        relationOrPermission: 'unbanned_view',
      });
    },
  );

  it.each(SEEDS)(
    "seed=%s: at the standard fuzz configuration's own effective maxDepth (25), the reference resolver DENIES the unprovable witness (fails closed on genuine uncertainty, never a certain disproof) and the boundary witness (a real, certain, found grant), and ALLOWS the clean witness",
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const schema = compileOk(fixture.schemaSource);

      const unprovableQuery = fixture.queries[6];
      const boundaryQuery = fixture.queries[7];
      const cleanQuery = fixture.queries[8];
      expect(unprovableQuery).toBeDefined();
      expect(boundaryQuery).toBeDefined();
      expect(cleanQuery).toBeDefined();
      if (!unprovableQuery || !boundaryQuery || !cleanQuery) return;

      const unprovableResult = referenceCheck(
        schema,
        fixture.tuples,
        unprovableQuery.subject,
        unprovableQuery.object,
        unprovableQuery.relationOrPermission,
        { maxDepth: STANDARD_MAX_DEPTH },
      );
      expect(
        unprovableResult.allowed,
        'a correct resolver must deny the unprovable witness at the real standard depth — this is the exact D-159 bug-shape trigger; ALLOWED here would mean the construct itself is unsound',
      ).toBe(false);

      const boundaryResult = referenceCheck(
        schema,
        fixture.tuples,
        boundaryQuery.subject,
        boundaryQuery.object,
        boundaryQuery.relationOrPermission,
        { maxDepth: STANDARD_MAX_DEPTH },
      );
      expect(boundaryResult.allowed).toBe(false);

      const cleanResult = referenceCheck(
        schema,
        fixture.tuples,
        cleanQuery.subject,
        cleanQuery.object,
        cleanQuery.relationOrPermission,
        { maxDepth: STANDARD_MAX_DEPTH },
      );
      expect(cleanResult.allowed).toBe(true);
    },
  );

  it.each(SEEDS)(
    "seed=%s: the unprovable witness's own real chain to `banned` is genuinely findable at a generous depth — a real, hand-built path, not a phantom one",
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const schema = compileOk(fixture.schemaSource);
      const { resourceNs } = namespaces(fixture);

      const generousResult = referenceCheck(
        schema,
        fixture.tuples,
        { ns: 'user', id: EXCLUSION_DEEP_CHAIN_UNPROVABLE_WITNESS_USER },
        { ns: resourceNs, id: 'edc_resource' },
        'banned',
        { maxDepth: 1000 },
      );
      expect(
        generousResult.allowed,
        'expected the unprovable witness to be a real, findable banned-member at a generous depth — proving the chain this construct depends on is real, not a phantom the reference resolver could never confirm either',
      ).toBe(true);
    },
  );

  it.each(SEEDS)(
    'seed=%s: the exclusion-deep-chain does not disturb the pre-existing reserved queries (indices 0-5) or the guaranteed cycle/coverage invariants',
    (seed) => {
      const fixture = generateFixture(seed, QUERY_COUNT);
      const { hierNs } = namespaces(fixture);

      expect(fixture.queries[3]).toEqual({
        subject: { ns: 'user', id: DEEP_CHAIN_DIRECT_GRANT_USER },
        object: { ns: hierNs, id: `dc_h${DEEP_CHAIN_HIER_HOPS}` },
        relationOrPermission: 'view',
      });
      expect(fixture.coverage.hasCycle).toBe(true);
      expect(fixture.coverage.ok).toBe(true);
    },
  );

  it('is a pure function of (seed, queryCount) — replaying the same seed reproduces the exact same exclusion-deep-chain tuples and reserved queries, byte-identical', () => {
    const seed = 'exclusion-deep-chain-reproducibility-seed';
    const first = generateFixture(seed, QUERY_COUNT);
    const second = generateFixture(seed, QUERY_COUNT);

    const exclusionChainTuples1 = first.tuples.filter(
      (t) => t.objectId.startsWith('edc_g') || t.objectId.startsWith('edc_resource'),
    );
    const exclusionChainTuples2 = second.tuples.filter(
      (t) => t.objectId.startsWith('edc_g') || t.objectId.startsWith('edc_resource'),
    );
    expect(exclusionChainTuples2).toEqual(exclusionChainTuples1);
    expect(second.queries.slice(6, 9)).toEqual(first.queries.slice(6, 9));
  });

  it('a queryCount below 9 omits whichever reserved exclusion-deep-chain queries do not fit, without throwing — the same graceful-degradation shape the pre-existing reserved queries already have', () => {
    for (let queryCount = 0; queryCount <= 9; queryCount += 1) {
      const fixture = generateFixture('exclusion-deep-chain-small-query-count-seed', queryCount);
      expect(fixture.queries.length).toBe(queryCount);
    }
  });
});
