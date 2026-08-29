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
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { runSoundnessFuzz } from '../../src/soundness/runner.js';
import { runMigrations } from '../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract: without this, an idle client hitting a
    // background/network-level error (most commonly this file's own container
    // being stopped in afterAll while a pooled connection was still technically
    // open, though the identical gap applies to any Pool in this file) crashes
    // the whole test run with an unhandled 'error' event, even though every
    // real assertion already passed — a known pg gotcha, not a bug in this
    // file's own test logic. Logged, not swallowed: still visible if it ever
    // fires somewhere other than expected teardown.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
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

/**
 * The Leopard-index Phase A "third comparison arm," `relationIndex: 'cold'`
 * mode (`docs/LEOPARD-INDEX-PROPOSAL.md`, "Test plan — the third comparison
 * arm") — the always-on, PR-speed companion to the standard 5,000-query run
 * above, at the SAME query budget/seed-count scale.
 *
 * **Correction (2026-08-29, documentation audit):** this comment used to
 * claim the nightly "many-seeds" `relationIndex: 'warm'` scale was owned by
 * "a separate, dedicated file." No such file exists — it was planned in
 * `docs/LEOPARD-INDEX-PROPOSAL.md`'s test plan but never built; see that
 * doc's own correction to the same row. This `'cold'` block is, today, the
 * only `relationIndex` coverage this fuzz harness actually ships.
 *
 * **What `'cold'` proves, and why it has to be run for real, not just
 * reasoned about.** `'cold'` pins every `productionCheck` call this run
 * makes to a real `atToken` and passes `useRelationIndex: true` — but
 * `rebuildRelationMembershipIndex` is never called for this fixture, so
 * `relation_membership_index_state.watermark_token` cannot possibly have
 * reached this fixture's own post-write pin token (a freshly written
 * fixture's own anchor is always strictly newer than whatever a `watermark_
 * token` an unrelated, earlier rebuild — by this file or any other test
 * sharing the same database — might have left behind; `runner.ts`'s own
 * `SoundnessRunOptions.relationIndex` doc comment states this precisely:
 * "genuinely below `pinToken`... genuinely reached on every single call and
 * genuinely misses every single time"). This is the literal, executed proof
 * of `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "A deployment that never sets
 * `LEOPARD_INDEX_ENABLED=true` is provably unaffected... intended to be
 * executed as a real differential-fuzz comparison arm (`relationIndex:
 * 'cold'`), not just asserted in prose" — restated for the adjacent,
 * equally load-bearing case: a deployment that sets the flag on but has
 * never yet run a rebuild.
 *
 * **`indexQueriesHit === 0` is the one real, falsifiable assertion here** —
 * `runner.ts`'s own doc comment states the mirror-image reasoning bluntly:
 * "a nonzero count [for `'cold'`] would mean this arm is, contrary to its
 * whole premise, actually consulting real index state — a bug in this
 * harness, not in the index." `indexFalseGrantCount === 0` is asserted too,
 * exactly as this task's own instructions specify, even though it is
 * necessarily `0` by construction whenever `indexQueriesHit` is (`'cold'`
 * mode never populates `CheckedQuery.productionIndexAllowed` at all — see
 * `checkAllQueries`'s own doc comment — so `classifyIndexDivergence` is
 * never even invoked for a `'cold'` run) — asserted directly anyway, never
 * silently relied upon as "obviously true," matching this project's own
 * "assert the thing you actually need, even when it looks redundant"
 * discipline elsewhere (`docs/DECISIONS.md` D-140's own non-vacuity
 * counters).
 */
describe("Leopard index — the flag-on-but-never-rebuilt path is provably inert (relationIndex: 'cold', real Postgres, PR-speed budget)", () => {
  it("across the SAME standard 5,000-query budget this file's own PR-speed run above uses, enabling useRelationIndex without ever calling rebuildRelationMembershipIndex never actually consults real index state (indexQueriesHit === 0) and never produces an index_false_grant (indexFalseGrantCount === 0) — a deployment that flips LEOPARD_INDEX_ENABLED on but has not yet run a rebuild is provably unaffected", async () => {
    const STANDARD_FUZZ_QUERIES = 5000;

    const start = performance.now();
    const result = await runSoundnessFuzz(pool, {
      seed: 'phase5-leopard-cold-standard-budget-real-postgres-run',
      queryCount: STANDARD_FUZZ_QUERIES,
      trigger: 'ci',
      relationIndex: 'cold',
    });
    const elapsedMs = performance.now() - start;

    console.log(
      `[soundness fuzz, real Postgres, relationIndex=cold] seed=${result.graphSeed} ` +
        `namespaces=${result.namespaceCount} tuples=${result.tupleCount} ` +
        `queries=${result.queryCount} indexQueriesHit=${result.indexQueriesHit} ` +
        `indexFalseGrantCount=${result.indexFalseGrantCount} elapsedMs=${elapsedMs.toFixed(0)}`,
    );

    expect(result.queryCount).toBe(STANDARD_FUZZ_QUERIES);

    // *** The two assertions this describe block exists to make. ***
    expect(result.indexQueriesHit).toBe(0);
    expect(result.indexFalseGrantCount).toBe(0);

    // `runner.ts`'s own `computeVerdict` extension forces `verdict` to
    // `'unsound'` if `relationIndex === 'cold' && indexQueriesHit !== 0` —
    // asserted here too, as the end-to-end confirmation that a hidden
    // regression in that gate itself would still fail this test even if
    // the two raw counters above were somehow read incorrectly.
    expect(result.verdict).not.toBe('unsound');

    // This run's own reference-vs-production comparison (`classify.ts`,
    // untouched by `relationIndex`) must still hold too — `'cold'` changes
    // nothing about the base engine's own byte-identical behavior.
    expect(result.falseGrantCount).toBe(0);
    expect(result.criticalNamespaceFalseGrants).toBe(0);
    expect(result.verdict).toBe('sound');
  }, 600_000);
});
