/**
 * `runSoundnessFuzz`'s *outer* `catch` block (`src/soundness/runner.ts`,
 * the one wrapping the whole `try` body, not the inner one immediately
 * before its own `return result` on the success path) — full-repo audit
 * finding #5, MEDIUM: a dry run (`dryRun: true`) whose real fuzz cycle
 * genuinely fails (a `SoundnessFixtureError`, or any other real thrown
 * error) must reach its caller as that exact original error, never as the
 * best-effort cleanup attempt's own `AggregateError`, even when that
 * cleanup attempt *also* fails while handling it.
 *
 * This is the sibling gap to the one `runner-dry-run-cleanup-failure.test
 * .ts` already closes for the *success* path (D-066: a cleanup failure
 * after a real, computed result must never discard that result). Neither
 * existing file in this directory actually reaches the scenario this file
 * is about:
 *
 *   - `runner-fixture-error.test.ts` forces each of the three
 *     generator-bug throw sites (D-075) but never passes `dryRun: true` —
 *     `cleanupIfDryRun()` is a same-tick no-op in every one of its cases,
 *     so this file's own outer `catch` never does any real cleanup work,
 *     let alone a *failing* one.
 *   - `runner-dry-run-cleanup-failure.test.ts` sets `dryRun: true` and
 *     forces `deleteTuple` to reject, but only ever on the *success*
 *     path (every other mock is wired to succeed) — the run itself never
 *     throws, so the outer `catch` this file is about is never reached
 *     either.
 *
 * So today, nothing in this repo proves the outer `catch`'s own contract
 * (see its top-of-file doc comment: "A failure here must never replace
 * `err`") against a *genuine* simultaneous failure on both sides — the
 * exact shape a future refactor collapsing the two nested
 * `try`/`cleanupIfDryRun()`/`catch` blocks into one `finally`, or
 * swapping which error gets rethrown, would break silently, with nothing
 * in CI to catch it.
 *
 * Deliberately DB-free, following the same established `vi.spyOn`
 * module-namespace-mock pattern both sibling files above already use:
 * `publishSchema` is mocked to succeed (so `publishedForCleanup` is
 * genuinely populated — this run gets as far as it realistically can
 * before failing), `writeTuple` is mocked to reject its very first call
 * (the same "a tuple write rejection is a generator bug" throw site
 * `runner-fixture-error.test.ts` already proves throws
 * `SoundnessFixtureError`, reused here rather than inventing a new one),
 * and `deleteTuple` — the cleanup call this reaches, since the failure
 * happens mid-tuple-write-loop, before the `soundness_runs` insert ever
 * runs — is mocked to reject on every call, forcing
 * `cleanupDryRunArtifacts` itself to fail with a real `AggregateError`.
 * `generateFixture`/`compileSchema` stay real and unmocked, matching both
 * sibling files' own stated reasoning: both are pure, deterministic, and
 * fast.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { runSoundnessFuzz, SoundnessFixtureError } from '../../../src/soundness/runner.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import * as publishModule from '../../../src/schema/publish.js';
import * as tuplesModule from '../../../src/store/tuples.js';

const SEED = 'runner-catch-cleanup-failure-fixed-seed';
const QUERY_COUNT = 5;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A fake `Pool` whose `query` throws if ever called. This scenario forces
 * its failure inside the tuple-write loop, strictly before the
 * `soundness_runs` insert (the only direct `pool.query` call
 * `runSoundnessFuzz` itself makes) — and the one `pool.query` call
 * `cleanupDryRunArtifacts` could otherwise make (the `soundness_runs`
 * delete) is itself gated on `artifacts.runId !== undefined`, which is
 * never true here, since that id is only ever assigned *after* the insert
 * this scenario never reaches. A real query landing on this pool would
 * mean either assumption broke.
 */
function poolThatMustNeverBeQueried(): Pool {
  return {
    query: vi.fn(async () => {
      throw new Error('poolThatMustNeverBeQueried: pool.query was called unexpectedly');
    }),
  } as unknown as Pool;
}

describe('runSoundnessFuzz: a real run failure survives a simultaneous dry-run cleanup failure', () => {
  it('a-dry-run-cleanup-failure-in-the-catch-block-never-replaces-the-genuine-run-failure-it-happened-while-handling', async () => {
    const fixture = generateFixture(SEED, QUERY_COUNT);
    // Guard against a future generator change that stops producing tuples
    // for this seed — the scenario below depends on `writeTuple` actually
    // being reached (and rejected) at least once.
    expect(fixture.tuples.length).toBeGreaterThan(0);

    vi.spyOn(publishModule, 'publishSchema').mockResolvedValue({
      ok: true,
      published: fixture.namespaces.map((n) => ({ namespace: n.namespace, version: 1 })),
    });
    vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue({
      ok: false,
      errors: [{ code: 'invalid_identifier', message: 'object id is malformed' }],
    });
    const deleteTupleSpy = vi
      .spyOn(tuplesModule, 'deleteTuple')
      .mockRejectedValue(new Error('simulated delete failure during catch-block cleanup'));
    const deleteNamespaceSpy = vi
      .spyOn(publishModule, 'deletePublishedNamespaceVersion')
      .mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const pool = poolThatMustNeverBeQueried();

    let resolvedValue: unknown = 'never assigned';
    let rejectedValue: unknown;
    try {
      resolvedValue = await runSoundnessFuzz(pool, {
        seed: SEED,
        queryCount: QUERY_COUNT,
        trigger: 'cli',
        dryRun: true,
      });
    } catch (err) {
      rejectedValue = err;
    }

    // The genuine run failure — never discarded, never resolved past,
    // and never replaced by the cleanup failure that happened while this
    // function was handling it.
    expect(resolvedValue).toBe('never assigned');
    expect(rejectedValue).toBeInstanceOf(SoundnessFixtureError);
    expect(rejectedValue).not.toBeInstanceOf(AggregateError);
    expect((rejectedValue as Error).message).toContain('failed to write a generated tuple');

    // Cleanup really was attempted here — not skipped just because the
    // run itself already failed — and really did fail, for real, via the
    // exact mocked rejection this test forced.
    expect(deleteTupleSpy).toHaveBeenCalled();
    expect(deleteNamespaceSpy).toHaveBeenCalled();

    // The cleanup failure is disclosed, not silently swallowed: logged via
    // `console.error`, exactly like the symmetric success-path cleanup
    // failure case (`runner-dry-run-cleanup-failure.test.ts`) already does
    // for its own, different, catch block.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [message, cleanupErr] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain('cleanup failed while handling an earlier error');
    expect(String(message)).toContain(SEED);
    expect(cleanupErr).toBeInstanceOf(AggregateError);
  });
});
