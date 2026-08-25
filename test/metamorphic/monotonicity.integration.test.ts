/**
 * Two corrected metamorphic properties built directly on top of
 * `src/metamorphic/monotonicity.ts`'s `classifyMonotone` — an earlier
 * design+adversarial-review pass proposed seven metamorphic/invariant
 * properties for this project's ReBAC engine, broke each one's ORIGINAL
 * form under adversarial review, and produced a corrected, verified-sound
 * version of each. This file implements exactly the two corrected
 * properties assigned to it (PROPERTY 4 and PROPERTY 5 below), not their
 * original, flawed statements — matching this project's own established
 * discipline of adversarial review before shipping a claim (see
 * `docs/DECISIONS.md`'s cache epoch-fence story, D-092, D-119).
 *
 * **Why these need a classifier at all, and why that classifier lives in a
 * separate, already-unit-tested file rather than being reinvented here.**
 * "Adding a tuple can never revoke an existing grant" is FALSE in general
 * for this DSL — `permission unbanned_view = viewer - banned` is the
 * concrete counterexample this repo's own guaranteed resource namespace
 * ships: a `banned` tuple ADDITION can flip `unbanned_view` from allowed to
 * denied. A metamorphic property that asserted "allowed0 => allowed1 after
 * ANY tuple addition, for ANY relationOrPermission" would therefore be
 * unsound on its face — it would either have to hand-exclude every
 * exclusion-shaped permission ad hoc inside this file (duplicating
 * `classifyMonotone`'s own AST walk, badly, inline) or produce spurious
 * failures against this repo's own guaranteed schema shape. `classifyMonotone`
 * is the already-built, already-unit-tested (`test/unit/metamorphic/
 * monotonicity.test.ts`, 7/7 green — reconfirmed directly before writing
 * this file) answer to exactly that scoping problem: PROPERTY 4 below only
 * ever asserts the monotone invariant for a `(ns, name)` pair the classifier
 * itself certifies monotone, and PROPERTY 5 is the direct, hand-verified
 * demonstration of the anti-monotone case the classifier is why 4 doesn't
 * naively claim to cover.
 *
 * **On atToken: it is a floor, never an exact snapshot pin (see
 * `docs/CONSISTENCY.md` and `src/store/tokens.ts`'s own doc comment).**
 * Every property below that pins to a token relies on ordinary real-time
 * happens-before ordering — every write this file performs is sequential
 * (`for...await`, never `Promise.all`, matching `src/soundness/runner.ts`'s
 * own real write-phase convention and `test/metamorphic/algebraic-properties
 * .integration.test.ts`'s own identical discipline) and nothing outside this
 * file's own uniquely-salted namespaces ever touches the rows a given
 * property reasons about between its writes and its checks. No assertion
 * below is ever justified by "atToken pins an exact historical state" — that
 * claim would be false of this system (a check pinned to token T is a
 * floor: it observes T and everything before it, and is free to observe
 * MORE if something else committed in the meantime) and every property here
 * is instead justified by the strict single-threaded ordering this test
 * enforces on itself, stated explicitly at each use.
 *
 * **Convention — now matches `test/isolation/differential-soundness.fuzz
 * .integration.test.ts`/`test/metamorphic/algebraic-properties
 * .integration.test.ts`'s own `PostgreSqlContainer` precedent; it briefly
 * deviated from it and that turned out to be a real bug, not a viable
 * accommodation.** This file originally connected directly via
 * `process.env.DATABASE_URL`, because the sandbox it was first written in
 * had the `docker` CLI present but no reachable daemon (`docker ps`:
 * "Cannot connect to the Docker daemon"), so `PostgreSqlContainer.start()`
 * failed outright there. That reasoning didn't generalize: real CI
 * (`.github/workflows/ci.yml`'s `test-integration` job) runs every sibling
 * `PostgreSqlContainer`-based file successfully in the same job this file
 * runs in, and never sets `DATABASE_URL` — so this file's own
 * direct-connection form was the one integration test in the repo
 * guaranteed to fail there unconditionally, caught live the first time this
 * PR's own CI ran (`docs/DECISIONS.md` D-140's follow-up). Fixed by
 * switching to the same ephemeral `PostgreSqlContainer` every sibling file
 * already uses (`@testcontainers/postgresql`) — no environment-specific
 * connection string hardcoded (`docs/DECISIONS.md` D-019/D-030: a hardcoded
 * connection string has already broken CI twice on this project). A sandbox
 * that genuinely lacks a reachable Docker daemon (as the one this fix was
 * written in still does) uses this repo's own established LOCALVERIFY
 * accommodation instead — swap this file's container-based `beforeAll`/
 * `afterAll` for a direct `DATABASE_URL` pool, run, then restore the exact
 * committed, container-based form before shipping — never a permanent
 * change to the committed file itself. `runMigrations` is still called
 * against the fresh container (matching every sibling file) so this file
 * never depends on any state existing beforehand. Every namespace/object/subject name below
 * is still freshly salted per seed/trial (`uniqueName` below, matching every
 * sibling `*.integration.test.ts` file's own established per-worker-salt
 * convention). `generateFixture` itself independently salts every
 * namespace name from a hash of its own `seed` argument (see `generators
 * .ts`'s own top-of-file doc comment) — passing a `uniqueName`-generated
 * seed here means BOTH layers of salting compose, closing the cross-run
 * collision risk from two directions at once.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { compileSchema } from '../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../src/schema/dsl/types.js';
import { productionCheck } from '../../src/resolve/production/resolver.js';
import {
  generateFixture,
  type GeneratedQuery,
  type GeneratedTuple,
} from '../../src/soundness/generators.js';
import { classifyMonotone } from '../../src/metamorphic/monotonicity.js';
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
// repo's own established per-integration-test-file convention (see
// `docs/DECISIONS.md` D-022's general "don't force accidental coupling
// between independent test files" reasoning, applied here to test helpers).
// ---------------------------------------------------------------------------

let uniqueCounter = 0;
// A random salt generated once when this file's test worker starts —
// `Date.now()` alone collides across sibling `*.integration.test.ts` files
// vitest runs in parallel worker threads that can start within the same
// wall-clock millisecond (a real, previously-hit defect on this project —
// see `cross-resolver-agreement.integration.test.ts`'s own identical
// comment).
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

/** Writes `t` for real and fails the test if the store rejects it. Returns the full result (token, created) — both properties below need `token`; Property 4 also needs `created` as a fresh-subject sanity check. */
async function writeOk(t: TupleKey): Promise<{ token: number; created: boolean }> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
  return { token: result.token, created: result.created };
}

/**
 * Compiles `source` and fails the test (loudly, distinguishing a fixture-
 * generator defect from a real finding) if it doesn't compile — every
 * fixture `generateFixture` produces is supposed to be guaranteed-compilable
 * by construction (see `generators.ts`'s own internal self-check), so a
 * failure here means the classifier can't even be exercised, not that a
 * property under test failed.
 */
function compileOk(source: string, seed: string): CompiledSchema {
  const compiled = compileSchema(source);
  if (!compiled.ok) {
    throw new Error(
      `seed=${seed}: generateFixture produced a schema that failed to compile — a generator ` +
        `bug, not a property finding: ${compiled.errors.map(formatSchemaError).join('; ')}`,
    );
  }
  return compiled.schema;
}

// ---------------------------------------------------------------------------
// PROPERTY 4 — monotone-permission-tuple-addition
// ---------------------------------------------------------------------------

describe('Property 4 — monotone-permission-tuple-addition (classifier-scoped, corrected)', () => {
  /**
   * **What this catches that neither differential fuzzing nor a static
   * schema check could.** Differential fuzzing (Phase 5) compares the
   * production resolver against the independent reference resolver at ONE
   * token/state per query; it never re-checks the SAME query across two
   * tokens that differ by exactly one tuple addition, so it has no way to
   * notice a resolver whose answer for a monotone permission spuriously
   * FLIPS FROM ALLOWED TO DENIED after a pure insertion — e.g. a caching
   * layer that fails to invalidate correctly and serves a stale `false`
   * despite a fresh grant now existing (the inverse direction of D-092's own
   * phantom-witness finding, on the allowed side), or a union/intersection
   * implementation bug that, for some specific new row, evaluates a branch
   * it shouldn't and drops a subject who was previously reachable through a
   * different, unrelated branch. A static schema check has no notion of
   * tuple data at all and can't observe this either. This property is a
   * direct, repeated probe of monotonicity itself, restricted — via
   * `classifyMonotone`, not ad hoc reasoning duplicated inline here — to
   * exactly the `(ns, name)` pairs where the invariant is actually true, so
   * a failure here is never confused with the `unbanned_view`-shaped
   * anti-monotone case Property 5 exists to test instead.
   *
   * **The exact invariant asserted, and why it's one-directional.**
   * `allowed0 => allowed1`, never the converse: a monotone permission/
   * relation can gain subjects after a tuple addition (a previously-denied
   * query can start passing) but can never LOSE one. `allowed0 === false`
   * therefore constrains nothing about `allowed1` and is left unchecked.
   */
  const SEED_COUNT = 50;
  const QUERY_COUNT = 25;

  it(`across ${SEED_COUNT} random seeds, every (ns, name) pair classifyMonotone certifies monotone keeps every previously-allowed query allowed after exactly one more tuple is written — classifier-excluded pairs are skipped, not asserted on`, async () => {
    let totalExercisedPairs = 0;
    // Distinct from totalExercisedPairs (real finding, adversarial review of
    // this implementation): a pair only exercises the property's own actual
    // assertion (allowed0 ⟹ allowed1) when allowed0 === true — the `continue`
    // below skips every allowed0 === false pair without asserting anything.
    // totalExercisedPairs > 0 alone could stay green forever even if
    // generateFixture's grant density ever dropped enough that allowed0 was
    // false for every single monotone-classified query, silently reducing
    // this property to a no-op — exactly the D-119 (M7/M8/M9) class of gap:
    // a test that runs and passes without ever exercising the logic it
    // claims to. Tracked and asserted separately so that failure mode is
    // loud, not silent.
    let totalAllowed0True = 0;
    let seedsWithAtLeastOnePair = 0;
    const perSeedCounts: number[] = [];

    for (let seedIndex = 0; seedIndex < SEED_COUNT; seedIndex += 1) {
      const seed = uniqueName(`prop4seed${seedIndex}`);
      const fixture = generateFixture(seed, QUERY_COUNT);

      await publishOk(fixture.schemaSource);
      // A second, independent compilation of the SAME source text, purely
      // to hand `classifyMonotone` a `CompiledSchema` object — `publishSchema`
      // compiles internally too, but doesn't return the compiled shape, and
      // `classifyMonotone` needs the real AST, not the DSL source string.
      const schema = compileOk(fixture.schemaSource, seed);

      // Every fixture tuple, written SEQUENTIALLY — for...await, never
      // Promise.all — matching `src/soundness/runner.ts`'s own real
      // write-phase convention and required for the strict real-time
      // happens-before ordering every atToken-pinned assertion below
      // depends on.
      let lastToken: number | undefined;
      for (const t of fixture.tuples) {
        const written = await writeOk(t);
        lastToken = written.token;
      }
      if (lastToken === undefined) {
        throw new Error(
          `seed=${seed}: generateFixture produced zero tuples — a generator bug, not a test bug`,
        );
      }
      const T0 = lastToken;

      // Classify every query's (object.ns, relationOrPermission) and, for
      // the monotone-classified subset only, record allowed0 at T0.
      // classifyMonotone's own contract THROWS for a malformed/mismatched
      // (schema, ns, name) triple rather than returning a "don't know"
      // boolean — every fixture.queries entry names a relationOrPermission
      // drawn from `checkableNamesByNs.get(object.ns)` (generators.ts's own
      // query construction), i.e. always a real relation or permission
      // declared on that exact namespace, so a throw here would indicate a
      // real mismatch between this test's assumptions and the fixture
      // shape, not a normal "skip" case — deliberately NOT try/caught away.
      const monotoneQueries: Array<{ query: GeneratedQuery; allowed0: boolean }> = [];
      for (const q of fixture.queries) {
        const isMonotone = classifyMonotone(schema, q.object.ns, q.relationOrPermission);
        if (!isMonotone) continue; // expected and correct — see this describe block's own doc comment
        const result0 = await productionCheck(
          pool,
          ref(q.subject.ns, q.subject.id),
          ref(q.object.ns, q.object.id),
          q.relationOrPermission,
          { atToken: T0 },
        );
        monotoneQueries.push({ query: q, allowed0: result0.allowed });
      }

      // The one additional tuple: reuse an existing relation on an existing
      // object (fixture.tuples[0] is guaranteed to be a real, already-
      // written, schema-valid tuple — see generators.ts's own construction
      // order), with a FRESH subject id (uniqueName's timestamp+process-
      // salt+counter construction is, in this repo's own established
      // convention, treated as collision-free for "never used elsewhere in
      // this fixture" purposes — the same assumption every sibling
      // integration test file in this repo already relies on for its own
      // per-trial subject/object ids). Copying `subjectRelation` when
      // present keeps the new tuple schema-valid regardless of whether the
      // reused relation's subject type is a plain principal or a userset
      // reference — the relation's own declared subjectTypes never change
      // between the original tuple and this fresh-subject copy of it.
      const templateTuple: GeneratedTuple | undefined = fixture.tuples[0];
      if (!templateTuple) {
        throw new Error(
          `seed=${seed}: fixture.tuples[0] missing — unreachable given the check above`,
        );
      }
      const freshSubjectId = uniqueName('freshsubj');
      const extraTuple = tuple(
        templateTuple.objectNs,
        templateTuple.objectId,
        templateTuple.relation,
        templateTuple.subjectNs,
        freshSubjectId,
        templateTuple.subjectRelation,
      );
      const extraWrite = await writeOk(extraTuple);
      // Sanity check on "fresh subject id never used elsewhere in this
      // fixture": writeTuple's own documented contract reports `created:
      // false` for an idempotent duplicate-key no-op — if this fresh id
      // somehow collided with an existing row, this write would silently
      // become a no-op and the property below would trivially and
      // meaninglessly "hold" (T1 would equal a token where nothing new was
      // added). Asserting `created: true` here makes that failure mode loud
      // instead of silent.
      expect(
        extraWrite.created,
        `seed=${seed}: expected the fresh-subject-id tuple addition to be a genuinely new row, not a duplicate`,
      ).toBe(true);
      const T1 = extraWrite.token; // LAST write for this seed, per the property's own statement

      perSeedCounts.push(monotoneQueries.length);
      if (monotoneQueries.length > 0) seedsWithAtLeastOnePair += 1;
      totalExercisedPairs += monotoneQueries.length;

      for (const { query: q, allowed0 } of monotoneQueries) {
        if (!allowed0) continue; // allowed0 === false constrains nothing about allowed1 — see this describe block's own doc comment
        totalAllowed0True += 1;
        const result1 = await productionCheck(
          pool,
          ref(q.subject.ns, q.subject.id),
          ref(q.object.ns, q.object.id),
          q.relationOrPermission,
          { atToken: T1 },
        );
        expect(
          result1.allowed,
          `seed=${seed}: (${q.subject.ns}:${q.subject.id} -> ${q.relationOrPermission} -> ${q.object.ns}:${q.object.id}) was allowed at T0=${T0} (classifyMonotone certified '${q.relationOrPermission}' on '${q.object.ns}' monotone) but DENIED at T1=${T1} after a pure tuple ADDITION — this is precisely the bug class this property exists to catch: a monotone permission losing a previously-granted subject under an insertion-only write is a real soundness regression in the production resolver, not a benign divergence`,
        ).toBe(true);
      }
    }

    console.log(
      `[Property 4] exercised ${totalExercisedPairs} (seed, monotone-classified query) pairs ` +
        `across ${SEED_COUNT} seeds (${seedsWithAtLeastOnePair}/${SEED_COUNT} seeds contributed at ` +
        `least one pair; ${totalAllowed0True} of those pairs had allowed0=true and actually reached ` +
        `the allowed0 ⟹ allowed1 assertion; per-seed counts: ${perSeedCounts.join(',')})`,
    );

    // "A property that never actually exercises anything is worse than
    // useless and must be flagged, not silently reported as 'passing'" —
    // the task's own explicit standing instruction. A run that reaches this
    // line with zero exercised pairs would mean every single query, across
    // every one of 50 seeds, was classifier-excluded — either a real
    // generator/classifier interaction bug, or evidence this property
    // provides no actual coverage; either way, that must fail loudly here,
    // not pass silently.
    expect(
      totalExercisedPairs,
      'Property 4 exercised ZERO (seed, monotone-classified query) pairs across all seeds — this property never actually tested anything',
    ).toBeGreaterThan(0);
    // The stronger, previously-missing guard (adversarial review of this
    // implementation, live-verification-audit era): totalExercisedPairs > 0
    // alone does not prove the property's own assertion ever actually ran —
    // only pairs with allowed0 === true do that. If this ever hit zero while
    // totalExercisedPairs stayed healthy, the property would be passing
    // while silently testing nothing, the exact class of gap this project's
    // own D-119 (M7/M8/M9) precedent exists to catch.
    expect(
      totalAllowed0True,
      'Property 4 classified pairs exist, but none had allowed0=true — the allowed0 ⟹ allowed1 assertion never actually ran for a single pair; this property is currently a silent no-op',
    ).toBeGreaterThan(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// PROPERTY 5 — exclusion-subtract-anti-monotonicity (unbanned_view only)
// ---------------------------------------------------------------------------

describe("Property 5 — exclusion-subtract-anti-monotonicity, scoped narrowly to generateFixture's own guaranteed 'unbanned_view = viewer - banned' (corrected)", () => {
  /**
   * **Why this is deliberately NOT a fuzz sweep across arbitrary schemas.**
   * The corrected version of this property restricts itself to ONE
   * hand-verified `generateFixture` instance — the resource namespace's own
   * guaranteed `unbanned_view = viewer - banned` — rather than generalizing
   * "an exclusion rule is anti-monotone" into a broad classifier-driven
   * sweep the way Property 4 does for the monotone case. `classifyMonotone`
   * only ever answers a BOOLEAN "is this monotone" — it deliberately has no
   * notion of WHICH relation, on WHICH side of an arbitrary exclusion, a
   * newly-added tuple needs to target to reliably trigger a flip for an
   * ARBITRARY schema's arbitrary exclusion rule (e.g. `(a & b) - (c | d)` —
   * which of `c`/`d` should the extra tuple target, and does the subject
   * already satisfy `a & b`, for a randomly generated fixture instance
   * chosen without hand-verification?). Answering that in general would
   * require extending the classifier to also walk `CompiledRelation
   * .subjectTypes` (to reason about which subject types can even satisfy a
   * given base/subtract branch) and to reason about EXISTING tuple state,
   * not just schema shape — a substantially different, unbuilt piece of
   * machinery. This is exactly the scope boundary the design review's own
   * finding drew, and this file honors it literally: one fixed, well-
   * understood, hand-derivable exclusion shape, exercised across many
   * random tuple-graph instances (so it's not a single brittle example) but
   * never across a randomly varying SCHEMA shape.
   *
   * **What this catches that Property 4 structurally cannot.** Property 4
   * only ever asserts on classifier-certified-monotone pairs — by
   * construction, it skips every exclusion-containing permission, including
   * `unbanned_view` itself. Without a property exercising the anti-monotone
   * direction directly, a production-resolver bug that made `unbanned_view`
   * (or any exclusion) WRONGLY behave as if it were monotone — e.g. an
   * implementation that unions `base` and mistakenly ORs in `subtract`
   * instead of subtracting it, or a caching layer that never invalidates on
   * a `banned` write specifically because exclusion's own subtract-side
   * writes weren't wired into its invalidation key — could ship with zero
   * test coverage from Property 4 alone, from the differential fuzz harness
   * (which checks agreement at one token, not the flip across two), and
   * from any purely schema-shape-level static check. This property directly
   * writes the one banned-tuple addition that MUST flip the result and
   * fails loudly if it doesn't.
   */
  const SEED_COUNT = 20;
  const QUERY_COUNT = 15; // queries aren't used by this property directly — kept small purely to bound each fixture's own tuple-write cost; the fixture's TUPLE graph (not its queries) is what this property reasons about.

  it(`across ${SEED_COUNT} random seeds, adding a 'banned' tuple for a subject who already has an unbanned 'unbanned_view' grant flips that grant to denied, and never flips any OTHER already-unbanned-and-viewing (subject, object) pair the other way`, async () => {
    let totalConstructedWitnesses = 0;
    let totalFoundWitnesses = 0;
    let totalBroadSweepPairsChecked = 0;

    for (let seedIndex = 0; seedIndex < SEED_COUNT; seedIndex += 1) {
      const seed = uniqueName(`prop5seed${seedIndex}`);
      const fixture = generateFixture(seed, QUERY_COUNT);

      await publishOk(fixture.schemaSource);
      const schema = compileOk(fixture.schemaSource, seed);

      // Locate the real, salted resource-namespace name for this fixture —
      // NEVER hardcoded, per this task's own explicit instruction: the
      // resource namespace is unambiguously identifiable as the one whose
      // compiled permissions include BOTH 'trusted_edit' and 'unbanned_view'
      // (generateFixture's own buildResourceNamespaceSource is the only
      // namespace-construction function that emits either name, and it
      // always emits both together).
      const resourceNsName = Object.values(schema.namespaces).find(
        (ns) => 'trusted_edit' in ns.permissions && 'unbanned_view' in ns.permissions,
      )?.namespace;
      if (!resourceNsName) {
        throw new Error(
          `seed=${seed}: no namespace with both 'trusted_edit' and 'unbanned_view' permissions found — ` +
            `generateFixture's own guaranteed resource-namespace shape must have changed; this is a ` +
            `fixture-shape assumption failure in this test, not a resolver finding`,
        );
      }

      // Every fixture tuple, written SEQUENTIALLY (see Property 4's own
      // identical note on why: matches runner.ts's real write-phase
      // convention, and is required for the strict happens-before ordering
      // every atToken-pinned assertion below depends on).
      let lastToken: number | undefined;
      for (const t of fixture.tuples) {
        const written = await writeOk(t);
        lastToken = written.token;
      }
      if (lastToken === undefined) {
        throw new Error(
          `seed=${seed}: generateFixture produced zero tuples — a generator bug, not a test bug`,
        );
      }

      // Restricted, deliberately, to DIRECT ('user'-subject) 'viewer'
      // tuples only — never a group#member-mediated grant. The property's
      // own wording ("directly OR via the group namespace's #member
      // userset") describes two ways a real fixture's witness COULD arise,
      // not a requirement that this test attempt both: proving the
      // 'unbanned_view' exclusion flip requires only THAT some subject has
      // 'viewer' and lacks 'banned' on some object, not HOW 'viewer' came to
      // be true. Verifying an INDIRECT (group-mediated) grant here would
      // require this test to independently re-derive group-membership
      // reachability — effectively duplicating the very resolver behavior
      // under test — which is exactly the kind of generalization the task's
      // own scoping note rules out ("generalizing this property requires
      // extending the classifier to also walk CompiledRelation.subjectTypes
      // ... out of scope here").
      const directViewerTuples = fixture.tuples.filter(
        (t) => t.objectNs === resourceNsName && t.relation === 'viewer' && t.subjectNs === 'user',
      );
      const bannedPairKeys = new Set(
        fixture.tuples
          .filter(
            (t) =>
              t.objectNs === resourceNsName && t.relation === 'banned' && t.subjectNs === 'user',
          )
          .map((t) => `${t.objectId}\0${t.subjectId}`),
      );
      const unbannedViewerTuples = directViewerTuples.filter(
        (t) => !bannedPairKeys.has(`${t.objectId}\0${t.subjectId}`),
      );

      let witnessSubject: string;
      let witnessObject: string;
      let populationToken: number;

      const found = unbannedViewerTuples[0];
      if (found) {
        witnessSubject = found.subjectId;
        witnessObject = found.objectId;
        populationToken = lastToken; // T0 — the population's final token, no construction write needed
        totalFoundWitnesses += 1;
      } else {
        // None existed in this random fixture — construct one, per the
        // property's own explicit "find or construct" instruction. Both the
        // subject and the object are freshly minted (rather than reusing an
        // existing resource-namespace object id) so this construction can
        // never accidentally collide with some OTHER subject's pre-existing
        // 'banned' tuple on a shared object — the witness pair is
        // unambiguously fresh and isolated.
        witnessSubject = uniqueName('propres5subj');
        witnessObject = uniqueName('propres5obj');
        const constructWrite = await writeOk(
          tuple(resourceNsName, witnessObject, 'viewer', 'user', witnessSubject),
        );
        populationToken = constructWrite.token; // T0 — now includes this one additional tuple, per the property's own definition of "the population's final token"
        totalConstructedWitnesses += 1;
      }
      const T0 = populationToken;

      // Confirm the pre-condition — hand-derivable directly from
      // 'unbanned_view = viewer - banned': a direct 'viewer' grant with no
      // 'banned' tuple for the identical (subject, object) pair means
      // viewer=true, banned=false, so unbanned_view must be allowed. This
      // is the property's own explicit "Confirm ... is allowed" step, not
      // an assumption skipped over.
      const beforeCheck = await productionCheck(
        pool,
        ref('user', witnessSubject),
        ref(resourceNsName, witnessObject),
        'unbanned_view',
        { atToken: T0 },
      );
      expect(
        beforeCheck.allowed,
        `seed=${seed}: expected unbanned_view allowed at T0 for the ${found ? 'found' : 'constructed'} witness (user:${witnessSubject} on ${resourceNsName}:${witnessObject}) — viewer granted, no banned tuple present`,
      ).toBe(true);

      // The one additional tuple this property is actually about — a
      // 'banned' grant for that EXACT (subject, object) pair. LAST write
      // for this seed, per the property's own statement.
      const bannedWrite = await writeOk(
        tuple(resourceNsName, witnessObject, 'banned', 'user', witnessSubject),
      );
      const T1 = bannedWrite.token;

      // The concrete, always-reproducible flip this property's correction
      // specifically calls out: adding ONLY a 'banned' tuple (an insertion,
      // nothing deleted) must flip 'unbanned_view' from allowed to denied.
      // A resolver bug this catches: an exclusion evaluated as if it were a
      // union (base | subtract instead of base - subtract) would keep this
      // allowed; a caching/invalidation bug that never keys on writes to the
      // 'subtract' side of an exclusion would also keep this allowed.
      const afterCheck = await productionCheck(
        pool,
        ref('user', witnessSubject),
        ref(resourceNsName, witnessObject),
        'unbanned_view',
        { atToken: T1 },
      );
      expect(
        afterCheck.allowed,
        `seed=${seed}: unbanned_view remained ALLOWED at T1=${T1} for user:${witnessSubject} on ${resourceNsName}:${witnessObject} after adding a 'banned' tuple for that exact pair — an exclusion rule that fails to exclude is exactly the bug class this property exists to catch`,
      ).toBe(false);

      // Broader sweep (still restricted to this exact permission/namespace,
      // per this describe block's own scope note): every OTHER
      // already-viewer-and-not-banned (subject, object) pair this random
      // fixture happened to populate must be UNAFFECTED by a banned-tuple
      // addition that names a completely different (or at least distinct)
      // subject/object pair — 'banned' tuples are keyed per (object,
      // subject), so an addition for (witnessObject, witnessSubject)
      // specifically can never touch any OTHER pair's own banned status.
      // The invariant checked is literally "never denied -> allowed" (in
      // fact, for THESE untouched pairs, the correct behavior is "stays
      // exactly as it was" — checked as an equality, which is strictly
      // stronger and still honest, since nothing about them changed).
      const otherUnbannedViewerTuples = unbannedViewerTuples.filter(
        (t) => !(t.objectId === witnessObject && t.subjectId === witnessSubject),
      );
      for (const t of otherUnbannedViewerTuples) {
        const otherBeforeCheck = await productionCheck(
          pool,
          ref('user', t.subjectId),
          ref(resourceNsName, t.objectId),
          'unbanned_view',
          { atToken: T0 },
        );
        expect(
          otherBeforeCheck.allowed,
          `seed=${seed}: expected unbanned_view allowed at T0 for the fixture's own (user:${t.subjectId}, ${resourceNsName}:${t.objectId}) pair (direct viewer, no banned tuple)`,
        ).toBe(true);

        const otherAfterCheck = await productionCheck(
          pool,
          ref('user', t.subjectId),
          ref(resourceNsName, t.objectId),
          'unbanned_view',
          { atToken: T1 },
        );
        expect(
          otherAfterCheck.allowed,
          `seed=${seed}: unbanned_view for an UNRELATED (user:${t.subjectId}, ${resourceNsName}:${t.objectId}) pair changed after banning a DIFFERENT (subject, object) pair — a banned-tuple addition must never affect any pair it doesn't name`,
        ).toBe(true); // never denied->allowed; here specifically "stays allowed", the stronger and still-correct claim
        totalBroadSweepPairsChecked += 1;
      }
    }

    console.log(
      `[Property 5] ${totalFoundWitnesses} witness(es) found directly in the random fixture, ` +
        `${totalConstructedWitnesses} constructed (of ${SEED_COUNT} seeds); ` +
        `${totalBroadSweepPairsChecked} additional (subject, object) pairs covered by the broader sweep`,
    );

    // Same "never silently report a property that exercised nothing as
    // passing" discipline as Property 4 — the core flip (found+constructed)
    // must always equal SEED_COUNT, since every seed either finds or
    // constructs exactly one witness, unconditionally.
    expect(totalFoundWitnesses + totalConstructedWitnesses).toBe(SEED_COUNT);
  }, 600_000);
});
