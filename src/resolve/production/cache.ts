/**
 * The check-result cache — closes `docs/DECISIONS.md` D-028, which
 * deliberately left this file unbuilt until "the write-invalidation story
 * [is] designed and proven correct in the same change, not staged ahead of
 * it." `docs/CONSISTENCY.md`'s own "The cache" section states the one
 * non-negotiable rule this file exists to satisfy: "it must be invalidated
 * by the specific writes it depends on, immediately, never left to expire
 * on a timer alone" — and the one property it must never violate, project-
 * wide: "a check pinned to token T never returns a result that ignores a
 * write with token ≤ T."
 *
 * **Opt-in, off by default.** `env.CHECK_CACHE_TTL_MS` defaults to `0`;
 * `createCheckCache` below is the *only* supported way to construct one, and
 * it returns `undefined` for any non-positive TTL rather than trusting each
 * call site to independently re-derive that gate — see its own doc comment
 * for why that's structural, not a convention.
 *
 * **Isolation from the two check resolvers, and from `productionCheck`
 * itself, is deliberate.** Nothing here imports from or is imported by
 * `src/resolve/reference/resolver.ts` (D-022's isolation rule). This module
 * doesn't call `productionCheck` at all — it only ever stores and returns
 * results `src/audit/checks.ts`'s `performCheck` already computed by calling
 * `productionCheck` itself, exactly as it always has. Every existing caller
 * of `productionCheck` (the DST/differential-fuzz harness, the soundness
 * runner, every resolver-level test, the CLI) never touches this file at
 * all and is therefore, by construction, completely unaffected — satisfying
 * `docs/CONSISTENCY.md`'s own "every claim this project makes about
 * correctness ... is proven with the cache off."
 *
 * **Why caching a *pinned* result is safe forever, not just until the next
 * write (verified, not assumed — this exact argument was independently
 * adversarially reviewed and confirmed against `resolver.ts`'s real code
 * before this file was written).** `ProductionCheckOptions.atToken` is a
 * FLOOR, not an exact snapshot pin (`resolver.ts`'s own doc comment on
 * `assertTokenObservedOnSnapshot`): a result cached under a specific
 * `atToken = T` can only ever have been produced by a `productionCheck` call
 * that itself re-verified, as the literal first statement of its own
 * `REPEATABLE READ` transaction, that `write_log` had already observed `T`.
 * Reusing that result later never "ignores" a write with token ≤ T — the
 * call that computed it already saw everything up through T by the time it
 * ran. It may miss a *later* write with token > T, but the boxed guarantee
 * never requires a T-pinned check to see anything past T; an uncached,
 * freshly-run call pinned to the same T is equally not guaranteed to see
 * that later write either (`docs/CONSISTENCY.md`: "not 'the latest write,
 * always'"). So a pinned entry is provably valid for the rest of this
 * process's life, regardless of how many writes land after it was cached.
 *
 * **What is NOT provably safe forever, and how this file bounds it
 * instead: unpinned (`atToken` absent) results.** `docs/CONSISTENCY.md`:
 * "a check with no token is a plain read of whatever is currently
 * committed" — no freshness floor to lean on the way a pinned check has.
 * Two mechanisms bound staleness here, and both are necessary — see the
 * epoch fence below for the one that closes a real race the first
 * mechanism alone does not:
 *   1. `clear()` is called by every successful write/delete/schema-publish
 *      reachable through this same server process (`src/api/server.ts`),
 *      invalidating every entry — including every pinned one, wastefully
 *      but harmlessly, since a pinned entry never needed invalidating in
 *      the first place.
 *   2. The underlying store's own TTL (`env.CHECK_CACHE_TTL_MS`) is a
 *      backstop for staleness this process's own `clear()` hook cannot
 *      observe at all: a write issued through a *different* process (the
 *      CLI, another replica of this same API behind a shared reverse
 *      proxy) or directly against Postgres. This is a genuine, disclosed
 *      gap this design does not close — a single in-process cache
 *      structurally cannot know about a write it never saw.
 *
 * **The epoch fence — a real race, found by adversarial review, not a
 * hypothetical.** `clear()` can only remove what is already IN the cache at
 * the moment it runs. It cannot cancel a `productionCheck` call that is
 * still in flight, reading pre-write state, and that then writes its
 * (now-stale) answer back into the cache *after* the `clear()` that was
 * supposed to invalidate exactly that data already ran — a concrete,
 * ordinary-concurrent-load scenario an adversarial review workflow
 * independently reproduced from three different angles before this file
 * was written: an unpinned check begins, is genuinely in flight for real
 * milliseconds (a multi-hop graph walk under real load), a concurrent write
 * revoking (or granting) exactly the fact that check depends on lands and
 * commits, its route handler calls `clear()` correctly, and only *then*
 * does the original check's `productionCheck` call resolve with its
 * pre-write answer — which the miss path would otherwise unconditionally
 * cache, re-poisoning a cache that was just correctly emptied. This is not
 * the disclosed cross-process gap above; it happens within one process,
 * through the very `clear()` hook this design relies on.
 *
 * The fix: `beginMiss()`/`trySet(epoch, ...)`. A caller on a cache miss
 * calls `beginMiss()` to snapshot the current epoch *before* starting its
 * own expensive, uncached computation, and later calls `trySet` with that
 * same snapshot. `trySet` silently drops the result — never calling into
 * the underlying store at all — if `clear()` has run (bumping the epoch) at
 * any point since. A write that lands and clears mid-flight is thereby
 * guaranteed to win the race: the stale result that arrives afterward is
 * discarded, never re-poisoning the cache. See `test/unit/resolve/
 * production/cache.test.ts` for a fully deterministic (no real timing,
 * no Postgres) proof of exactly this fencing behavior, and `src/audit/
 * checks.ts`'s own doc comment for how `performCheck` actually sequences
 * `beginMiss`/`productionCheck`/the audit insert/`trySet` to close the race
 * end to end.
 */
import { LruMap } from 'toad-cache';

import type { EntityRef, ProductionCheckOptions, ProductionCheckResult } from './resolver.js';

/**
 * `atToken`/`maxDepth` tagged explicitly (`T:`/`U`, `D:`/`X`), never a bare
 * stringified number and never `JSON.stringify` of the raw options object —
 * both were named as real landmines by adversarial review: a bare number
 * could coincide with a real token/depth value acting as a sentinel, and
 * `JSON.stringify` silently drops `undefined` object properties, which is
 * exactly the mechanism that could collapse "absent" and a sentinel into
 * the same string by accident. `atToken: 0` (a structurally legal,
 * `assertTokenObserved`-valid token) and "no `atToken` at all" must always
 * key differently — a wrong hit here would mean an unpinned check served a
 * pinned result it never asked for and would have failed a token-observed
 * check on, or a pinned check silently reusing an unpinned result subject
 * to this file's own disclosed staleness gap, defeating the floor guarantee
 * the pin exists to provide. `\0` joins every field — no real identifier
 * (`IDENTIFIER_PATTERN`, `src/schema/dsl/types.ts`) can ever contain it,
 * matching `src/audit/expand.ts`'s own `nameKey` precedent exactly.
 */
export function buildCacheKey(
  subject: EntityRef,
  relationOrPermission: string,
  object: EntityRef,
  options: ProductionCheckOptions,
): string {
  const tokenTag = options.atToken === undefined ? 'U' : `T:${options.atToken}`;
  const depthTag = options.maxDepth === undefined ? 'X' : `D:${options.maxDepth}`;
  return [
    subject.ns,
    subject.id,
    relationOrPermission,
    object.ns,
    object.id,
    tokenTag,
    depthTag,
  ].join('\0');
}

/**
 * The one class this file exports. Never constructed directly by a real
 * caller — see `createCheckCache` below, the only supported entry point.
 * `maxEntries`/`ttlMs` are handed straight to `toad-cache`'s `LruMap`,
 * already a transitive dependency of `@fastify/rate-limit` and already used
 * directly elsewhere in this codebase (`src/api/server.ts`'s
 * `authFloodState`, `src/api/redis-store.ts`'s `InMemoryFloodStore`) — no
 * new dependency for this file.
 */
export class CheckCache {
  private readonly store: LruMap<ProductionCheckResult>;
  private epoch = 0;

  /**
   * `ttlMs` must be a positive integer — `createCheckCache` is the only
   * supported constructor path and already enforces this; this constructor
   * still asserts it defensively rather than silently forwarding a
   * non-positive value into `toad-cache`, whose own real behavior for
   * `ttl <= 0` is "never expire," the exact opposite of "disabled"
   * (confirmed by reading the installed `toad-cache` source directly during
   * adversarial review, not assumed from its types) — a landmine this class
   * must never be able to reach silently, from any call site, present or
   * future.
   */
  constructor(maxEntries: number, ttlMs: number) {
    if (!(ttlMs > 0)) {
      throw new Error(
        `CheckCache: ttlMs must be a positive number of milliseconds (got ${ttlMs}) — ` +
          `use createCheckCache(maxEntries, ttlMs) instead of this constructor directly; ` +
          `it returns undefined for a non-positive TTL rather than reaching this throw`,
      );
    }
    this.store = new LruMap(maxEntries, ttlMs);
  }

  /** A cache hit's own result, or `undefined` on a miss (never present, expired, or evicted). */
  get(key: string): ProductionCheckResult | undefined {
    return this.store.get(key);
  }

  /**
   * Snapshots the current epoch. A caller on a cache miss must call this
   * *before* starting its own uncached computation (`productionCheck`) and
   * pass the returned value to `trySet` once that computation — and, per
   * `performCheck`'s own doc comment, the audit-log insert that must
   * complete first — is done. See this file's own top-of-file doc comment,
   * "The epoch fence," for why this exists at all.
   */
  beginMiss(): number {
    return this.epoch;
  }

  /**
   * Records `result` for `key` — but only if no `clear()` has run since
   * `epochAtMissStart` was captured via `beginMiss()`. A `clear()` in
   * between means a write this result should have reflected may have landed
   * while the caller's own uncached computation was still in flight; the
   * safe, conservative choice is to drop the result rather than risk
   * re-poisoning a cache that was just correctly invalidated. Dropping here
   * only ever costs a cache miss on some *future* call for the same key —
   * it never affects the result already returned to the caller of
   * `performCheck` for *this* call, which gets its real, freshly-computed
   * answer either way; only whether that answer also gets cached.
   */
  trySet(epochAtMissStart: number, key: string, result: ProductionCheckResult): void {
    if (epochAtMissStart !== this.epoch) return;
    this.store.set(key, result);
  }

  /**
   * Invalidates every cached entry — pinned and unpinned alike, the former
   * wastefully (a pinned entry is valid forever, per this file's own
   * top-of-file doc comment) but harmlessly — and bumps the epoch, fencing
   * off any miss already in flight from re-poisoning the cache with a
   * pre-clear answer (see `trySet`). Called by `src/api/server.ts` after
   * every successful `writeTuple`/`deleteTuple`/`publishSchema` reachable
   * through this process. Deliberately whole-cache, not scoped to whatever
   * this specific write could plausibly affect — see this file's own
   * top-of-file doc comment and `docs/DECISIONS.md` for the reasoning
   * (a userset/tuple-to-userset hop can cross namespaces, and a schema
   * publish can invalidate a cached result with zero tuple writes at all;
   * a precise dependency-tracking scheme would need its own soundness
   * proof this change deliberately keeps out of scope).
   */
  clear(): void {
    this.epoch += 1;
    this.store.clear();
  }
}

/**
 * The only supported way to construct a `CheckCache`. Returns `undefined`
 * for any `ttlMs <= 0` — never constructs the underlying `LruMap` at all in
 * that case — so "disabled" (`env.CHECK_CACHE_TTL_MS`'s own documented `0`
 * default) is structural at every call site, present and future, rather
 * than a convention each one has to independently remember to re-derive.
 * This exists specifically because adversarial review found that
 * `toad-cache`'s real `ttl <= 0` behavior is "cache forever," not
 * "disabled" — the single most dangerous possible misreading given this
 * project's own "off by default" default. `src/api/server.ts` is, as of
 * this change, this function's only real caller; any future call site
 * (e.g. a bulk list/reverse-lookup endpoint wanting the same optimization)
 * gets this same safety for free by calling this function instead of
 * `new CheckCache(...)` directly.
 */
export function createCheckCache(maxEntries: number, ttlMs: number): CheckCache | undefined {
  if (ttlMs <= 0) return undefined;
  return new CheckCache(maxEntries, ttlMs);
}
