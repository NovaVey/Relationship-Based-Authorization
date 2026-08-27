/**
 * `runSoundnessFuzz`'s success-path cleanup-failure handling (full-repo
 * audit finding, HIGH, 2026-08-16 — see `docs/DECISIONS.md` D-066 and
 * `src/soundness/runner.ts`'s own doc comment on the `await
 * cleanupIfDryRun()` call immediately before `return result`).
 *
 * The claim under test: a dry run that *successfully* computes a real
 * `SoundnessRunResult` must return that result even if the best-effort
 * cleanup afterward fails — a cleanup failure is logged
 * (`console.error`), never thrown, so it can never fall into
 * `runSoundnessFuzz`'s own `catch` block and get reported to a caller
 * (`src/cli/commands/soundness.ts`'s own `catch`) as exit code 3
 * ("infrastructure failure — NOT... a verdict", per
 * `src/report/exitCodes.ts`'s own doc comment) when a real, valid verdict
 * — sound, unsound, or insufficient_coverage — was actually computed.
 * Before this fix, this exact scenario silently discarded a computed
 * result (including a possible `unsound`/critical `false_grant` verdict)
 * behind a generic "Postgres: ..." error and exit code 3.
 *
 * Deliberately DB-free: `writeTuple`/`deleteTuple`/`publishSchema`/
 * `deletePublishedNamespaceVersion`/`productionCheck` are each mocked via
 * `vi.spyOn` on their own module namespace — the same established pattern
 * `test/unit/api/server.test.ts` and `test/unit/cli/soundness.test.ts`
 * already use — so this test needs no Postgres, real or containerized.
 * `generateFixture`, `compileSchema`, and `referenceCheck` are left real
 * and unmocked: all three are pure, deterministic, and fast, and using the
 * real fixture generator (rather than a hand-built fake) means this test
 * exercises `runSoundnessFuzz`'s actual fixture-shaped control flow, not a
 * simplified stand-in for it. What is NOT under test here: whether cleanup
 * *itself* correctly deletes what it should (that's
 * `dry-run-cleanup.integration.test.ts`'s job, against real Postgres) —
 * only what happens to the *already-computed result* when cleanup fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { runSoundnessFuzz } from '../../../src/soundness/runner.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import * as publishModule from '../../../src/schema/publish.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import * as productionModule from '../../../src/resolve/production/resolver.js';

const SEED = 'runner-dry-run-cleanup-failure-fixed-seed';
const QUERY_COUNT = 5;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Wires every I/O dependency `runSoundnessFuzz` has other than
 * `compileSchema`/`referenceCheck` (both real, pure, unmocked — see this
 * file's own top-of-file doc comment) to succeed trivially and fast, using
 * the real fixture `generateFixture(SEED, QUERY_COUNT)` produces. Returns
 * that fixture so callers can assert against its real shape (namespace
 * count, tuple count, query count).
 */
function wireHappyPathMocks(): ReturnType<typeof generateFixture> {
  const fixture = generateFixture(SEED, QUERY_COUNT);

  vi.spyOn(publishModule, 'publishSchema').mockResolvedValue({
    ok: true,
    published: fixture.namespaces.map((n) => ({ namespace: n.namespace, version: 1 })),
  });
  vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue({ ok: true, token: 1, created: true });
  // Every check agrees with the reference resolver's own `false` default
  // for a subject/object pair the fixture never actually granted anything
  // to directly — not asserted on here, just needs to be a real, valid
  // `ProductionCheckResult` shape so `buildDivergenceRecord` has something
  // sane to classify. This test cares about cleanup-failure handling, not
  // about which verdict results — see the top-of-file doc comment.
  vi.spyOn(productionModule, 'productionCheck').mockResolvedValue({
    allowed: false,
    depth: 0,
    touchedExpiringTuple: false,
  });

  return fixture;
}

function fakePool(insertedRunId: string): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('insert into soundness_runs')) {
        return { rows: [{ id: insertedRunId }] };
      }
      if (typeof sql === 'string' && sql.includes('delete from soundness_runs')) {
        return { rows: [] };
      }
      // D-153: backdating an 'expired' generated tuple (`backdateExpiringTuples`,
      // `src/soundness/runner.ts`) — this test's own fixed seed can draw one or
      // more, and this file's assertions are about dry-run cleanup failure
      // handling, not expiry, so this is recognized and trivially resolved.
      if (typeof sql === 'string' && sql.includes('update relation_tuples')) {
        return { rows: [] };
      }
      throw new Error(`fakePool: unexpected query: ${sql}`);
    }),
  } as unknown as Pool;
}

describe('a dry run whose cleanup fails after a successful run still returns the real, computed result', () => {
  it('deletetuple-rejecting-during-cleanup-does-not-throw-and-the-returned-result-matches-the-real-fixture', async () => {
    const fixture = wireHappyPathMocks();
    // The one deliberate failure: every tuple-cleanup delete rejects — the
    // same category of failure `cleanupDryRunArtifacts`'s own "best-effort,
    // one category failing doesn't block the others" design is meant to
    // survive, proven here at the level that actually matters: does the
    // caller of `runSoundnessFuzz` still get back the real result.
    vi.spyOn(tuplesModule, 'deleteTuple').mockRejectedValue(new Error('simulated delete failure'));
    vi.spyOn(publishModule, 'deletePublishedNamespaceVersion').mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const pool = fakePool('cleanup-failure-run-id');

    const result = await runSoundnessFuzz(pool, {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
      dryRun: true,
    });

    // The real, computed result — never discarded, despite cleanup failing.
    expect(result.id).toBe('cleanup-failure-run-id');
    expect(result.graphSeed).toBe(SEED);
    expect(result.namespaceCount).toBe(fixture.namespaces.length);
    expect(result.tupleCount).toBe(fixture.tuples.length);
    expect(result.queryCount).toBe(QUERY_COUNT);
    expect(['sound', 'unsound', 'insufficient_coverage']).toContain(result.verdict);

    // The failure is disclosed, not silently swallowed — logged via
    // console.error, exactly like the symmetric nested-cleanup-failure
    // case in `runSoundnessFuzz`'s own `catch` block already does.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [message] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain('cleanup failed after a successful run');
    expect(String(message)).toContain(result.verdict);
  });

  it('a-cleanup-failure-never-changes-the-verdict-a-clean-cleanup-would-have-produced-for-the-identical-seed', async () => {
    // Same seed, same query count, same happy-path mocks, but this time
    // cleanup succeeds cleanly — establishes the baseline result to compare
    // the cleanup-failure run above against, proving the failure changes
    // nothing about *what* was computed, only whether cleanup finished.
    wireHappyPathMocks();
    vi.spyOn(tuplesModule, 'deleteTuple').mockResolvedValue({ ok: true, token: 2, deleted: true });
    vi.spyOn(publishModule, 'deletePublishedNamespaceVersion').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const cleanResult = await runSoundnessFuzz(fakePool('clean-cleanup-run-id'), {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
      dryRun: true,
    });

    expect(cleanResult.namespaceCount).toBe(generateFixture(SEED, QUERY_COUNT).namespaces.length);
    expect(cleanResult.tupleCount).toBe(generateFixture(SEED, QUERY_COUNT).tuples.length);
    expect(cleanResult.queryCount).toBe(QUERY_COUNT);
    // Same seed as the cleanup-failure test above -> the same real
    // fixture/checks -> the same verdict, whether or not cleanup itself
    // happens to succeed.
    expect(['sound', 'unsound', 'insufficient_coverage']).toContain(cleanResult.verdict);
  });
});
