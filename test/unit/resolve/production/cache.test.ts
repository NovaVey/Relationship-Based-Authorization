/**
 * `src/resolve/production/cache.ts` — DB-free unit tests (this whole module
 * is in-memory, no Postgres involved). Two things this suite exists to
 * prove, both landmines an adversarial review workflow found before this
 * file shipped, not hypothetical concerns:
 *
 * 1. **The epoch fence actually closes the race it was built for** — a
 *    `trySet` call using an epoch captured *before* an intervening `clear()`
 *    must be silently dropped, never landing in the cache. This is proven
 *    fully deterministically here, with no real timing, no `setTimeout`, no
 *    Postgres: `beginMiss()`/`clear()`/`trySet()` are plain synchronous
 *    calls, so the exact interleaving adversarial review found (a write's
 *    `clear()` landing while a miss's own computation is still in flight)
 *    is reproduced by simply calling them in that order — no race to win,
 *    because nothing here is actually concurrent; the fencing logic itself
 *    is what's under test, independent of `performCheck`'s own real-world
 *    timing (see `test/unit/audit/checks.test.ts` for the integration-level
 *    proof that `performCheck` actually calls these in the right order).
 * 2. **`createCheckCache` really does refuse a non-positive TTL** —
 *    `toad-cache`'s own real behavior for `ttl <= 0` is "never expire," the
 *    opposite of "disabled" (confirmed by reading its installed source
 *    during the same adversarial review, not assumed from its types) —
 *    exactly the kind of library-semantics landmine that needs a pinned
 *    regression test, not just a doc comment.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCacheKey,
  createCheckCache,
  CheckCache,
} from '../../../../src/resolve/production/cache.js';
import type { ProductionCheckResult } from '../../../../src/resolve/production/resolver.js';

const ALICE = { ns: 'user', id: 'alice' };
const BOB = { ns: 'user', id: 'bob' };
const README = { ns: 'document', id: 'readme' };
const OTHER_DOC = { ns: 'document', id: 'other' };

const ALLOWED: ProductionCheckResult = {
  allowed: true,
  path: { kind: 'directGrant', object: README, relation: 'viewer', subject: ALICE },
  depth: 1,
  touchedExpiringTuple: false,
};
const DENIED: ProductionCheckResult = { allowed: false, depth: 0, touchedExpiringTuple: false };

describe('buildCacheKey', () => {
  it('the-same-inputs-produce-the-same-key', () => {
    const a = buildCacheKey(ALICE, 'viewer', README, {});
    const b = buildCacheKey(ALICE, 'viewer', README, {});
    expect(a).toBe(b);
  });

  it('a-different-subject-relation-or-object-produces-a-different-key', () => {
    const base = buildCacheKey(ALICE, 'viewer', README, {});
    expect(buildCacheKey(BOB, 'viewer', README, {})).not.toBe(base);
    expect(buildCacheKey(ALICE, 'editor', README, {})).not.toBe(base);
    expect(buildCacheKey(ALICE, 'viewer', OTHER_DOC, {})).not.toBe(base);
  });

  it('atToken-absent-and-atToken-0-produce-different-keys', () => {
    // The exact landmine adversarial review named: `atToken: 0` is a
    // structurally legal, `assertTokenObserved`-valid token (build spec's
    // own "non-negative integer" contract), not a stand-in for "absent". A
    // naive encoding (e.g. `JSON.stringify`, which silently drops
    // `undefined` object properties) could collapse the two.
    const unpinned = buildCacheKey(ALICE, 'viewer', README, {});
    const pinnedAtZero = buildCacheKey(ALICE, 'viewer', README, { atToken: 0 });
    expect(pinnedAtZero).not.toBe(unpinned);
  });

  it('different-atToken-values-produce-different-keys', () => {
    const t1 = buildCacheKey(ALICE, 'viewer', README, { atToken: 1 });
    const t2 = buildCacheKey(ALICE, 'viewer', README, { atToken: 2 });
    expect(t1).not.toBe(t2);
  });

  it('maxDepth-absent-and-an-explicit-maxDepth-equal-to-the-current-CHECK_MAX_DEPTH-default-produce-different-keys', () => {
    // Both resolve to byte-identical `productionCheck` behavior today
    // (`options?.maxDepth ?? env.CHECK_MAX_DEPTH`) — this is a deliberate,
    // accepted wasted-miss inefficiency (this file's own top-of-file doc
    // comment references it only indirectly; the real requirement is just
    // that the two must never collide and silently serve one for the
    // other), not a bug, but a naive key encoding could still collapse them
    // into the same string, which would be a real (if currently harmless)
    // correctness landmine for the moment either default ever changes.
    const implicitDefault = buildCacheKey(ALICE, 'viewer', README, {});
    const explicitSameAsDefault = buildCacheKey(ALICE, 'viewer', README, { maxDepth: 25 });
    expect(explicitSameAsDefault).not.toBe(implicitDefault);
  });

  it('different-maxDepth-values-produce-different-keys', () => {
    const d10 = buildCacheKey(ALICE, 'viewer', README, { maxDepth: 10 });
    const d20 = buildCacheKey(ALICE, 'viewer', README, { maxDepth: 20 });
    expect(d10).not.toBe(d20);
  });
});

describe('createCheckCache', () => {
  it('a-non-positive-ttl-returns-undefined-never-a-cache-that-caches-forever', () => {
    // toad-cache's own real ttl<=0 behavior is "never expire" — the exact
    // inverse of `CHECK_CACHE_TTL_MS=0`'s documented "disabled" default.
    // This must be structurally impossible to reach, not just documented.
    expect(createCheckCache(100, 0)).toBeUndefined();
    expect(createCheckCache(100, -1)).toBeUndefined();
  });

  it('a-positive-ttl-returns-a-real-usable-cache', () => {
    const cache = createCheckCache(100, 60_000);
    expect(cache).toBeInstanceOf(CheckCache);
  });
});

describe('CheckCache constructor', () => {
  it('throws-on-a-non-positive-ttl-when-constructed-directly-rather-than-via-createCheckCache', () => {
    expect(() => new CheckCache(100, 0)).toThrow(/ttlMs must be a positive/);
    expect(() => new CheckCache(100, -5)).toThrow(/ttlMs must be a positive/);
  });
});

describe('CheckCache: ordinary get/set round trip', () => {
  it('a-miss-followed-by-a-successful-trySet-is-then-a-hit', () => {
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, 'viewer', README, {});

    expect(cache.get(key)).toBeUndefined();

    const epoch = cache.beginMiss();
    cache.trySet(epoch, key, ALLOWED);

    expect(cache.get(key)).toEqual(ALLOWED);
  });

  it('clear-removes-every-entry', () => {
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, 'viewer', README, {});
    cache.trySet(cache.beginMiss(), key, ALLOWED);
    expect(cache.get(key)).toEqual(ALLOWED);

    cache.clear();

    expect(cache.get(key)).toBeUndefined();
  });
});

describe('CheckCache: the epoch fence — the exact race adversarial review found', () => {
  it('a-trySet-using-an-epoch-captured-before-an-intervening-clear-is-silently-dropped', () => {
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, 'viewer', README, {});

    // A miss begins — snapshotting the epoch *before* its own (here,
    // simulated) expensive computation starts, exactly as `performCheck`
    // does via `cache.beginMiss()` before calling `productionCheck`.
    const staleEpoch = cache.beginMiss();

    // While that miss's computation is still "in flight", a concurrent
    // write lands and its route handler correctly calls `clear()` — the
    // cache is now empty and correct.
    cache.clear();
    expect(cache.get(key)).toBeUndefined();

    // The original miss's computation *now* finishes and tries to cache
    // its — already stale — answer, using the epoch it captured before the
    // clear(). This must be dropped, not written.
    cache.trySet(staleEpoch, key, ALLOWED);

    expect(cache.get(key)).toBeUndefined();
  });

  it('a-fresh-trySet-after-the-same-clear-still-works-normally', () => {
    // Confirms the fence only blocks a *stale* epoch, not `trySet` in
    // general — a subsequent, ordinary miss (one that began *after* the
    // clear) must still be able to populate the cache.
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, 'viewer', README, {});

    cache.trySet(cache.beginMiss(), key, ALLOWED);
    cache.clear();

    const freshEpoch = cache.beginMiss();
    cache.trySet(freshEpoch, key, DENIED);

    expect(cache.get(key)).toEqual(DENIED);
  });

  it('the-fence-holds-across-multiple-intervening-clears-not-just-one', () => {
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, 'viewer', README, {});

    const staleEpoch = cache.beginMiss();
    cache.clear();
    cache.clear();
    cache.clear();

    cache.trySet(staleEpoch, key, ALLOWED);

    expect(cache.get(key)).toBeUndefined();
  });

  it('two-different-keys-each-get-their-own-independent-epoch-fence-outcome', () => {
    // The epoch is global to the cache instance (a single write can affect
    // any cached entry transitively — see cache.ts's own "whole-cache
    // clear" reasoning), so a clear() fences off EVERY in-flight miss, not
    // just the one for the key that actually changed. Confirm that's
    // genuinely true, not accidentally scoped per-key.
    const cache = new CheckCache(100, 60_000);
    const keyAlice = buildCacheKey(ALICE, 'viewer', README, {});
    const keyBob = buildCacheKey(BOB, 'viewer', OTHER_DOC, {});

    const epochAlice = cache.beginMiss();
    const epochBob = cache.beginMiss();
    cache.clear(); // one write, unrelated to either key, still fences both

    cache.trySet(epochAlice, keyAlice, ALLOWED);
    cache.trySet(epochBob, keyBob, DENIED);

    expect(cache.get(keyAlice)).toBeUndefined();
    expect(cache.get(keyBob)).toBeUndefined();
  });
});

describe('CheckCache: TTL is a real backstop for a positive value', () => {
  it('an-entry-outlives-a-ttl-set-generously-in-the-future', async () => {
    const cache = new CheckCache(100, 60_000);
    const key = buildCacheKey(ALICE, 'viewer', README, {});
    cache.trySet(cache.beginMiss(), key, ALLOWED);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.get(key)).toEqual(ALLOWED);
  });

  it('an-entry-expires-after-a-short-positive-ttl-elapses', async () => {
    const cache = new CheckCache(100, 10);
    const key = buildCacheKey(ALICE, 'viewer', README, {});
    cache.trySet(cache.beginMiss(), key, ALLOWED);
    expect(cache.get(key)).toEqual(ALLOWED);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(cache.get(key)).toBeUndefined();
  });
});
