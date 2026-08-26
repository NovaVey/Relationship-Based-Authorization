/**
 * `src/cli/exitCodes.ts` — pure-function coverage of every branch its own
 * top-of-file doc comment claims, including the two judgment calls that
 * doc comment states explicitly aren't spelled out by build spec §9's own
 * table (a bounded `HOLDS` maps to `2`, not `0`; self-validation
 * disagreeing with the search — `mismatch`/`empirical-counterexample` —
 * maps to `3`, not `1` or `2`). Fabricated `CheckResult`/`ValidationOutcome`
 * values here, not real fixture files — `test/cli.test.ts` is where a real
 * schema/invariant pair exercises this mapping end-to-end through the
 * actual subprocess.
 */
import { describe, expect, it } from 'vitest';

import { combineExitCodes, invariantExitCode } from '../src/cli/exitCodes.js';
import type { CheckResult } from '../src/reachability/types.js';
import type { ValidationOutcome } from '../src/validate/types.js';

const NOT_APPLICABLE: ValidationOutcome = { kind: 'not-applicable' };
const CONFIRMED: ValidationOutcome = {
  kind: 'confirmed',
  witness: [],
  engineResult: { allowed: true, depth: 1, touchedExpiringTuple: false },
};
const EMPIRICALLY_CLEAN: ValidationOutcome = { kind: 'empirically-clean', sampled: 200 };
const MISMATCH: ValidationOutcome = {
  kind: 'mismatch',
  witness: [],
  reason: 'real engine denied it',
};
const EMPIRICAL_COUNTEREXAMPLE: ValidationOutcome = {
  kind: 'empirical-counterexample',
  tuples: [],
  engineResult: { allowed: true, depth: 3, touchedExpiringTuple: false },
};

function result(partial: Partial<CheckResult> & Pick<CheckResult, 'verdict'>): CheckResult {
  return partial;
}

describe('invariantExitCode', () => {
  it('monotone HOLDS (no bound) → 0', () => {
    expect(
      invariantExitCode(result({ verdict: 'HOLDS', fragment: 'monotone' }), EMPIRICALLY_CLEAN),
    ).toBe(0);
  });

  it('VIOLATED, self-validation confirmed → 1', () => {
    expect(
      invariantExitCode(
        result({ verdict: 'VIOLATED', fragment: 'monotone', witness: [] }),
        CONFIRMED,
      ),
    ).toBe(1);
  });

  it('non-monotone VIOLATED (already confirmed at search time) → 1', () => {
    expect(
      invariantExitCode(
        result({ verdict: 'VIOLATED', fragment: 'non-monotone', witness: [] }),
        NOT_APPLICABLE,
      ),
    ).toBe(1);
  });

  it('monotone UNKNOWN → 2', () => {
    expect(
      invariantExitCode(
        result({ verdict: 'UNKNOWN', fragment: 'monotone', reason: 'crossed an exclusion edge' }),
        NOT_APPLICABLE,
      ),
    ).toBe(2);
  });

  it('non-monotone HOLDS up to k=N (bounded, not exact) → 2, not 0', () => {
    expect(
      invariantExitCode(
        result({ verdict: 'HOLDS', fragment: 'non-monotone', bound: 3 }),
        NOT_APPLICABLE,
      ),
    ).toBe(2);
  });

  it('self-validation mismatch → 3, even though the search itself said VIOLATED', () => {
    expect(
      invariantExitCode(
        result({ verdict: 'VIOLATED', fragment: 'monotone', witness: [] }),
        MISMATCH,
      ),
    ).toBe(3);
  });

  it('empirical counterexample → 3, even though the search itself said HOLDS', () => {
    expect(
      invariantExitCode(
        result({ verdict: 'HOLDS', fragment: 'monotone' }),
        EMPIRICAL_COUNTEREXAMPLE,
      ),
    ).toBe(3);
  });
});

describe('combineExitCodes — worst-wins ordering: 3 > 1 > 2 > 0', () => {
  it('all clean → 0', () => {
    expect(combineExitCodes([0, 0, 0])).toBe(0);
  });

  it('one violated among clean ones → 1', () => {
    expect(combineExitCodes([0, 1, 0])).toBe(1);
  });

  it('one unknown among clean ones → 2', () => {
    expect(combineExitCodes([0, 2, 0])).toBe(2);
  });

  it('violated outranks unknown', () => {
    expect(combineExitCodes([2, 1])).toBe(1);
  });

  it('a single tool-error outranks everything, even a real confirmed violation', () => {
    expect(combineExitCodes([0, 1, 2, 3])).toBe(3);
  });

  it('throws on empty input rather than silently picking a meaningless code', () => {
    expect(() => combineExitCodes([])).toThrow();
  });
});
