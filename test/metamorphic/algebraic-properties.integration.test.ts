/**
 * Four corrected metamorphic/algebraic properties for the ReBAC engine —
 * an earlier design+adversarial-review pass proposed seven such properties,
 * broke each one's ORIGINAL form under adversarial review, and produced a
 * corrected, verified-sound version of each. This file implements exactly
 * the four corrected properties assigned to it (labelled A-D below), not
 * their original, flawed statements. This mirrors this project's own
 * established discipline of adversarial review before shipping a claim —
 * see `docs/DECISIONS.md`'s cache epoch-fence story, D-092 (the
 * phantom-witness finding: a claim that "looks obviously true" from the
 * code's shape turned out to require a real, careful counterexample search
 * before it could be trusted), and D-119 (mutation testing found two
 * shipped test files that asserted the right *shape* of result without
 * actually pinning down the property that mattered).
 *
 * **Why these four are "metamorphic" properties, structurally different
 * from every other test file in this repo.** Every other integration test
 * in `test/isolation/` and `test/unit/resolve/production/` either (a)
 * hand-derives one specific expected answer and asserts a resolver matches
 * it, or (b) runs the differential fuzz harness and asserts the production
 * resolver agrees with the independent reference resolver on many random
 * queries. Both of those need an *oracle* for the expected answer (a human
 * hand-deriving it, or the reference resolver deriving it independently). A
 * metamorphic property instead states a relationship that must hold between
 * two *related* runs of the SAME system, without ever computing an
 * independent expected answer at all — "these two things must agree with
 * EACH OTHER," not "this must match a known-correct answer." That makes
 * metamorphic testing a genuinely different verification axis from
 * differential fuzzing (Phase 5) and hand-derived unit tests (Phase 3/4):
 * it can catch a bug that happens to be *consistent* with itself in a way
 * that would never surface as a hand-derived-example mismatch, but would
 * surface as two runs of the identical logical fact set disagreeing with
 * each other.
 *
 * **On atToken: it is a floor, never an exact snapshot pin (see
 * `docs/CONSISTENCY.md` and `src/store/tokens.ts`'s own doc comment).**
 * Every property below that pins to a token relies on ordinary real-time
 * happens-before ordering — every write this file performs is sequential
 * (`for...await`, never `Promise.all`, matching `src/soundness/runner.ts`'s
 * own real write-phase convention) and nothing outside this file's own
 * uniquely-salted namespaces ever touches the rows a given property reasons
 * about between its writes and its checks. No assertion below is ever
 * justified by "atToken pins an exact historical state" — that claim would
 * be false of this system (a check pinned to token T is a floor: it
 * observes T and everything before it, and is free to observe MORE if
 * something else committed in the meantime) and every property here is
 * instead justified by the strict single-threaded ordering this test
 * enforces on itself, stated explicitly at each use.
 *
 * **Convention, matching `test/isolation/differential-soundness.fuzz
 * .integration.test.ts` and every file in `test/unit/resolve/production/`
 * exactly:** this file starts its own ephemeral `PostgreSqlContainer`
 * (real Postgres 16, via `@testcontainers/postgresql`, already a
 * devDependency) and applies this project's own migrations, rather than
 * assuming any one environment's local Postgres is reachable at a fixed
 * connection string (`docs/DECISIONS.md` D-019/D-030: a hardcoded
 * connection string has already broken CI twice on this project). Every
 * namespace/object/subject name below is freshly salted per test/trial
 * (`uniqueName`, mirroring `cross-resolver-agreement.integration.test.ts`'s
 * own established per-worker-salt convention) — other agents in this same
 * workflow may be running real-Postgres integration tests concurrently
 * against the SAME live database, so nothing here may assume the database
 * is empty or exclusively its own.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, deleteTuple, type TupleKey } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { productionCheck } from '../../src/resolve/production/resolver.js';
import { expand } from '../../src/audit/expand.js';
import { generateFixture } from '../../src/soundness/generators.js';
import { runMigrations } from '../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract — see the identical comment in every
    // sibling *.integration.test.ts file in this repo: without this, an
    // idle client hitting a background/network-level error (most commonly
    // this file's own container being stopped in afterAll while a pooled
    // connection was still technically open) crashes the whole test run
    // with an unhandled 'error' event, even though every real assertion
    // already passed. Logged, not swallowed.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Shared helpers — deliberately small and local to this file, matching this
// repo's own established per-integration-test-file convention rather than
// importing a shared test-utility module (see docs/DECISIONS.md D-022's
// general "don't force accidental coupling between independent test files"
// reasoning, applied here to test helpers rather than resolver code).
// ---------------------------------------------------------------------------

let uniqueCounter = 0;
// A random salt generated once when this file's test worker starts —
// `Date.now()` alone collides across sibling *.integration.test.ts files
// vitest runs in parallel worker threads that can start within the same
// wall-clock millisecond (a real, previously-hit defect on this project —
// see cross-resolver-agreement.integration.test.ts's own identical comment).
const processSalt = Math.random().toString(36).slice(2, 10);
/** A fresh lowercase identifier, unique across this and sibling test files/workers, matching IDENTIFIER_PATTERN (`^[a-z][a-z0-9_]*$`). */
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

interface Ref {
  ns: string;
  id: string;
}

function ref(ns: string, id: string): Ref {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): TupleKey {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

/** Publishes `source` and fails the test (with the real errors) if it doesn't compile/publish. */
async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

/** Writes `t` for real and fails the test if the store rejects it. Returns the full result (token, created) — several properties below need both. */
async function writeOk(t: TupleKey): Promise<{ token: number; created: boolean }> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
  return { token: result.token, created: result.created };
}

/** Deletes `t` for real and fails the test if the store rejects it. */
async function deleteOk(t: TupleKey): Promise<{ token: number; deleted: boolean }> {
  const result = await deleteTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to delete: ${JSON.stringify(result.errors)}`);
  }
  return { token: result.token, deleted: result.deleted };
}

/**
 * Races `promise` against a `ms`-millisecond timer and reports which one
 * settled first, WITHOUT ever throwing on timeout — a hang must be a normal,
 * assertable test failure ("resolved a timeout sentinel, not the real
 * result"), never an uncaught rejection or a vitest-level timeout that
 * reports as an ambiguous suite-level failure. Used exclusively by Property
 * D below: "denied AND resolved within the timeout" is two independent
 * assertions on the SAME race result, exactly per that property's own
 * corrected statement — a hang must fail this test as decisively as a wrong
 * grant would.
 *
 * Deliberate, disclosed limitation: if `promise` never settles, this
 * function's own timer branch still resolves and lets the test report a
 * clean, specific failure — but the abandoned `promise` itself keeps
 * running in the background (attached to a real, checked-out Postgres
 * connection) for as long as it takes to actually finish or the process
 * exits. That is only a live risk if cycle detection is ACTUALLY broken,
 * which — per this project's own real, current code — it is not; this
 * helper's contract is "prove denied-and-fast when the guard works, fail
 * loud and specific when it doesn't," not "guarantee bounded resource use
 * under an active regression."
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ kind: 'resolved'; value: T } | { kind: 'timeout' }> {
  return Promise.race([
    promise.then((value): { kind: 'resolved'; value: T } => ({ kind: 'resolved', value })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Property A — idempotent-duplicate-write-check-invariance
// ---------------------------------------------------------------------------

describe('Property A — idempotent-duplicate-write-check-invariance', () => {
  /**
   * **What this catches that neither differential fuzzing nor a static
   * schema check could.** Differential fuzzing (Phase 5) compares the
   * production resolver against the reference resolver at ONE token/state;
   * it has no way to notice that the production resolver's own answer
   * changes between two tokens that observe the exact same visible fact
   * set. A static schema check operates purely on the compiled rewrite
   * rules, before any tuple or token exists at all. This property is
   * specifically about the *consistency-token pinning* mechanism itself
   * (§6.3): the top-level task's own explicit mandate is "a check pinned to
   * a token T must never return a result that ignores a write with token <=
   * T" — write the test that proves this directly. This test proves the
   * companion half of that same mandate from the opposite direction: two
   * DIFFERENT tokens whose visible fact sets are IDENTICAL (T1's only new
   * fact, per `writeTuple`'s own documented idempotent-duplicate contract,
   * is a `write_log` row — `created: false` means zero new `relation_tuples`
   * rows) must produce IDENTICAL `allowed` verdicts for every query. A bug
   * this would catch: an implementation that (mis)treats `atToken` as an
   * exact snapshot equality check rather than a floor (e.g., a
   * `write_log.id = $token` comparison instead of `>=`), or a not-yet-shipped
   * result cache keyed by exact token value in a way that fails to notice
   * two different tokens denote the same visible world and serves a stale
   * hit/miss inconsistently between them — such a bug could pass every
   * hand-derived example AND every differential-fuzz query (both of which
   * only ever check ONE token per query) while still violating the "floor,
   * not a pin" contract this whole property exists to test.
   */
  it('a tuple key written twice in immediate succession yields two tokens whose pinned checks agree on every query in the fixture', async () => {
    // A fresh seed per test run — generateFixture salts every namespace
    // name from a hash of this seed (see generators.ts's own top-of-file
    // doc comment), so a unique seed here is what keeps this run's
    // namespaces from ever colliding with any other seed's, this file's
    // own or another concurrently-running agent's.
    const seed = uniqueName('propA-seed');
    const QUERY_COUNT = 40;
    const fixture = generateFixture(seed, QUERY_COUNT);

    await publishOk(fixture.schemaSource);

    // Every fixture tuple, written SEQUENTIALLY — for...await, never
    // Promise.all — exactly matching src/soundness/runner.ts's own real
    // write-phase convention (the task's own explicit instruction), and
    // required for the "strict real-time happens-before ordering, no
    // concurrent writer" discipline every atToken-pinned assertion below
    // depends on.
    let lastToken: number | undefined;
    for (const t of fixture.tuples) {
      const written = await writeOk(t);
      lastToken = written.token;
    }
    if (lastToken === undefined) {
      throw new Error('generateFixture produced zero tuples — a generator bug, not a test bug');
    }
    const T0 = lastToken;

    // The duplicate write of an already-written key K — this MUST be the
    // LAST write this test performs, per the property's own statement:
    // everything after this point is checks only, no further writes.
    const duplicateKey = fixture.tuples[0];
    if (!duplicateKey) {
      throw new Error('generateFixture produced zero tuples — a generator bug, not a test bug');
    }
    const duplicateWrite = await writeOk(duplicateKey);
    // Hand-derived from writeTuple's own documented contract
    // (src/store/tuples.ts): an identical key hits the `on conflict ...
    // do nothing` branch — zero new relation_tuples rows — while
    // write_log still gets a new row (the same reason a redundant delete
    // still advances the token). So: created:false, but the token is
    // still strictly greater than T0.
    expect(duplicateWrite.created).toBe(false);
    expect(duplicateWrite.token).toBeGreaterThan(T0);
    const T1 = duplicateWrite.token;

    // Both full query batches, back-to-back, with NO intervening write —
    // the exact condition the property's own corrected statement
    // requires. Run SEQUENTIALLY, not via Promise.all — this is still
    // required today, on its own, for the "no intervening write" ordering
    // discipline alone: concurrent execution could let a write from one
    // in-flight call's own connection interleave between two queries this
    // property's own precondition needs to stay atomic, independent of
    // anything about connection-pool sizing.
    //
    // Historical note — the SECOND, independent reason this was originally
    // sequential no longer applies, but is kept here as the real account of
    // how this test was actually developed, not retroactively cleaned up.
    // When this test was first written, `productionCheck` held ONE pinned
    // `PoolClient` for its own `REPEATABLE READ` transaction for its whole
    // lifetime, but `getConfig`'s `namespace_configs` lookup deliberately
    // still went through `ctx.pool` (a second, independent `pool.query()`
    // call) rather than that same pinned client — a disclosed gap in
    // `docs/DECISIONS.md` D-092's own writeup. That meant one in-flight
    // `productionCheck` call could need TWO real pool connections
    // simultaneously. Racing `QUERY_COUNT` (40) such calls concurrently via
    // `Promise.all` against `pg.Pool`'s default `max: 10` deadlocked the
    // pool outright: the first 10 calls each grabbed one connection for
    // their own pinned transaction and blocked on the token floor-check
    // query; once all 10 were through that first query and ready to call
    // `getConfig`, none of them could ever obtain the SECOND connection
    // `getConfig` needed, because all 10 available connections were already
    // held, each waiting on the other — confirmed live: this exact
    // `Promise.all` version was run once, observed to hang indefinitely,
    // and `pg_stat_activity` on the real database showed exactly 10
    // connections `idle in transaction`, all having just finished `select
    // max(token) as max_token from write_log` (the token floor check) and
    // stalled there, before this was rewritten to the strictly sequential
    // form below. That gap — disclosed as real, live, standalone follow-up
    // work (`docs/DECISIONS.md` D-140's own "Revisit if," independently
    // reproduced a second time in D-142) — is now closed structurally:
    // `getConfig` runs on the same pinned client as everything else in the
    // check, so a single `productionCheck`/`expand()` call never needs more
    // than one connection, at any concurrency (see `resolver.ts`'s own doc
    // comment for the fix). This describe block's own query batches stay
    // sequential regardless, per the first, still-live reason above.
    const resultsAtT0: boolean[] = [];
    for (const q of fixture.queries) {
      const result = await productionCheck(
        pool,
        ref(q.subject.ns, q.subject.id),
        ref(q.object.ns, q.object.id),
        q.relationOrPermission,
        { atToken: T0 },
      );
      resultsAtT0.push(result.allowed);
    }
    const resultsAtT1: boolean[] = [];
    for (const q of fixture.queries) {
      const result = await productionCheck(
        pool,
        ref(q.subject.ns, q.subject.id),
        ref(q.object.ns, q.object.id),
        q.relationOrPermission,
        { atToken: T1 },
      );
      resultsAtT1.push(result.allowed);
    }

    expect(resultsAtT0).toHaveLength(fixture.queries.length);
    expect(resultsAtT1).toHaveLength(fixture.queries.length);
    for (let i = 0; i < fixture.queries.length; i += 1) {
      const q = fixture.queries[i];
      const atT0 = resultsAtT0[i];
      const atT1 = resultsAtT1[i];
      if (!q || atT0 === undefined || atT1 === undefined) {
        throw new Error('unreachable: index within bounds was undefined');
      }
      expect(
        atT1,
        `query ${i} (${q.subject.ns}:${q.subject.id} -> ${q.relationOrPermission} -> ${q.object.ns}:${q.object.id}) disagreed between T0=${T0} and T1=${T1}`,
      ).toBe(atT0);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Property B — write-order-commutativity-final-state
// ---------------------------------------------------------------------------

describe('Property B — write-order-commutativity-final-state', () => {
  /** `relation a: user`, `relation b: user`, `permission both = a & b`, `permission either = a | b` — the fixed template every trial re-salts. */
  function templateSource(ns: string): string {
    return [
      `namespace ${ns} {`,
      '  relation a: user',
      '  relation b: user',
      '',
      '  permission both = a & b',
      '  permission either = a | b',
      '}',
    ].join('\n');
  }

  /**
   * **What this catches that neither differential fuzzing nor a static
   * schema check could.** A static schema check has no notion of write
   * order at all — `permission both = a & b` is declared symmetric in the
   * DSL text regardless of which relation tuple lands in Postgres first.
   * Differential fuzzing writes a single fixture's tuples in ONE order and
   * checks the result once; it has no mechanism to notice a resolver whose
   * real answer secretly depends on physical row insertion order rather
   * than on the abstract set of facts that exist. This property is a direct
   * probe of exactly that risk, and it is not hypothetical on this
   * codebase: `docs/DECISIONS.md` D-092 finding #2's own disclosed
   * trade-off is "`DISTINCT ON` with no `ORDER BY` picks an UNSPECIFIED
   * representative among same-iteration duplicates" in the SQL recursive
   * CTE `fetchReachableFrontier` uses — explicitly argued, at the time, to
   * only ever affect diagnostic path-length precision, never the boolean
   * `allowed` verdict. This property is the direct, independent check of
   * that argument: two structurally-identical graphs, built by writing the
   * SAME two tuples in the OPPOSITE order, must still agree on `allowed`
   * for both `&` (intersection) and `|` (union). It would also catch a
   * much cruder bug: an intersection or union implemented with an
   * early-return that happens to depend on which branch's underlying row
   * committed first (e.g., a buggy "short-circuit on the first relation
   * that has ANY row, regardless of which one" implementation of `&`) —
   * that class of bug could easily pass every hand-derived example (which
   * typically writes tuples in one fixed, "obvious" order) while still
   * being wrong for the opposite order.
   *
   * Explicitly NOT a byte-identical-rows claim (the task's own corrected
   * wording): the two namespaces' `relation_tuples` rows differ in id,
   * `created_at`, and the namespace string itself (each carries its own
   * salt) — this property only ever compares the ALLOWED verdicts for
   * structurally-corresponding queries, never the raw rows.
   */
  it('the same two tuples written in opposite order, into two independently-salted copies of the identical schema template, produce identical allowed verdicts for both intersection and union — 20 trials', async () => {
    const TRIALS = 20;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const ns1 = uniqueName(`propb1t${trial}`);
      const ns2 = uniqueName(`propb2t${trial}`);
      // One random subject and one random object, SHARED across both
      // namespace copies — the property's own corrected statement
      // requires the same logical (subject, object) pair be checked in
      // both, so any divergence can only be attributable to write order,
      // never to different entities being compared.
      const subjectId = `subj_${Math.random().toString(36).slice(2, 10)}`;
      const objectId = `obj_${Math.random().toString(36).slice(2, 10)}`;

      // ns1: publish, write X (grants `a`) then Y (grants `b`).
      await publishOk(templateSource(ns1));
      await writeOk(tuple(ns1, objectId, 'a', 'user', subjectId));
      const ns1Final = await writeOk(tuple(ns1, objectId, 'b', 'user', subjectId));
      const T1 = ns1Final.token;

      // ns2: publish, write Y (grants `b`) then X (grants `a`) — the
      // OPPOSITE order, on a structurally-identical but physically
      // independent namespace instance.
      await publishOk(templateSource(ns2));
      await writeOk(tuple(ns2, objectId, 'b', 'user', subjectId));
      const ns2Final = await writeOk(tuple(ns2, objectId, 'a', 'user', subjectId));
      const T2 = ns2Final.token;

      const bothNs1 = await productionCheck(
        pool,
        ref('user', subjectId),
        ref(ns1, objectId),
        'both',
        {
          atToken: T1,
        },
      );
      const bothNs2 = await productionCheck(
        pool,
        ref('user', subjectId),
        ref(ns2, objectId),
        'both',
        {
          atToken: T2,
        },
      );
      const eitherNs1 = await productionCheck(
        pool,
        ref('user', subjectId),
        ref(ns1, objectId),
        'either',
        {
          atToken: T1,
        },
      );
      const eitherNs2 = await productionCheck(
        pool,
        ref('user', subjectId),
        ref(ns2, objectId),
        'either',
        {
          atToken: T2,
        },
      );

      // Sanity check before the real assertion: both grants exist in
      // both namespaces by construction, so BOTH permissions must
      // genuinely be true in both — a trial where this were false would
      // mean the fixture itself was broken, not a real finding about
      // write-order commutativity.
      expect(bothNs1.allowed, `trial ${trial}: expected 'both' true on ns1`).toBe(true);
      expect(eitherNs1.allowed, `trial ${trial}: expected 'either' true on ns1`).toBe(true);

      // The actual property: agreement across the two independently-
      // ordered, independently-salted copies.
      expect(bothNs2.allowed, `trial ${trial}: 'both' disagreed between write orders`).toBe(
        bothNs1.allowed,
      );
      expect(eitherNs2.allowed, `trial ${trial}: 'either' disagreed between write orders`).toBe(
        eitherNs1.allowed,
      );
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Property C — sole-grounding-deletion-flip-via-expand
// ---------------------------------------------------------------------------

describe('Property C — sole-grounding-deletion-flip-via-expand', () => {
  /**
   * **What this catches that neither differential fuzzing nor a static
   * schema check could.** `productionCheck` and `expand()`
   * (`src/audit/expand.ts`) are two SEPARATE, independently-written
   * production code paths over the same `relation_tuples` table —
   * `expand()`'s own top-of-file doc comment states plainly why it carries
   * no §6.2 "no shared code" weight (it has no oracle to stay independent
   * *from*: it answers "who is in this set," not "is this one subject in
   * this set," so there is no differential-fuzzing-style comparison for it
   * to participate in at all) and confirms neither its functions nor any
   * private helper of `resolver.ts`'s is imported by the other. That
   * independence is exactly what makes agreement between them meaningful
   * evidence here, the same reasoning §6.2 applies to the two check
   * resolvers, just for a genuinely different pair of code paths. This
   * property proves the SAME real-world event (deleting the one tuple that
   * grounds a permission) is observed identically by BOTH: before the
   * delete, `productionCheck` says allowed AND `expand()` shows the real
   * subject; after, `productionCheck` says denied AND `expand()` shows an
   * empty subject list. A bug this would catch: a `deleteTuple` predicate
   * mismatch between the two files' own hand-written SQL (e.g., a
   * `subject_relation` NULL-handling difference — `deleteTuple`'s own
   * `WHERE` clause vs. `expandRelation`'s `fetchTuplesOn` SELECT — that
   * left one of the two reading a phantom row the other correctly
   * considers gone), or a `productionCheck`-side staleness bug that
   * continues to see the tuple as extant (a false_grant that only THIS
   * cross-check, not a same-code-path unit test, would surface).
   *
   * **Honest scope, stated per this property's own corrected design:** this
   * fixture's schema (`relation viewer: user` / `permission view =
   * viewer` — no union/intersection/exclusion) makes "sole path" true BY
   * CONSTRUCTION, not something `expand()` discovers. `expand()`'s own
   * enumeration here is a genuine, valuable INDEPENDENT CONFIRMATION of two
   * separately-written production code paths agreeing — it is explicitly
   * NOT being used, and must never be read, as a substitute for Phase 5's
   * differential-fuzzing methodology (which compares `productionCheck`
   * against the wholly separate, hand-verified reference resolver — a
   * different comparison entirely, against a different independent
   * implementation).
   *
   * **On atToken and `expand()`:** `ExpandOptions` (`src/audit/expand.ts`)
   * has NO `atToken` field at all — confirmed by reading its exported
   * interface directly, not assumed. This property deliberately never
   * attempts to pass one. Every ordering claim below instead rests purely
   * on this test's own strict, single-threaded, sequential execution
   * (publish, write, check, expand, delete, check, expand — each `await`ed
   * before the next starts, nothing else touching this object concurrently)
   * — stated explicitly here because assuming `expand()` supported token
   * pinning was a real, documented flaw caught in this exact property's own
   * design review, and the corrected version exists specifically to not
   * reintroduce it.
   */
  it('deleting the sole grounding tuple flips both productionCheck and expand() from grant to empty, in strict sequential order', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    const soleGrant = tuple(ns, objectId, 'viewer', 'user', 'alice');

    // 1. The sole grounding tuple.
    const written = await writeOk(soleGrant);
    const T0 = written.token;

    // 2. productionCheck, pinned at T0 (nothing concurrent touches this
    // fixture, so pinned or unpinned would both be meaningful here — T0 is
    // used for symmetry with the post-delete check below).
    const beforeCheck = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
      {
        atToken: T0,
      },
    );
    expect(beforeCheck.allowed).toBe(true);

    // 3. expand() — independent confirmation via a wholly separate code
    // path. No atToken passed — ExpandOptions has none.
    const beforeExpand = await expand(pool, ref(ns, objectId), 'view');
    if (beforeExpand.kind !== 'relation') {
      throw new Error(`expected kind 'relation', got '${beforeExpand.kind}'`);
    }
    expect(beforeExpand.directSubjects).toHaveLength(1);
    expect(beforeExpand.directSubjects[0]).toEqual({ ns: 'user', id: 'alice' });
    expect(beforeExpand.usersets).toEqual([]);

    // 4. Delete the identical key.
    const deleted = await deleteOk(soleGrant);
    expect(deleted.deleted).toBe(true);
    const T1 = deleted.token;

    // 5. productionCheck again, pinned at T1 — must now observe the delete.
    const afterCheck = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
      {
        atToken: T1,
      },
    );
    expect(afterCheck.allowed).toBe(false);

    // 6. expand() again — still no atToken; relies purely on this test's
    // own strict sequential ordering (see this describe block's own doc
    // comment).
    const afterExpand = await expand(pool, ref(ns, objectId), 'view');
    if (afterExpand.kind !== 'relation') {
      throw new Error(`expected kind 'relation', got '${afterExpand.kind}'`);
    }
    expect(afterExpand.directSubjects).toEqual([]);
    expect(afterExpand.usersets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property D — ungrounded-cycle-growth-preserves-emptiness
// ---------------------------------------------------------------------------

describe('Property D — ungrounded-cycle-growth-preserves-emptiness', () => {
  /**
   * **What this catches that neither differential fuzzing nor a static
   * schema check could, and why it needs its own dedicated property.** A
   * static schema check (`checkCircularPermissions` in the compiler) only
   * catches a SYNTACTIC self-referential permission cycle (`permission p =
   * p`), a fixed property of the schema TEXT alone — it has no way to see,
   * and is not designed to see, a cycle formed by actual DATA (real written
   * tuples forming an object graph cycle), which is exactly what every
   * round below constructs. Differential fuzzing (Phase 5) DOES include a
   * guaranteed cycle in every generated fixture (`generateFixture`'s own
   * hand-placed `cycle_a`/`cycle_b` construction) — but a fuzz run's own
   * termination-proving power is entirely dependent on BOTH resolvers
   * finishing so a divergence can be counted; if cycle detection regressed
   * to the point of an actual hang, the fuzz run itself would simply never
   * finish, timing out the whole test suite ambiguously rather than
   * reporting a specific, attributable finding. Isolating cycle-termination
   * as its own dedicated, `Promise.race`d assertion — "denied AND resolved
   * within N seconds," both required — turns a would-be silent hang into a
   * loud, specific, fast-failing signal instead.
   *
   * **Why `maxDepth` is forced to a large, explicit value for D1 and D2
   * (not left at the default 25), mirroring `cross-resolver-agreement
   * .integration.test.ts`'s own established discipline for its analogous
   * cyclic fixture.** At the *default* `CHECK_MAX_DEPTH` of 25, a
   * completely broken cycle guard would STILL terminate quickly on a
   * 2-node cycle — the independent depth ceiling would silently absorb the
   * missing guard within 25 iterations, and this test would report
   * "denied, and fast" even with zero real cycle protection, proving
   * nothing about the cycle-detection mechanism specifically. Forcing
   * `maxDepth` to 1,000,000 removes that ambiguity: only a WORKING guard
   * can plausibly return in well under the several-second timeout at that
   * ceiling; a broken one would spend the entire million-iteration budget
   * (SQL-side: growing a `path` array by one element per row; TS-side: a
   * genuine unbounded recursive call chain) — the exact reasoning
   * `docs/DECISIONS.md`'s cyclic-case tests already apply, applied here to
   * a metamorphic-growth property instead of a single fixed-size check.
   */
  const FORCED_MAX_DEPTH_FOR_CYCLE_ISOLATION = 1_000_000;
  const CYCLE_TIMEOUT_MS = 8_000;

  describe('D1 — SQL recursive-CTE cycle guard, growing the cycle graph across three rounds', () => {
    function groupCycleSource(ns: string): string {
      return [`namespace ${ns} {`, `  relation member: user | ${ns}#member`, '}'].join('\n');
    }

    it('a 2-node cycle, then a disjoint second cycle reachable from it, then a redundant edge plus a third cycle — always denied for an unrelated subject, always bounded', async () => {
      const ns = uniqueName('grpd1');
      await publishOk(groupCycleSource(ns));

      const a = uniqueName('a');
      const b = uniqueName('b');
      // A subject id used NOWHERE in this fixture, at any round — never a
      // decoy tuple naming it elsewhere. Confirmed by reading
      // src/resolve/production/resolver.ts's own `fetchReachableFrontier`
      // and `fetchTuplesOnFrontier` directly (not assumed): NEITHER query
      // filters on subject_id at the SQL level at all — the recursive CTE
      // explores the object graph structure unconditionally, and subject
      // matching happens entirely in TypeScript, over the full,
      // unconditionally-computed frontier, in `sqlRelationMembershipWithWitness`'s
      // own `.some(...)` loop. A sibling file
      // (`cross-resolver-agreement.integration.test.ts`) adds a decoy
      // tuple naming its checked subject elsewhere specifically to defeat
      // a documented Postgres query-planner pruning risk — for THIS
      // exact, current query shape (verified directly against the live
      // source above), that risk does not apply, so this property's own
      // literal "used nowhere in this fixture" wording is followed
      // exactly rather than deviated from out of unnecessary caution.
      const stranger = uniqueName('stranger');

      // Round 1: the guaranteed 2-node cycle, zero grounding anywhere.
      await writeOk(tuple(ns, a, 'member', ns, b, 'member'));
      await writeOk(tuple(ns, b, 'member', ns, a, 'member'));

      const round1 = await raceWithTimeout(
        productionCheck(pool, ref('user', stranger), ref(ns, a), 'member', {
          maxDepth: FORCED_MAX_DEPTH_FOR_CYCLE_ISOLATION,
        }),
        CYCLE_TIMEOUT_MS,
      );
      expect(
        round1.kind,
        'round 1: productionCheck did not resolve within the timeout — a hang, not a wrong answer, but exactly the failure mode this property exists to catch',
      ).toBe('resolved');
      if (round1.kind === 'resolved') {
        expect(round1.value.allowed).toBe(false);
      }

      // Round 2: a second, DISJOINT cycle (c <-> d), connected into the
      // reachable graph from `a` via b -> c, still zero grounding
      // anywhere. Growing the cycle structure must not somehow flip the
      // answer or reintroduce non-termination.
      const c = uniqueName('c');
      const d = uniqueName('d');
      await writeOk(tuple(ns, c, 'member', ns, d, 'member'));
      await writeOk(tuple(ns, d, 'member', ns, c, 'member'));
      await writeOk(tuple(ns, b, 'member', ns, c, 'member'));

      const round2 = await raceWithTimeout(
        productionCheck(pool, ref('user', stranger), ref(ns, a), 'member', {
          maxDepth: FORCED_MAX_DEPTH_FOR_CYCLE_ISOLATION,
        }),
        CYCLE_TIMEOUT_MS,
      );
      expect(round2.kind, 'round 2: productionCheck did not resolve within the timeout').toBe(
        'resolved',
      );
      if (round2.kind === 'resolved') {
        expect(round2.value.allowed).toBe(false);
      }

      // Round 3: a redundant duplicate edge (re-writing an already-
      // written tuple — an idempotent no-op per writeTuple's own
      // contract) plus a THIRD cycle (e <-> f), connected in via d -> e.
      await writeOk(tuple(ns, a, 'member', ns, b, 'member')); // redundant duplicate
      const e = uniqueName('e');
      const f = uniqueName('f');
      await writeOk(tuple(ns, e, 'member', ns, f, 'member'));
      await writeOk(tuple(ns, f, 'member', ns, e, 'member'));
      await writeOk(tuple(ns, d, 'member', ns, e, 'member'));

      const round3 = await raceWithTimeout(
        productionCheck(pool, ref('user', stranger), ref(ns, a), 'member', {
          maxDepth: FORCED_MAX_DEPTH_FOR_CYCLE_ISOLATION,
        }),
        CYCLE_TIMEOUT_MS,
      );
      expect(round3.kind, 'round 3: productionCheck did not resolve within the timeout').toBe(
        'resolved',
      );
      if (round3.kind === 'resolved') {
        expect(round3.value.allowed).toBe(false);
      }
    }, 60_000);
  });

  describe("D2 — TS-level `visited` Set guard (resolve()/evalRewrite's own re-entry guard), a structurally different mechanism from D1", () => {
    /**
     * `relation parent: <self>` / `permission view = parent->view`, real
     * cross-object tuples forming a 2-node cycle (a.parent=b, b.parent=a) —
     * deliberately NOT a compiler-rejected self-referential permission
     * (`permission p = p`, which `checkCircularPermissions` statically
     * rejects at compile time and therefore can never reach a resolver at
     * all). `parent` here is a PLAIN, non-userset relation
     * (`subjectTypes: [{namespace: selfNs}]`, no `#relation`) — confirmed by
     * reading `src/resolve/production/resolver.ts`'s `evalRewrite`'s
     * `tupleToUserset` case directly: it resolves the followed relation via
     * `listTupleSubjects` (a plain, unfiltered-by-subject SELECT, no
     * recursive CTE at all) and recurses back into `resolve()` for `view`
     * on the new object, sharing the SAME `visited` Set the outer call
     * already populated. `resolve()`'s relation branch (which is what would
     * hand off to the SQL-level `sqlRelationMembershipWithWitness` D1
     * exercises) is never entered here at all, since `resolve()` is only
     * ever asked to resolve `view` (a permission), never `parent` (the
     * relation) directly — this fixture is guaranteed, by its own
     * construction, to exercise ONLY the TS-level guard, zero SQL recursive
     * CTE involvement.
     */
    function hierCycleSource(ns: string): string {
      return [
        `namespace ${ns} {`,
        `  relation parent: ${ns}`,
        '',
        '  permission view = parent->view',
        '}',
      ].join('\n');
    }

    it('a 2-node object cycle formed via real tupleToUserset tuples (a.parent=b, b.parent=a), with no relation grant anywhere, is denied and bounded', async () => {
      const ns = uniqueName('hierd2');
      await publishOk(hierCycleSource(ns));

      const a = uniqueName('a');
      const b = uniqueName('b');
      const stranger = uniqueName('stranger');

      await writeOk(tuple(ns, a, 'parent', ns, b));
      await writeOk(tuple(ns, b, 'parent', ns, a));

      const result = await raceWithTimeout(
        productionCheck(pool, ref('user', stranger), ref(ns, a), 'view', {
          maxDepth: FORCED_MAX_DEPTH_FOR_CYCLE_ISOLATION,
        }),
        CYCLE_TIMEOUT_MS,
      );
      expect(
        result.kind,
        'productionCheck did not resolve within the timeout — the TS-level `visited` Set guard failed to terminate a permission/tupleToUserset re-entry cycle',
      ).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.value.allowed).toBe(false);
      }
    }, 30_000);
  });

  describe('D3 — depth-ceiling backstop alone, on a non-repeating (acyclic) chain, isolated from the revisit guard', () => {
    /**
     * A single straight-line chain of `member`-userset edges,
     * `g0 -> g1#member -> g2#member -> ... -> g7#member` (8 distinct nodes,
     * 7 edges, no repeated key anywhere — the revisit guard's `visited`/
     * path-array checks never fire on this fixture, by construction), with
     * an explicit `maxDepth: 5` — smaller than the chain's real length (7),
     * per this property's own corrected statement. Zero grounding anywhere.
     *
     * **Honest limitation of this exact fixture, stated plainly (the most
     * valuable finding a reviewer can produce, per this task's own
     * standing instruction).** Because there is genuinely no grant anywhere
     * on this chain, `allowed: false` is the correct answer at ANY
     * `maxDepth` — including `maxDepth: Infinity`, or no ceiling at all —
     * since a finite acyclic chain simply runs out of edges to follow and
     * naturally returns false once fully walked. That means THIS fixture's
     * `allowed` assertion, by itself, cannot actually distinguish "the
     * depth ceiling correctly stopped the walk at depth 5" from "the depth
     * ceiling was silently ignored and the walk ran the full 7 hops
     * anyway" — both produce the same denied verdict. (The genuinely
     * discriminating version of that claim — a grant placed PAST the
     * ceiling, denied at a small `maxDepth` and allowed at a larger one —
     * is already covered, exhaustively, by
     * `production-check-behavior.integration.test.ts`'s own "depth-budget
     * accounting parity" describe block, which is where D-069's real,
     * previously-live false_grant/false_deny regressions were actually
     * caught and fixed.) What this fixture DOES prove, and is the genuine
     * reason D3 exists as its own property distinct from D1/D2: an acyclic
     * chain LONGER than the configured ceiling resolves cleanly — no
     * thrown error, no `NaN`-comparator failure mode (`docs/DECISIONS.md`
     * D-092 finding #6's own real, previously-shipped bug: `x > NaN` is
     * always `false` in JavaScript, silently disabling a depth ceiling
     * entirely), no hang — under the SAME `Promise.race`-bounded,
     * "denied AND resolved within the timeout" discipline D1/D2 apply to
     * the cycle-guard mechanism, applied here to the ceiling mechanism
     * instead. This is flagged to the calling agent as a genuine, disclosed
     * gap in the corrected property's own literal wording ("still zero
     * grounding anywhere"), not silently worked around by adding a grant
     * the property's own text didn't ask for.
     */
    function chainGroupSource(ns: string): string {
      return [`namespace ${ns} {`, `  relation member: user | ${ns}#member`, '}'].join('\n');
    }

    it('a non-repeating 7-hop userset chain, at an explicit maxDepth of 5, is denied and resolves well within a timeout', async () => {
      const ns = uniqueName('grpd3');
      await publishOk(chainGroupSource(ns));

      const CHAIN_LENGTH = 8; // 8 nodes, 7 edges — strictly greater than maxDepth: 5.
      const SMALL_MAX_DEPTH = 5;
      const nodeIds = Array.from({ length: CHAIN_LENGTH }, (_, i) => uniqueName(`g${i}`));
      for (let i = 0; i < CHAIN_LENGTH - 1; i += 1) {
        const from = nodeIds[i];
        const to = nodeIds[i + 1];
        if (!from || !to) throw new Error('unreachable: chain node id out of bounds');
        await writeOk(tuple(ns, from, 'member', ns, to, 'member'));
      }
      const stranger = uniqueName('stranger');
      const root = nodeIds[0];
      if (!root) throw new Error('unreachable: chain root missing');

      const result = await raceWithTimeout(
        productionCheck(pool, ref('user', stranger), ref(ns, root), 'member', {
          maxDepth: SMALL_MAX_DEPTH,
        }),
        5_000,
      );
      expect(
        result.kind,
        'productionCheck did not resolve within the timeout on a finite, non-repeating, zero-grounded chain',
      ).toBe('resolved');
      if (result.kind === 'resolved') {
        expect(result.value.allowed).toBe(false);
      }
    }, 30_000);
  });
});
