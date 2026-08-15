/**
 * Reference resolver (Phase 3) tests — graph topology.
 *
 * Written from `.claude/commands/build-authz-service.md` §6.4 ("Cycle
 * detection and a depth budget are correctness requirements, not
 * performance optimizations... The walk tracks visited (namespace, id,
 * relation) triples per branch and terminates instead of looping") and
 * §10's `a-cyclic-group-nesting-terminates-and-resolves-denied`. Per §14
 * delegation rule 5, `src/resolve/reference/resolver.ts` was deliberately
 * NOT read while writing these tests — expected results are derived from
 * §5/§6.4 and hand-reasoning about the constructed graphs, not from
 * watching what the resolver does.
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

describe('a-cyclic-group-nesting-terminates-and-resolves-denied', () => {
  // group:a's `member` relation nests group:b's members, and vice versa —
  // a genuine cycle, per §5's `group#member` userset-subject syntax and
  // §6.4's own worked example ("group:a nests group:b nests group:a"). No
  // tuple anywhere in the cycle grants zoe (or anyone) real membership, so
  // the hand-derived answer is unambiguous: denied. The property under
  // test isn't just the boolean — it's that the walk terminates instead of
  // looping forever, so this must also be observed to run in bounded time,
  // not merely to return the right value if it happens to return at all.
  const source = ['namespace group {', '  relation member: user | group#member', '}'].join('\n');

  it('a-cyclic-group-nesting-terminates-and-resolves-denied', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('group', 'a', 'member', 'group', 'b', 'member'),
      tuple('group', 'b', 'member', 'group', 'a', 'member'),
    ];

    // maxDepth is set enormous and *explicit* on purpose: §6.4 says cycle
    // detection and the depth budget are two independent mechanisms, and
    // this test's whole point is to prove the *cycle detector* terminates
    // this graph — not to prove the depth ceiling eventually would have
    // caught it regardless. With the default budget (1000) a 2-node cycle
    // hits the depth ceiling in ~1000 recursive steps either way, which is
    // fast enough that a resolver with cycle detection completely removed
    // would still pass this test by accident, via the depth backstop
    // quietly doing the job cycle detection was supposed to do. Forcing
    // maxDepth far past anything the depth ceiling could plausibly absorb
    // quickly means: if cycle detection is broken, this either blows the
    // call stack or runs long enough to blow the wall-clock bound below;
    // if it's intact, the `visiting` set catches the repeat after two hops
    // regardless of what maxDepth is set to.
    const start = performance.now();
    const result = referenceCheck(schema, tuples, ref('user', 'zoe'), ref('group', 'a'), 'member', {
      maxDepth: 1_000_000,
    });
    const elapsedMs = performance.now() - start;

    expect(result.allowed).toBe(false);
    // Generous bound — this is not a performance assertion, it's a "did
    // not hang" assertion. A resolver that loops forever (or recurses
    // toward a million-deep ceiling because cycle detection didn't catch
    // the repeat after two hops) would never reach this line at all, or
    // would blow the call stack first; Vitest's own test timeout is the
    // backstop for the former, and this explicit bound plus the maxDepth
    // chosen above are what make the latter two distinguishable from a
    // healthy, fast, cycle-detected termination.
    expect(elapsedMs).toBeLessThan(4000);
  });

  it('a-cyclic-group-nesting-with-a-real-grant-outside-the-cycle-still-resolves-allowed-for-the-subject-with-a-real-path', () => {
    // The cycle itself must not poison an otherwise-real, non-cyclic grant
    // reachable through the same object: group:a nests group:b nests
    // group:a (the cycle, ungrounded), AND group:a directly grants
    // membership to user:mabel outside the cycle entirely.
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('group', 'a', 'member', 'group', 'b', 'member'),
      tuple('group', 'b', 'member', 'group', 'a', 'member'),
      tuple('group', 'a', 'member', 'user', 'mabel'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'mabel'),
      ref('group', 'a'),
      'member',
    );
    expect(result.allowed).toBe(true);
  });
});

describe('a-diamond-shaped-non-cyclic-revisit-of-the-same-object-is-not-falsely-treated-as-a-cycle', () => {
  // folder:start reaches folder:shared via two distinct edges (`parent`
  // and `sibling_link`), each recursing into a *different* computed
  // permission on folder:shared (`view` vs `edit`). folder:shared has no
  // `viewer` tuple (so `view` on it is false) but does have an `editor`
  // tuple for lee (so `edit` on it is true). This is the specific failure
  // mode a naive "have I ever seen this (namespace, id) before" cycle
  // guard gets wrong: it is not an ancestor of itself on either path (the
  // walk fully returns from the `parent->view` branch before starting the
  // `sibling_link->edit` branch — a diamond, not a cycle), and §6.4 states
  // the tracked key is a (namespace, id, relation) triple, not the bare
  // node, so the second visit (same node, different relation) must not be
  // rejected as a repeat of the first.
  const source = [
    'namespace folder {',
    '  relation parent: folder',
    '  relation sibling_link: folder',
    '  relation viewer: user',
    '  relation editor: user',
    '',
    '  permission view = viewer',
    '  permission edit = editor',
    '  permission access = parent->view | sibling_link->edit',
    '}',
  ].join('\n');

  it('a-diamond-shaped-non-cyclic-revisit-of-the-same-object-is-not-falsely-treated-as-a-cycle', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'start', 'parent', 'folder', 'shared'),
      tuple('folder', 'start', 'sibling_link', 'folder', 'shared'),
      tuple('folder', 'shared', 'editor', 'user', 'lee'),
      // deliberately no `viewer` tuple on folder:shared — the parent->view
      // branch must fail on its own merits, not because of any dedup bug.
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'lee'),
      ref('folder', 'start'),
      'access',
    );
    expect(result.allowed).toBe(true);
  });

  it('a-diamond-shaped-non-cyclic-revisit-does-not-manufacture-a-grant-when-only-the-dead-end-branch-exists', () => {
    // Control: remove the sibling_link edge entirely. Now the only route
    // to folder:shared is parent->view, which is false (no viewer tuple).
    // If the previous test passed only because the resolver treats any
    // reach of folder:shared as automatically granting (rather than really
    // walking sibling_link->edit), this control would incorrectly also
    // pass — it must not.
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'start', 'parent', 'folder', 'shared'),
      tuple('folder', 'shared', 'editor', 'user', 'lee'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'lee'),
      ref('folder', 'start'),
      'access',
    );
    expect(result.allowed).toBe(false);
  });
});

describe('a-sibling-branchs-completed-visit-to-a-node-and-relation-does-not-suppress-a-later-independent-visit-to-the-identical-node-and-relation', () => {
  // The test above (different relation names, `view` vs `edit`, on the
  // shared node) cannot actually distinguish two implementations: (1) one
  // that tracks visited (namespace, id, relation) triples per root-to-node
  // path and correctly pops them on backtrack, and (2) a naive one that
  // adds a key the first time it's ever seen and never removes it, i.e. a
  // "have I ever seen this node" global set. Because the two branches ask
  // about *different* relation names, their keys never collide, so
  // implementation (2) would pass that test too, undetected.
  //
  // This test forces the exact same (namespace, id, relation) key to be
  // looked up twice, from two branches that are siblings (not ancestor and
  // descendant) of a union, where the *first* branch's own evaluation of
  // that key happens to complete (truthfully) but the branch containing it
  // still denies overall for an unrelated reason (an intersection with a
  // second, failing condition) — then the *second*, independent branch
  // depends solely on that same key resolving true. A per-path
  // implementation that pops the key once the first branch's call returns
  // gets this right; an implementation that marks the key "seen" forever
  // gets it wrong, because it will incorrectly deny the second branch's
  // fresh, independent lookup of a key that in truth still resolves true.
  //
  // Hand-derived expected value: access = (view(shared) AND gatekeeper(shared))
  // OR view(shared) = (true AND false) OR true = true, regardless of how a
  // correct implementation is structured internally — a pure boolean fact
  // about the tuple graph, not an artifact of traversal order.
  const source = [
    'namespace folder {',
    '  relation parent: folder',
    '  relation sibling_link: folder',
    '  relation viewer: user',
    '  relation gatekeeper: user',
    '',
    '  permission view = viewer',
    '  permission blocked_view = view & gatekeeper',
    '  permission access = parent->blocked_view | sibling_link->view',
    '}',
  ].join('\n');

  it('a-sibling-branchs-completed-visit-to-a-node-and-relation-does-not-suppress-a-later-independent-visit-to-the-identical-node-and-relation', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'start', 'parent', 'folder', 'shared'),
      tuple('folder', 'start', 'sibling_link', 'folder', 'shared'),
      tuple('folder', 'shared', 'viewer', 'user', 'lee'),
      // deliberately no `gatekeeper` tuple anywhere — blocked_view(shared)
      // must be false, so the *first* union branch (parent->blocked_view)
      // fails for a reason unrelated to view(shared) itself, which is true.
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'lee'),
      ref('folder', 'start'),
      'access',
    );
    expect(result.allowed).toBe(true);
  });

  it('removing-the-second-branch-correctly-denies-proving-the-allowed-result-above-genuinely-depends-on-both-branches-being-walked', () => {
    // Control: without sibling_link, the only route is parent->blocked_view,
    // which is false. If the previous test only passed because the
    // resolver treats any reach of folder:shared as an automatic grant,
    // this control would incorrectly also pass — it must not.
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'start', 'parent', 'folder', 'shared'),
      tuple('folder', 'shared', 'viewer', 'user', 'lee'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'lee'),
      ref('folder', 'start'),
      'access',
    );
    expect(result.allowed).toBe(false);
  });
});
