/**
 * Counterexample self-validation (build spec §6) — "the phase that makes
 * this credible." A `VIOLATED` verdict is never reported on the static
 * search's word alone: the materialized witness is replayed, tuple by
 * tuple, against the real, unmodified production check engine, on a
 * fresh in-memory store. `HOLDS` gets the complementary check —
 * empirical, not a proof, but real: N random type-valid tuple sets are
 * thrown at the same goal, and none may ever produce `allow`.
 */
import type { ProductionCheckResult } from '../../../../src/resolve/production/resolver.js';
import type { WitnessTuple } from '../reachability/types.js';

/** `VIOLATED`, replayed, and the real engine agrees: `allowed === true`. This is the counterexample CHECKPOINT 4 asks for — real tuples, a real check, a real `allow`. */
export interface Confirmed {
  readonly kind: 'confirmed';
  readonly witness: readonly WitnessTuple[];
  readonly engineResult: ProductionCheckResult;
}

/**
 * `VIOLATED`, replayed, and the real engine disagrees — either it denied
 * the goal outright, or one of the witness's own tuples was rejected as
 * type-invalid against the real schema before the check could even run.
 * Reported loudly, never silently downgraded to `confirmed` or dropped:
 * the static model and the runtime engine disagree about what this
 * schema means, and that is itself the finding.
 */
export interface Mismatch {
  readonly kind: 'mismatch';
  readonly witness: readonly WitnessTuple[];
  readonly reason: string;
  readonly engineResult?: ProductionCheckResult;
}

/** `HOLDS`, and `sampled` random type-valid tuple sets were thrown at the same goal without ever producing `allow`. Empirical, not a proof — see build spec §6's own framing. */
export interface EmpiricallyClean {
  readonly kind: 'empirically-clean';
  readonly sampled: number;
}

/**
 * `HOLDS`, but a random type-valid tuple set made the real engine return
 * `allow` anyway — the static search's `HOLDS` verdict is empirically
 * contradicted. This is a serious finding (a modeling bug in the search
 * itself, most likely), reported loudly, never silently discarded as
 * "probably a fluke."
 */
export interface EmpiricalCounterexample {
  readonly kind: 'empirical-counterexample';
  readonly tuples: readonly WitnessTuple[];
  readonly engineResult: ProductionCheckResult;
}

/** The verdict was `UNKNOWN` — self-validation was never attempted; there is nothing to replay or fuzz against. */
export interface NotApplicable {
  readonly kind: 'not-applicable';
}

export type ValidationOutcome =
  Confirmed | Mismatch | EmpiricallyClean | EmpiricalCounterexample | NotApplicable;
