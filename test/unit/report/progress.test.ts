/**
 * `createProgressReporter` (`src/report/progress.ts`) — the cadence logic
 * behind `authz soundness run --progress <n>` (D-090, `docs/DECISIONS.md`).
 * A plain injected `write` stub stands in for `process.stderr.write`, per
 * this function's own doc comment on why `write` is a parameter rather than
 * hardcoded — no real terminal, no real CLI invocation, no Postgres needed
 * to pin the actual counting behavior.
 */
import { describe, expect, it } from 'vitest';

import { createProgressReporter } from '../../../src/report/progress.js';

function collectLines(every: number): {
  report: (completed: number, total: number) => void;
  lines: string[];
} {
  const lines: string[] = [];
  const report = createProgressReporter(every, (line) => lines.push(line));
  return { report, lines };
}

describe('createProgressReporter', () => {
  it('reports once every `every` completions', () => {
    const { report, lines } = collectLines(2);
    report(2, 10);
    report(4, 10);
    expect(lines).toEqual(['  checked 2/10 queries\n', '  checked 4/10 queries\n']);
  });

  it('stays silent on a call that has not yet crossed a milestone', () => {
    const { report, lines } = collectLines(5);
    report(3, 10);
    expect(lines).toEqual([]);
  });

  it('always reports the final call, even when `every` does not evenly divide the total', () => {
    const { report, lines } = collectLines(3);
    report(3, 7);
    report(6, 7);
    report(7, 7); // not a multiple of 3, but it is the final call
    expect(lines).toEqual([
      '  checked 3/7 queries\n',
      '  checked 6/7 queries\n',
      '  checked 7/7 queries\n',
    ]);
  });

  it('never reports the same completed count twice when the final call already landed exactly on a milestone', () => {
    const { report, lines } = collectLines(5);
    report(5, 10);
    report(10, 10); // final call, and 10 is itself a multiple of 5
    expect(lines).toEqual(['  checked 5/10 queries\n', '  checked 10/10 queries\n']);
  });

  it('reports every completed/total pair passed to it when `every` is 1', () => {
    const { report, lines } = collectLines(1);
    report(1, 3);
    report(2, 3);
    report(3, 3);
    expect(lines).toHaveLength(3);
  });

  it('a fresh reporter never reports on a batch of zero real progress', () => {
    const { report, lines } = collectLines(5);
    // A degenerate call this project's own callers never actually make
    // (`checkAllQueries` only calls back after a non-empty batch) — pinned
    // anyway, since `completed === lastReported` (both 0) must not print.
    report(0, 10);
    expect(lines).toEqual([]);
  });
});
