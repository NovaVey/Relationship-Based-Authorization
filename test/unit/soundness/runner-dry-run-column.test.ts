/**
 * `soundness_runs.dry_run` (migration `0005_soundness_runs_dry_run_flag
 * .sql`) — full-repo audit finding #13, LOW, 2026-08-22. D-063/D-066
 * (`docs/DECISIONS.md`) already disclose that a dry run's cleanup
 * (`cleanupDryRunArtifacts`, `src/soundness/runner.ts`) is best-effort, not
 * transactional: a process crash or connection loss mid-cleanup can, in
 * principle, leave partial fixture rows behind. If the row that survives a
 * partial cleanup failure is the `soundness_runs` row itself, nothing
 * previously persisted let a later operator tell "orphaned dry-run debris,
 * safe to purge" apart from "a real, historically significant run that
 * must be kept." This column closes that gap — the claim under test is
 * narrow: `runSoundnessFuzz`'s own `insert into soundness_runs` always
 * includes `dry_run` as its 12th column, bound to the local `dryRun`
 * variable (`options.dryRun ?? false`), for both a real run and a dry run.
 *
 * Deliberately DB-free, mirroring `runner-maxdepth-resolution.test.ts`'s
 * own established pattern: every I/O dependency `runSoundnessFuzz` has is
 * mocked via `vi.spyOn` on its own module namespace, and `fakePool`'s
 * `query` spy captures the exact SQL text and parameter array the insert
 * was actually called with — the most honest thing this can verify without
 * a real Postgres to confirm the column round-trips end to end (this
 * sandbox has no container runtime; see `dry-run-cleanup.integration.test
 * .ts` for the real-Postgres half of this table's own dry-run behavior,
 * which this test does not duplicate).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { runSoundnessFuzz } from '../../../src/soundness/runner.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import * as publishModule from '../../../src/schema/publish.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import * as productionModule from '../../../src/resolve/production/resolver.js';

const SEED = 'runner-dry-run-column-fixed-seed';
const QUERY_COUNT = 5;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Same happy-path wiring `runner-dry-run-cleanup-failure.test.ts` already establishes. */
function wireHappyPathMocks(): ReturnType<typeof generateFixture> {
  const fixture = generateFixture(SEED, QUERY_COUNT);

  vi.spyOn(publishModule, 'publishSchema').mockResolvedValue({
    ok: true,
    published: fixture.namespaces.map((n) => ({ namespace: n.namespace, version: 1 })),
  });
  vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue({ ok: true, token: 1, created: true });
  vi.spyOn(productionModule, 'productionCheck').mockResolvedValue({
    allowed: false,
    depth: 0,
    touchedExpiringTuple: false,
  });

  return fixture;
}

/**
 * Captures every `insert into soundness_runs` call's SQL text and params
 * (there should be exactly one per `runSoundnessFuzz` call) alongside the
 * plain fake-pool responses every other query in this codepath needs —
 * `delete from soundness_runs` (dry-run cleanup) resolves trivially since
 * this test cares about the insert, not cleanup.
 */
function fakePool(insertedRunId: string, captured: { sql: string; params: unknown[] }[]): Pool {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('insert into soundness_runs')) {
        captured.push({ sql, params: params ?? [] });
        return { rows: [{ id: insertedRunId }] };
      }
      if (typeof sql === 'string' && sql.includes('delete from soundness_runs')) {
        return { rows: [] };
      }
      throw new Error(`fakePool: unexpected query: ${sql}`);
    }),
  } as unknown as Pool;
}

describe('runSoundnessFuzz inserts soundness_runs.dry_run correctly (audit finding #13, LOW)', () => {
  it('a real (non-dry-run) call inserts dry_run as the 12th column, bound to false', async () => {
    wireHappyPathMocks();
    const captured: { sql: string; params: unknown[] }[] = [];

    await runSoundnessFuzz(fakePool('real-run-id', captured), {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
      // dryRun omitted — exercises `options.dryRun ?? false`.
    });

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain('dry_run');
    expect(sql).toContain('$12');
    expect(params).toHaveLength(12);
    expect(params[11]).toBe(false);
  });

  it('a dry-run call inserts dry_run as the 12th column, bound to true', async () => {
    wireHappyPathMocks();
    vi.spyOn(tuplesModule, 'deleteTuple').mockResolvedValue({ ok: true, token: 2, deleted: true });
    vi.spyOn(publishModule, 'deletePublishedNamespaceVersion').mockResolvedValue(undefined);
    const captured: { sql: string; params: unknown[] }[] = [];

    await runSoundnessFuzz(fakePool('dry-run-id', captured), {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
      dryRun: true,
    });

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain('dry_run');
    expect(sql).toContain('$12');
    expect(params).toHaveLength(12);
    expect(params[11]).toBe(true);
  });

  it('the 12th placeholder is positioned immediately after the existing 11-column list, not appended past a stale $11 boundary', async () => {
    // Guards against the specific regression this task could introduce:
    // adding `dry_run` to the column list but forgetting to also widen the
    // `values (...)` placeholder list, which would silently insert `true`/
    // `false` into whatever the 12th *positional* column already was (or
    // throw a Postgres "bind message supplies N parameters, but prepared
    // statement requires M" error) rather than into `dry_run`.
    wireHappyPathMocks();
    const captured: { sql: string; params: unknown[] }[] = [];

    await runSoundnessFuzz(fakePool('placement-check-run-id', captured), {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
      dryRun: true,
    });

    const { sql } = captured[0]!;
    const columnList = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')'));
    const columns = columnList.split(',').map((c) => c.trim());
    const valuesClause = sql.slice(sql.indexOf('values'));
    const placeholders = valuesClause.match(/\$\d+/g) ?? [];

    expect(columns).toHaveLength(12);
    expect(columns[11]).toBe('dry_run');
    expect(placeholders).toHaveLength(12);
    expect(placeholders[11]).toBe('$12');
  });
});
