/**
 * The three-valued result of checking one invariant against one schema
 * (build spec §5). `HOLDS`: exhaustive search over the monotone fragment
 * found no witness. `VIOLATED`: it found one, materialized below.
 * `UNKNOWN`: the search had to cross an intersection or exclusion edge
 * and can't say either way (§5's own `checkInvariant`, still — bounded
 * search for that case is §7's `checkInvariantBounded`, a separate,
 * fragment-aware entry point) — never collapsed into `HOLDS`, per the
 * build spec's own explicit warning that doing so is "the failure mode
 * that makes a verifier actively dangerous."
 */
export type Verdict = 'HOLDS' | 'VIOLATED' | 'UNKNOWN';

/** Build spec §7: "if the schema uses only the monotone fragment, the verifier is exact — sound and complete. Say that." Set only by the fragment-aware entry point (`../validate/check-and-validate.ts`, via `./fragment.ts`'s `scanReachability`) — plain `checkInvariant` (§5) doesn't know which fragment it's in and leaves this `undefined`. */
export type Fragment = 'monotone' | 'non-monotone';

/**
 * One tuple the witness needs written for the violation to be real.
 * `subjectRelation` set means the tuple's subject is itself a userset
 * (`group:g1#member`, not a plain `user:u1`) — the same distinction
 * `DirectEdge.subjectTypes` carries in the IR.
 */
export interface WitnessTuple {
  readonly objectType: string;
  readonly object: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subject: string;
  readonly subjectRelation?: string;
}

export interface CheckResult {
  readonly verdict: Verdict;
  /** Present only when `verdict === 'VIOLATED'` — one tuple per schema-graph edge walked, per build spec §5's own "materialize the witness" step. */
  readonly witness?: readonly WitnessTuple[];
  /** Present only when `verdict === 'UNKNOWN'` — why the search couldn't decide. */
  readonly reason?: string;
  /** Which fragment this schema (as reachable from the goal) falls into — only set by the fragment-aware entry point, §7. */
  readonly fragment?: Fragment;
  /** Present only when `fragment === 'non-monotone'` and `verdict === 'HOLDS'` — the bound the exhaustive bounded search ran up to. The verdict must always be reported as "HOLDS up to k = N", never a bare HOLDS, when this is set — build spec §7's own explicit instruction. */
  readonly bound?: number;
}
