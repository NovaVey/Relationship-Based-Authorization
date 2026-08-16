/**
 * The single source of truth for `soundness_runs.verdict -> process exit
 * code`, per build spec §7's table:
 *
 *   0  sound
 *   1  unsound (a `false_grant` — always blocking, per §6.5/D-006)
 *   2  insufficient_coverage
 *   3  infrastructure failure — NOT this file's concern. That code is a
 *      thrown error from `runSoundnessFuzz` itself that is *not* a
 *      `SoundnessFixtureError` (an unreachable database, an unexpected
 *      `soundness_runs` insert response), surfaced before any verdict
 *      exists to map. A `SoundnessFixtureError` — a generated schema,
 *      publish, or tuple write that itself failed — maps to exit code 2
 *      instead, alongside `insufficient_coverage`, per build spec §7
 *      ("insufficient fuzz coverage or a schema/tuple validation
 *      failure"); see `src/cli/commands/soundness.ts`'s own `catch` block
 *      and top-of-file exit-code table for exactly how the two are told
 *      apart.
 *
 * `src/cli/commands/soundness.ts` calls `soundnessExitCode` directly (no
 * inlined `if (verdict === 'unsound') ... else if (...)` chain of its own —
 * that was true only up through Phase 5; full-repo audit finding #25,
 * MEDIUM, 2026-08-16 caught this paragraph still describing the pre-refactor
 * state after the refactor itself had already shipped, in the very same
 * commit that added this comment). See that file's own doc comment for the
 * exact behavior this must match: `sound` leaves `process.exitCode` at its
 * default (equivalent to `0`, never explicitly set), `unsound` sets it to
 * `1`, `insufficient_coverage` sets it to `2`. This function returns a plain
 * `0 | 1 | 2` in every case — whether the caller then chooses to leave
 * `process.exitCode` unset for the `0` case or set it explicitly is a
 * CLI-wiring decision, not a difference this mapping itself needs to encode.
 */
import type { SoundnessVerdict } from '../soundness/classify.js';

const SOUNDNESS_EXIT_CODES: Readonly<Record<SoundnessVerdict, 0 | 1 | 2>> = {
  sound: 0,
  unsound: 1,
  insufficient_coverage: 2,
};

/** `verdict -> exit code`, per build spec §7. See this file's own top-of-file doc comment for exit code `3` (infrastructure failure — out of scope here). */
export function soundnessExitCode(verdict: SoundnessVerdict): 0 | 1 | 2 {
  return SOUNDNESS_EXIT_CODES[verdict];
}
