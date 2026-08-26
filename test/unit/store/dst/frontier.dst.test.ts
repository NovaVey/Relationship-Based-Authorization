/**
 * DB-free unit tests for `fetchReachableFrontierVia` — `src/store/dst/
 * frontier.ts`'s own doc comment lays out the three fidelity properties
 * these tests pin down against real, hand-computed expected outputs
 * before the far slower, real-Postgres differential-equivalence suite
 * (`docs/DECISIONS.md` D-100,
 * `test/unit/resolve/production/frontier-equivalence.integration.test.ts`)
 * ever runs. This file builds `FakeStoreState` graphs directly (bypassing
 * `writeTuple`'s own write path entirely — this is a pure unit test of the
 * BFS algorithm itself, not of the write path, so direct state
 * construction is the right tool, matching `state.ts`'s own
 * `seedNamespaceConfig` precedent for exactly this reason).
 */
import { describe, expect, it } from 'vitest';

import { createFakeStoreState, type FakeStoreState } from '../../../../src/store/dst/state.js';
import { fetchReachableFrontierVia } from '../../../../src/store/dst/frontier.js';

let nextTupleId = 1;

/** Directly appends one real userset-subject edge to `state` — no write path, no locking, no schema validation; see this file's own top-of-file doc comment. */
function pushEdge(
  state: FakeStoreState,
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation: string,
  commitSeq = 1,
): void {
  state.relationTuples.push({
    id: String(nextTupleId++),
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    subjectRelation,
    createdAt: new Date(0),
    commitSeq,
    expiresAt: null, // D-144 — this file's own fixtures never test expiry
  });
}

function identity(ns: string, id: string, relation: string): string {
  return `${ns}:${id}#${relation}`;
}

describe('fetchReachableFrontierVia — property 1: iterative, working-table semantics (only the previous round own output is ever expanded)', () => {
  it('a-linear-chain-is-discovered-one-depth-per-round-in-order', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member');
    pushEdge(state, 'group', 'a', 'member', 'group', 'b', 'member');
    pushEdge(state, 'group', 'b', 'member', 'group', 'c', 'member');

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 10, undefined);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => identity(r.ns, r.id, r.relation))).toEqual([
      identity('group', 'root', 'member'),
      identity('group', 'a', 'member'),
      identity('group', 'b', 'member'),
      identity('group', 'c', 'member'),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
    // The winning row's own path is a real root-to-node walk through real edges.
    expect(rows[3]?.path).toEqual([
      identity('group', 'root', 'member'),
      identity('group', 'a', 'member'),
      identity('group', 'b', 'member'),
      identity('group', 'c', 'member'),
    ]);
  });

  it('an-empty-graph-with-no-outgoing-edges-at-all-returns-only-the-seed-row', () => {
    const state = createFakeStoreState();
    const rows = fetchReachableFrontierVia(state, 'group', 'lonely', 'member', 10, undefined);
    expect(rows).toEqual([
      {
        ns: 'group',
        id: 'lonely',
        relation: 'member',
        depth: 0,
        path: [identity('group', 'lonely', 'member')],
      },
    ]);
  });
});

describe('fetchReachableFrontierVia — the maxDepth cap (the exact boundary D2 own review caught a real bug in, D-099)', () => {
  it('maxDepth-0-never-recurses-even-with-a-real-outgoing-edge-present', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member');

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 0, undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(0);
  });

  it('a-chain-longer-than-maxDepth-is-truncated-at-exactly-the-boundary', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member');
    pushEdge(state, 'group', 'a', 'member', 'group', 'b', 'member');
    pushEdge(state, 'group', 'b', 'member', 'group', 'c', 'member');

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 2, undefined);

    // root(0), a(1), b(2) — c would be depth 3, past the cap; b's own
    // depth (2) fails the real query's own `m.depth < $4` guard (2 < 2 is
    // false), so b is never expanded, exactly like real Postgres.
    expect(rows.map((r) => r.id)).toEqual(['root', 'a', 'b']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });
});

describe('fetchReachableFrontierVia — property 3: per-row path cycle guard, not a global visited set', () => {
  it('a-real-cycle-terminates-on-its-own-via-the-cycle-guard-before-any-depth-cap-is-even-reached', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member');
    pushEdge(state, 'group', 'a', 'member', 'group', 'b', 'member');
    pushEdge(state, 'group', 'b', 'member', 'group', 'a', 'member'); // cycles back

    // maxDepth generously large — if the cycle guard didn't work, this
    // would either loop forever (it can't, given the while-bound) or
    // silently re-add 'a' a second time; asserting the exact row count
    // proves it terminated via zero-new-rows, not via exhausting maxDepth.
    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, undefined);

    expect(rows.map((r) => r.id)).toEqual(['root', 'a', 'b']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it('a-self-loop-is-excluded-immediately-leaving-only-the-seed-row', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'root', 'member');

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(0);
  });

  it('the-identical-node-reached-again-at-a-later-unrelated-iteration-is-not-deduped-by-this-function-matching-real-postgres', () => {
    // root -> a -> target (target reached at depth 2)
    // root -> x -> y -> target (target reached again at depth 3, via a
    // completely different path whose own ancestor list never mentions
    // 'target' until this point) — a genuinely different round, not a
    // same-iteration collision, so property 2's dedup does not apply here.
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member');
    pushEdge(state, 'group', 'a', 'member', 'group', 'target', 'member');
    pushEdge(state, 'group', 'root', 'member', 'group', 'x', 'member');
    pushEdge(state, 'group', 'x', 'member', 'group', 'y', 'member');
    pushEdge(state, 'group', 'y', 'member', 'group', 'target', 'member');

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, undefined);

    const targetRows = rows.filter((r) => r.id === 'target');
    expect(targetRows).toHaveLength(2);
    expect(targetRows.map((r) => r.depth).sort()).toEqual([2, 3]);
    // dedupeFrontier (resolver.ts, unchanged, applied downstream by
    // sqlRelationMembershipWithWitness) is what collapses this down to
    // the min-depth occurrence for correctness — this function's own job
    // is only to match the real query's raw, undeduped-across-iterations
    // output, which it does here.
  });
});

describe('fetchReachableFrontierVia — property 2: per-iteration DISTINCT ON dedup, not global (the reconvergent diamond)', () => {
  it('a-single-diamond-root-A-C-and-root-B-C-collapses-C-to-one-row-not-two-at-the-same-depth', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member');
    pushEdge(state, 'group', 'root', 'member', 'group', 'b', 'member');
    pushEdge(state, 'group', 'a', 'member', 'group', 'c', 'member');
    pushEdge(state, 'group', 'b', 'member', 'group', 'c', 'member');

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, undefined);

    // Exactly 4 raw rows — root, a, b, and ONE c (not two) — proving the
    // same-iteration collision on c's own identity was collapsed, per
    // this file's own top-of-file doc comment on why comparing the *set*
    // of reached identities (never raw paths) is the correct assertion
    // shape here: which of a/b's own path "wins" for c is deliberately
    // left unasserted.
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(new Set(byId.keys())).toEqual(new Set(['root', 'a', 'b', 'c']));
    expect(byId.get('a')?.depth).toBe(1);
    expect(byId.get('b')?.depth).toBe(1);
    expect(byId.get('c')?.depth).toBe(2);
  });

  /**
   * D-092's own named hardest known case (`docs/DECISIONS.md`): "a
   * 12-level, branching-3 chain of reconvergent diamonds ... produces
   * b^d rows for only b·d distinct nodes" without per-iteration dedup —
   * the exponential blowup the real `DISTINCT ON` fix closed. This
   * function's own dedup (property 2) is the identical fix, in-memory —
   * proven here by asserting the exact distinct-node count (never
   * exponential) and that it completes instantly, not by timing it
   * against a 20-second real-Postgres-shaped budget (meaningless for
   * pure in-memory JS on ~37 nodes either way).
   */
  it('the-12-level-branching-3-reconvergent-diamond-chain-reaches-exactly-1-plus-36-nodes-with-no-blowup', () => {
    const state = createFakeStoreState();
    const LEVELS = 12;
    const BRANCHING = 3;
    let previousLevelIds: string[] = ['root'];
    for (let level = 1; level <= LEVELS; level += 1) {
      const thisLevelIds = Array.from({ length: BRANCHING }, (_, i) => `L${level}_${i}`);
      for (const parentId of previousLevelIds) {
        for (const childId of thisLevelIds) {
          pushEdge(state, 'group', parentId, 'member', 'group', childId, 'member');
        }
      }
      previousLevelIds = thisLevelIds;
    }

    const rows = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, undefined);

    // 1 (root) + 12 levels * 3 nodes each = 37 total rows — every one of
    // them a genuinely distinct identity (no duplicate id appears twice,
    // unlike the earlier "reached again at a later iteration" test —
    // this graph has no such cross-level re-convergence by construction).
    expect(rows).toHaveLength(1 + LEVELS * BRANCHING);
    expect(new Set(rows.map((r) => identity(r.ns, r.id, r.relation))).size).toBe(rows.length);
    expect(rows[rows.length - 1]?.depth).toBe(LEVELS);
  });
});

describe('fetchReachableFrontierVia — snapshot visibility (D2/D3 composition)', () => {
  it('an-edge-committed-after-the-snapshot-boundary-is-invisible-to-the-frontier-walk', () => {
    const state = createFakeStoreState();
    pushEdge(state, 'group', 'root', 'member', 'group', 'a', 'member', 1);
    pushEdge(state, 'group', 'a', 'member', 'group', 'b', 'member', 5); // committed later

    const asOfSnapshot = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, 1);
    expect(asOfSnapshot.map((r) => r.id)).toEqual(['root', 'a']);

    const live = fetchReachableFrontierVia(state, 'group', 'root', 'member', 25, undefined);
    expect(live.map((r) => r.id)).toEqual(['root', 'a', 'b']);
  });
});
