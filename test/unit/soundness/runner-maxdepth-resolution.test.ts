/**
 * D-071 (`docs/DECISIONS.md`) — `runSoundnessFuzz` resolves one effective
 * `maxDepth` (`options.maxDepth ?? env.CHECK_MAX_DEPTH`) and passes it
 * explicitly to *both* resolvers, on every query, never letting either one
 * silently fall back to its own independently-defaulted ceiling
 * (`productionCheck`'s own default is `env.CHECK_MAX_DEPTH`;
 * `referenceCheck`'s own default is the much larger, independent
 * `DEFAULT_REFERENCE_MAX_DEPTH`). D-070 proved that exact mismatch made an
 * entire class of real `false_grant` bugs (D-069 bug 1's own shape)
 * structurally undetectable by the standard-configuration fuzz run.
 *
 * Deliberately DB-free, mirroring `runner-dry-run-cleanup-failure.test.ts`'s
 * own established pattern: `publishSchema`/`writeTuple`/`productionCheck`
 * are mocked via `vi.spyOn` on their own module namespace; `generateFixture`
 * and `referenceCheck` are left real (both pure, deterministic, fast — no
 * value in faking either), and `referenceCheck` is *also* spied on (via
 * `vi.spyOn(..., 'referenceCheck')` with `mockImplementation` delegating to
 * the real function) purely to capture the `options` object it was actually
 * called with, without changing its real behavior at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { runSoundnessFuzz } from '../../../src/soundness/runner.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import { env } from '../../../src/config/env.js';
import * as publishModule from '../../../src/schema/publish.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import * as productionModule from '../../../src/resolve/production/resolver.js';
import * as referenceModule from '../../../src/resolve/reference/resolver.js';

const SEED = 'runner-maxdepth-resolution-fixed-seed';
const QUERY_COUNT = 8;

afterEach(() => {
  vi.restoreAllMocks();
});

// Captured before any `vi.spyOn` touches this module's export binding — the
// spy below replaces `referenceModule.referenceCheck` itself, so delegating
// to *that* name from inside the spy's own implementation would recurse
// into the spy forever rather than reach the real function.
const realReferenceCheck = referenceModule.referenceCheck;

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
  vi.spyOn(referenceModule, 'referenceCheck').mockImplementation(
    // Delegate to the real, pre-captured implementation — this spy exists
    // only to observe call arguments, never to change behavior.
    (...args: Parameters<typeof referenceModule.referenceCheck>) => realReferenceCheck(...args),
  );

  return fixture;
}

function fakePool(): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('insert into soundness_runs')) {
        return { rows: [{ id: 'maxdepth-resolution-run-id' }] };
      }
      throw new Error(`fakePool: unexpected query: ${sql}`);
    }),
  } as unknown as Pool;
}

describe('runSoundnessFuzz resolves one effective maxDepth and passes it explicitly to both resolvers (D-071)', () => {
  it('options.maxDepth omitted: both productionCheck and referenceCheck are called with { maxDepth: env.CHECK_MAX_DEPTH } on every single query', async () => {
    const fixture = wireHappyPathMocks();
    const productionSpy = vi.mocked(productionModule.productionCheck);
    const referenceSpy = vi.mocked(referenceModule.referenceCheck);

    await runSoundnessFuzz(fakePool(), {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
    });

    expect(productionSpy).toHaveBeenCalledTimes(fixture.queries.length);
    expect(referenceSpy).toHaveBeenCalledTimes(fixture.queries.length);

    for (const call of productionSpy.mock.calls) {
      const options = call[4];
      expect(options).toEqual({ maxDepth: env.CHECK_MAX_DEPTH });
    }
    for (const call of referenceSpy.mock.calls) {
      const options = call[5];
      expect(options).toEqual({ maxDepth: env.CHECK_MAX_DEPTH });
    }
  });

  it('options.maxDepth explicitly set: both resolvers are called with that exact value uniformly, overriding env.CHECK_MAX_DEPTH — the pre-existing override contract is unchanged', async () => {
    const explicitMaxDepth = 7;
    expect(explicitMaxDepth).not.toBe(env.CHECK_MAX_DEPTH); // the test would prove nothing if these coincided

    const fixture = wireHappyPathMocks();
    const productionSpy = vi.mocked(productionModule.productionCheck);
    const referenceSpy = vi.mocked(referenceModule.referenceCheck);

    await runSoundnessFuzz(fakePool(), {
      seed: SEED,
      queryCount: QUERY_COUNT,
      trigger: 'cli',
      maxDepth: explicitMaxDepth,
    });

    expect(productionSpy).toHaveBeenCalledTimes(fixture.queries.length);
    expect(referenceSpy).toHaveBeenCalledTimes(fixture.queries.length);

    for (const call of productionSpy.mock.calls) {
      expect(call[4]).toEqual({ maxDepth: explicitMaxDepth });
    }
    for (const call of referenceSpy.mock.calls) {
      expect(call[5]).toEqual({ maxDepth: explicitMaxDepth });
    }
  });
});
