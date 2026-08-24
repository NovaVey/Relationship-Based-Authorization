/**
 * `performCheck` — the "every check, allowed or denied, is logged" half of
 * §9 Phase 6's exit criterion. A thin, main-agent-owned wrapper around
 * `productionCheck` (`src/resolve/production/resolver.ts`, Phase 4/6): runs
 * the real check, times it, and inserts exactly one `checks` row (§4)
 * recording the outcome — `resolution_path` populated iff `allowed` is
 * true, matching the resolver's own "present iff allowed" contract for
 * `path`.
 *
 * This is the *only* place in the codebase a real, application-facing
 * check should go through — the CLI's `authz check` command calls this,
 * never `productionCheck` directly, so nothing that looks like a real
 * caller's check can silently skip the audit log. The API's `POST /check`
 * route (`src/api/server.ts`, Phase 8) already routes through this same
 * function for the same reason.
 *
 * **`runSoundnessFuzz` (Phase 5) deliberately does NOT call this.** Its
 * per-query checks (up to `SOUNDNESS_FUZZ_QUERIES` — 5,000 by default) are
 * synthetic fuzz instrumentation against generated, salted fixture data,
 * not real application traffic; logging every one to `checks` would
 * drown a real audit trail in synthetic noise for no benefit — a fuzz
 * run's own result is already durably recorded, in full, as its own
 * `soundness_runs` row. See `docs/DECISIONS.md`.
 *
 * **If the `checks` insert itself fails, `performCheck` throws** — the
 * already-computed `allowed`/`path` result is discarded, never returned.
 * §9 Phase 6's exit criterion states logging as unconditional ("every
 * check ... is logged"), not best-effort; a caller that received an
 * answer this function silently failed to log would have no way to know
 * the audit trail is now missing an entry for a real decision. This
 * matches `productionCheck`'s own established contract (a genuinely
 * unreachable database is an infrastructure failure — exit 3 in the CLI
 * — never smoothed over into an ordinary answer). See `docs/DECISIONS.md`.
 *
 * **The optional `cache` parameter (post-audit improvement, closes D-028;
 * `src/resolve/production/cache.ts`).** Defaults to `undefined`, preserving
 * today's exact behavior byte-for-byte for every one of this function's
 * existing callers (tests, the CLI, and every place that constructs
 * `PerformCheckOptions` without also passing a cache) — nothing has to
 * change at a call site that doesn't opt in. `src/api/server.ts`'s `/check`
 * route is, as of this change, the only real caller that ever passes one,
 * and only when `env.CHECK_CACHE_TTL_MS > 0` (`createCheckCache` returns
 * `undefined` otherwise — see that function's own doc comment).
 *
 * Logging stays unconditional on a hit exactly as on a miss: a hit skips
 * `productionCheck`'s own graph walk, never the `checks` insert. The insert
 * on a **miss** now runs *before* `cache.trySet(...)`, not after (a real
 * bug an adversarial review workflow found before this shipped, not a
 * stylistic choice): if the insert throws, `performCheck` still throws and
 * discards the result exactly as it always has, and — because `trySet`
 * never ran — that discarded result can never live on in the cache and be
 * served to some *other* caller under a checks-table row that misrepresents
 * when/how it was actually computed. `cache.beginMiss()` is called before
 * `productionCheck` even starts, and the epoch it captures is checked again
 * by `trySet` after the insert completes — fencing the *entire* window (the
 * graph walk and the audit insert both) during which a concurrent write
 * could have called `cache.clear()` and made this result stale before it
 * would otherwise be cached. See `cache.ts`'s own top-of-file doc comment,
 * "The epoch fence," for the full race this closes.
 */
import type { Pool } from 'pg';

import {
  productionCheck,
  type EntityRef,
  type ProductionCheckOptions,
  type ProductionCheckResult,
} from '../resolve/production/resolver.js';
import { buildCacheKey, type CheckCache } from '../resolve/production/cache.js';

export type PerformCheckOptions = ProductionCheckOptions;

export type PerformCheckResult = ProductionCheckResult;

/** The one `checks` row every call inserts, hit or miss — factored out so both paths write it identically. */
async function insertCheckRow(
  pool: Pool,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options: PerformCheckOptions,
  result: PerformCheckResult,
  durationMs: number,
): Promise<void> {
  await pool.query(
    `insert into checks
       (subject_ns, subject_id, relation, object_ns, object_id, allowed,
        consistency_token, resolution_path, depth, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      subject.ns,
      subject.id,
      relationOrPermission,
      object.ns,
      object.id,
      result.allowed,
      options.atToken ?? null,
      result.allowed ? JSON.stringify(result.path) : null,
      result.depth,
      durationMs,
    ],
  );
}

export async function performCheck(
  pool: Pool,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options: PerformCheckOptions = {},
  cache?: CheckCache,
): Promise<PerformCheckResult> {
  const cacheKey = cache
    ? buildCacheKey(subject, relationOrPermission, object, options)
    : undefined;

  if (cache && cacheKey !== undefined) {
    const hitStart = performance.now();
    const hit = cache.get(cacheKey);
    if (hit !== undefined) {
      const hitDurationMs = Math.round(performance.now() - hitStart);
      await insertCheckRow(
        pool,
        subject,
        object,
        relationOrPermission,
        options,
        hit,
        hitDurationMs,
      );
      return hit;
    }
  }

  // Captured before `productionCheck` even starts, per this function's own
  // doc comment — fences the whole miss (graph walk + audit insert) against
  // a concurrent `cache.clear()`, not just the graph walk alone.
  const missEpoch = cache?.beginMiss();

  const start = performance.now();
  const result = await productionCheck(pool, subject, object, relationOrPermission, options);
  const durationMs = Math.round(performance.now() - start);

  await insertCheckRow(pool, subject, object, relationOrPermission, options, result, durationMs);

  // Only after the audit insert has succeeded — see this function's own doc
  // comment for why a cache write must never precede it on the miss path.
  if (cache && cacheKey !== undefined && missEpoch !== undefined) {
    cache.trySet(missEpoch, cacheKey, result);
  }

  return result;
}
