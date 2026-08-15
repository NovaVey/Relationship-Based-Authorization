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
 * caller's check can silently skip the audit log. A future API surface
 * (Phase 8) should route through this same function for the same reason.
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
 */
import type { Pool } from 'pg';

import {
  productionCheck,
  type EntityRef,
  type ProductionCheckOptions,
  type ProductionCheckResult,
} from '../resolve/production/resolver.js';

export type PerformCheckOptions = ProductionCheckOptions;

export type PerformCheckResult = ProductionCheckResult;

export async function performCheck(
  pool: Pool,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options: PerformCheckOptions = {},
): Promise<PerformCheckResult> {
  const start = performance.now();
  const result = await productionCheck(pool, subject, object, relationOrPermission, options);
  const durationMs = Math.round(performance.now() - start);

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

  return result;
}
