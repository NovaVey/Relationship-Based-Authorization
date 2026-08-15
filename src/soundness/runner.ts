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
 */
import type { Pool } from 'pg';

import { env } from '../config/env.js';
import { compileSchema } from '../schema/dsl/compiler.js';
import { formatSchemaError } from '../schema/dsl/errors.js';
import { publishSchema } from '../schema/publish.js';
import { writeTuple } from '../store/tuples.js';
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
   * *both* resolvers. Omit for the standard run — production-realistic
   * depth, exactly what real callers see. A generic replay/reproduction
   * knob (e.g. re-running a seed at a different depth budget to see
   * whether a boundary-dependent divergence appears) — **not** a fix for
   * catching a missing SQL cycle guard specifically; see D-035 for why
   * that bug class is structurally invisible to boolean-only differential
   * comparison at any depth, and forcing a large value here on a full-size
   * query batch is itself impractical (confirmed directly: a 500-query run
   * forced to `maxDepth: 20_000` against a schema containing the
   * guaranteed cycle did not complete within 5 minutes — every query
   * touching that cycle pays the same superlinear cost the missing guard
   * introduces, not just the one query that would demonstrate it).
   */
  maxDepth?: number;
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

/** Runs `queries` through both resolvers, `concurrency` at a time, preserving input order in the returned array. */
async function checkAllQueries(
  pool: Pool,
  schema: Parameters<typeof referenceCheck>[0],
  referenceTuples: Parameters<typeof referenceCheck>[1],
  queries: readonly GeneratedQuery[],
  concurrency: number,
  maxDepth: number | undefined,
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
          maxDepth !== undefined ? { maxDepth } : {},
        );
        const productionResult = await productionCheck(
          pool,
          query.subject,
          query.object,
          query.relationOrPermission,
          maxDepth !== undefined ? { maxDepth } : {},
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
  }
  return results;
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
 * and must not be silently absorbed into a misleading verdict.
 */
export async function runSoundnessFuzz(
  pool: Pool,
  options: SoundnessRunOptions = {},
): Promise<SoundnessRunResult> {
  const seed = options.seed ?? generateRandomSeed();
  const queryCount = options.queryCount ?? env.SOUNDNESS_FUZZ_QUERIES;
  const trigger = options.trigger ?? DEFAULT_TRIGGER;

  const fixture = generateFixture(seed, queryCount);

  // The reference resolver needs its own compiled schema — compiled fresh
  // from the exact same source text `publishSchema` below will also
  // compile internally, so both resolvers are guaranteed to be reasoning
  // about byte-identical schema data, never two independently-drifted
  // copies (see cross-resolver-agreement.integration.test.ts's own
  // `setUpSchema` precedent).
  const compiled = compileSchema(fixture.schemaSource);
  if (!compiled.ok) {
    throw new Error(
      `soundness run (seed=${seed}): generated schema failed to compile — this is a ` +
        `generator bug, not a resolver finding: ${compiled.errors.map(formatSchemaError).join('; ')}`,
    );
  }
  const schema = compiled.schema;

  const published = await publishSchema(pool, fixture.schemaSource);
  if (!published.ok) {
    throw new Error(
      `soundness run (seed=${seed}): failed to publish the generated schema: ${published.errors.join('; ')}`,
    );
  }

  for (const tuple of fixture.tuples) {
    const result = await writeTuple(pool, tuple);
    if (!result.ok) {
      throw new Error(
        `soundness run (seed=${seed}): failed to write a generated tuple ` +
          `${JSON.stringify(tuple)}: ${JSON.stringify(result.errors)}`,
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
    options.maxDepth,
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

  return {
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
}
