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

/** Build spec §7: "if the schema uses only the monotone fragment, the verifier is exact — sound and complete. Say that." Set only by the fragment-aware entry point (`../validate/check-and-validate.ts`, via `./fragment.ts`'s `scanReachability`) — plain `checkInvariant` (§5) doesn't know which fragment it's in and leaves this `undefined`. Purely structural: whether the schema, as reachable from the goal, contains an intersection/exclusion edge ANYWHERE — independent of whether `checkInvariant` still managed to decide a verdict outright despite that (see `Proof` below, which is the field that actually answers "was this exact"). */
export type Fragment = 'monotone' | 'non-monotone';

/**
 * Whether a verdict is an unconditional proof or a bounded check —
 * orthogonal to `Fragment` (docs/DECISIONS.md, the entry adding
 * intersection/exclusion short-circuits to `checkInvariant`): a
 * structurally non-monotone schema (real intersection/exclusion
 * reachable from the goal) can still get an `'exact'` verdict when one
 * of those short-circuits decides it outright, without ever falling
 * back to bounded search. `'exact'`: `checkInvariant` itself decided
 * the verdict — the pure-monotone case this always covered, or the new
 * short-circuit case. `'bounded'`: `boundedSearch` decided it up to
 * `bound` — the only case `bound` is ever set. Present whenever
 * `verdict` is `HOLDS` or `VIOLATED`; never for `UNKNOWN` (there's
 * nothing to characterize the exactness of when nothing was decided).
 */
export type Proof = 'exact' | 'bounded';

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
  /** Which fragment this schema (as reachable from the goal) falls into — only set by the fragment-aware entry point, §7. Purely structural — see `Fragment`'s own doc comment for why this can be `'non-monotone'` on an `'exact'`-proof verdict. */
  readonly fragment?: Fragment;
  /** Whether this verdict is `'exact'` (an unconditional proof) or `'bounded'` (checked up to `bound`) — see `Proof`'s own doc comment. Only set by the fragment-aware entry point, same as `fragment`. */
  readonly proof?: Proof;
  /** Present only when `proof === 'bounded'` and `verdict === 'HOLDS'` — the bound the exhaustive bounded search ran up to. The verdict must always be reported as "HOLDS up to k = N", never a bare HOLDS, when this is set — build spec §7's own explicit instruction. */
  readonly bound?: number;
}
