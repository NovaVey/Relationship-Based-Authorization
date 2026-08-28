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

describe('a-tuple-to-userset-cycle-through-a-parent-chain-terminates-and-resolves-denied', () => {
  // The cycle above is built entirely from mechanism 2 — userset-subject
  // nesting (`group#member` as a tuple's subject). §6.4's cycle guard must
  // also catch a cycle built from the *other* recursive mechanism this
  // engine has: `tupleToUserset` (`parent->view`), which walks a stored
  // relation to a different object and then recurses into a *permission* on
  // it, never itself appearing as a tuple subject. folder:a's `parent` is
  // folder:b; folder:b's `parent` is folder:a — so `view = viewer |
  // parent->view` recurses view(a) -> view(b) -> view(a), a genuine cycle
  // through the tupleToUserset rewrite rule with no userset-subject nesting
  // anywhere in the graph. No `viewer` tuple exists on either folder, so the
  // hand-derived answer is unambiguous: denied. As with the mechanism-2 test
  // above, maxDepth is set enormous and explicit so a depth-ceiling backstop
  // can't accidentally stand in for a broken (or absent) cycle detector.
  const source = [
    'namespace folder {',
    '  relation parent: folder',
    '  relation viewer: user',
    '',
    '  permission view = viewer | parent->view',
    '}',
  ].join('\n');

  it('a-tuple-to-userset-cycle-through-a-parent-chain-terminates-and-resolves-denied', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'a', 'parent', 'folder', 'b'),
      tuple('folder', 'b', 'parent', 'folder', 'a'),
    ];

    const start = performance.now();
    const result = referenceCheck(schema, tuples, ref('user', 'zoe'), ref('folder', 'a'), 'view', {
      maxDepth: 1_000_000,
    });
    const elapsedMs = performance.now() - start;

    expect(result.allowed).toBe(false);
    expect(elapsedMs).toBeLessThan(4000);
  });
});

describe('a-direct-self-loop-tuple-terminates-and-resolves-denied', () => {
  // A third, independent cycle shape from both the mechanism-2 two-node
  // nesting above and the tupleToUserset chain above it: a single stored
  // tuple whose subject names its own object and relation —
  // `group:a#member@group:a#member`, one row, zero hops before the walk
  // would revisit its own starting `(namespace, id, relation)` triple. No
  // tuple anywhere grants a real `user` membership, so the hand-derived
  // answer is unambiguous: denied.
  const source = ['namespace group {', '  relation member: user | group#member', '}'].join('\n');

  it('a-direct-self-loop-tuple-terminates-and-resolves-denied', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [tuple('group', 'a', 'member', 'group', 'a', 'member')];

    const start = performance.now();
    const result = referenceCheck(schema, tuples, ref('user', 'zoe'), ref('group', 'a'), 'member', {
      maxDepth: 1_000_000,
    });
    const elapsedMs = performance.now() - start;

    expect(result.allowed).toBe(false);
    expect(elapsedMs).toBeLessThan(4000);
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

describe('a-cycle-inside-an-exclusions-subtract-branch-must-not-flip-a-fail-closed-cycle-guard-into-an-unsound-grant', () => {
  // The exclusion/cycle-guard soundness fix. Every cycle-termination test
  // above involves ONLY plain union/tupleToUserset recursion — no
  // `exclusion` rewrite rule anywhere in the loop. That distinction matters:
  // for a purely positive (non-negated) recursive walk, "this branch
  // revisits a name already being resolved, treat it as false" is exactly
  // the correct least-fixpoint answer (no independent grounding exists
  // through the cycle, so the correct value really is false) — the tests
  // above already prove this holds. But the instant an `exclusion` sits
  // anywhere in the cycle, `NOT` is now part of the recursive system, and
  // "cannot prove" is no longer safe to negate into "proven absent": doing
  // so is exactly the classic recursion-through-negation problem
  // (non-stratified negation) Datalog-with-negation has, and it manufactures
  // a real, unsound grant here — confirmed live (with the fix reverted) via
  // this exact fixture before the fix existed.
  //
  // `view = grant - parent->view` on a self-referencing `parent` — an
  // ordinary hierarchy pattern, nothing exotic: self-referencing `parent`
  // tuples are this DSL's own headline use case.
  const source = [
    'namespace folder {',
    '  relation parent: folder',
    '  relation grant: user',
    '',
    '  permission view = grant - parent->view',
    '}',
  ].join('\n');

  it('a-self-referencing-parent-tuple-inside-an-exclusions-subtract-resolves-denied-not-an-unsound-grant', () => {
    // folder:a is its own parent (a one-node cycle, zero hops before the
    // walk revisits `folder:a#view`, already being resolved). Hand-derived
    // answer: view(a) = grant(a) AND NOT(parent->view(a)) = grant(a) AND
    // NOT(view(a)) — a self-referential equation with no consistent
    // grounding once the cycle is set aside (the only real fact is
    // grant(a), which the exclusion's own subtract can neither confirm nor
    // rule out through this ungrounded loop). Per this project's own
    // fail-closed philosophy (§6.4 — "cannot prove" is never treated as a
    // license to grant), the correct answer is denied, not allowed.
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'a', 'parent', 'folder', 'a'),
      tuple('folder', 'a', 'grant', 'user', 'alice'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('folder', 'a'),
      'view',
      {
        maxDepth: 20,
      },
    );
    expect(result.allowed).toBe(false);
  });

  it('a-three-node-ring-inside-an-exclusions-subtract-resolves-denied-not-an-unsound-grant-at-every-node-in-the-ring', () => {
    // folder:a -> parent -> folder:b -> parent -> folder:c -> parent ->
    // folder:a, every node granted. An ODD-length ring — deliberately, not
    // arbitrarily: for this exact `grant - parent->view` shape, an EVEN-
    // length ring (e.g. a plain two-node mutual `parent` pair) has a
    // structural quirk worth naming explicitly, confirmed by hand-tracing
    // and then independently confirmed live against the reverted
    // (pre-fix) code: the unsound flip still happens internally at the
    // "inner" node the raw cycle guard hits, but gets re-negated exactly
    // once more by the "outer" (queried) node's own exclusion, which
    // coincidentally lands back on the correct `denied` answer at the TOP
    // level regardless of which of the two nodes is queried — the bug is
    // real but invisible at the top level for that specific even-length
    // shape. An ODD-length ring has no such accidental cancellation: with
    // the fix reverted, querying `view` on EVERY node in this exact 3-node
    // ring returned an unsound `allowed: true`, confirmed live. This test
    // is the odd-length case precisely because it cannot be satisfied by
    // accident the way a 2-node mutual cycle sometimes can.
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'a', 'parent', 'folder', 'b'),
      tuple('folder', 'b', 'parent', 'folder', 'c'),
      tuple('folder', 'c', 'parent', 'folder', 'a'),
      tuple('folder', 'a', 'grant', 'user', 'alice'),
      tuple('folder', 'b', 'grant', 'user', 'alice'),
      tuple('folder', 'c', 'grant', 'user', 'alice'),
    ];
    for (const id of ['a', 'b', 'c']) {
      const result = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('folder', id),
        'view',
        { maxDepth: 20 },
      );
      expect(result.allowed).toBe(false);
    }
  });

  it('control-the-identical-cyclic-shape-but-the-subtract-branch-is-certainly-grounded-false-still-resolves-allowed-no-regression', () => {
    // Not every cycle inside a subtract branch is unprovable — if the
    // subtract branch's OWN base fails before the cycle is ever reached
    // (Kleene AND: a certain `false` dominates, regardless of the
    // unevaluated recursive term), the exclusion is genuinely, certainly
    // "not excluded," and the fix must not turn this into a new,
    // over-conservative false_deny. folder:b has NO `grant` tuple at all,
    // so view(b) = false AND ... = false, certainly, without ever needing
    // to chase b's own `parent->view` back to folder:a — the cycle is
    // structurally present in the tuple graph but never actually walked
    // for this particular query.
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'a', 'parent', 'folder', 'b'),
      tuple('folder', 'b', 'parent', 'folder', 'a'),
      tuple('folder', 'a', 'grant', 'user', 'alice'),
      // deliberately no folder:b grant tuple for alice or anyone else.
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('folder', 'a'),
      'view',
      {
        maxDepth: 20,
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('control-a-real-non-cyclic-exclusion-still-correctly-denies-when-the-excluded-set-genuinely-holds', () => {
    // No cycle at all here — mallory is directly, certainly banned. Proves
    // the fix didn't weaken the ordinary, non-cyclic exclusion path.
    const bannedSource = [
      'namespace document {',
      '  relation grant: user',
      '  relation banned: user',
      '',
      '  permission view = grant - banned',
      '}',
    ].join('\n');
    const schema = compileOk(bannedSource);
    const tuples: ReferenceTuple[] = [
      tuple('document', 'readme', 'grant', 'user', 'mallory'),
      tuple('document', 'readme', 'banned', 'user', 'mallory'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'mallory'),
      ref('document', 'readme'),
      'view',
    );
    expect(result.allowed).toBe(false);
  });
});
