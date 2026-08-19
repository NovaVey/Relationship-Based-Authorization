/**
 * Real-Postgres proof of `runSoundnessFuzz`'s `dryRun` option (D-063,
 * closing `docs/DECISIONS.md` D-060's own "revisit if" — see
 * `src/soundness/runner.ts`'s own doc comments on `SoundnessRunOptions
 * .dryRun`, `cleanupDryRunArtifacts`, and `runSoundnessFuzz` itself, which
 * this file treats as the authoritative spec for the property under test,
 * the same way `test/isolation/differential-soundness.fuzz.integration
 * .test.ts` treats build spec §9 Phase 5's own exit-criterion wording as
 * its spec).
 *
 * The claim under test: `dryRun: true` runs the exact same real
 * differential-fuzz cycle as the default path — real `publishSchema`, real
 * `writeTuple`, real checks against both resolvers, a real (if
 * briefly-lived) `soundness_runs` row — and then deletes every row it
 * created before returning, leaving `namespace_configs`/`relation_tuples`/
 * `soundness_runs` in exactly their prior state, while deliberately never
 * touching `write_log` (an honest, append-only ledger of writes that
 * really happened). This is proven here against real row counts and real
 * data, never by reading `runner.ts` and asserting it "looks right."
 *
 * Real Postgres via `PostgreSqlContainer`, migrations applied via this
 * project's own `runMigrations` — matching `docs/DECISIONS.md` D-019/D-030
 * and every other `*.integration.test.ts` in this repo (see
 * `test/isolation/differential-soundness.fuzz.integration.test.ts`,
 * `test/unit/store/tuple-store.integration.test.ts`). Query counts are
 * kept small (a few hundred, not the 5,000 default) — this file proves the
 * dry-run *mechanism*, not soundness itself, which
 * `differential-soundness.fuzz.integration.test.ts` already owns.
 *
 * **What this file does NOT attempt, and why:** proving "cleanup still
 * runs for whatever was created even when the run itself fails partway
 * through" against a *genuine*, deterministically-triggered mid-run
 * failure, reached only through `runSoundnessFuzz`'s own public
 * `(pool, options)` surface, with zero changes to `src/soundness/runner.ts`
 * or any other source file. Investigated directly: every throw site inside
 * `runSoundnessFuzz` (a schema that fails to compile, a publish rejection,
 * a tuple write rejection) is only reachable from a fixture the generator
 * itself produced, and the generator's own fixtures are always
 * self-consistent by construction (the schema it publishes always declares
 * exactly the relations/subject-types the tuples it writes actually use) —
 * there is no `SoundnessRunOptions` combination that makes a real, valid
 * fixture's own tuple write fail. The one genuine race available (two
 * concurrent `runSoundnessFuzz` calls sharing an identical seed racing
 * `publishSchema`'s own read-then-insert next-version query) is a real
 * failure path, but not a *deterministic* one — Postgres's read-committed
 * default isolation means whether the two transactions actually interleave
 * closely enough to collide depends on scheduling, so a test built on it
 * would be genuinely flaky for reasons unrelated to the property under
 * test, not a reliable proof. Per this task's own explicit instruction not
 * to fake this, it is left unautomated here — validated instead, per the
 * task brief, by the main agent's own manual fail-check (forced
 * cleanup-always-fails injection, and separately a forced mid-run-write
 * failure, both performed directly against `runner.ts`).
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { runSoundnessFuzz, type SoundnessRunResult } from '../../../src/soundness/runner.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

interface TableCounts {
  namespaceConfigs: number;
  relationTuples: number;
  soundnessRuns: number;
  writeLog: number;
}

/** Real `select count(*)` from every table `dryRun` cleanup either does or (for `write_log`) deliberately does not touch. */
async function countRows(p: Pool): Promise<TableCounts> {
  const [namespaceConfigs, relationTuples, soundnessRuns, writeLog] = await Promise.all([
    p.query<{ count: string }>('select count(*) as count from namespace_configs'),
    p.query<{ count: string }>('select count(*) as count from relation_tuples'),
    p.query<{ count: string }>('select count(*) as count from soundness_runs'),
    p.query<{ count: string }>('select count(*) as count from write_log'),
  ]);
  return {
    namespaceConfigs: Number(namespaceConfigs.rows[0]?.count ?? 0),
    relationTuples: Number(relationTuples.rows[0]?.count ?? 0),
    soundnessRuns: Number(soundnessRuns.rows[0]?.count ?? 0),
    writeLog: Number(writeLog.rows[0]?.count ?? 0),
  };
}

// "a modest query count (a few hundred, not the full 5,000 default) —
// keep this test fast" per this task's own brief. Large enough that the
// generator still produces a real, non-trivial fixture (every rewrite-rule
// kind, a guaranteed cycle — see generators.ts) every run.
const QUERY_COUNT = 200;

describe('runSoundnessFuzz dryRun (D-063) — real full differential-fuzz cycle, zero persistent trace', () => {
  describe('a dry run followed by a real run of the identical seed', () => {
    const seed = `dry-run-mechanism-${randomUUID()}`;
    // Pure, deterministic, zero I/O — generateFixture(seed, QUERY_COUNT)
    // reproduces byte-identically whatever runSoundnessFuzz's own internal
    // call with the same (seed, queryCount) will generate (proven directly
    // in test/isolation/differential-soundness.fuzz.test.ts's own
    // reproducibility test) — used here only to know, independently, which
    // real namespace names this run's dry-run cleanup must leave with zero
    // trace below, not to predict or assert on the resolvers' own verdicts.
    const expectedFixture = generateFixture(seed, QUERY_COUNT);
    const generatedNamespaceNames = expectedFixture.namespaces.map((n) => n.namespace);

    let before: TableCounts;
    let afterDry: TableCounts;
    let dryResult: SoundnessRunResult;
    let realResult: SoundnessRunResult;
    let afterReal: TableCounts;
    // Captured immediately after the dry run and before the real run below
    // starts — deliberately NOT re-queried live inside an `it`, because the
    // real run (same seed, so the identical salted namespace names) runs
    // next in this same `beforeAll` and *legitimately* leaves rows behind
    // under those exact names; querying "do any rows exist for these
    // names" after both calls have completed would silently see the real
    // run's own legitimate rows and prove nothing about dry-run cleanup —
    // caught live the first time this file actually ran against real
    // Postgres (see this file's own PROGRESS.md-style verification note).
    let survivingNamespaceRowsAfterDry: number;
    let survivingTupleRowsAfterDry: number;

    beforeAll(async () => {
      before = await countRows(pool);

      dryResult = await runSoundnessFuzz(pool, {
        seed,
        queryCount: QUERY_COUNT,
        trigger: 'cli',
        dryRun: true,
      });
      afterDry = await countRows(pool);

      const { rows: namespaceSurvival } = await pool.query<{ count: string }>(
        'select count(*) as count from namespace_configs where namespace = any($1)',
        [generatedNamespaceNames],
      );
      survivingNamespaceRowsAfterDry = Number(namespaceSurvival[0]?.count ?? -1);

      const { rows: tupleSurvival } = await pool.query<{ count: string }>(
        'select count(*) as count from relation_tuples where object_ns = any($1)',
        [generatedNamespaceNames],
      );
      survivingTupleRowsAfterDry = Number(tupleSurvival[0]?.count ?? -1);

      realResult = await runSoundnessFuzz(pool, {
        seed,
        queryCount: QUERY_COUNT,
        trigger: 'cli',
        dryRun: false,
      });
      afterReal = await countRows(pool);
    }, 300_000);

    it('a-dry-run-leaves-namespace-configs-relation-tuples-and-soundness-runs-at-exactly-their-prior-row-counts', async () => {
      // Sanity first: the dry run genuinely generated and checked a real,
      // non-degenerate fixture — a dry run that silently no-op'd its own
      // body would trivially "leave the database unchanged" without
      // proving anything about real cleanup.
      expect(dryResult.namespaceCount).toBeGreaterThan(0);
      expect(dryResult.tupleCount).toBeGreaterThan(0);
      expect(dryResult.queryCount).toBe(QUERY_COUNT);
      expect(dryResult.id).toBeTruthy();
      expect(dryResult.graphSeed).toBe(seed);

      expect(afterDry.namespaceConfigs).toBe(before.namespaceConfigs);
      expect(afterDry.relationTuples).toBe(before.relationTuples);
      expect(afterDry.soundnessRuns).toBe(before.soundnessRuns);

      // Stronger than the aggregate counts above: the *specific* row this
      // call inserted is gone, and *specifically* the namespaces this
      // call's own fixture published have zero rows anywhere — not just
      // "the totals happen to match," which an unrelated create+delete
      // pair elsewhere could coincidentally also produce.
      const { rows: survivingRun } = await pool.query<{ id: string }>(
        'select id from soundness_runs where id = $1',
        [dryResult.id],
      );
      expect(survivingRun).toHaveLength(0);

      // Captured in `beforeAll`, immediately after the dry run and before
      // the (same-seed) real run that follows it — see the `let` decl's
      // own comment above for why a live query at this point would be
      // wrong.
      expect(survivingNamespaceRowsAfterDry).toBe(0);
      expect(survivingTupleRowsAfterDry).toBe(0);
    });

    it('dry-run-and-non-dry-run-of-the-identical-seed-compute-byte-identical-namespace-tuple-query-and-divergence-results', () => {
      // The single most important assertion in this file: a dry-run mode
      // that silently weakened or skipped part of the real comparison to
      // make cleanup easier would still leave the database looking clean —
      // this is the assertion that would catch that class of regression,
      // not the persistence checks above.
      expect(realResult.graphSeed).toBe(dryResult.graphSeed);
      expect(realResult.namespaceCount).toBe(dryResult.namespaceCount);
      expect(realResult.tupleCount).toBe(dryResult.tupleCount);
      expect(realResult.queryCount).toBe(dryResult.queryCount);
      expect(realResult.falseGrantCount).toBe(dryResult.falseGrantCount);
      expect(realResult.falseDenyCount).toBe(dryResult.falseDenyCount);
      expect(realResult.criticalNamespaceFalseGrants).toBe(dryResult.criticalNamespaceFalseGrants);
      expect(realResult.verdict).toBe(dryResult.verdict);
      expect(realResult.divergences).toEqual(dryResult.divergences);

      // The ids are two distinct, really-persisted-then-really-deleted vs.
      // really-persisted rows — not the same object handed back twice —
      // so the equality above is a genuine independent re-computation.
      expect(realResult.id).not.toBe(dryResult.id);
    });

    it('the-non-dry-run-call-persists-a-real-soundness-runs-row-and-grows-namespace-configs-and-relation-tuples-by-exactly-the-fixtures-own-size', async () => {
      expect(afterReal.soundnessRuns).toBe(before.soundnessRuns + 1);
      expect(afterReal.namespaceConfigs).toBe(before.namespaceConfigs + realResult.namespaceCount);
      expect(afterReal.relationTuples).toBe(before.relationTuples + realResult.tupleCount);

      const { rows } = await pool.query<{
        graph_seed: string;
        verdict: string;
        query_count: number;
      }>('select graph_seed, verdict, query_count from soundness_runs where id = $1', [
        realResult.id,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.graph_seed).toBe(seed);
      expect(rows[0]?.verdict).toBe(realResult.verdict);
      expect(Number(rows[0]?.query_count)).toBe(QUERY_COUNT);
    });

    it('write-log-is-not-touched-by-dry-run-cleanup-it-grows-by-one-write-and-one-delete-entry-per-generated-tuple-rather-than-staying-flat', () => {
      // Hand-derivable independently of runner.ts's own implementation,
      // from src/store/tuples.ts's own documented contract alone:
      // writeTuple and deleteTuple are each "idempotent ... but still
      // advances the consistency token" — i.e. every call logs exactly one
      // write_log row, hit or no-op, real row created/removed or not.
      // cleanupDryRunArtifacts calls deleteTuple once per tuple in the
      // *entire* generated fixture (its own doc comment: safe to pass the
      // whole list even when only some were ever actually written). So a
      // dry run of a fixture with N tuples must grow write_log by exactly
      // N ('write', from the run itself) + N ('delete', from cleanup
      // undoing it) = 2N — never flat (proving the writes and their
      // cleanup deletes really happened, not that "nothing happened here
      // at all"), and never fewer (proving write_log itself was left
      // alone, not selectively pruned to also hide the dry run).
      const expectedGrowth = 2 * dryResult.tupleCount;
      expect(afterDry.writeLog).toBeGreaterThan(before.writeLog);
      expect(afterDry.writeLog).toBe(before.writeLog + expectedGrowth);
    });
  });

  describe('dryRun: false (explicit) vs. omitting dryRun entirely', () => {
    it('explicit-false-and-omitted-dry-run-both-persist-normally-and-neither-triggers-cleanup', async () => {
      const before = await countRows(pool);

      const explicitFalseResult = await runSoundnessFuzz(pool, {
        seed: `dry-run-explicit-false-${randomUUID()}`,
        queryCount: 40,
        trigger: 'cli',
        dryRun: false,
      });
      const afterExplicitFalse = await countRows(pool);

      const omittedResult = await runSoundnessFuzz(pool, {
        seed: `dry-run-omitted-${randomUUID()}`,
        queryCount: 40,
        trigger: 'cli',
        // dryRun omitted entirely — must behave exactly like `dryRun: false` above.
      });
      const afterOmitted = await countRows(pool);

      // Explicit `dryRun: false` persists, same shape as the default path
      // always has.
      expect(afterExplicitFalse.soundnessRuns).toBe(before.soundnessRuns + 1);
      expect(afterExplicitFalse.namespaceConfigs).toBe(
        before.namespaceConfigs + explicitFalseResult.namespaceCount,
      );
      expect(afterExplicitFalse.relationTuples).toBe(
        before.relationTuples + explicitFalseResult.tupleCount,
      );

      // Omitting `dryRun` entirely persists too, growing by exactly its
      // own fixture's size on top of the explicit-false call above — the
      // same shape of growth, proving omission is not silently treated as
      // `dryRun: true`.
      expect(afterOmitted.soundnessRuns).toBe(afterExplicitFalse.soundnessRuns + 1);
      expect(afterOmitted.namespaceConfigs).toBe(
        afterExplicitFalse.namespaceConfigs + omittedResult.namespaceCount,
      );
      expect(afterOmitted.relationTuples).toBe(
        afterExplicitFalse.relationTuples + omittedResult.tupleCount,
      );
    }, 120_000);
  });
});
