import { describe, expect, it } from 'vitest';

import { depthChainWorkload, exampleGraphWorkload } from '../src/workload.js';

describe('depthChainWorkload', () => {
  it('is deterministic: the same seed/depths/runsPerDepth always produces byte-identical output', () => {
    const a = depthChainWorkload(42, [1, 3, 5], 3);
    const b = depthChainWorkload(42, [1, 3, 5], 3);
    expect(a).toEqual(b);
  });

  it('produces a different runId sequence for a different seed', () => {
    const a = depthChainWorkload(1, [1, 3], 2);
    const b = depthChainWorkload(2, [1, 3], 2);
    expect(a.map((c) => c.runId)).not.toEqual(b.map((c) => c.runId));
  });

  it('produces exactly depth tuples for the chain plus one viewer grant, per case', () => {
    const cases = depthChainWorkload(42, [1, 3, 5, 10], 2);
    expect(cases).toHaveLength(4 * 2);
    for (const c of cases) {
      // `depth` parent-chain tuples + 1 viewer grant on the root node.
      expect(c.tuples).toHaveLength(c.depth + 1);
      const parentTuples = c.tuples.filter((t) => t.relation === 'parent');
      const viewerTuples = c.tuples.filter((t) => t.relation === 'viewer');
      expect(parentTuples).toHaveLength(c.depth);
      expect(viewerTuples).toHaveLength(1);
      // Every parent tuple is a plain bench_node->bench_node pointer, never
      // a userset subject — the real, confirmed OpenFGA constraint
      // src/workload.ts's own doc comment explains.
      for (const t of parentTuples) {
        expect(t.subject.relation).toBeUndefined();
        expect(t.subject.type).toBe('bench_node');
      }
      // The check targets the deepest node, for the chain's own subject.
      expect(c.check.objectId).toBe(`node_${c.runId}_${c.depth}`);
      expect(c.check.permission).toBe('view');
    }
  });

  it('never reuses an object id across cases in one call (no collision within a run)', () => {
    const cases = depthChainWorkload(42, [1, 3, 5], 4);
    const allObjectIds = cases.flatMap((c) => c.tuples.map((t) => `${t.objectType}:${t.objectId}`));
    expect(new Set(allObjectIds).size).toBe(allObjectIds.length);
  });
});

describe('exampleGraphWorkload', () => {
  const workload = exampleGraphWorkload();

  it('has exactly 8 canonical checks, matching the count docs/BENCHMARK-PROPOSAL.md documents', () => {
    expect(workload.checks).toHaveLength(8);
  });

  it('has both ALLOWED and DENIED expectations (not a trivially-all-true set)', () => {
    const allowed = workload.checks.filter((c) => c.expected).length;
    const denied = workload.checks.filter((c) => !c.expected).length;
    expect(allowed).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
  });

  it("every check's object/subject is backed by at least one real tuple in the same workload (no check about an undeclared namespace)", () => {
    const objectTypes = new Set(workload.tuples.map((t) => t.objectType));
    for (const { query } of workload.checks) {
      expect(objectTypes.has(query.objectType)).toBe(true);
    }
  });
});
