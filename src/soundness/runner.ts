/**
 * Phase 5 orchestration — the piece that actually runs the differential
 * fuzz: generate a fixture (`generators.ts`), publish it and write its
 * tuples for real (`src/schema/publish.ts`, `src/store/tuples.ts`), run
 * every query through both the reference resolver
 * (`src/resolve/reference/resolver.ts`) and the production resolver
 * (`src/resolve/production/resolver.ts`), classify every result
 * (`classify.ts`), and persist one `soundness_runs` row (§4) with the full
 * result. See `.claude/commands/build-authz-service.md` §6.2, §6.8, §9
 * Phase 5.
 *
 * This file is the *only* place in `src/soundness/` that imports either
 * resolver, `publishSchema`, or `writeTuple` — `generators.ts` and
 * `classify.ts` stay pure/data-only, matching the same "keep I/O at the
 * edges" discipline `src/schema/dsl/*` already holds itself to.
 *
 * `SoundnessRunOptions.dryRun` (D-063, closing D-060's own "revisit if")
 * runs this exact same real cycle — real `publishSchema`, real
 * `writeTuple`, real checks against both resolvers, a real `soundness_runs`
 * row — and then deletes every row it created (`namespace_configs`,
 * `relation_tuples`, that `soundness_runs` row) before returning, so the
 * database ends the call in exactly the state it started in. It does not
 * touch `write_log`: that table is an honest, append-only ledger of every
 * write that really happened, including a dry run's write-then-delete
 * pairs, and leaving it alone is deliberate, not an oversight — see
 * `SoundnessRunOptions.dryRun`'s own doc comment.
 */
import type { Pool } from 'pg';

import { env } from '../config/env.js';
import { compileSchema } from '../schema/dsl/compiler.js';
import { formatSchemaError } from '../schema/dsl/errors.js';
import {
  publishSchema,
  deletePublishedNamespaceVersion,
  type PublishedNamespace,
} from '../schema/publish.js';
import { writeTuple, deleteTuple, type TupleKey } from '../store/tuples.js';
import { referenceCheck } from '../resolve/reference/resolver.js';
import type { ResolutionStep as ReferenceResolutionStep } from '../resolve/reference/resolver.js';
import { productionCheck } from '../resolve/production/resolver.js';
import type { ResolutionStep as ProductionResolutionStep } from '../resolve/production/resolver.js';
import { classifyResult, computeVerdict, type SoundnessVerdict } from './classify.js';
import {
  generateFixture,
  generateRandomSeed,
  type GeneratedEntityRef,
  type GeneratedQuery,
} from './generators.js';

export interface SoundnessRunOptions {
  /** Omit to generate one — the seed actually used is still recorded on the returned result and the persisted row. */
  seed?: string;
  /** Defaults to `env.SOUNDNESS_FUZZ_QUERIES` (5,000). */
  queryCount?: number;
  trigger?: 'cli' | 'ci' | 'api';
  prNumber?: number;
  /**
   * Overrides `env.CHECK_MAX_DEPTH` for every check this run makes, on
   * *both* resolvers. **Omit for the standard run.** Until D-071
   * (`docs/DECISIONS.md`), omitting this meant each resolver silently fell
   * back to its own *independent* default — `productionCheck` to
   * `env.CHECK_MAX_DEPTH` (25), `referenceCheck` to
   * `DEFAULT_REFERENCE_MAX_DEPTH` (1000, `src/resolve/reference/
   * resolver.ts`) — a 40x mismatch that D-070 proved makes an entire class
   * of real, boolean-level `false_grant` bugs (D-069 bug 1's own shape:
   * an under-reduced depth budget on a relation lookup) structurally
   * undetectable by this harness at the default configuration, no matter
   * how the fixture generator is built. As of D-071, omitting this option
   * resolves *one* effective ceiling — `env.CHECK_MAX_DEPTH` — and passes
   * it explicitly to *both* resolvers, so "the standard run" now actually
   * means "both resolvers are held to the one real, production-configured
   * ceiling," not "each resolver quietly does its own, mismatched thing."
   * Still a generic replay/reproduction knob when explicitly set (e.g.
   * re-running a seed at a different depth budget to see whether a
   * boundary-dependent divergence appears) — **not** a fix for catching a
   * missing SQL cycle guard specifically; see D-035 for why that bug class
   * is structurally invisible to boolean-only differential comparison at
   * any depth, and forcing a large value here on a full-size query batch
   * is itself impractical (confirmed directly: a 500-query run forced to
   * `maxDepth: 20_000` against a schema containing the guaranteed cycle
   * did not complete within 5 minutes — every query touching that cycle
   * pays the same superlinear cost the missing guard introduces, not just
   * the one query that would demonstrate it).
   */
  maxDepth?: number;
  /**
   * When `true`, runs the exact same real differential-fuzz cycle as the
   * default path below — real `publishSchema`, real `writeTuple` calls,
   * real checks against both resolvers, a real (if briefly-lived)
   * `soundness_runs` row inserted and returned with a real `id` — and
   * computes the exact same verdict. The only difference: before returning,
   * it deletes every row this call created (the `soundness_runs` row, every
   * tuple in the generated fixture, and every `(namespace, version)`
   * `publishSchema` published), leaving `namespace_configs`,
   * `relation_tuples`, and `soundness_runs` in exactly the state they were
   * in before the call — no visible trace, even though the same real
   * soundness claim was proven the same real way. This closes
   * `docs/DECISIONS.md` D-060's own "revisit if" — the local-exploration
   * use case (e.g. the README's "try it yourself" walkthrough) no longer
   * has to leave randomly-named fixture rows behind in whatever database
   * it's pointed at.
   *
   * Cleanup is best-effort and unconditional: it still runs, for whatever
   * was actually created, even if the run itself throws partway through
   * (a generator bug, a crashing check, anything) — see this file's own
   * `runSoundnessFuzz` implementation for exactly what "best-effort" means
   * when cleanup itself fails. **A cleanup failure after an otherwise
   * successful run never discards that run's own result** (D-066): the
   * verdict this option promises to prove is real the moment it's computed,
   * whether or not the housekeeping afterward succeeds — a failed cleanup
   * in that case is logged, not thrown, so it can never masquerade as
   * (and get mapped to the exit code of) the "no verdict was ever computed"
   * failure `src/report/exitCodes.ts` reserves exit code 3 for.
   *
   * Deliberately does **not** clean up `write_log`: that table is an
   * honest, append-only ledger of every write that has ever really
   * happened against this database, and a dry run's writes (and the
   * deletes that immediately undo them) really did happen — removing them
   * from `write_log` would make that ledger lie about the database's own
   * history. Leaving `write_log` alone here is the correct, deliberate
   * choice, not a gap to "fix" later.
   *
   * Omit (or pass `false`) for today's exact behavior: every row this run
   * creates is left in place, permanently, exactly as it always has been —
   * this option changes nothing about the default path.
   */
  dryRun?: boolean;
  /**
   * Called after each concurrency-sized batch of queries finishes checking
   * (`checkAllQueries` below) — never more often than that, and never for
   * anything else this function does (schema publish, tuple writes,
   * cleanup). `completed` is always `<= total`; the final call in any run
   * always has `completed === total`, so a caller doesn't need its own
   * separate "done" signal.
   *
   * Added live, for a real reason: `soundness run`'s existing contract
   * (nothing prints until the whole run finishes) looks identical to a
   * hang on a slow connection — the checks phase is the one meaningfully
   * long part of a run, and a real user with no visibility into that
   * asked, mid-troubleshooting, "can you make it so it gives me a count
   * every x amount." Omit for today's exact behavior: `checkAllQueries`
   * skips the callback entirely when this is `undefined`, so nothing about
   * the default path changes. Deliberately a plain callback, not a
   * `console.log` call in this file directly — `runner.ts` does real I/O
   * elsewhere (Postgres, in `checkAllQueries` itself) but has no opinion on
   * *how* progress is displayed; `src/cli/commands/soundness.ts` supplies
   * the actual stderr-writing implementation (`createProgressReporter`,
   * `src/report/progress.ts`) — never stdout, since `--format
   * markdown`/`json`'s own contract is "stdout is the report and nothing
   * else" (this file's own sibling doc comments elsewhere in this
   * codebase; see that CLI file's top-of-file comment).
   */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * One divergence, in the shape `soundness_runs.divergences` (jsonb) stores
 * it. `referencePath`/`productionPath` are Phase 6 additions (§6.7): each
 * resolver's own resolution path, present exactly when *that* resolver's
 * own `expected`/`actual` boolean is `true` — never a shared or merged
 * shape (they're independently-typed per-resolver `ResolutionStep`s, per
 * `docs/DECISIONS.md` D-022's field-for-field-independent precedent, not
 * unified into one "the" path type). For a `false_grant` specifically,
 * this is what turns "production disagreed with reference" into "here is
 * the exact bogus chain the production resolver *thought* it found," per
 * this task's own restated framing of the Phase 5 PR's open question — see
 * `test/isolation/differential-soundness.fuzz.test.ts`'s formerly-`.todo()`
 * test of the same name. Purely additive data on the record: it changes
 * nothing about which queries count as a divergence or how they're
 * classified (`classify.ts`'s own logic is untouched by this).
 */
export interface DivergenceRecord {
  query: {
    subject: GeneratedEntityRef;
    object: GeneratedEntityRef;
    relationOrPermission: string;
  };
  /** The reference resolver's (oracle) `allowed` value. */
  expected: boolean;
  /** The production resolver's `allowed` value. */
  actual: boolean;
  kind: 'false_grant' | 'false_deny';
  critical: boolean;
  /** Present iff `expected` is true — the real chain the reference resolver found. */
  referencePath?: ReferenceResolutionStep;
  /** Present iff `actual` is true — for a `false_grant`, the bogus chain the production resolver thought it found. */
  productionPath?: ProductionResolutionStep;
}

/**
 * Thrown when the generated fixture itself is broken — a schema that fails
 * to compile, a publish rejection, or a tuple write rejection — and never
 * for anything else `runSoundnessFuzz` can throw (an unreachable database,
 * an unexpected `soundness_runs` insert response, a rethrown cleanup
 * failure). These are generator bugs, not resolver findings: build spec §7
 * puts them in exit code 2 ("insufficient fuzz coverage or a schema/tuple
 * validation failure"), a distinct category from exit code 3
 * ("infrastructure failure (DB unreachable, etc.)") — see
 * `src/cli/commands/soundness.ts`'s own top-of-file exit-code table, which
 * already documented this split before this class existed to let its
 * `catch` block actually implement it (full-repo audit finding #12,
 * MEDIUM, 2026-08-16 — `src/cli/commands/soundness.ts`'s previous blanket
 * `catch` mapped every thrown error, including these, to exit code 3, and
 * additionally mislabeled the message with a `"Postgres: "` prefix that
 * implies a database-connectivity problem regardless of which of these
 * three actually happened — see `docs/DECISIONS.md`).
 */
export class SoundnessFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoundnessFixtureError';
  }
}

export interface SoundnessRunResult {
  /** The persisted `soundness_runs` row's id. */
  id: string;
  graphSeed: string;
  namespaceCount: number;
  tupleCount: number;
  queryCount: number;
  falseGrantCount: number;
  falseDenyCount: number;
  criticalNamespaceFalseGrants: number;
  verdict: SoundnessVerdict;
  divergences: DivergenceRecord[];
}

const DEFAULT_TRIGGER: NonNullable<SoundnessRunOptions['trigger']> = 'cli';

interface CheckedQuery {
  query: GeneratedQuery;
  referenceAllowed: boolean;
  productionAllowed: boolean;
  /** Present iff `referenceAllowed` — see `DivergenceRecord`'s own doc comment. */
  referencePath?: ReferenceResolutionStep;
  /** Present iff `productionAllowed` — see `DivergenceRecord`'s own doc comment. */
  productionPath?: ProductionResolutionStep;
}

export interface BuildDivergenceRecordInput extends CheckedQuery {
  criticalNamespaces: ReadonlySet<string>;
}

/**
 * Classifies one already-checked query (`classify.ts`'s own, untouched
 * `classifyResult` — this function changes nothing about *which* queries
 * count as a divergence or how they're classified) and, if it is one,
 * builds its `DivergenceRecord` — `null` on agreement. Pure, no I/O.
 *
 * Extracted out of `runSoundnessFuzz`'s own loop specifically so the
 * `referencePath`/`productionPath` population rule (§6.7, Phase 6 — each
 * present iff that resolver's own boolean was true) is independently
 * testable with hand-supplied inputs, the same way `classify.ts`'s own
 * tests already exercise `classifyResult` directly with synthetic
 * booleans — no real Postgres, no real fuzz run, and no need to mutate a
 * shipped resolver file at test time (this project's own established,
 * deliberate constraint — see `test/isolation/differential-soundness.fuzz
 * .test.ts`'s own doc comment on why the "fuzz harness has power" tests use
 * a local synthetic double rather than editing `resolver.ts` live). See
 * `a-run-that-finds-any-false-grant-records-the-full-resolution-path...`
 * in that same file for the un-skipped test this makes possible.
 */
export function buildDivergenceRecord(input: BuildDivergenceRecordInput): DivergenceRecord | null {
  const classification = classifyResult({
    referenceAllowed: input.referenceAllowed,
    productionAllowed: input.productionAllowed,
    objectNamespace: input.query.object.ns,
    criticalNamespaces: input.criticalNamespaces,
  });
  if (!classification) return null;

  return {
    query: {
      subject: input.query.subject,
      object: input.query.object,
      relationOrPermission: input.query.relationOrPermission,
    },
    expected: input.referenceAllowed,
    actual: input.productionAllowed,
    kind: classification.kind,
    critical: classification.critical,
    ...(input.referencePath !== undefined ? { referencePath: input.referencePath } : {}),
    ...(input.productionPath !== undefined ? { productionPath: input.productionPath } : {}),
  };
}

/**
 * Runs `queries` through both resolvers, `concurrency` at a time,
 * preserving input order in the returned array. `maxDepth` is always a
 * concrete, already-resolved number by the time it reaches here (D-071,
 * `docs/DECISIONS.md`) — `runSoundnessFuzz` resolves `options.maxDepth ??
 * env.CHECK_MAX_DEPTH` exactly once, before this function is ever called,
 * and passes the *same* resolved value to both `referenceCheck` and
 * `productionCheck` below, unconditionally. This function itself has no
 * "fall back to each resolver's own default" branch left to get wrong —
 * that mismatch (`env.CHECK_MAX_DEPTH` vs. `DEFAULT_REFERENCE_MAX_DEPTH`)
 * is exactly what made D-069 bug 1's own `false_grant` shape structurally
 * undetectable by this harness at the standard configuration (D-070); see
 * D-071 for the live-verified fix and numbers.
 */
async function checkAllQueries(
  pool: Pool,
  schema: Parameters<typeof referenceCheck>[0],
  referenceTuples: Parameters<typeof referenceCheck>[1],
  queries: readonly GeneratedQuery[],
  concurrency: number,
  maxDepth: number,
  onProgress?: (completed: number, total: number) => void,
): Promise<CheckedQuery[]> {
  const results: CheckedQuery[] = [];
  for (let start = 0; start < queries.length; start += concurrency) {
    const batch = queries.slice(start, start + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (query): Promise<CheckedQuery> => {
        const referenceResult = referenceCheck(
          schema,
          referenceTuples,
          query.subject,
          query.object,
          query.relationOrPermission,
          { maxDepth },
        );
        const productionResult = await productionCheck(
          pool,
          query.subject,
          query.object,
          query.relationOrPermission,
          { maxDepth },
        );
        return {
          query,
          referenceAllowed: referenceResult.allowed,
          productionAllowed: productionResult.allowed,
          ...(referenceResult.allowed ? { referencePath: referenceResult.path } : {}),
          ...(productionResult.allowed ? { productionPath: productionResult.path } : {}),
        };
      }),
    );
    results.push(...batchResults);
    // See `SoundnessRunOptions.onProgress`'s own doc comment — called once
    // per batch, after that batch's queries have actually finished
    // checking, never more often. `results.length` is always the true
    // completed count regardless of `queries.length % concurrency`, since
    // `batch` (and so `batchResults`) is only ever smaller than
    // `concurrency` on the final iteration.
    onProgress?.(results.length, queries.length);
  }
  return results;
}

/**
 * Deletes, best-effort, exactly what one `dryRun` call to
 * `runSoundnessFuzz` actually created: the `soundness_runs` row
 * (`artifacts.runId`, `undefined` iff the insert never happened — a plain
 * `delete ... where id = $1`, this file's own raw SQL against this table,
 * matching the `insert` right above it rather than a new helper exported
 * elsewhere), every tuple in the generated fixture (`deleteTuple` —
 * already idempotent/safe per `src/store/tuples.ts`'s own doc comment, so
 * it's safe to pass the *entire* generated tuple list here even when a
 * mid-loop write failure meant only some of them were ever actually
 * written), and every `(namespace, version)` pair `publishSchema` actually
 * returned (`deletePublishedNamespaceVersion`, empty iff publish never
 * succeeded).
 *
 * "Best-effort" specifically means: one failing delete never stops the
 * rest from being attempted — every deletion in every category is tried
 * regardless of any other's outcome, and only once everything has been
 * attempted does this throw a single `AggregateError` summarizing whatever
 * failed (or resolve cleanly if nothing did). Callers decide what to do
 * with that — see `runSoundnessFuzz`'s own comment on why an error from
 * here is deliberately never allowed to *replace* an earlier, real run
 * failure.
 *
 * Deliberately does not touch `write_log` — see
 * `SoundnessRunOptions.dryRun`'s own doc comment for why that's correct,
 * not an oversight.
 */
async function cleanupDryRunArtifacts(
  pool: Pool,
  artifacts: {
    runId: string | undefined;
    tuples: readonly TupleKey[];
    namespaces: readonly PublishedNamespace[];
  },
): Promise<void> {
  const errors: unknown[] = [];

  if (artifacts.runId !== undefined) {
    try {
      await pool.query(`delete from soundness_runs where id = $1`, [artifacts.runId]);
    } catch (err) {
      errors.push(err);
    }
  }

  for (const tuple of artifacts.tuples) {
    try {
      const result = await deleteTuple(pool, tuple);
      // `deleteTuple` reports a validation failure as `{ ok: false, errors
      // }`, not a thrown error — checked explicitly here, not just
      // `await`ed, so this loop's own doc comment above ("every deletion
      // attempted... a single AggregateError summarizing whatever failed")
      // holds for both failure shapes the same way the write loop above
      // already checks `.ok` for writes (full-repo audit finding #10, LOW,
      // 2026-08-16 — not reachable today, since every fixture-generated
      // tuple already deterministically passes `deleteTuple`'s own
      // syntactic identifier check, but a latent gap in this contract
      // nonetheless).
      if (!result.ok) {
        errors.push(new Error(`deleteTuple validation failed: ${JSON.stringify(result.errors)}`));
      }
    } catch (err) {
      errors.push(err);
    }
  }

  for (const namespace of artifacts.namespaces) {
    try {
      await deletePublishedNamespaceVersion(pool, namespace.namespace, namespace.version);
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `soundness dry run cleanup: ${errors.length} deletion(s) failed — some fixture rows ` +
        `may remain in namespace_configs/relation_tuples/soundness_runs`,
    );
  }
}

/**
 * Runs one full differential-soundness fuzz cycle against `pool` and
 * persists the result. Generation is fully deterministic from the seed
 * used (recorded either way — see `SoundnessRunOptions.seed`); everything
 * after generation is real I/O against `pool` (`publishSchema`,
 * `writeTuple`, `productionCheck`) plus a pure in-memory oracle call
 * (`referenceCheck`) per query.
 *
 * Throws (never returns a "soft" failure result) if the generated fixture
 * itself is broken — a schema that fails to compile, a publish rejection,
 * or a tuple write rejection are all generator bugs, not fuzz findings,
 * and must not be silently absorbed into a misleading verdict. This
 * contract is unchanged by `options.dryRun`: a dry run throws for exactly
 * the same reasons a real run does.
 *
 * When `options.dryRun` is true, every step below still happens for real
 * (see `SoundnessRunOptions.dryRun`'s own doc comment) — the only
 * difference is the `cleanupIfDryRun`/`catch` handling wrapped around the
 * exact same body, which deletes everything this call created before
 * returning or rethrowing. When `options.dryRun` is false or omitted
 * (the default), `cleanupIfDryRun` is a same-tick no-op (see its own
 * definition below) and every statement in the body below runs exactly as
 * it did before this option existed — same queries, same persistence,
 * same return shape.
 */
export async function runSoundnessFuzz(
  pool: Pool,
  options: SoundnessRunOptions = {},
): Promise<SoundnessRunResult> {
  const seed = options.seed ?? generateRandomSeed();
  const queryCount = options.queryCount ?? env.SOUNDNESS_FUZZ_QUERIES;
  const trigger = options.trigger ?? DEFAULT_TRIGGER;
  const dryRun = options.dryRun ?? false;
  // Resolved once, here, and passed explicitly to *both* resolvers below
  // (D-071, `docs/DECISIONS.md`) — never left for `referenceCheck`/
  // `productionCheck` to silently apply their own, independently mismatched
  // defaults (`env.CHECK_MAX_DEPTH` = 25 vs. `DEFAULT_REFERENCE_MAX_DEPTH`
  // = 1000), which D-070 proved makes an entire real `false_grant` bug
  // class undetectable by this harness at the standard configuration.
  const effectiveMaxDepth = options.maxDepth ?? env.CHECK_MAX_DEPTH;

  const fixture = generateFixture(seed, queryCount);

  // Populated incrementally, below, exactly as each step actually
  // succeeds — so that whatever this call has actually created by the
  // time (if ever) something throws is exactly what `cleanupIfDryRun`
  // deletes. Read only by `cleanupIfDryRun`, which itself is a no-op
  // whenever `dryRun` is false, so mutating these has no effect on the
  // default path.
  let publishedForCleanup: PublishedNamespace[] = [];
  let insertedRunIdForCleanup: string | undefined;

  // Not a plain `finally`, deliberately: a `finally` that itself throws
  // always *replaces* whatever the `try` was already throwing, which
  // would let a cleanup failure mask a real run failure — exactly what
  // this task's own contract forbids. Calling this explicitly from both
  // the success path (inside `try`, just before `return`) and the failure
  // path (`catch`) gives each outcome exactly one cleanup attempt while
  // keeping the choice of *which* error ultimately propagates explicit,
  // below, rather than left to `finally`'s own override-the-earlier-error
  // default.
  const cleanupIfDryRun = async (): Promise<void> => {
    if (!dryRun) return;
    await cleanupDryRunArtifacts(pool, {
      runId: insertedRunIdForCleanup,
      tuples: fixture.tuples,
      namespaces: publishedForCleanup,
    });
  };

  try {
    // The reference resolver needs its own compiled schema — compiled fresh
    // from the exact same source text `publishSchema` below will also
    // compile internally, so both resolvers are guaranteed to be reasoning
    // about byte-identical schema data, never two independently-drifted
    // copies (see cross-resolver-agreement.integration.test.ts's own
    // `setUpSchema` precedent).
    const compiled = compileSchema(fixture.schemaSource);
    if (!compiled.ok) {
      throw new SoundnessFixtureError(
        `soundness run (seed=${seed}): generated schema failed to compile — this is a ` +
          `generator bug, not a resolver finding: ${compiled.errors.map(formatSchemaError).join('; ')}`,
      );
    }
    const schema = compiled.schema;

    const published = await publishSchema(pool, fixture.schemaSource);
    if (!published.ok) {
      throw new SoundnessFixtureError(
        `soundness run (seed=${seed}): failed to publish the generated schema: ${published.errors.join('; ')}`,
      );
    }
    publishedForCleanup = published.published;

    for (const tuple of fixture.tuples) {
      const writeResult = await writeTuple(pool, tuple);
      if (!writeResult.ok) {
        throw new SoundnessFixtureError(
          `soundness run (seed=${seed}): failed to write a generated tuple ` +
            `${JSON.stringify(tuple)}: ${JSON.stringify(writeResult.errors)}`,
        );
      }
    }

    const criticalNamespaces = new Set(
      fixture.namespaces
        .filter((namespace) => namespace.critical)
        .map((namespace) => namespace.namespace),
    );

    const concurrency = Math.max(1, env.MAX_CONCURRENCY);
    const checked = await checkAllQueries(
      pool,
      schema,
      fixture.tuples,
      fixture.queries,
      concurrency,
      effectiveMaxDepth,
      options.onProgress,
    );

    const divergences: DivergenceRecord[] = [];
    let falseGrantCount = 0;
    let falseDenyCount = 0;
    let criticalNamespaceFalseGrants = 0;

    for (const checkedQuery of checked) {
      const record = buildDivergenceRecord({ ...checkedQuery, criticalNamespaces });
      if (!record) continue;

      divergences.push(record);
      if (record.kind === 'false_grant') {
        falseGrantCount += 1;
        if (record.critical) criticalNamespaceFalseGrants += 1;
      } else {
        falseDenyCount += 1;
      }
    }

    const verdict = computeVerdict({ falseGrantCount, coverageOk: fixture.coverage.ok });

    const { rows } = await pool.query<{ id: string }>(
      `insert into soundness_runs
         (trigger, pr_number, graph_seed, namespace_count, tuple_count, query_count,
          false_grant_count, false_deny_count, critical_namespace_false_grants, verdict, divergences)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        trigger,
        options.prNumber ?? null,
        seed,
        fixture.namespaces.length,
        fixture.tuples.length,
        fixture.queries.length,
        falseGrantCount,
        falseDenyCount,
        criticalNamespaceFalseGrants,
        verdict,
        JSON.stringify(divergences),
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('soundness_runs insert did not return an id');
    }
    insertedRunIdForCleanup = id;

    const result: SoundnessRunResult = {
      id,
      graphSeed: seed,
      namespaceCount: fixture.namespaces.length,
      tupleCount: fixture.tuples.length,
      queryCount: fixture.queries.length,
      falseGrantCount,
      falseDenyCount,
      criticalNamespaceFalseGrants,
      verdict,
      divergences,
    };

    // Real row inserted, real result computed — now erase the evidence
    // (no-op when `dryRun` is false) before handing the result back.
    //
    // Deliberately NOT a bare `await cleanupIfDryRun();` here (full-repo
    // audit finding, HIGH, 2026-08-16 — see `docs/DECISIONS.md` D-066): a
    // dry run's cleanup is a courtesy on top of an already-successful,
    // already-persisted run — `result` above is a real, valid
    // `SoundnessRunResult` the moment the insert above returns, whether or
    // not cleanup afterward succeeds. Letting a cleanup failure here
    // propagate as a thrown error would fall into this function's own
    // `catch` block below and reach `soundnessRun`'s `catch`
    // (`src/cli/commands/soundness.ts`) indistinguishably from a genuine
    // "no verdict was ever computed" failure — silently downgrading a real
    // verdict (possibly `unsound`, with a critical `false_grant` — exit
    // code 1, meant to block a PR) to exit code 3
    // ("infrastructure failure"), which `src/report/exitCodes.ts`'s own
    // doc comment reserves for exactly the case that did NOT happen here.
    // A cleanup failure at this point is logged, visibly, not thrown — it
    // never gets the chance to mask the verdict this function is about to
    // return.
    try {
      await cleanupIfDryRun();
    } catch (cleanupErr) {
      console.error(
        `soundness dry run (seed=${seed}): cleanup failed after a successful run — ` +
          `the computed verdict (${verdict}) is still valid and will be returned; ` +
          `some fixture rows may remain in namespace_configs/relation_tuples/soundness_runs`,
        cleanupErr,
      );
    }
    return result;
  } catch (err) {
    // Best-effort cleanup of whatever was actually created before this
    // throw, for exactly the same reason the success path above cleans up
    // before returning — a dry run promises no trace regardless of how the
    // call ends. A failure here must never replace `err`: whether `err` is
    // a genuine run failure (a bad tuple, a crashing check, …) or itself
    // came from the cleanup call on the success path above, `err` is
    // always the one thing this function is already about to throw, and
    // that must reach the caller unchanged — see this function's own doc
    // comment ("Throws ... if the generated fixture itself is broken")
    // and this task's own instruction not to reshape or swallow it. A
    // second cleanup failure here is logged, not thrown, so it's visible
    // without masking `err`.
    try {
      await cleanupIfDryRun();
    } catch (cleanupErr) {
      console.error(
        `soundness dry run (seed=${seed}): cleanup failed while handling an earlier error — ` +
          `some fixture rows may remain in the database`,
        cleanupErr,
      );
    }
    throw err;
  }
}
