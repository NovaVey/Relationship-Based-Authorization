/**
 * Property 7 (token-pin coverage expansion) — DB-free, DST-fake, mirrors
 * `test/unit/store/dst/production-check.dst.test.ts`'s own D-092
 * "phantom-witness" describe block as its exact template (`raceUnderPause`
 * choreography, per-statement pause-point counting against the real,
 * unmodified `productionCheck`).
 *
 * **Why only two of the three originally-proposed halves are implemented
 * here.** An earlier design pass proposed a "backward/no-reading-into-the-
 * future" half of this property (paraphrased: a check pinned to token T
 * should never observe a write with token > T either) — adversarial review
 * found that half false and it is deliberately NOT implemented: `atToken`
 * is documented (`docs/CONSISTENCY.md`, `src/resolve/production/
 * resolver.ts`'s own `assertTokenObservedOnSnapshot` doc comment, and this
 * project's own "conventions" note above) as a **floor**, never an exact
 * snapshot pin or a ceiling — "this read must reflect everything up to and
 * including T," not "give me exactly T and nothing more." A `REPEATABLE
 * READ` transaction's real snapshot is anchored at whatever moment its own
 * first real query actually executes, which can easily be later, in real
 * commit-order terms, than the token it was pinned to — nothing in
 * `productionCheck`'s real contract promises "and never anything newer
 * either." Asserting that a paused-then-resumed check pinned at T never
 * observes a write with a token > T would therefore assert a property the
 * production code never claims and is not a bug if violated — see this
 * file's own "genuinely a floor, not a ceiling" regression at the bottom of
 * Property 7a's own describe block for a live, deliberate demonstration of
 * exactly this, rather than just asserting it in prose here.
 *
 * The two halves implemented below ARE both genuinely sound and both
 * independently valuable:
 *
 * - **7a (forward-direction coverage expansion).** The existing D-092
 *   regression only ever exercised "a check pinned to token T never loses a
 *   write with token <= T" on one schema shape (a plain single-hop
 *   relation, `permission view = viewer`) at two pause points. This
 *   generalizes the identical invariant — restated precisely as: a write
 *   already committed *before* a check's own transaction even opens can
 *   never be lost by that check, however its own `REPEATABLE READ`
 *   snapshot happens to get paused/resumed mid-flight, and regardless of
 *   what unrelated concurrent write activity happens during that pause —
 *   across the four rewrite-rule kinds this project's schema DSL actually
 *   has (union, intersection, exclusion, tupleToUserset), at every real
 *   post-anchor statement boundary each one's own resolution issues on its
 *   pinned connection. A bug this catches that D-092's own narrower
 *   original could not: an implementation that only correctly threads
 *   `visibleAsOf`/the pinned snapshot through the *first* relation-
 *   membership sub-query a check issues, but subtly drops or resets it for
 *   a *second* or *third* one (e.g. a union's second branch, an
 *   intersection's second branch, exclusion's `subtract` branch, or a
 *   tuple-to-userset hop's own recursive `resolve` call) — a bug class
 *   that is structurally invisible to any test built on a schema with only
 *   one relation-membership sub-query per check.
 *
 * - **7b (pure REPEATABLE READ isolation, decoupled from `atToken`).** Once
 *   a check's snapshot has anchored (`connection.ts`'s own D2 doc comment:
 *   at or after the first real query it issues in Snapshot mode), no write
 *   committing afterward is ever observed by it — for BOTH pinned and
 *   *unpinned* checks. The existing corpus only ever exercised this for
 *   pinned checks (`atToken` set) — an unpinned check still opens the exact
 *   same `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction
 *   (`productionCheck`'s own code: the transaction is unconditional: only
 *   the *token floor re-check* is conditional on `atToken` being present),
 *   so its own snapshot anchors identically — at its own first real query —
 *   and the identical non-observation guarantee should hold for it too. A
 *   bug this catches that a pinned-only corpus could not: an
 *   implementation that accidentally makes `REPEATABLE READ`'s isolation
 *   itself conditional on `atToken` being set (e.g. by opening a cheaper,
 *   weaker-isolation transaction whenever no token is supplied, on the
 *   theory that "nobody asked for consistency this time") — every existing
 *   test with `atToken` set would stay green while every real, un-pinned
 *   `authz check` call in production silently lost the exact guarantee
 *   `docs/CONSISTENCY.md` claims unconditionally.
 *
 * **Four fixtures, one rewrite-rule kind each, deliberately isolated** — a
 * failure in one of these tests names exactly which rewrite-rule kind's own
 * statement sequence stopped honoring the snapshot, never a mix of two.
 * None of the four namespaces below is shared with, or structurally
 * modeled after internal code in, `src/resolve/reference/resolver.ts` — see
 * this project's own non-negotiable that the two resolvers share no code,
 * ever; nothing here touches the reference resolver at all, only the real,
 * unmodified production one (`src/resolve/production/resolver.ts`).
 *
 * **How each pause-point sweep was derived — read, not guessed.** Every
 * `POST_ANCHOR_*_POINTS` array below is derived directly from
 * `resolver.ts`'s own control flow for that fixture's specific rewrite
 * shape (see each array's own comment for the exact statement-by-statement
 * accounting) and then confirmed empirically by actually running every
 * test in this file: `raceUnderPause` throws its own loud, structural
 * error ("expected the held operation to genuinely suspend... but it
 * settled before that ever happened") if a claimed pause point is past the
 * real end of that connection's own statement sequence, which would have
 * failed this file's own `npx vitest run` the moment any of these counts
 * were wrong — they were not (see this task's own final report for the
 * real, actually-observed pass count).
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
import { raceUnderPause } from '../../../../src/store/dst/scheduler.js';

// ---------------------------------------------------------------------------
// The four rewrite-rule-kind fixtures — one namespace (or, for
// tupleToUserset, one namespace pair) per kind, each declaring exactly the
// relations that one rewrite rule needs and nothing else, so a failure in
// one describe block below can never be blamed on a different rule kind
// bleeding in.
// ---------------------------------------------------------------------------

const UNION_SCHEMA_SOURCE = [
  'namespace union_res {',
  '  relation branch_one: user',
  '  relation branch_two: user',
  '  permission view = branch_one | branch_two',
  '}',
].join('\n');

const INTERSECTION_SCHEMA_SOURCE = [
  'namespace intersection_res {',
  '  relation branch_one: user',
  '  relation branch_two: user',
  '  permission view = branch_one & branch_two',
  '}',
].join('\n');

const EXCLUSION_SCHEMA_SOURCE = [
  'namespace exclusion_res {',
  '  relation grantee: user',
  '  relation banned: user',
  '  permission view = grantee - banned',
  '}',
].join('\n');

/** `parent_link->view` — the real tupleToUserset shape, isolated to its own two-namespace pair so no union/intersection/exclusion node is anywhere in this rewrite tree. */
const TUPLE_TO_USERSET_SCHEMA_SOURCE = [
  'namespace t2u_target {',
  '  relation viewer: user',
  '  permission view = viewer',
  '}',
  'namespace t2u_object {',
  '  relation parent_link: t2u_target',
  '  permission view = parent_link->view',
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

function freshUnionSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compileNamespace(UNION_SCHEMA_SOURCE, 'union_res'));
  return { state, source: createFakeConnectionSource(state) };
}

function freshIntersectionSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compileNamespace(INTERSECTION_SCHEMA_SOURCE, 'intersection_res'));
  return { state, source: createFakeConnectionSource(state) };
}

function freshExclusionSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compileNamespace(EXCLUSION_SCHEMA_SOURCE, 'exclusion_res'));
  return { state, source: createFakeConnectionSource(state) };
}

function freshTupleToUsersetSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 't2u_target'));
  seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 't2u_object'));
  return { state, source: createFakeConnectionSource(state) };
}

async function expectOk(
  result: { ok: true; token: number; created: boolean } | { ok: false },
): Promise<number> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected write to succeed');
  return result.token;
}

// ---------------------------------------------------------------------------
// Real statement-sequence accounting (traced against resolver.ts, then
// confirmed by running this file — see this file's own top-of-file doc
// comment). `productionCheck`'s real per-connection sequence is always:
//
//   1. BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY   (never anchors)
//   2. [pinned only] assertTokenObservedOnSnapshot's floor check — the
//      first REAL query, so THIS is what anchors the snapshot when pinned
//   2'. [unpinned] the walk's own first real read IS statement 2, and IS
//      what anchors the snapshot instead — same position, different query
//   3..N. every further relation_tuples read the walk's own rewrite tree
//      needs (frontier + tuples-on-frontier per relation-membership check;
//      one listTupleSubjects per tupleToUserset hop)
//   N+1. COMMIT
//
// "Post-anchor" pause points therefore always start at 2 (pinned: right
// after the floor check; unpinned: right after the first real read) and run
// through N (right before COMMIT) — every boundary the connection actually
// passes through while still inside the live transaction.
// ---------------------------------------------------------------------------

/**
 * union_res's `view = branch_one | branch_two` always evaluates
 * `branch_one` first (frontier+tuples, 2 queries) then, if that branch
 * alone doesn't decide it, `branch_two` (frontier+tuples, 2 more) — see
 * `evalRewrite`'s `'union'` case, which only short-circuits on the first
 * TRUE branch, never on a false one. Every fixture below is deliberately
 * constructed so `branch_one` is false and `branch_two` is what the check
 * actually turns on, forcing both branches — and therefore the full 4-query
 * sequence — to run every time. Pinned: BEGIN(1) tokencheck(2, anchors)
 * frontier-a(3) tuples-a(4) frontier-b(5) tuples-b(6) COMMIT(7) — post-
 * anchor boundaries {2,3,4,5,6}. Unpinned: BEGIN(1) frontier-a(2, anchors)
 * tuples-a(3) frontier-b(4) tuples-b(5) COMMIT(6) — post-anchor boundaries
 * {2,3,4,5}. Intersection and exclusion below share this identical 4-query,
 * 2-relation-check shape (see each fixture's own note for why), so the
 * exact same two point-arrays are reused for all three.
 */
const TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS = [2, 3, 4, 5, 6];
const TWO_RELATION_CHECK_POST_ANCHOR_UNPINNED_POINTS = [2, 3, 4, 5];

/**
 * t2u_object's `view = parent_link->view` issues exactly one
 * `listTupleSubjects` query (the `parent_link` hop) followed by one
 * relation-membership check (frontier+tuples) on whatever it points to —
 * 3 real queries total, one fewer than the two-relation-check shape above.
 * Pinned: BEGIN(1) tokencheck(2, anchors) listTupleSubjects(3) frontier(4)
 * tuples(5) COMMIT(6) — post-anchor boundaries {2,3,4,5}. Unpinned:
 * BEGIN(1) listTupleSubjects(2, anchors) frontier(3) tuples(4) COMMIT(5) —
 * post-anchor boundaries {2,3,4}.
 */
const TUPLE_TO_USERSET_POST_ANCHOR_PINNED_POINTS = [2, 3, 4, 5];
const TUPLE_TO_USERSET_POST_ANCHOR_UNPINNED_POINTS = [2, 3, 4];

// ---------------------------------------------------------------------------
// Property 7a — forward-direction coverage expansion.
//
// Construction (traced precisely against `assertTokenObservedOnSnapshot`'s
// own real code and `productionCheck`'s own real statement order, per this
// task's own instruction not to guess): `atToken` is checked TWICE — once
// on the plain pool, before any connection for this check is even opened,
// and a second time as the pinned connection's own first real statement,
// against `write_log` as *that connection's own* snapshot will see it.
// Because `REPEATABLE READ`'s snapshot is anchored at that connection's
// *first real query* (not at BEGIN), and both `write_log` and
// `relation_tuples` rows from one committed transaction become visible to
// any later snapshot atomically together (they are two rows the SAME
// `writeTuple` transaction commits at one `commitSeq`, never separately —
// see `src/store/dst/state.ts`'s own `commitSeq` accounting and
// `src/store/tuples.ts`'s own `insertWriteLog`/tuple-insert pairing inside
// one `BEGIN`/`COMMIT`), a token G obtained from a real write that already
// committed BEFORE this check's connection is even opened is trivially, and
// unconditionally, within reach of this check's own eventual snapshot —
// regardless of when, mid-flight, that snapshot actually gets to anchor,
// and regardless of what unrelated concurrent writes land during any pause
// along the way. That is the exact "never loses a write with token <= T"
// contract, pinned as tightly as it can be constructed: T = G, the flip
// write's own token, so this is the T <= T boundary case, not a looser
// approximation of it.
//
// Each fixture below: (1) writes whatever OTHER fact (if any) the rewrite
// tree needs just to reach its own second branch/hop at all — never itself
// the fact that flips the answer; (2) confirms, with a real (unpaused,
// unpinned) check, that the object is genuinely denied before the flip
// write; (3) writes the ONE flip fact, capturing its own token as G;
// (4) races a check pinned at G, at every real post-anchor statement
// boundary, against a completely unrelated "noise" write landing during
// the pause — and asserts `allowed: true` every time.
// ---------------------------------------------------------------------------

describe('Property 7a — a write already committed before a pinned checks own connection ever opens is never lost, across every rewrite-rule kind and every post-anchor pause point', () => {
  describe('union (union_res#view = branch_one | branch_two)', () => {
    it.each(TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS)(
      'pauseAfterStatements=%i: the flip grant on the SECOND union branch survives every pause point',
      async (pausePoint) => {
        const { source } = freshUnionSource();

        const before = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'union_res', id: 'racy' },
          'view',
        );
        expect(before.allowed).toBe(false);

        const flipWrite = await writeTuple(source, {
          objectNs: 'union_res',
          objectId: 'racy',
          relation: 'branch_two',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        const pinnedToken = await expectOk(flipWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'union_res', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            // Unrelated noise, on a different object, with a strictly
            // higher token than the pin — proves the pinned check's own
            // required write (token <= pinnedToken) survives regardless of
            // what else lands mid-pause.
            const noise: TupleKey = {
              objectNs: 'union_res',
              objectId: 'noise',
              relation: 'branch_one',
              subjectNs: 'user',
              subjectId: 'zoe',
            };
            await expectOk(await writeTuple(source, noise));
          },
        });

        expect(result.allowed).toBe(true);
      },
    );
  });

  describe('intersection (intersection_res#view = branch_one & branch_two)', () => {
    it.each(TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS)(
      'pauseAfterStatements=%i: the flip grant on the SECOND (short-circuit-blocking) intersection branch survives every pause point',
      async (pausePoint) => {
        const { source } = freshIntersectionSource();

        // branch_one must already be true, or evalRewrite's intersection
        // case short-circuits before ever reaching branch_two at all —
        // this write is structural (needed to reach the full 4-query
        // sequence), never itself the flip.
        await expectOk(
          await writeTuple(source, {
            objectNs: 'intersection_res',
            objectId: 'racy',
            relation: 'branch_one',
            subjectNs: 'user',
            subjectId: 'alice',
          }),
        );

        const before = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'intersection_res', id: 'racy' },
          'view',
        );
        expect(before.allowed).toBe(false);

        const flipWrite = await writeTuple(source, {
          objectNs: 'intersection_res',
          objectId: 'racy',
          relation: 'branch_two',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        const pinnedToken = await expectOk(flipWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'intersection_res', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            const noise: TupleKey = {
              objectNs: 'intersection_res',
              objectId: 'noise',
              relation: 'branch_one',
              subjectNs: 'user',
              subjectId: 'zoe',
            };
            await expectOk(await writeTuple(source, noise));
          },
        });

        expect(result.allowed).toBe(true);
      },
    );
  });

  describe('exclusion (exclusion_res#view = grantee - banned)', () => {
    it.each(TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS)(
      'pauseAfterStatements=%i: the flip grant on the BASE branch (with banned staying empty) survives every pause point',
      async (pausePoint) => {
        const { source } = freshExclusionSource();

        // No grantee tuple yet: evalRewrite's exclusion case disproves the
        // base immediately and never even evaluates `banned` — a genuinely
        // short sequence, and a genuinely denied result.
        const before = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'exclusion_res', id: 'racy' },
          'view',
        );
        expect(before.allowed).toBe(false);

        // The flip: granting the BASE is what turns this on (banned has,
        // and stays, zero rows) — unlike union/intersection, this single
        // write both reaches the second (subtract) branch AND is the fact
        // that flips the answer, in one shot.
        const flipWrite = await writeTuple(source, {
          objectNs: 'exclusion_res',
          objectId: 'racy',
          relation: 'grantee',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        const pinnedToken = await expectOk(flipWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'exclusion_res', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            const noise: TupleKey = {
              objectNs: 'exclusion_res',
              objectId: 'noise',
              relation: 'grantee',
              subjectNs: 'user',
              subjectId: 'zoe',
            };
            await expectOk(await writeTuple(source, noise));
          },
        });

        expect(result.allowed).toBe(true);
      },
    );
  });

  describe('tupleToUserset (t2u_object#view = parent_link->view)', () => {
    it.each(TUPLE_TO_USERSET_POST_ANCHOR_PINNED_POINTS)(
      'pauseAfterStatements=%i: the flip grant on the FOLLOWED objects own relation survives every pause point',
      async (pausePoint) => {
        const { source } = freshTupleToUsersetSource();

        // The parent_link edge is structural: without it, listTupleSubjects
        // returns zero subjects and the tupleToUserset rule contributes
        // nothing via a much shorter (1-query) sequence — this write is
        // what makes the full 3-query sequence real, never itself the flip.
        await expectOk(
          await writeTuple(source, {
            objectNs: 't2u_object',
            objectId: 'racy',
            relation: 'parent_link',
            subjectNs: 't2u_target',
            subjectId: 'grp',
          }),
        );

        const before = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 't2u_object', id: 'racy' },
          'view',
        );
        expect(before.allowed).toBe(false);

        const flipWrite = await writeTuple(source, {
          objectNs: 't2u_target',
          objectId: 'grp',
          relation: 'viewer',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        const pinnedToken = await expectOk(flipWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 't2u_object', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            const noise: TupleKey = {
              objectNs: 't2u_target',
              objectId: 'noise',
              relation: 'viewer',
              subjectNs: 'user',
              subjectId: 'zoe',
            };
            await expectOk(await writeTuple(source, noise));
          },
        });

        expect(result.allowed).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // "Genuinely a floor, not a ceiling" — a live demonstration of exactly why
  // this file does NOT implement the original design's disproven "backward"
  // half (see this file's own top-of-file doc comment). A concurrent write
  // that lands BEFORE the pinned connection's own snapshot ever anchors
  // (pauseAfterStatements=1, strictly pre-anchor — never claimed as a
  // "post-anchor" point above) legitimately becomes visible to that
  // snapshot even though its own token is HIGHER than the pin — because
  // `REPEATABLE READ`'s real anchor point is "whatever is actually
  // committed the moment the first real query runs," not "exactly the
  // pinned token and nothing more." Asserting `allowed: false` here would
  // be asserting a property `atToken` never promised.
  // -------------------------------------------------------------------------
  it('a write with a HIGHER token than the pin, landing strictly before the snapshot anchors, is legitimately visible — atToken is a floor, not a ceiling', async () => {
    const { source } = freshUnionSource();

    const decoyWrite = await writeTuple(source, {
      objectNs: 'union_res',
      objectId: 'decoy',
      relation: 'branch_one',
      subjectNs: 'user',
      subjectId: 'zoe',
    });
    const pinnedToken = await expectOk(decoyWrite);

    // pauseAfterStatements: 1 — pauses BEFORE statement 2 (the token
    // floor-check, the real query that anchors the snapshot), i.e. strictly
    // pre-anchor. See connection.ts's own doc comment: the pause check runs
    // before the anchor-setting branch, so this is the one point in this
    // whole file that is deliberately NOT a "post-anchor" boundary.
    const result = await raceUnderPause({
      source,
      pauseAfterStatements: 1,
      heldOp: () =>
        productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'union_res', id: 'racy' },
          'view',
          { atToken: pinnedToken },
        ),
      concurrentOp: async () => {
        // This write's own token is strictly HIGHER than pinnedToken — and
        // yet, because it commits before the paused connection's anchor
        // statement ever runs, the anchor (whenever it resumes and runs)
        // sees it anyway. Real, correct REPEATABLE READ behavior — not a
        // bug, and not something a "never observes token > T" assertion
        // could ever pass against.
        await expectOk(
          await writeTuple(source, {
            objectNs: 'union_res',
            objectId: 'racy',
            relation: 'branch_two',
            subjectNs: 'user',
            subjectId: 'alice',
          }),
        );
      },
    });

    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 7b — pure REPEATABLE READ isolation, decoupled from atToken.
//
// Generalizes the existing D-092 regression (which only ever ran the
// single-relation-check shape, only ever pinned) two ways at once: across
// all four rewrite-rule kinds, and across BOTH pinned and unpinned checks —
// see this file's own top-of-file doc comment for exactly what bug class
// the unpinned half catches that a pinned-only corpus structurally cannot.
// ---------------------------------------------------------------------------

describe('Property 7b — once a checks own snapshot has anchored, no later write is ever observed by it (pinned AND unpinned), across every rewrite-rule kind', () => {
  describe('union (union_res#view = branch_one | branch_two)', () => {
    it.each(TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS)(
      'pinned, pauseAfterStatements=%i: a grant on branch_two committed mid-pause never flips this pinned checks own result',
      async (pausePoint) => {
        const { source } = freshUnionSource();
        const decoyWrite = await writeTuple(source, {
          objectNs: 'union_res',
          objectId: 'decoy',
          relation: 'branch_one',
          subjectNs: 'user',
          subjectId: 'zoe',
        });
        const pinnedToken = await expectOk(decoyWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'union_res', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 'union_res',
                objectId: 'racy',
                relation: 'branch_two',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(false);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'union_res', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(true);
      },
    );

    it.each(TWO_RELATION_CHECK_POST_ANCHOR_UNPINNED_POINTS)(
      'unpinned, pauseAfterStatements=%i: the identical non-observation holds with no atToken at all',
      async (pausePoint) => {
        const { source } = freshUnionSource();

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'union_res', id: 'racy' },
              'view',
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 'union_res',
                objectId: 'racy',
                relation: 'branch_two',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(false);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'union_res', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(true);
      },
    );
  });

  describe('intersection (intersection_res#view = branch_one & branch_two)', () => {
    it.each(TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS)(
      'pinned, pauseAfterStatements=%i: a grant on branch_two committed mid-pause never flips this pinned checks own result',
      async (pausePoint) => {
        const { source } = freshIntersectionSource();
        // branch_one already true (decoy/structural) so evalRewrite
        // genuinely reaches, and evaluates, branch_two too — the full
        // 4-query sequence, not a branch_one short-circuit.
        const decoyWrite = await writeTuple(source, {
          objectNs: 'intersection_res',
          objectId: 'racy',
          relation: 'branch_one',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        const pinnedToken = await expectOk(decoyWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'intersection_res', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 'intersection_res',
                objectId: 'racy',
                relation: 'branch_two',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(false);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'intersection_res', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(true);
      },
    );

    it.each(TWO_RELATION_CHECK_POST_ANCHOR_UNPINNED_POINTS)(
      'unpinned, pauseAfterStatements=%i: the identical non-observation holds with no atToken at all',
      async (pausePoint) => {
        const { source } = freshIntersectionSource();
        await expectOk(
          await writeTuple(source, {
            objectNs: 'intersection_res',
            objectId: 'racy',
            relation: 'branch_one',
            subjectNs: 'user',
            subjectId: 'alice',
          }),
        );

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'intersection_res', id: 'racy' },
              'view',
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 'intersection_res',
                objectId: 'racy',
                relation: 'branch_two',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(false);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'intersection_res', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(true);
      },
    );
  });

  describe('exclusion (exclusion_res#view = grantee - banned)', () => {
    it.each(TWO_RELATION_CHECK_POST_ANCHOR_PINNED_POINTS)(
      'pinned, pauseAfterStatements=%i: a grant on banned committed mid-pause never flips this pinned checks own allowed result to denied',
      async (pausePoint) => {
        const { source } = freshExclusionSource();
        // grantee already true (decoy/structural) so evalRewrite genuinely
        // reaches, and evaluates, `banned` too — the full 4-query sequence
        // — and the baseline is ALLOWED (banned starts empty), the mirror
        // image of union/intersection's baseline-denied shape above: this
        // exercises "a later write is not observed" in the
        // allowed-would-flip-to-denied direction instead.
        const decoyWrite = await writeTuple(source, {
          objectNs: 'exclusion_res',
          objectId: 'racy',
          relation: 'grantee',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        const pinnedToken = await expectOk(decoyWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'exclusion_res', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 'exclusion_res',
                objectId: 'racy',
                relation: 'banned',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        // The would-be-denying write is NOT observed — this pinned check's
        // own answer stays allowed, exactly as its own frozen snapshot saw
        // the world before the ban ever committed.
        expect(result.allowed).toBe(true);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'exclusion_res', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(false);
      },
    );

    it.each(TWO_RELATION_CHECK_POST_ANCHOR_UNPINNED_POINTS)(
      'unpinned, pauseAfterStatements=%i: the identical non-observation holds with no atToken at all',
      async (pausePoint) => {
        const { source } = freshExclusionSource();
        await expectOk(
          await writeTuple(source, {
            objectNs: 'exclusion_res',
            objectId: 'racy',
            relation: 'grantee',
            subjectNs: 'user',
            subjectId: 'alice',
          }),
        );

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 'exclusion_res', id: 'racy' },
              'view',
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 'exclusion_res',
                objectId: 'racy',
                relation: 'banned',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(true);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'exclusion_res', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(false);
      },
    );
  });

  describe('tupleToUserset (t2u_object#view = parent_link->view)', () => {
    it.each(TUPLE_TO_USERSET_POST_ANCHOR_PINNED_POINTS)(
      'pinned, pauseAfterStatements=%i: a viewer grant on the followed object committed mid-pause never flips this pinned checks own result',
      async (pausePoint) => {
        const { source } = freshTupleToUsersetSource();
        // The parent_link edge is structural (needed to reach the target
        // object at all, giving the full 3-query sequence) — the decoy
        // token pinned below.
        const decoyWrite = await writeTuple(source, {
          objectNs: 't2u_object',
          objectId: 'racy',
          relation: 'parent_link',
          subjectNs: 't2u_target',
          subjectId: 'grp',
        });
        const pinnedToken = await expectOk(decoyWrite);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 't2u_object', id: 'racy' },
              'view',
              { atToken: pinnedToken },
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 't2u_target',
                objectId: 'grp',
                relation: 'viewer',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(false);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 't2u_object', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(true);
      },
    );

    it.each(TUPLE_TO_USERSET_POST_ANCHOR_UNPINNED_POINTS)(
      'unpinned, pauseAfterStatements=%i: the identical non-observation holds with no atToken at all',
      async (pausePoint) => {
        const { source } = freshTupleToUsersetSource();
        await expectOk(
          await writeTuple(source, {
            objectNs: 't2u_object',
            objectId: 'racy',
            relation: 'parent_link',
            subjectNs: 't2u_target',
            subjectId: 'grp',
          }),
        );

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: pausePoint,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: 'alice' },
              { ns: 't2u_object', id: 'racy' },
              'view',
            ),
          concurrentOp: async () => {
            await expectOk(
              await writeTuple(source, {
                objectNs: 't2u_target',
                objectId: 'grp',
                relation: 'viewer',
                subjectNs: 'user',
                subjectId: 'alice',
              }),
            );
          },
        });

        expect(result.allowed).toBe(false);

        const fresh = await productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 't2u_object', id: 'racy' },
          'view',
        );
        expect(fresh.allowed).toBe(true);
      },
    );
  });
});
