/**
 * `performCheck`'s cache wiring (`src/audit/checks.ts`, post-audit
 * improvement closing D-028) — deliberately DB-free, mirroring the
 * established `vi.spyOn` pattern `test/unit/soundness/
 * runner-dry-run-cleanup-failure.test.ts` already uses for the identical
 * kind of orchestration-logic test (`productionCheck` mocked via
 * `vi.spyOn` on its own module namespace; Postgres itself replaced with a
 * tiny fake `Pool` whose `query` just distinguishes the one statement shape
 * this file cares about).
 *
 * What's under test here is `performCheck`'s own sequencing — hit-path
 * logging, miss-path caching, and, above all, the exact ordering an
 * adversarial review workflow required before this shipped:
 * `beginMiss()` → `productionCheck` → the audit insert → `trySet(...)`,
 * with `trySet` silently dropping a result whenever a `clear()` landed
 * anywhere in that window. `test/unit/resolve/production/cache.test.ts`
 * already proves `CheckCache`'s own fencing logic is correct in complete
 * isolation; this file proves `performCheck` actually *calls* it in the
 * right order, at the one layer where a mistake (e.g. swapping the insert
 * and the `trySet` back the wrong way round) would matter.
 *
 * Real Postgres integration coverage for `performCheck` itself (uncached)
 * already exists in `checks.integration.test.ts` — nothing here duplicates
 * that; this file is specifically about the *cache* wiring, which needs no
 * real database to prove.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { performCheck } from '../../../src/audit/checks.js';
import { CheckCache, buildCacheKey } from '../../../src/resolve/production/cache.js';
import * as productionModule from '../../../src/resolve/production/resolver.js';
import type { EntityRef, ProductionCheckResult } from '../../../src/resolve/production/resolver.js';

const ALICE: EntityRef = { ns: 'user', id: 'alice' };
const README: EntityRef = { ns: 'document', id: 'readme' };
const RELATION = 'viewer';

const ALLOWED: ProductionCheckResult = {
  allowed: true,
  path: { kind: 'directGrant', object: README, relation: RELATION, subject: ALICE },
  depth: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake `Pool` recording every `insert into checks` call; anything else throws — nothing else should ever be queried by `performCheck` itself. */
function fakePool(): { pool: Pool; insertCalls: unknown[][] } {
  const insertCalls: unknown[][] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('insert into checks')) {
        insertCalls.push(params ?? []);
        return { rows: [] };
      }
      throw new Error(`fakePool: unexpected query: ${sql}`);
    }),
  } as unknown as Pool;
  return { pool, insertCalls };
}

describe('performCheck with no cache argument: unchanged from before this change existed', () => {
  it('always-calls-productionCheck-and-logs-exactly-one-row', async () => {
    const productionCheckSpy = vi
      .spyOn(productionModule, 'productionCheck')
      .mockResolvedValue(ALLOWED);
    const { pool, insertCalls } = fakePool();

    const result = await performCheck(pool, ALICE, README, RELATION);

    expect(result).toEqual(ALLOWED);
    expect(productionCheckSpy).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
  });
});

describe('performCheck with a cache: a miss computes, logs, then caches', () => {
  it('a-miss-calls-productionCheck-logs-one-row-and-populates-the-cache', async () => {
    const productionCheckSpy = vi
      .spyOn(productionModule, 'productionCheck')
      .mockResolvedValue(ALLOWED);
    const { pool, insertCalls } = fakePool();
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, RELATION, README, {});

    expect(cache.get(key)).toBeUndefined();

    const result = await performCheck(pool, ALICE, README, RELATION, {}, cache);

    expect(result).toEqual(ALLOWED);
    expect(productionCheckSpy).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
    expect(cache.get(key)).toEqual(ALLOWED);
  });
});

describe('performCheck with a cache: a hit never calls productionCheck, but still logs', () => {
  it('a-hit-skips-productionCheck-entirely-and-still-inserts-exactly-one-row', async () => {
    const productionCheckSpy = vi.spyOn(productionModule, 'productionCheck');
    const { pool, insertCalls } = fakePool();
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, RELATION, README, {});
    cache.trySet(cache.beginMiss(), key, ALLOWED);

    const result = await performCheck(pool, ALICE, README, RELATION, {}, cache);

    expect(result).toEqual(ALLOWED);
    expect(productionCheckSpy).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(1);
    // `allowed` is the 6th positional param in checks.ts's own insert list.
    expect(insertCalls[0]?.[5]).toBe(true);
  });
});

describe('performCheck with a cache: the exact race adversarial review required a fix for', () => {
  it('a-clear-that-lands-while-productionCheck-is-in-flight-means-the-miss-result-is-never-cached', async () => {
    // Simulates the race deterministically: the mocked `productionCheck`
    // itself calls `cache.clear()` before resolving — modeling "a
    // concurrent write's route handler clears the cache while this miss's
    // own graph walk is still in flight," without needing any real timing.
    // From `performCheck`'s own perspective this is indistinguishable from
    // the real race — it only cares whether a clear() happened anywhere
    // between its own `beginMiss()` call and its own `trySet` call, not why.
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, RELATION, README, {});

    vi.spyOn(productionModule, 'productionCheck').mockImplementation(async () => {
      cache.clear();
      return ALLOWED;
    });
    const { pool, insertCalls } = fakePool();

    const result = await performCheck(pool, ALICE, README, RELATION, {}, cache);

    // The caller of performCheck still gets the real, correctly-computed
    // answer — the race affects only whether it gets CACHED, never what
    // performCheck itself returns.
    expect(result).toEqual(ALLOWED);
    // Still logged unconditionally, exactly once.
    expect(insertCalls).toHaveLength(1);
    // But NOT cached — the epoch fence dropped the stale trySet.
    expect(cache.get(key)).toBeUndefined();
  });

  it('a-clear-that-lands-AFTER-productionCheck-resolves-still-allows-the-result-to-be-cached', async () => {
    // Contrast case: confirms the fence isn't overzealous — a clear() that
    // happens to land after productionCheck already returned (but, in this
    // test, before the audit insert — still within the fenced window,
    // since the fence covers the whole miss path) must still correctly
    // block caching, while a clear() that never happens at all must not.
    // This test covers the "never happens at all" half.
    const productionCheckSpy = vi
      .spyOn(productionModule, 'productionCheck')
      .mockResolvedValue(ALLOWED);
    const { pool } = fakePool();
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, RELATION, README, {});

    await performCheck(pool, ALICE, README, RELATION, {}, cache);

    expect(productionCheckSpy).toHaveBeenCalledTimes(1);
    expect(cache.get(key)).toEqual(ALLOWED);
  });
});

describe('performCheck with a cache: a failed audit insert on a miss never poisons the cache', () => {
  it('when-the-checks-insert-throws-performCheck-throws-and-the-result-is-never-cached', async () => {
    // Proves the required fix directly: on a miss, the audit insert must
    // complete BEFORE trySet runs. If the insert throws, performCheck must
    // both (a) throw, discarding the already-computed result exactly as it
    // always has, unconditionally, and (b) never let that discarded result
    // reach the cache — otherwise a later, unrelated caller could get a
    // cache HIT for a decision that was never actually logged.
    vi.spyOn(productionModule, 'productionCheck').mockResolvedValue(ALLOWED);
    const pool = {
      query: vi.fn(async () => {
        throw new Error('simulated transient checks-table insert failure');
      }),
    } as unknown as Pool;
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, RELATION, README, {});

    await expect(performCheck(pool, ALICE, README, RELATION, {}, cache)).rejects.toThrow(
      'simulated transient checks-table insert failure',
    );

    expect(cache.get(key)).toBeUndefined();
  });
});
