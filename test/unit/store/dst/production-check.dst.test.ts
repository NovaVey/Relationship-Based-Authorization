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
 * Seeded pause-point selection and the pause/resume/observe choreography
 * itself now go through `src/store/dst/scheduler.ts` (DST D4,
 * `docs/DECISIONS.md` D-101) — this file used to carry its own local
 * `mulberry32` PRNG (a byte-identical copy also lived in
 * `advisory-lock.dst.test.ts`, explicitly documented at the time as "not
 * yet a pattern worth the cross-file dependency") and its own hand-rolled
 * `flushMicrotasks` + settled-flag choreography; D4 is the generalization
 * both were always going to need.
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
import {
  dstRngFromSeed,
  dstSeedList,
  raceUnderPause,
} from '../../../../src/store/dst/scheduler.js';

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
  // Self-referential (group#member as its own subject type) — matches
  // schema/example.authz's own real group.member declaration exactly.
  // D3's own multi-level-recursion tests need real nested-group chains,
  // not just a single userset hop straight to a plain user.
  '  relation member: user | group#member',
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

// ---------------------------------------------------------------------------
// D-106 (second full-repo audit, findings #2/#10) — productionCheck's catch
// block ran an unprotected `ROLLBACK` on a possibly-already-dead connection,
// which could silently replace the real error with a misleading one. The
// exact bug class D0's crash-injection work already found and fixed for
// writeTuple/deleteTuple/publishOne/runMigrations (docs/DECISIONS.md
// D-097/D-098) — this file's own `armNextConnectionCrash` gives the same
// mechanism direct access to productionCheck's transaction for the first
// time.
// ---------------------------------------------------------------------------

describe('D-106 — a connection that dies after BEGIN but before COMMIT never has its own real error masked by a ROLLBACK failure', () => {
  it('the-error-productionCheck-throws-is-the-original-crash-not-a-rollback-failure-error', async () => {
    const { source } = freshPlainSource();
    // Statement 0 is `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`
    // (resolver.ts's own first query) — crashAfterStatements: 1 lets that
    // one statement succeed, then crashes the very next query productionCheck
    // issues, reproducing "BEGIN succeeded, the check itself then failed."
    source.armNextConnectionCrash(1);

    await expect(
      productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'readme' },
        'view',
      ),
    ).rejects.toThrow(/simulated crash — connection terminated mid-statement/);
  });

  it('control-the-same-crash-point-would-throw-a-different-rollback-failure-message-if-the-catch-blocks-own-rollback-were-unprotected', async () => {
    // Not a test of production code — a direct proof that this file's own
    // fake connection really does behave the way the finding/fix above
    // assumes: once dead, every subsequent `.query()` (including the
    // `ROLLBACK` an unprotected catch block would have issued) throws a
    // second, different error. If this ever stopped being true, the
    // "not masked" assertion above would no longer mean anything.
    const { source } = freshPlainSource();
    source.armNextConnectionCrash(1);
    const client = await source.connect();
    await expect(
      client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    ).resolves.toBeDefined();
    await expect(client.query('SELECT 1')).rejects.toThrow(
      /simulated crash — connection terminated mid-statement/,
    );
    await expect(client.query('ROLLBACK')).rejects.toThrow(
      /query issued on a connection that has already crashed/,
    );
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

      // raceUnderPause (DST D4, docs/DECISIONS.md D-101) owns the "arm the
      // pause, start the check, confirm it's genuinely suspended (not
      // merely fast), run the concurrent grant, resume" choreography this
      // test used to hand-write — its own structural throw already proves
      // the check was genuinely paused when the grant committed, stronger
      // than the soft `expect(checkSettled).toBe(false)` this replaces.
      const result = await raceUnderPause({
        source,
        pauseAfterStatements: pausePoint,
        heldOp: () =>
          productionCheck(
            source,
            { ns: 'user', id: 'alice' },
            { ns: 'document', id: 'racy' },
            'view',
            { atToken: pinnedToken },
          ),
        concurrentOp: async () => {
          // The grant, committed for real, while the check above is still
          // suspended mid-transaction — on a completely different
          // connection.
          const grantWrite = await writeTuple(source, {
            objectNs: 'document',
            objectId: 'racy',
            relation: 'viewer',
            subjectNs: 'user',
            subjectId: 'alice',
          });
          expect(grantWrite.ok).toBe(true);
        },
      });

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

  // DST D5 (docs/DECISIONS.md D-102) — 6 by default, on every PR; the
  // identical logic below sweeps far more when DST_SEED_COUNT is set (the
  // nightly job's own concern), no separate code path needed.
  const SEEDS = dstSeedList('phantom_witness', 6);

  it.each(SEEDS)(
    'seed=%s: the same non-observation property holds across varied object/subject identifiers and pause points',
    async (seed) => {
      const rng = dstRngFromSeed(seed);
      const pausePoint = rng.pick([2, 3]);
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

      const result = await raceUnderPause({
        source,
        pauseAfterStatements: pausePoint,
        heldOp: () =>
          productionCheck(
            source,
            { ns: 'user', id: subjectId },
            { ns: 'document', id: objectId },
            'view',
            { atToken: decoyWrite.token },
          ),
        concurrentOp: async () => {
          const grantWrite = await writeTuple(source, {
            objectNs: 'document',
            objectId,
            relation: 'viewer',
            subjectNs: 'user',
            subjectId,
          });
          expect(grantWrite.ok).toBe(true);
        },
      });

      expect(result.allowed).toBe(false);
    },
  );
});

/**
 * D2 shipped a deliberately narrow seed-only frontier handler that threw
 * rather than silently mis-answer any check needing real userset-subject
 * recursion (`docs/DECISIONS.md` D-099) — D3 (`docs/DECISIONS.md` D-100)
 * replaces it with `fetchReachableFrontierVia`, a real, multi-level BFS.
 * These tests are what D2's own "throws, this needs D3" tests became: the
 * *identical* schemas and tuple graphs that used to throw now genuinely
 * resolve, through real recursion, via the real, unmodified
 * `productionCheck`.
 */
describe('real multi-level userset-subject recursion, genuinely working through productionCheck for the first time (D3, D-100)', () => {
  it('a-single-hop-userset-edge-that-would-have-thrown-under-D2-now-resolves-allowed-through-real-recursion', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // document:readme#viewer@group:eng#member — the exact shape D2's own
    // seed-only handler could not traverse and threw on instead.
    const edgeWrite = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });
    expect(edgeWrite.ok).toBe(true);
    // alice is a real, direct member of group:eng.
    const membershipWrite = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(membershipWrite.ok).toBe(true);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );
    expect(result.allowed).toBe(true);
  });

  it('control-the-identical-userset-edge-with-a-subject-who-is-not-a-member-anywhere-resolves-denied-not-a-throw', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    const edgeWrite = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });
    expect(edgeWrite.ok).toBe(true);
    // No group:eng membership grant for mallory anywhere.

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'mallory' },
      { ns: 'document', id: 'readme' },
      'view',
    );
    expect(result.allowed).toBe(false);
  });

  it('a-two-level-nested-group-chain-resolves-allowed-proving-real-multi-hop-recursion-not-just-one-level', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // document:readme#viewer@group:eng#member
    //   -> group:eng#member@group:backend#member
    //        -> group:backend#member@user:alice
    // Two real userset hops between the check's own subject and object.
    const edgeWrite = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });
    expect(edgeWrite.ok).toBe(true);
    const nestedWrite = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng',
      relation: 'member',
      subjectNs: 'group',
      subjectId: 'backend',
      subjectRelation: 'member',
    });
    expect(nestedWrite.ok).toBe(true);
    const membershipWrite = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'backend',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(membershipWrite.ok).toBe(true);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );
    expect(result.allowed).toBe(true);
  });

  /**
   * The exact `maxDepth: 0` boundary D2's own adversarial review caught a
   * real bug in (`docs/DECISIONS.md` D-099: the seed-only handler ignored
   * `maxDepth` and threw even when real recursion couldn't have fired
   * either). Now answered by the real BFS's own `while (iterationDepth <
   * maxDepth)` bound (`src/store/dst/frontier.ts`) — `maxDepth: 0` means
   * zero rounds ever run, matching real Postgres's own `m.depth < $4`
   * guard at the seed row's own `depth = 0` exactly. Kept as its own test
   * because the underlying property (a userset edge a zero depth budget
   * cannot reach resolves a clean denial, never a throw) is still real and
   * still worth pinning down, even though the mechanism proving it changed
   * from "a guard declines to fire" to "recursion genuinely has no budget
   * to run."
   */
  it('a-userset-edge-that-a-zero-remaining-depth-budget-cannot-reach-resolves-a-clean-denial-not-a-throw', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // The identical userset-subject tuple this describe block's own first
    // test uses — the difference here is entirely the maxDepth budget.
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
