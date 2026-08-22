/**
 * DST D2's own exit criterion (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md`
 * D-099): "the flagship D-092 phantom-witness regression reproduced and
 * proven unreachable under many seeded interleavings." No Postgres, no
 * Testcontainers, no `LOCK TABLE` trick — every test below runs the real,
 * unmodified `productionCheck` (`src/resolve/production/resolver.ts`)
 * against the in-memory fake, using `armNextConnectionPause` to get the
 * same deterministic mid-transaction control point `docs/DECISIONS.md`
 * D-092's own real regression test needed a real `LOCK TABLE
 * namespace_configs IN ACCESS EXCLUSIVE MODE` to manufacture against real
 * Postgres.
 *
 * `mulberry32` below is a small, local, deliberately independent PRNG —
 * same rationale as `advisory-lock.dst.test.ts`'s own identical copy (not
 * `src/soundness/generators.ts`'s `SeededRng`, coupled to a different
 * purpose): kept local here too rather than extracted to a shared helper,
 * since this is still only the second use, not yet a pattern worth the
 * cross-file dependency (rule of three).
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { writeTuple, type TupleKey } from '../../../../src/store/tuples.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
  type FakeConnectionSource,
} from '../../../../src/store/dst/index.js';

const PLAIN_SCHEMA_SOURCE = [
  'namespace document {',
  '  relation viewer: user',
  '  permission view = viewer',
  '}',
].join('\n');

const USERSET_SCHEMA_SOURCE = [
  'namespace document {',
  '  relation viewer: user | group#member',
  '  permission view = viewer',
  '}',
  'namespace group {',
  '  relation member: user',
  '}',
].join('\n');

/** `parent->view` — a real `tupleToUserset` rewrite rule, the exact shape from this repo's own `schema/example.authz` (`permission view = viewer | edit | parent->view`), needed to exercise `listTupleSubjects`/`listTupleSubjectsHandler` through the fake at all — see this file's own "tuple-to-userset" describe block below. */
const TUPLE_TO_USERSET_SCHEMA_SOURCE = [
  'namespace folder {',
  '  relation viewer: user',
  '  permission view = viewer',
  '}',
  'namespace document {',
  '  relation parent: folder',
  '  relation viewer: user',
  '  permission view = viewer | parent->view',
  '}',
].join('\n');

function compileNamespace(source: string, name: string) {
  const compiled = compileSchema(source);
  if (!compiled.ok) {
    throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  const namespace = compiled.schema.namespaces[name];
  if (!namespace) throw new Error(`fixture schema did not produce a ${name} namespace`);
  return namespace;
}

function freshPlainSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compileNamespace(PLAIN_SCHEMA_SOURCE, 'document'));
  return { state, source: createFakeConnectionSource(state) };
}

/** Deterministic, seed-only PRNG — see this file's own top-of-file doc comment. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** See advisory-lock.dst.test.ts's own identical helper — drains the microtask queue so a wrongly-unblocked promise has every chance to have already settled, with no real wall-clock wait needed. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('DST D2 — productionCheck against the in-memory fake, no Postgres (baseline wiring)', () => {
  it('a-plain-direct-grant-resolves-allowed-through-the-real-unmodified-productionCheck', async () => {
    const { source } = freshPlainSource();
    const tuple: TupleKey = {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };
    const write = await writeTuple(source, tuple);
    expect(write.ok).toBe(true);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );

    expect(result.allowed).toBe(true);
  });

  it('a-subject-with-no-grant-resolves-denied-through-the-real-unmodified-productionCheck', async () => {
    const { source } = freshPlainSource();
    const write = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(write.ok).toBe(true);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'mallory' },
      { ns: 'document', id: 'readme' },
      'view',
    );

    expect(result.allowed).toBe(false);
  });
});

/**
 * D2's own flagship exit-criterion tests — full reasoning in
 * `docs/DECISIONS.md` D-099. `productionCheck`'s real statement sequence on
 * its own snapshot `client`, for a token-pinned check against a simple
 * relation (no tuple-to-userset hop), is exactly: (1)
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, (2)
 * `assertTokenObservedOnSnapshot`'s floor check — the statement that
 * anchors the snapshot — (3) `fetchReachableFrontier`, (4)
 * `fetchTuplesOnFrontier`, (5) `COMMIT`. (`getConfig`'s own
 * `namespace_configs` lookup runs on a *different* connection — the plain
 * `pool` — and never touches this count; see `resolver.ts`'s own doc
 * comment.) `pauseAfterStatements: 2` therefore pauses right after the
 * snapshot anchors, before the frontier fetch; `3` pauses between the
 * frontier fetch and the tuple-on-frontier fetch — the exact query pair
 * D-092's own counterexample was about.
 */
describe('the D-092 phantom-witness regression, reproduced through the fake and generalized across seeds (D-099)', () => {
  it.each([2, 3])(
    'pauseAfterStatements=%i: a grant committed while the check is paused mid-snapshot is invisible to that checks own result, even though a fresh check afterward sees it',
    async (pausePoint) => {
      const { state, source } = freshPlainSource();
      const decoyWrite = await writeTuple(source, {
        objectNs: 'document',
        objectId: 'decoy',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'zoe',
      });
      expect(decoyWrite.ok).toBe(true);
      if (!decoyWrite.ok) return;
      const pinnedToken = decoyWrite.token;

      const { resume } = source.armNextConnectionPause(pausePoint);
      let checkSettled = false;
      const checkPromise = productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'racy' },
        'view',
        { atToken: pinnedToken },
      ).then(
        (r) => {
          checkSettled = true;
          return r;
        },
        (e: unknown) => {
          checkSettled = true;
          throw e;
        },
      );

      // Confirmed, not assumed: the check is genuinely paused, not merely
      // fast — see advisory-lock.dst.test.ts's own identical control idiom.
      await flushMicrotasks();
      expect(checkSettled).toBe(false);

      // The grant, committed for real, while the check above is still
      // suspended mid-transaction — on a completely different connection.
      const grantWrite = await writeTuple(source, {
        objectNs: 'document',
        objectId: 'racy',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(grantWrite.ok).toBe(true);

      resume();
      const result = await checkPromise;

      // The actual invariant under test: this check's own frozen snapshot,
      // anchored before the grant committed, never observes it — even
      // though the check's own later statements literally execute after
      // the grant, in real logical commit order.
      expect(result.allowed).toBe(false);
      expect(state.relationTuples).toHaveLength(2); // decoy + the real grant, both genuinely committed

      // Control: a fresh, unpinned check issued *after* the grant commits
      // does see it — proving the grant really landed, and this isn't
      // `allowed: false` by some unrelated failure.
      const freshResult = await productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'racy' },
        'view',
      );
      expect(freshResult.allowed).toBe(true);
    },
  );

  const SEEDS = [1, 2, 3, 4, 5, 6];

  it.each(SEEDS)(
    'seed=%i: the same non-observation property holds across varied object/subject identifiers and pause points',
    async (seed) => {
      const rng = mulberry32(seed);
      const pausePoint = rng() < 0.5 ? 2 : 3;
      const objectId = `racy_${seed}`;
      const subjectId = `user_${seed}`;

      const { source } = freshPlainSource();
      const decoyWrite = await writeTuple(source, {
        objectNs: 'document',
        objectId: `decoy_${seed}`,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'zoe',
      });
      expect(decoyWrite.ok).toBe(true);
      if (!decoyWrite.ok) return;

      const { resume } = source.armNextConnectionPause(pausePoint);
      const checkPromise = productionCheck(
        source,
        { ns: 'user', id: subjectId },
        { ns: 'document', id: objectId },
        'view',
        { atToken: decoyWrite.token },
      );

      await flushMicrotasks();
      const grantWrite = await writeTuple(source, {
        objectNs: 'document',
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId,
      });
      expect(grantWrite.ok).toBe(true);
      resume();

      const result = await checkPromise;
      expect(result.allowed).toBe(false);
    },
  );
});

describe("D2's own disclosed scope limit — the frontier handler throws rather than silently under-report a real userset-subject edge it cannot yet traverse (D3's job)", () => {
  it('a-check-that-would-need-real-frontier-recursion-throws-a-clear-named-error-instead-of-a-silent-wrong-denial', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // A real userset-subject tuple — document:readme#viewer@group:eng#member
    // — the exact shape fetchReachableFrontier's real recursive term exists
    // to follow, and D2's own seed-only handler explicitly does not.
    const write = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });
    expect(write.ok).toBe(true);

    await expect(
      productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'readme' },
        'view',
      ),
    ).rejects.toThrow(/D3's own job/);
  });

  it('control-the-identical-schema-with-no-userset-edge-actually-written-resolves-normally-through-the-same-guard', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // Only a plain grant — no userset-subject tuple exists on this object,
    // so the guard's own `hasUsersetEdge` check must find nothing and let
    // this resolve normally, proving the guard doesn't over-fire on a
    // schema that merely *allows* userset subjects without one present.
    const write = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(write.ok).toBe(true);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );
    expect(result.allowed).toBe(true);
  });

  /**
   * Caught live by D2's own adversarial review pass, not assumed correct
   * from the first draft (`docs/DECISIONS.md` D-099): the guard above
   * ignores real Postgres's own `maxDepth` (`$4`) ceiling on the frontier
   * query's recursive term (`m.depth < $4`). At the seed row's own
   * `depth = 0`, that guard is false whenever `maxDepth <= 0` — real
   * Postgres's own recursion *cannot* fire regardless of what tuples
   * exist, so the seed-only answer this handler always computes already
   * is the true, complete one, and throwing anyway would be a false
   * positive. `maxDepth: 0` here reaches `fetchReachableFrontier` as
   * `remainingDepth = Math.max(0, 0 - 0) = 0` (`resolver.ts`'s own
   * `resolve()`), the exact boundary this test targets.
   */
  it('a-userset-edge-that-a-zero-remaining-depth-budget-could-never-actually-reach-does-not-trigger-the-guard', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // The identical userset-subject tuple the guard-firing test above uses
    // — the difference here is entirely the maxDepth budget, not the data.
    const write = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });
    expect(write.ok).toBe(true);

    // Checking the relation directly (not the 'view' permission, which
    // would consume one unit of depth just resolving the indirection,
    // leaving remainingDepth ambiguous) — maxDepth: 0 against 'viewer'
    // itself reaches fetchReachableFrontier with remainingDepth exactly 0.
    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'viewer',
      { maxDepth: 0 },
    );

    // alice has no plain grant on document:readme#viewer — only the
    // userset edge the zero depth budget can never reach — so this must
    // resolve a clean denial, not throw.
    expect(result.allowed).toBe(false);
  });
});

/**
 * Closes a real coverage gap D2's own adversarial review found: unlike
 * `fetchReachableFrontier`/`fetchTuplesOnFrontier` (exercised by every
 * test above), nothing in this suite previously called `listTupleSubjects`
 * — the third new D2 shape — at all, since neither `PLAIN_SCHEMA_SOURCE`
 * nor `USERSET_SCHEMA_SOURCE` contains a real `tupleToUserset` rewrite
 * rule. `docs/DST-PROPOSAL.md`'s own "required recognizer-coverage gate"
 * argument ("a mismatch throws 'no shape registered', a test catches it")
 * only holds for a shape some test actually invokes — this describe block
 * is that test for `listTupleSubjects`, using `TUPLE_TO_USERSET_SCHEMA_SOURCE`'s
 * real `parent->view` rule (the identical shape this repo's own
 * `schema/example.authz` uses).
 */
describe("the tuple-to-userset hop (parent->view) — listTupleSubjects's own SQL shape, genuinely exercised for the first time (D-099)", () => {
  it('a-permission-granted-via-the-parent-objects-own-viewer-relation-resolves-allowed-through-the-real-tupleToUserset-rewrite', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 'folder'));
    seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);

    // document:readme's parent is folder:docs — a plain relation tuple,
    // not a userset subject; this is exactly what listTupleSubjects reads.
    const parentWrite = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'parent',
      subjectNs: 'folder',
      subjectId: 'docs',
    });
    expect(parentWrite.ok).toBe(true);

    // alice has no direct document:readme#viewer grant — only reachable
    // via parent->view through folder:docs#viewer.
    const grantWrite = await writeTuple(source, {
      objectNs: 'folder',
      objectId: 'docs',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(grantWrite.ok).toBe(true);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );

    expect(result.allowed).toBe(true);
  });

  it('control-a-subject-with-no-grant-anywhere-on-the-parent-chain-resolves-denied-through-the-identical-tupleToUserset-path', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 'folder'));
    seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);

    const parentWrite = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'parent',
      subjectNs: 'folder',
      subjectId: 'docs',
    });
    expect(parentWrite.ok).toBe(true);
    // No viewer grant anywhere — folder:docs#viewer has zero tuples, so
    // listTupleSubjects's own real read (exercised by the case above)
    // isn't what's under test here — this is the "found the parent, found
    // nothing on it" path through the exact same tuple-to-userset rewrite.

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'mallory' },
      { ns: 'document', id: 'readme' },
      'view',
    );

    expect(result.allowed).toBe(false);
  });
});
