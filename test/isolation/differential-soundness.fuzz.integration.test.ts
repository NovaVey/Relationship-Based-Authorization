/**
 * The literal §9 Phase 5 / §10 exit criterion, run for real: "0
 * `false_grant` across `SOUNDNESS_FUZZ_QUERIES` (default 5,000) random
 * queries; `false_deny` rate reported even at zero." This is the one test
 * in the differential-soundness suite that has to run the *real*
 * production engine (`src/resolve/production/resolver.ts`, real SQL)
 * against the *real* reference oracle (`src/resolve/reference/
 * resolver.ts`) and real Postgres for its result to mean anything — see
 * `.claude/commands/build-authz-service.md` §6.2, §9 Phase 5, §10's
 * "Soundness harness (Phase 5)" test list.
 *
 * Split out of `differential-soundness.fuzz.test.ts` specifically because
 * of that Postgres dependency: `vitest.config.ts`'s `exclude` only drops
 * `**\/*.integration.test.ts` from the fast `npm test` suite, and this
 * repo's own `.fuzz.test.ts` files are otherwise matched by it — so this
 * file gets the `.integration.test.ts` suffix and runs via `npm run
 * test:integration` instead, exactly like `test/unit/resolve/production/
 * cross-resolver-agreement.integration.test.ts`. Starts its own ephemeral
 * `PostgreSqlContainer` and applies this project's own migrations — never a
 * connection string hardcoded to one environment's local Postgres
 * (`docs/DECISIONS.md` D-019/D-030: that mistake has already broken CI
 * twice on this project).
 *
 * This test drives `runSoundnessFuzz` exactly the way `authz soundness
 * run` does in production (`src/cli/commands/soundness.ts`) — generate a
 * fixture, publish it, write every tuple for real, check every query
 * against both resolvers, classify, persist one `soundness_runs` row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { runSoundnessFuzz } from '../../src/soundness/runner.js';
import { runMigrations } from '../../src/store/migrate.js';

const MIGRATIONS_DIR = new URL('../../src/store/migrations', import.meta.url).pathname;

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

describe('differential fuzzing — production check engine vs. the naive reference resolver (real Postgres)', () => {
  it('across 5,000 random (schema, tuple graph, query) triples, the production engine and the reference resolver agree on every single query — zero false_grant, reported false_deny rate stated even at zero', async () => {
    const STANDARD_FUZZ_QUERIES = 5000;

    const start = performance.now();
    const result = await runSoundnessFuzz(pool, {
      seed: 'phase5-standard-budget-real-postgres-run',
      queryCount: STANDARD_FUZZ_QUERIES,
      trigger: 'ci',
    });
    const elapsedMs = performance.now() - start;

    // Reported for the record — the actual elapsed time for a real,
    // full-budget run, not asserted against beyond the test's own
    // timeout (a real Postgres round trip per query dominates this, not
    // anything CPU-bound).
    console.log(
      `[soundness fuzz, real Postgres] seed=${result.graphSeed} ` +
        `namespaces=${result.namespaceCount} tuples=${result.tupleCount} ` +
        `queries=${result.queryCount} elapsedMs=${elapsedMs.toFixed(0)}`,
    );

    expect(result.queryCount).toBe(STANDARD_FUZZ_QUERIES);

    // The single most load-bearing assertion in the whole repo (§6.2,
    // §6.5, docs/DECISIONS.md D-006): zero false_grant, on any
    // namespace, always — no threshold, no exception.
    expect(result.falseGrantCount).toBe(0);
    expect(result.criticalNamespaceFalseGrants).toBe(0);
    expect(result.divergences.filter((d) => d.kind === 'false_grant')).toHaveLength(0);
    expect(result.verdict).not.toBe('unsound');

    // "false_deny rate reported even at zero" (§9 Phase 5's own exit
    // wording) — a present, non-negative number, never an
    // absent/undefined field standing in for "we didn't bother counting."
    expect(typeof result.falseDenyCount).toBe('number');
    expect(result.falseDenyCount).toBeGreaterThanOrEqual(0);

    // Coverage must actually have been achieved for this run's verdict to
    // mean "sound" rather than "insufficient_coverage" — the real
    // exit-criterion reading of "0 false_grant" implicitly assumes the
    // run actually exercised the full rewrite-rule/cycle surface, not a
    // degenerate one that trivially had nothing to get wrong.
    expect(result.verdict).toBe('sound');
  }, 600_000);
});
