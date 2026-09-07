/**
 * The scope-bounding query (D-186) — given a principal, which of a
 * caller-supplied set of `(namespace, relationOrPermission)` targets does
 * that principal currently hold at least one grant for, right now? Built for
 * a caller minting a delegation credential (a short-lived token, an agent
 * tool-call broker's own scoped credential) that needs to bound the new
 * credential's own claimed scope to no more than what the underlying ReBAC
 * graph actually grants — never wider, since a delegation token claiming a
 * permission its own principal doesn't actually hold would be exactly the
 * kind of over-grant this project's whole soundness effort exists to catch,
 * just relocated to a different credential instead of a `/check` call.
 *
 * **A thin orchestrator over `src/audit/list.ts`'s `hasAnyGrant`, never a
 * second implementation of the graph walk.** Every one of this file's own
 * correctness properties is inherited from `hasAnyGrant`'s (soundness:
 * `granted: true` only ever comes from one real `productionCheck`
 * `allowed: true`; the same candidate-cap completeness limit `listObjects`
 * already discloses) — this file's own job is purely the multi-target
 * fan-out and per-target failure isolation `hasAnyGrant` itself has no
 * concept of.
 *
 * **Deliberately NOT what `/check/batch` does, on purpose, not by
 * oversight.** `/check/batch` (`src/api/server.ts`'s `runCheckBatch`) has a
 * known, already-disclosed limitation (D-185, `docs/INTEGRATION.md`): a
 * single item's runtime failure — a genuine Postgres error, or that one
 * item's own `token_not_yet_observed` condition — fails the *entire*
 * request and discards every other item's already-computed result, since
 * nothing in its own batch loop catches a per-item throw. Having already
 * named that as worth fixing one PR ago, shipping the identical flaw again
 * here — in a brand-new endpoint with no existing callers to keep
 * byte-compatible — would be repeating a mistake this project already knows
 * about. `queryScope` below catches each target's own failure independently
 * (`tryTarget`) and records it as that one target's own outcome; every
 * other target still gets a real, live answer. Only a *structural* problem
 * (malformed input, an out-of-scope namespace) is the caller's fault and
 * stays all-or-nothing, rejecting the whole request before any target is
 * attempted — that check lives in `src/api/server.ts`'s route handler,
 * mirroring `/check/batch`'s own identical split between "reject the whole
 * request for a structural problem" and "run every item independently"
 * (this file's own job is only the second half; the route handler still
 * owns request-level validation and scope-checking, the same division
 * every other file under `src/audit/` already has with `server.ts`).
 *
 * **Targets are processed sequentially, not fanned out in parallel — a
 * deliberate, disclosed choice, not the obvious-in-hindsight one.** Each
 * target's own `hasAnyGrant` call is already internally concurrency-bounded
 * at `Math.max(1, env.MAX_CONCURRENCY)` (`list.ts`'s own
 * `checkCandidatesUntilFirstMatch`). Fanning out *targets* in parallel on
 * top of that would multiply concurrent `productionCheck`/pool-connection
 * pressure by however many targets run at once — up to
 * `MAX_CONCURRENCY²` in the worst case (64, at today's default of 8) — for
 * a benefit this project has no load data to justify yet, the same
 * "start simple and bounded, revisit with real data" posture
 * `LIST_OBJECTS_MAX_CANDIDATES`'s own "a documented starting point, not
 * load-tested" framing already takes. Revisit if a real caller's own
 * latency needs justify bounded cross-target fan-out.
 *
 * **One shared, request-level `atToken`, not one per target** — unlike
 * `/check/batch`'s N-independent-questions shape, this file answers one
 * coherent question ("what is my scope as of this point"), so a single
 * pin threaded into every target's own `hasAnyGrant` call fits better than
 * per-target pins would. Same disclosed re-validation-per-candidate cost
 * `listObjects` already accepts (`list.ts`'s own top-of-file doc comment),
 * now also multiplied across targets — accepted for the same reason
 * `listObjects` accepts it: a second, `atToken`-aware path bypassing
 * `productionCheck`'s own real validation would duplicate real correctness
 * logic for a modest constant-factor speedup.
 */
import type { ConnectionSource } from '../store/query-executor.js';
import type { EntityRef } from '../resolve/production/resolver.js';
import { hasAnyGrant, type ListObjectsOptions } from './list.js';

/** One `(namespace, relationOrPermission)` pair to check for `subject` — see this file's own top-of-file doc comment for why this is caller-supplied rather than auto-discovered from every published namespace. */
export interface ScopeQueryTarget {
  namespace: string;
  relationOrPermission: string;
}

/**
 * The cap on how many targets one `queryScope` call will check — sized and
 * named the same way `src/api/server.ts`'s own `CHECK_BATCH_MAX_SIZE` is
 * (that constant's own doc comment: each item is a full, independent unit
 * of real server-side work, so an unbounded batch would let one request
 * demand an unbounded amount of it). An oversized `targets` array is the
 * caller's own structural problem — `src/api/server.ts`'s route handler
 * rejects it outright (400) before this function is ever called, the same
 * "rejected outright, never silently truncated" posture `/check/batch`
 * already established (D-152) and this file's own top-of-file doc comment
 * explains why per-target failures do NOT get the same all-or-nothing
 * treatment.
 */
export const SCOPE_QUERY_MAX_TARGETS = 50;

/** One target's real, live outcome — a confirmed grant/non-grant, or (deliberately, see this file's own top-of-file doc comment) an independent failure that never aborts any other target's own outcome. */
export type ScopeGrantOutcome =
  | {
      namespace: string;
      relationOrPermission: string;
      granted: boolean;
      /** See `HasAnyGrantResult.truncated` (`src/audit/list.ts`) — identical meaning, passed through unchanged. */
      truncated: boolean;
    }
  | {
      namespace: string;
      relationOrPermission: string;
      /**
       * The real `Error` `hasAnyGrant`'s own underlying `productionCheck`
       * call threw for this target specifically — never caught/mapped to
       * an `ApiErrorCode` here (this file has no `api/errors.ts` import,
       * matching every other file under `src/audit/`'s own established
       * layering: domain functions throw or return domain-shaped results,
       * only `src/api/server.ts` translates a thrown error into an HTTP
       * error shape). The route handler maps this the same way
       * `runOrInfrastructureError` already maps a whole-request failure —
       * `instanceof TokenNotObservedError` for a distinguishable
       * `token_not_yet_observed`, otherwise the generic infrastructure
       * path — just applied per-target instead of per-request.
       */
      error: Error;
    };

export interface ScopeQueryOptions {
  /** Pinned straight through to every target's own `hasAnyGrant` call — see this file's own top-of-file doc comment for why one shared token, not one per target. */
  atToken?: number;
  /** Overrides `env.CHECK_MAX_DEPTH` for every target's own underlying `productionCheck` calls — same option, same meaning as `ProductionCheckOptions.maxDepth`. */
  maxDepth?: number;
}

export interface ScopeQueryResult {
  grants: ScopeGrantOutcome[];
}

async function tryTarget(
  pool: ConnectionSource,
  subject: EntityRef,
  target: ScopeQueryTarget,
  options: ListObjectsOptions,
): Promise<ScopeGrantOutcome> {
  try {
    const { granted, truncated } = await hasAnyGrant(
      pool,
      subject,
      target.relationOrPermission,
      target.namespace,
      options,
    );
    return {
      namespace: target.namespace,
      relationOrPermission: target.relationOrPermission,
      granted,
      truncated,
    };
  } catch (err) {
    return {
      namespace: target.namespace,
      relationOrPermission: target.relationOrPermission,
      error: err as Error,
    };
  }
}

/**
 * Given `subject` and a caller-supplied list of `(namespace,
 * relationOrPermission)` targets, reports each one's own real, live
 * grant/non-grant outcome — or, deliberately, that one target's own
 * independent failure (see this file's own top-of-file doc comment for why
 * that never aborts the rest). `targets` is expected to already be
 * validated against `SCOPE_QUERY_MAX_TARGETS` and scope-checked by the
 * caller (`src/api/server.ts`'s route handler) before this function ever
 * runs — this function itself has no opinion about either, the same
 * division `src/audit/list.ts`'s functions already have with the routes
 * that call them.
 */
export async function queryScope(
  pool: ConnectionSource,
  subject: EntityRef,
  targets: readonly ScopeQueryTarget[],
  options: ScopeQueryOptions = {},
): Promise<ScopeQueryResult> {
  const hasAnyGrantOptions: ListObjectsOptions = {
    ...(options.atToken !== undefined ? { atToken: options.atToken } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  };

  // Sequential, not Promise.all across targets — see this file's own
  // top-of-file doc comment for why (each target's own hasAnyGrant call is
  // already internally concurrency-bounded; fanning out targets too would
  // multiply that bound rather than compose safely with it).
  const grants: ScopeGrantOutcome[] = [];
  for (const target of targets) {
    grants.push(await tryTarget(pool, subject, target, hasAnyGrantOptions));
  }
  return { grants };
}
