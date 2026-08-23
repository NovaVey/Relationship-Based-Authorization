/**
 * `result -> exit code`, per build spec §9's own table:
 *
 *   0  holds
 *   1  violated
 *   2  unknown / bound exceeded
 *   3  tool error
 *
 * "Distinct codes matter — CI needs to distinguish 'your schema is
 * unsafe' from 'the verifier crashed,' and collapsing them is the same
 * generic-error mistake that made llmreg failures hard to read." Exit
 * `3` in `src/cli/verify.ts` is reserved for exactly that literal
 * reading — a thrown exception (a file that doesn't exist, a schema or
 * invariant that fails to compile/parse, an unexpected error from the
 * check engine itself). This module's own job is mapping a *result the
 * verifier successfully produced* onto one of the four codes, which
 * needs two judgment calls the build spec's own table doesn't spell out
 * — both real, both worth stating explicitly rather than leaving
 * implicit in a chain of `if`s:
 *
 * 1. A non-monotone `HOLDS` (`result.bound !== undefined`) is a bounded
 *    result, not a proof — `docs/INVARIANTS.md`'s own §7 section is
 *    explicit that this must always be reported as "HOLDS up to k = N,"
 *    never a bare `HOLDS` (§7's own wording). Exit `0` is reserved for a
 *    genuine, unconditional proof (the monotone fragment's small-model
 *    property), so a bounded `HOLDS` maps to `2` (`unknown / bound
 *    exceeded`) alongside a real `UNKNOWN` verdict — both mean "no
 *    violation was found, but this isn't a proof of safety," which is
 *    exactly what code `2` is for.
 * 2. Self-validation (§6) disagreeing with the static search — a
 *    `mismatch` (the real engine denied a witness the search claimed was
 *    a violation) or an `empirical-counterexample` (the real engine
 *    granted something the search claimed `HOLDS` against) — is not a
 *    schema-safety verdict at all. It means the verifier's own claim
 *    couldn't be substantiated against the real engine: either a genuine
 *    static/runtime divergence (`depth-exceeds-limit.authz`'s own
 *    `CHECK_MAX_DEPTH` gap, `docs/DECISIONS.md` D-120) or a bug in the
 *    search itself. Neither "your schema is unsafe" (would be `1`, but
 *    the claimed counterexample doesn't actually reproduce) nor "no
 *    violation found" (would be `2`, but that undersells a claim that
 *    was actively contradicted) fits — this maps to `3`, the same bucket
 *    as a crash, because the right next step is the same: stop trusting
 *    this result and investigate the tool, not just the schema.
 */
import type { CheckResult } from '../reachability/types.js';
import type { ValidationOutcome } from '../validate/types.js';

export type InvariantExitCode = 0 | 1 | 2 | 3;

/** One invariant's `checkAndValidate` result -> exit code, per this file's own top-of-file doc comment. */
export function invariantExitCode(
  result: CheckResult,
  validation: ValidationOutcome,
): InvariantExitCode {
  if (validation.kind === 'mismatch' || validation.kind === 'empirical-counterexample') {
    return 3;
  }
  if (result.verdict === 'VIOLATED') return 1;
  if (result.verdict === 'UNKNOWN') return 2;
  // HOLDS: exact (monotone, no bound) is 0; bounded (non-monotone) is 2.
  return result.bound !== undefined ? 2 : 0;
}

/** `Priority`, highest first — worst-wins ordering when a single `--invariants` file names more than one invariant and their exit codes disagree. `3` (the verifier's own claim is unsubstantiated) outranks `1` (a real, confirmed violation) outranks `2` (inconclusive) outranks `0` (clean). Reported this way because a caller who only checks the process exit code must never see `0` when *any* invariant in the file has a real problem, and must see `3` — not a quieter `1` — when even one result can't be trusted at all. */
const PRIORITY: readonly InvariantExitCode[] = [3, 1, 2, 0];

/** Combines every invariant's own exit code in a `--invariants` file into the one code the process actually exits with. Empty input is a caller bug, not something this function should paper over: `parseInvariants('')` genuinely returns `{ ok: true, invariants: [] }` — confirmed directly, despite `src/invariants/parser.ts`'s own informal grammar comment reading `file := invariant+` (one or more) — so `verify.ts` checks for and rejects an empty invariants file itself (exit `3`, before this function is ever called) rather than this function silently picking a code that doesn't mean anything. */
export function combineExitCodes(codes: readonly InvariantExitCode[]): InvariantExitCode {
  if (codes.length === 0) {
    throw new Error('combineExitCodes: no exit codes to combine');
  }
  for (const candidate of PRIORITY) {
    if (codes.includes(candidate)) return candidate;
  }
  /* c8 ignore next -- unreachable: PRIORITY enumerates every InvariantExitCode value */
  throw new Error(`combineExitCodes: unrecognized exit code among ${JSON.stringify(codes)}`);
}
