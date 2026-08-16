/**
 * `runSoundnessFuzz`'s three generator-bug throw sites (full-repo audit
 * finding #12, MEDIUM, 2026-08-16) — each now throws `SoundnessFixtureError`
 * (`src/soundness/runner.ts`), never a plain `Error`, so `src/cli/commands/
 * soundness.ts`'s own `catch` block can route a broken *fixture* to exit
 * code 2 ("insufficient fuzz coverage or a schema/tuple validation
 * failure", per build spec §7) instead of exit code 3 ("infrastructure
 * failure") — see that file's own top-of-file doc comment and
 * `docs/DECISIONS.md` for the full split, and `test/unit/cli/soundness.test
 * .ts`'s own "finding #12" describe block for the CLI-level half of this
 * same proof. The three sites, in the order `runSoundnessFuzz`'s own body
 * reaches them:
 *
 *   1. the generated schema fails to compile (`compileSchema(...).ok ===
 *      false`)
 *   2. the generated schema fails to publish (`publishSchema(...).ok ===
 *      false`)
 *   3. a generated tuple is rejected on write (`writeTuple(...).ok ===
 *      false`)
 *
 * Deliberately DB-free, following `runner-dry-run-cleanup-failure.test.ts`'s
 * own established pattern: `publishSchema`/`writeTuple` are mocked via
 * `vi.spyOn` on their own module namespace; `generateFixture` and
 * `compileSchema` are left real and unmocked wherever possible, since both
 * are pure, deterministic, and fast, and using the real fixture generator
 * (rather than a hand-built fake) exercises `runSoundnessFuzz`'s actual
 * fixture-shaped control flow for the publish/write cases. The one
 * exception is the schema-compile-failure case: forcing a *real* compile
 * failure out of the real generator would mean fighting its own
 * "guaranteed to compile by construction" design (see `generators.ts`'s own
 * top-of-file doc comment and its own internal self-check, which throws a
 * *plain* `Error` — a generator sizing/construction bug, not a
 * `SoundnessFixtureError` — if its construction logic ever produced an
 * uncompilable schema). So that one case instead mocks `generateFixture`
 * itself (`src/soundness/generators.js`) to return a fixture whose
 * `schemaSource` is deliberately invalid DSL text — the empty string, which
 * `src/schema/dsl/parser.ts` rejects with `empty_source` (the same fixture
 * `test/unit/api/errors.test.ts` uses as its own `SchemaError` example) —
 * bypassing the real generator's own internal compile self-check entirely
 * (that self-check only runs inside the real, unmocked `generateFixture`,
 * which this one case never calls).
 *
 * Each case asserts `.rejects.toThrow(SoundnessFixtureError)` — vitest's
 * class-argument form of `toThrow`, which checks `instanceof`, not just a
 * message substring — so a regression that reverted one of these three
 * throw sites back to a plain `Error` would fail this test even if the
 * rejection's message text stayed identical.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { runSoundnessFuzz, SoundnessFixtureError } from '../../../src/soundness/runner.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import type { GeneratedFixture } from '../../../src/soundness/generators.js';
import * as generatorsModule from '../../../src/soundness/generators.js';
import * as publishModule from '../../../src/schema/publish.js';
import * as tuplesModule from '../../../src/store/tuples.js';

const SEED = 'runner-fixture-error-fixed-seed';
const QUERY_COUNT = 5;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A fake `Pool` whose `query` throws if ever called. Every scenario in this
 * file throws before `runSoundnessFuzz` reaches its first real `pool.query`
 * call (the `soundness_runs` insert, which only happens after schema
 * compile/publish and every tuple write already succeeded) — so a real
 * query here would mean the throw site under test did not actually fire
 * where this file claims it did.
 */
function poolThatMustNeverBeQueried(): Pool {
  return {
    query: vi.fn(async () => {
      throw new Error('poolThatMustNeverBeQueried: pool.query was called unexpectedly');
    }),
  } as unknown as Pool;
}

describe('runSoundnessFuzz throws SoundnessFixtureError, never a plain Error, for each of its three generator-bug throw sites', () => {
  it('a-schema-publish-rejection-throws-soundnessfixtureerror', async () => {
    vi.spyOn(publishModule, 'publishSchema').mockResolvedValue({
      ok: false,
      errors: ['line 4: namespace `document` is declared twice'],
    });

    const pool = poolThatMustNeverBeQueried();

    await expect(
      runSoundnessFuzz(pool, { seed: SEED, queryCount: QUERY_COUNT, trigger: 'cli' }),
    ).rejects.toThrow(SoundnessFixtureError);
  });

  it('a-tuple-write-rejection-throws-soundnessfixtureerror', async () => {
    const fixture = generateFixture(SEED, QUERY_COUNT);
    // Guard against a future generator change that stops producing tuples
    // for this seed — the assertions below depend on `writeTuple` actually
    // being reached at least once.
    expect(fixture.tuples.length).toBeGreaterThan(0);

    vi.spyOn(publishModule, 'publishSchema').mockResolvedValue({
      ok: true,
      published: fixture.namespaces.map((n) => ({ namespace: n.namespace, version: 1 })),
    });
    vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue({
      ok: false,
      errors: [{ code: 'invalid_identifier', message: 'object id is malformed' }],
    });

    const pool = poolThatMustNeverBeQueried();

    await expect(
      runSoundnessFuzz(pool, { seed: SEED, queryCount: QUERY_COUNT, trigger: 'cli' }),
    ).rejects.toThrow(SoundnessFixtureError);
  });

  it('a-schema-that-fails-to-compile-throws-soundnessfixtureerror', async () => {
    const brokenFixture: GeneratedFixture = {
      seed: SEED,
      // Deliberately invalid DSL text — `src/schema/dsl/parser.ts` rejects
      // an empty source with `empty_source`, guaranteeing `compileSchema`
      // fails inside `runSoundnessFuzz` before publish/write are ever
      // reached.
      schemaSource: '',
      namespaces: [],
      tuples: [],
      queries: [],
      coverage: {
        rewriteRuleKinds: {
          union: false,
          intersection: false,
          exclusion: false,
          tupleToUserset: false,
        },
        hasCycle: false,
        ok: false,
      },
    };
    vi.spyOn(generatorsModule, 'generateFixture').mockReturnValue(brokenFixture);
    const publishSpy = vi.spyOn(publishModule, 'publishSchema');
    const writeSpy = vi.spyOn(tuplesModule, 'writeTuple');

    const pool = poolThatMustNeverBeQueried();

    await expect(
      runSoundnessFuzz(pool, { seed: SEED, queryCount: QUERY_COUNT, trigger: 'cli' }),
    ).rejects.toThrow(SoundnessFixtureError);

    // The compile check runs first — publish/write must never be reached
    // for this scenario at all.
    expect(publishSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('none of the three fixture-error scenarios ever produces a SoundnessRunResult', () => {
  it('a-rejected-runsoundnessfuzz-call-never-resolves-with-a-result-object-it-only-ever-rejects', async () => {
    vi.spyOn(publishModule, 'publishSchema').mockResolvedValue({
      ok: false,
      errors: ['a publish failure'],
    });
    const pool = poolThatMustNeverBeQueried();

    let resolvedValue: unknown = 'never assigned';
    let rejectedValue: unknown;
    try {
      resolvedValue = await runSoundnessFuzz(pool, {
        seed: SEED,
        queryCount: QUERY_COUNT,
        trigger: 'cli',
      });
    } catch (err) {
      rejectedValue = err;
    }

    expect(resolvedValue).toBe('never assigned');
    expect(rejectedValue).toBeInstanceOf(SoundnessFixtureError);
  });
});
