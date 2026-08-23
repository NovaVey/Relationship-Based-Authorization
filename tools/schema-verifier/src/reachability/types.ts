/**
 * The three-valued result of checking one invariant against one schema
 * (build spec §5). `HOLDS`: exhaustive search over the monotone fragment
 * found no witness. `VIOLATED`: it found one, materialized below.
 * `UNKNOWN`: the search had to cross an intersection or exclusion edge
 * (§7, not yet built) and can't say either way — never collapsed into
 * `HOLDS`, per the build spec's own explicit warning that doing so is
 * "the failure mode that makes a verifier actively dangerous."
 */
export type Verdict = 'HOLDS' | 'VIOLATED' | 'UNKNOWN';

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
}
