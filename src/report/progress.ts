/**
 * `authz soundness run --progress <n>` — a stderr progress line every `n`
 * completed queries, plus always once more on the final call regardless of
 * whether `total` is a multiple of `n`. Exists because `soundness run`'s
 * existing contract (nothing prints until the whole run finishes) is
 * indistinguishable from a hang on a slow connection — added live, after a
 * real user asked for exactly this mid-troubleshooting a genuinely slow
 * (not stuck) run against a remote database.
 *
 * A pure function returning a closure — no I/O of its own, matching this
 * project's own established "keep I/O at the edges" preference
 * (`src/store/migrate.ts`'s `discoverMigrations`, `src/soundness/runner.ts`'s
 * `buildDivergenceRecord`) — so the actual cadence logic is unit-testable
 * without a real terminal, a real CLI invocation, or Postgres. `write` is
 * injected rather than hardcoded to `process.stderr.write` specifically for
 * that: tests pass a plain array-pushing stub; `src/cli/commands/
 * soundness.ts` passes the real thing. Always stderr in production, never
 * stdout — `--format markdown`/`json`'s own contract is "stdout is the
 * report and nothing else" (see that file's own top-of-file doc comment);
 * progress output must never be able to land inside a captured report body.
 */
export function createProgressReporter(
  every: number,
  write: (line: string) => void,
): (completed: number, total: number) => void {
  let lastReported = 0;
  return (completed: number, total: number): void => {
    const crossedAMilestone = completed - lastReported >= every;
    const isTheFinalCall = completed >= total;
    if (!crossedAMilestone && !isTheFinalCall) return;
    // Guards a call sequence where the very last batch is itself exactly on
    // a milestone (e.g. every=500, total=5000, the 5000th query completing
    // the 10th batch of 500) from printing the same count twice.
    if (completed === lastReported) return;
    write(`  checked ${completed}/${total} queries\n`);
    lastReported = completed;
  };
}
