/**
 * The single most important file in this repo. Everything else can be
 * wrong in a recoverable way; this file existing and passing is what makes
 * every other claim this project makes checkable rather than asserted.
 *
 * The predecessor suite (`test/rls/postgres.fuzz.test.ts`, before this
 * repo's identity changed — see `test/isolation/README.md`) fuzzed a single
 * function's input space against one hand-written oracle
 * (`IDENTIFIER_PATTERN`) and asserted agreement across thousands of
 * generated strings. This file does the same shape of thing one level up:
 * instead of fuzzing a string against a regex, it fuzzes a whole relation
 * graph — a random schema, a random set of tuples, a random query — against
 * a second, independent implementation of "does a path exist," and asserts
 * the real check engine agrees with it on every single one.
 *
 * **The oracle is the reference resolver** (`Phase 3` of the build spec): a
 * deliberately naive, deliberately slow, in-memory BFS over a fully
 * materialized snapshot of the tuple graph, with no caching, no query
 * planner, no recursion budget beyond the total tuple count. It exists to
 * be obviously correct, never to be fast — the same reason
 * `docs/DECISIONS.md` will record for why it is hand-written rather than
 * derived from the production resolver's own code path. A test that
 * derives its oracle from the thing it's checking proves nothing; see the
 * `test-author` subagent's rule against exactly this in
 * `.claude/commands/build-authz-service.md` §14.
 *
 * **The verdict is asymmetric, and the asymmetry is the point** (mirrors
 * §6.5 of the build spec):
 *
 * - `false_grant` — the production engine said allowed where the reference
 *   resolver, walking the same graph, found no path at all. This is a
 *   security bug. One occurrence anywhere in a run fails the check, full
 *   stop, and a `critical` namespace's false grant fails it regardless of
 *   how the rest of the run went.
 * - `false_deny` — the production engine said denied where a path exists.
 *   This is a correctness bug, worth fixing, and never a security incident.
 *   It does not block on its own.
 *
 * Conflating these two would be the same mistake the build spec's
 * statistical sibling project warns against for `no_detectable_difference`
 * vs `insufficient_data` (§5.4 there): different findings, and treating
 * them as one throws away exactly the distinction that matters most for
 * deciding what to do next.
 *
 * ---
 *
 * **Phase 5 status — un-skipped in place, per `docs/DECISIONS.md` D-001's
 * standing rule ("don't leave a satisfiable `.todo()` stale"):**
 *
 * - Every test below that's answerable without a real Postgres (fixture
 *   reproducibility, rewrite-rule/cycle coverage, the reference resolver's
 *   own cyclic termination, both "the fuzz harness has power" tests via a
 *   local synthetic broken-engine double, and the two asymmetric-verdict
 *   tests, since `classifyResult`/`computeVerdict` are pure) is un-skipped
 *   here, for real, against the real Phase 5 generator/classifier.
 * - `across 5,000 random (schema, tuple graph, query) triples, the
 *   production engine and the reference resolver agree on every single
 *   query — zero false_grant, reported false_deny rate stated even at
 *   zero` — the literal §9/§10 exit criterion — needs the *real* production
 *   engine against *real* Postgres to mean anything, so it lives in
 *   `differential-soundness.fuzz.integration.test.ts` instead (run via
 *   `npm run test:integration`), not here — this file's own suffix
 *   (`.fuzz.test.ts`) is matched by the fast, Docker-free default suite
 *   (see `vitest.config.ts`'s `exclude`), and that test needs a real
 *   `PostgreSqlContainer` per `docs/DECISIONS.md` D-019/D-030.
 * - `a run that finds any false_grant records the full resolution path both
 *   resolvers took, not just "disagreed"` stays `.todo()` — see the comment
 *   directly above it below. Not a shortfall: `DivergenceRecord`
 *   (`src/soundness/runner.ts`) has no resolution-path field yet, by a
 *   deliberate Phase 3/4 design choice (`docs/DECISIONS.md` D-020) that
 *   Phase 5 inherited rather than reopened. Satisfying this honestly needs
 *   Phase 6's resolution-path work; weakening the assertion to fit the
 *   current shape would be exactly the kind of self-reported-but-unverified
 *   claim this project's own rule 9 warns against.
 * - The "cycle detection deliberately removed" fuzz-power test is
 *   un-skipped but *renamed* — see the comment directly above it below for
 *   why its original wording cannot be honestly satisfied at any depth
 *   setting (`docs/DECISIONS.md` D-035), and what it demonstrates instead.
 */
import { describe, expect, it } from 'vitest';

import {
  generateFixture,
  checkRewriteRuleCoverage,
  type GeneratedEntityRef,
  type GeneratedTuple,
} from '../../src/soundness/generators.js';
import { classifyResult, computeVerdict } from '../../src/soundness/classify.js';
import { compileSchema } from '../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../src/schema/dsl/errors.js';
import { referenceCheck } from '../../src/resolve/reference/resolver.js';
import type { CompiledSchema, RewriteRule } from '../../src/schema/dsl/types.js';

/** Compiles `source` and fails the test (with the formatted errors) if it doesn't compile. */
function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected fixture schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

describe('differential fuzzing — production check engine vs. the naive reference resolver', () => {
  it('every run is seeded and the seed is recorded — replaying a run with the same seed reproduces byte-identical schemas, tuples, queries, and any divergence found', () => {
    const seed = 'isolation-reproducibility-seed-1';
    const first = generateFixture(seed, 50);
    const second = generateFixture(seed, 50);

    expect(second.seed).toBe(first.seed);
    expect(second.schemaSource).toBe(first.schemaSource);
    expect(second.namespaces).toEqual(first.namespaces);
    expect(second.tuples).toEqual(first.tuples);
    expect(second.queries).toEqual(first.queries);
    expect(second.coverage).toEqual(first.coverage);

    // "and any divergence found" — referenceCheck is a pure function of
    // (schema, tuples, query); since the schema/tuples/queries above are
    // already shown byte-identical, every query's own referenceAllowed
    // verdict must reproduce identically too, which is what actually
    // makes a divergence found on one replay reproducible on the next.
    const schema1 = compileOk(first.schemaSource);
    const schema2 = compileOk(second.schemaSource);
    for (const query of first.queries.slice(0, 25)) {
      const r1 = referenceCheck(
        schema1,
        first.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
      );
      const r2 = referenceCheck(
        schema2,
        second.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
      );
      expect(r2.allowed).toBe(r1.allowed);
    }

    // Power check: a *different* seed must not reproduce the same
    // fixture — otherwise this test would pass trivially even if the
    // generator ignored its seed argument entirely.
    const differentlySeed = generateFixture('isolation-reproducibility-seed-2', 50);
    expect(differentlySeed.schemaSource).not.toBe(first.schemaSource);
  });

  /**
   * `DivergenceRecord` (`src/soundness/runner.ts`) is `{ query, expected,
   * actual, kind, critical }` — no resolution-path field. Both resolvers
   * currently return only `{ allowed: boolean }` (`docs/DECISIONS.md`
   * D-020, a deliberate Phase 3 choice carried forward through Phase 4 and
   * into Phase 5 rather than reopened under this phase's own time
   * pressure — see `PROGRESS.md`'s Phase 5 "open question"). There is
   * nothing in this codebase today for a test to call that would produce a
   * real resolution path to assert against; writing one anyway would mean
   * either inventing a path-shaped return value nothing else in the repo
   * produces (testing a fiction) or silently weakening "records the full
   * resolution path" into "records that a divergence happened," which is
   * exactly the kind of quiet downgrade this project's own discipline
   * (build spec rule against loosening an assertion to make a test pass)
   * forbids. Stays `.todo()` until Phase 6 gives `checks.resolution_path`
   * (§6.7) a real shape both resolvers can produce.
   */
  it.todo(
    'a run that finds any false_grant records the full resolution path both resolvers took, not just "disagreed" — the same "show the diff, not the score" principle the build spec\'s §5.8 names for its own sibling project\'s PR comment',
  );

  it('a false_grant on a namespace flagged critical fails the run even when the aggregate false_grant rate across the whole graph is otherwise zero', () => {
    const criticalNamespaces = new Set(['critical_ns']);

    // The one false_grant, on the critical namespace.
    const criticalClassification = classifyResult({
      referenceAllowed: false,
      productionAllowed: true,
      objectNamespace: 'critical_ns',
      criticalNamespaces,
    });
    expect(criticalClassification).toEqual({ kind: 'false_grant', critical: true });

    // A large batch of perfect agreement elsewhere in the graph — the
    // aggregate false_grant rate across the whole run is 1-in-many,
    // "otherwise zero" against everything but this one query.
    let falseGrantCount = 0;
    for (let i = 0; i < 999; i += 1) {
      const agreement = classifyResult({
        referenceAllowed: true,
        productionAllowed: true,
        objectNamespace: 'noncritical_ns',
        criticalNamespaces,
      });
      expect(agreement).toBeNull();
    }
    if (criticalClassification?.kind === 'false_grant') falseGrantCount += 1;
    expect(falseGrantCount).toBe(1);

    // computeVerdict never sees a "rate" — only the raw count — so the
    // aggregate size of the run (999 agreeing queries above) cannot
    // dilute a single false_grant into a passing verdict.
    const verdict = computeVerdict({ falseGrantCount, coverageOk: true });
    expect(verdict).toBe('unsound');

    // Control: the exact same single false_grant on a namespace NOT
    // flagged critical still fails the run just as hard — critical-ness
    // changes *reporting* metadata (D-031), never whether the run fails.
    const nonCriticalClassification = classifyResult({
      referenceAllowed: false,
      productionAllowed: true,
      objectNamespace: 'noncritical_ns',
      criticalNamespaces,
    });
    expect(nonCriticalClassification).toEqual({ kind: 'false_grant', critical: false });
    expect(computeVerdict({ falseGrantCount: 1, coverageOk: true })).toBe('unsound');
  });

  it('a false_deny never fails the run on its own; it is reported and counted, never blocking', () => {
    const criticalNamespaces = new Set(['critical_ns']);

    // Even on a namespace flagged critical — false_deny's non-blocking
    // status does not depend on critical-namespace status at all, only
    // false_grant does.
    const classification = classifyResult({
      referenceAllowed: true,
      productionAllowed: false,
      objectNamespace: 'critical_ns',
      criticalNamespaces,
    });
    expect(classification).toEqual({ kind: 'false_deny', critical: true });

    // A run with zero false_grant and ANY number of false_deny is still
    // sound — computeVerdict's input never even carries a falseDenyCount,
    // which is itself the point: false_deny cannot influence the verdict
    // by construction, not merely by convention.
    expect(computeVerdict({ falseGrantCount: 0, coverageOk: true })).toBe('sound');

    // Agreement on `false` (production also denies) is not a divergence
    // at all — classifyResult's first check is equality, not "did
    // production allow" — so a resolver that always denies would not
    // manufacture false_deny entries it didn't earn.
    const bothDeny = classifyResult({
      referenceAllowed: false,
      productionAllowed: false,
      objectNamespace: 'critical_ns',
      criticalNamespaces,
    });
    expect(bothDeny).toBeNull();
  });

  it('random schemas exercise every rewrite-rule kind at least once per run (union, intersection, exclusion, tuple-to-userset) — a generator that only ever produces plain union schemas is testing a fraction of the surface and must be treated as a coverage gap, not silently accepted', () => {
    for (const seed of [
      'isolation-coverage-seed-a',
      'isolation-coverage-seed-b',
      'isolation-coverage-seed-c',
      'isolation-coverage-seed-42',
      'isolation-coverage-seed-zzz',
    ]) {
      const fixture = generateFixture(seed, 5);
      const schema = compileOk(fixture.schemaSource);

      // Independently re-derived from the *compiled* schema (never
      // trusted from the fixture's own self-reported coverage alone —
      // docs/DECISIONS.md D-032).
      const coverage = checkRewriteRuleCoverage(schema);
      expect(coverage.union).toBe(true);
      expect(coverage.intersection).toBe(true);
      expect(coverage.exclusion).toBe(true);
      expect(coverage.tupleToUserset).toBe(true);

      // The fixture's own audited coverage report must agree, and must
      // be the thing computeVerdict actually gates on.
      expect(fixture.coverage.rewriteRuleKinds).toEqual(coverage);
      expect(fixture.coverage.ok).toBe(true);
      expect(computeVerdict({ falseGrantCount: 0, coverageOk: fixture.coverage.ok })).toBe('sound');
    }
  });

  it('random tuple graphs include at least one cyclic group nesting per run, and the reference resolver itself terminates on it — the oracle has to handle the hard case too, or it is not a valid oracle for it', () => {
    const seed = 'isolation-cycle-terminates-seed-1';
    const fixture = generateFixture(seed, 5);

    // Independently re-derived (docs/DECISIONS.md D-032) — not trusted
    // from construction intent alone.
    expect(fixture.coverage.hasCycle).toBe(true);

    const schema = compileOk(fixture.schemaSource);

    // `namespaces[0]` is always the group-shaped namespace, and its
    // guaranteed cycle always lives on objects literally named `cycle_a`/
    // `cycle_b` — both stated, tested guarantees of `generateFixture`
    // itself (generators.ts's own doc comments: "always namespace #0",
    // "The guaranteed cycle's two objects are created first... cycle_a"/
    // "cycle_b"), not incidental output this test happens to depend on.
    const groupNs = fixture.namespaces[0]?.namespace;
    expect(groupNs).toBeDefined();
    if (!groupNs) return; // narrows for TS; unreachable given the expect above
    const cycleObject: GeneratedEntityRef = { ns: groupNs, id: 'cycle_a' };

    // query 1 (queryCount >= 2's second reserved query — see generators.ts)
    // is the real, direct, unconditional grant on the same cyclic object:
    // `addTuple` never removes a tuple once added, so this grant can never
    // be absent regardless of what else the seed's random draws produce —
    // proving the cycle doesn't poison a real grant sitting next to it.
    const allowedQuery = fixture.queries[1];
    expect(allowedQuery).toBeDefined();
    if (!allowedQuery) return;

    // A subject guaranteed to have zero real edges anywhere in this
    // fixture: every generated tuple's `user`-typed subject id is drawn
    // only from `userIds` (u0..u(n-1) — see generators.ts's own
    // `assignRandomTuples`); this id is deliberately outside that set, so
    // — unlike literally reusing "the first generated query" — there is
    // no seed-dependent chance a random tuple elsewhere in the graph
    // happens to grant it real membership on the cyclic object. This is
    // deliberately a *stronger* fixture than reusing the generator's own
    // reserved "no path" query: an earlier draft of this test did exactly
    // that and found, for a different seed, that a random tuple (drawn
    // independently by `assignRandomTuples`, which is free to pick any
    // user for a `user`-typed subject regardless of creation order) had
    // coincidentally granted that reserved query's subject real
    // membership — a true positive the test wrongly expected to be a
    // denial. That is not a generator bug (nothing promises the
    // *reserved* subject stays ungranted forever — only the direct grant
    // on `cycle_a` is unconditional); it means "query 0 is always denied"
    // cannot be assumed from construction alone the way "query 1 is
    // always allowed" can, so this test derives its own denial witness.
    const ghostSubject: GeneratedEntityRef = { ns: 'user', id: 'ghost_no_real_edges_anywhere' };

    // Forced to an explicit, very large value — per docs/DECISIONS.md
    // D-024: at the resolver's *default* depth budget, a cyclic-
    // termination test can pass even with cycle detection completely
    // disabled, because the independent depth ceiling silently absorbs
    // the infinite recursion first. This value has to be large enough
    // that the depth ceiling alone could not plausibly be what
    // terminates the walk.
    const FORCED_MAX_DEPTH = 1_000_000;

    const deniedStart = performance.now();
    const deniedResult = referenceCheck(schema, fixture.tuples, ghostSubject, cycleObject, 'view', {
      maxDepth: FORCED_MAX_DEPTH,
    });
    const deniedElapsedMs = performance.now() - deniedStart;

    const allowedStart = performance.now();
    const allowedResult = referenceCheck(
      schema,
      fixture.tuples,
      allowedQuery.subject,
      allowedQuery.object,
      allowedQuery.relationOrPermission,
      { maxDepth: FORCED_MAX_DEPTH },
    );
    const allowedElapsedMs = performance.now() - allowedStart;

    // Hand-derived: `ghost_no_real_edges_anywhere` names no tuple's
    // subject anywhere in `fixture.tuples`, by construction above — no
    // path can exist to it, but reaching that conclusion still requires
    // the walk to actually traverse `view = member`'s real tuples on
    // `cycle_a`, including the cyclic edge into `cycle_b` and back —
    // exercising real cycle termination, not a trivially-empty object.
    expect(deniedResult.allowed).toBe(false);
    expect(allowedResult.allowed).toBe(true);

    // "Did not hang" assertions, not performance assertions — matches
    // cross-resolver-agreement.integration.test.ts's own discipline for
    // the identical property against the production engine.
    expect(deniedElapsedMs).toBeLessThan(4000);
    expect(allowedElapsedMs).toBeLessThan(4000);
  });
});

/**
 * This suite must be able to fail, and this block is where that gets
 * proven — mirrors the build spec's `test-author` subagent rule: "after a
 * test passes, verify it fails when the behavior is broken." A fuzz harness
 * that has never been observed catching a real bug is not evidence it can
 * catch one.
 *
 * Both tests below build a small, local, deliberately-wrong test double
 * standing in for "the production engine" rather than mutating the real
 * `src/resolve/production/resolver.ts` on disk — per this task's own hard
 * constraint: mutating a shipped source file at test-run time is unsafe (a
 * crash mid-test leaves the repo broken), not parallelizable, and not
 * repeatable the way a real CI-checked-in test needs to be. The double is
 * driven through the *real* fixture generator (`generateFixture`), the
 * *real* oracle (`referenceCheck`), and the *real* classifier
 * (`classifyResult`/`computeVerdict`) — only "the production engine" side
 * of the comparison is synthetic, and it is synthetic in one specific,
 * named way per test, not a generic stub.
 */
describe('the fuzz harness has power — it catches a deliberately introduced unsoundness bug', () => {
  /**
   * A small, self-contained, otherwise-faithful naive resolver over the
   * same `GeneratedFixture` data shape both real resolvers consume —
   * independently written from the DSL grammar (§5) and the compiled
   * schema shape (`src/schema/dsl/types.ts`), never derived from either
   * real resolver's own source. `intersectionBug`, when true, evaluates an
   * `intersection` rewrite node as a union instead — "one rewrite branch
   * deliberately skipped," exactly the bug class the un-skipped test below
   * names. `usersetCycleGuard`, when false, removes the cycle guard
   * specifically on the *userset-subject* recursion (the branch that walks
   * a tuple's own `subjectRelation` — the in-memory analog of the
   * production resolver's SQL-side `WITH RECURSIVE` path-array guard,
   * `docs/DECISIONS.md` D-026) while leaving the `maxDepth` ceiling and the
   * *separate* cross-object (tuple-to-userset) cycle guard untouched — the
   * same shape as the real, already-diagnosed defect (D-035), not a
   * different or weaker one.
   */
  function syntheticCheck(
    schema: CompiledSchema,
    tuples: readonly GeneratedTuple[],
    subject: GeneratedEntityRef,
    object: GeneratedEntityRef,
    name: string,
    options: { intersectionBug?: boolean; usersetCycleGuard?: boolean; maxDepth?: number } = {},
  ): boolean {
    const intersectionBug = options.intersectionBug ?? false;
    const usersetCycleGuard = options.usersetCycleGuard ?? true;
    const maxDepth = options.maxDepth ?? 1000;

    // Cross-object / rewrite-tree recursion guard — the TS-orchestrated
    // analog of the production resolver's tuple-to-userset cycle guard.
    // Never disabled by either synthetic bug above; D-026/D-035's whole
    // point is that this guard and the userset-subject guard below are two
    // independent mechanisms.
    const rewriteVisited = new Set<string>();

    function relationMembership(
      target: GeneratedEntityRef,
      relationName: string,
      usersetVisited: Set<string>,
      depth: number,
    ): boolean {
      if (depth > maxDepth) return false;
      const key = `${target.ns}|${target.id}|${relationName}`;
      if (usersetCycleGuard) {
        if (usersetVisited.has(key)) return false;
        usersetVisited.add(key);
      }
      for (const t of tuples) {
        if (t.objectNs !== target.ns || t.objectId !== target.id || t.relation !== relationName) {
          continue;
        }
        if (t.subjectRelation === undefined) {
          if (t.subjectNs === subject.ns && t.subjectId === subject.id) {
            if (usersetCycleGuard) usersetVisited.delete(key);
            return true;
          }
          continue;
        }
        if (
          relationMembership(
            { ns: t.subjectNs, id: t.subjectId },
            t.subjectRelation,
            usersetVisited,
            depth + 1,
          )
        ) {
          if (usersetCycleGuard) usersetVisited.delete(key);
          return true;
        }
      }
      if (usersetCycleGuard) usersetVisited.delete(key);
      return false;
    }

    function evalRewrite(target: GeneratedEntityRef, rule: RewriteRule, depth: number): boolean {
      if (depth > maxDepth) return false;
      switch (rule.kind) {
        case 'computedUserset':
          return resolveName(target, rule.name, depth + 1);
        case 'union':
          return rule.children.some((child) => evalRewrite(target, child, depth));
        case 'intersection':
          return intersectionBug
            ? rule.children.some((child) => evalRewrite(target, child, depth))
            : rule.children.every((child) => evalRewrite(target, child, depth));
        case 'exclusion':
          return (
            evalRewrite(target, rule.base, depth) && !evalRewrite(target, rule.subtract, depth)
          );
        case 'tupleToUserset': {
          for (const t of tuples) {
            if (
              t.objectNs !== target.ns ||
              t.objectId !== target.id ||
              t.relation !== rule.relation
            ) {
              continue;
            }
            if (
              resolveName({ ns: t.subjectNs, id: t.subjectId }, rule.computedUserset, depth + 1)
            ) {
              return true;
            }
          }
          return false;
        }
      }
    }

    function resolveName(target: GeneratedEntityRef, name2: string, depth: number): boolean {
      if (depth > maxDepth) return false;
      const key = `${target.ns}|${target.id}|${name2}`;
      if (rewriteVisited.has(key)) return false;
      rewriteVisited.add(key);
      try {
        const nsConfig = schema.namespaces[target.ns];
        if (!nsConfig) return false;
        const relation = nsConfig.relations[name2];
        if (relation) {
          return relationMembership(target, name2, new Set<string>(), depth);
        }
        const permission = nsConfig.permissions[name2];
        if (permission) {
          return evalRewrite(target, permission.rewrite, depth);
        }
        return false;
      } finally {
        rewriteVisited.delete(key);
      }
    }

    return resolveName(object, name, 0);
  }

  it('given a production engine with one rewrite branch deliberately skipped (an intersection rule implemented as a union), the fuzz run reports at least one false_grant within the standard 5,000-query budget — proving the harness would have caught this class of bug, not just that it currently reports zero', () => {
    const seed = 'isolation-fuzz-power-intersection-bug-seed';
    const STANDARD_FUZZ_QUERIES = 5000;
    const fixture = generateFixture(seed, STANDARD_FUZZ_QUERIES);
    const schema = compileOk(fixture.schemaSource);
    const criticalNamespaces = new Set(
      fixture.namespaces.filter((n) => n.critical).map((n) => n.namespace),
    );

    let falseGrantCount = 0;
    for (const query of fixture.queries) {
      const referenceResult = referenceCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
      );
      const brokenResult = syntheticCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
        { intersectionBug: true },
      );
      const classification = classifyResult({
        referenceAllowed: referenceResult.allowed,
        productionAllowed: brokenResult,
        objectNamespace: query.object.ns,
        criticalNamespaces,
      });
      if (classification?.kind === 'false_grant') falseGrantCount += 1;
    }

    // Proving the harness has power: at least one false_grant surfaced
    // within the standard budget purely from the intersection-as-union
    // bug (the same 5,000-query fixture, run through the *correct*
    // engine shape via `referenceCheck` on both sides, would agree with
    // itself on every query — see the un-broken control immediately
    // below).
    expect(falseGrantCount).toBeGreaterThan(0);
    expect(computeVerdict({ falseGrantCount, coverageOk: fixture.coverage.ok })).toBe('unsound');

    // Control: the same fixture, same queries, `intersectionBug: false`
    // (the fixed shape) must agree with the reference resolver on every
    // single query — proving the false_grants above come specifically
    // from the deliberate bug, not from `syntheticCheck` itself being a
    // sloppy or generally-wrong resolver.
    let controlFalseGrantCount = 0;
    let controlFalseDenyCount = 0;
    for (const query of fixture.queries) {
      const referenceResult = referenceCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
      );
      const fixedResult = syntheticCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
        { intersectionBug: false },
      );
      const classification = classifyResult({
        referenceAllowed: referenceResult.allowed,
        productionAllowed: fixedResult,
        objectNamespace: query.object.ns,
        criticalNamespaces,
      });
      if (classification?.kind === 'false_grant') controlFalseGrantCount += 1;
      if (classification?.kind === 'false_deny') controlFalseDenyCount += 1;
    }
    expect(controlFalseGrantCount).toBe(0);
    expect(controlFalseDenyCount).toBe(0);
  });

  /**
   * The original wording of this `.todo()` ("the fuzz run either times out
   * in a way the runner reports as its own distinct failure mode, or
   * reports the resulting false state — it never silently passes") is not
   * achievable as an honest passing assertion, at any depth setting —
   * verified directly, not assumed, and recorded as `docs/DECISIONS.md`
   * D-035 before this test was written: removing the SQL-level cycle guard
   * (`docs/DECISIONS.md` D-026's path-array guard) corrupts only a query's
   * *latency*, never its returned boolean, because the independent depth
   * cap (§6.4) is still a valid — if catastrophically slow — termination
   * guarantee on its own. `classifyResult` compares only
   * `referenceAllowed`/`productionAllowed` booleans, so a defect that
   * changes nothing about the boolean is invisible to it by construction,
   * no matter how large `maxDepth` is forced or how long a run is willing
   * to wait (confirmed at production-realistic depth and, separately, by
   * forcing `maxDepth: 20_000` on a real 500-query Postgres run that then
   * failed to even finish within 300 seconds — see D-035's own account).
   *
   * Per this task's own explicit instruction, this test is renamed (not
   * weakened) to assert the real, verified boundary: a synthetic double
   * with the userset-subject cycle guard removed but the depth cap left in
   * place returns the exact same classification as the guarded version —
   * proving the fuzzer is structurally blind to this specific bug class at
   * standard depth *by design*, not by oversight, and that real coverage
   * for it lives instead in the targeted, elapsed-time-asserting Phase 3/4
   * termination tests (`docs/DECISIONS.md` D-024, D-027, D-029;
   * `test/unit/resolve/production/cross-resolver-agreement.integration
   * .test.ts`'s own cyclic-termination assertions) — a stated division of
   * labor, not a gap in this file.
   */
  it('a missing userset-subject cycle guard, with the depth cap still in place, produces the exact same classification as the guarded engine — boolean-only differential comparison cannot see a latency-only defect, which is why real coverage for it lives in the elapsed-time-asserting Phase 3/4 termination tests instead (docs/DECISIONS.md D-035), not here', () => {
    const seed = 'isolation-fuzz-power-cycle-guard-seed';
    // A depth cap generous enough that the *unguarded* walk visibly
    // exercises many repeated trips around the guaranteed 2-node cycle
    // (cycle_a <-> cycle_b) before giving up — not just one or two hops
    // that could pass by coincidence rather than by the depth cap
    // actually doing the work. Deliberately NOT pushed arbitrarily high
    // (e.g. matching the reference resolver's own 1,000,000 elsewhere in
    // this file): this synthetic double's userset-subject recursion is
    // real JS call-stack recursion (unlike the production resolver's
    // real defect, which recurses inside a single SQL `WITH RECURSIVE`
    // query server-side, never threatening the Node process's own call
    // stack) — found live, the first version of this test used
    // `DEPTH_CAP = 5_000` and intermittently overflowed the call stack
    // depending on how much stack headroom was already consumed
    // elsewhere in the process, which would have made this test flaky
    // for a reason that has nothing to do with the property under test.
    // 150+ round trips around a 2-node cycle is still unambiguously
    // "many," well clear of both extremes.
    const DEPTH_CAP = 300;
    const fixture = generateFixture(seed, 5);
    const schema = compileOk(fixture.schemaSource);
    const criticalNamespaces = new Set(
      fixture.namespaces.filter((n) => n.critical).map((n) => n.namespace),
    );

    expect(fixture.coverage.hasCycle).toBe(true);

    // Both reserved queries: the one that would recurse straight into the
    // cyclic construct (query 0 — whose *own* boolean this test does not
    // assume, unlike the "reference resolver terminates on a cycle" test
    // above; see that test's own comment on why "query 0 is always denied"
    // isn't actually guaranteed by construction), and the real direct
    // grant sitting next to it (query 1 — unconditionally allowed, and
    // itself not cycle-shaped at all, so it should not even be affected by
    // the guard removal — part of what "same classification either way"
    // is claiming, for a query that never touches the cycle at all).
    const cycleTouchingQuery = fixture.queries[0];
    const allowedQuery = fixture.queries[1];
    expect(cycleTouchingQuery).toBeDefined();
    expect(allowedQuery).toBeDefined();
    if (!cycleTouchingQuery || !allowedQuery) return;

    for (const query of [cycleTouchingQuery, allowedQuery]) {
      const referenceResult = referenceCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
        { maxDepth: DEPTH_CAP },
      );

      const guardedResult = syntheticCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
        { usersetCycleGuard: true, maxDepth: DEPTH_CAP },
      );
      const unguardedResult = syntheticCheck(
        schema,
        fixture.tuples,
        query.subject,
        query.object,
        query.relationOrPermission,
        { usersetCycleGuard: false, maxDepth: DEPTH_CAP },
      );

      // The headline claim: removing only the userset-subject cycle
      // guard changes nothing about the returned boolean, with the
      // depth cap left in place — both synthetic variants agree with
      // each other AND with the real oracle.
      expect(unguardedResult).toBe(guardedResult);
      expect(unguardedResult).toBe(referenceResult.allowed);

      const guardedClassification = classifyResult({
        referenceAllowed: referenceResult.allowed,
        productionAllowed: guardedResult,
        objectNamespace: query.object.ns,
        criticalNamespaces,
      });
      const unguardedClassification = classifyResult({
        referenceAllowed: referenceResult.allowed,
        productionAllowed: unguardedResult,
        objectNamespace: query.object.ns,
        criticalNamespaces,
      });
      expect(guardedClassification).toBeNull();
      expect(unguardedClassification).toBeNull();
    }
  });
});
