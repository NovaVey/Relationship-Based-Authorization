/**
 * `soundnessExitCode` — build spec `.claude/commands/build-authz-service.md`
 * §7's exit-code table, the single source of truth for
 * `soundness_runs.verdict -> process exit code`:
 *
 *   0  sound
 *   1  unsound (a `false_grant` — always blocking, §6.5/`docs/DECISIONS.md`
 *      D-006, regardless of aggregate rate)
 *   2  insufficient_coverage
 *
 * Exit code 3 (infrastructure failure) is deliberately out of scope for this
 * function — see `src/report/exitCodes.ts`'s own top-of-file doc comment:
 * that code is a thrown error surfaced by `src/cli/commands/soundness.ts`'s
 * own `catch` block, before any verdict exists to map.
 *
 * Written from §7's table alone — `soundnessExitCode`'s own signature
 * (`(verdict: SoundnessVerdict) => 0 | 1 | 2`) is a plain, total, three-case
 * lookup, so there is no ambiguity to resolve by reading the implementation.
 */
import { describe, expect, it } from 'vitest';

import { soundnessExitCode } from '../../../src/report/exitCodes.js';
import type { SoundnessVerdict } from '../../../src/soundness/classify.js';

describe('soundnessExitCode', () => {
  it('a-sound-verdict-exits-zero', () => {
    expect(soundnessExitCode('sound')).toBe(0);
  });

  it('an-unsound-verdict-a-false-grant-exits-one', () => {
    expect(soundnessExitCode('unsound')).toBe(1);
  });

  it('an-insufficient-coverage-verdict-exits-two', () => {
    expect(soundnessExitCode('insufficient_coverage')).toBe(2);
  });

  it('every-verdict-maps-to-a-distinct-exit-code-and-sound-is-the-only-one-mapped-to-zero', () => {
    const verdicts: SoundnessVerdict[] = ['sound', 'unsound', 'insufficient_coverage'];
    const codes = verdicts.map((v) => soundnessExitCode(v));

    // Distinctness: no verdict silently shares another's code (in
    // particular, nothing except `sound` may share `sound`'s own `0`,
    // which is the one exit code Node also treats as "unset" — collapsing
    // any other verdict onto it would make that verdict look like success).
    expect(new Set(codes).size).toBe(codes.length);
    expect(soundnessExitCode('sound')).toBe(0);
    expect(soundnessExitCode('unsound')).not.toBe(0);
    expect(soundnessExitCode('insufficient_coverage')).not.toBe(0);
  });
});
