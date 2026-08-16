import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests (currently the isolation suite's real-Postgres
    // proof, see test/isolation/permission-resolution.integration.test.ts)
    // need Docker and live in their own vitest project — see
    // vitest.integration.config.ts / `npm run test:integration` — so
    // contributors without Docker aren't blocked on the fast unit suite,
    // and this suite's coverage numbers aren't skewed by a slow outlier.
    // Matched by suffix rather than by directory, since integration tests
    // now live alongside the fuzz/unit tests they're related to inside
    // test/isolation/, not in a separate test/integration/ tree.
    exclude: ['**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/types.ts'],
      // Still no thresholds — but not for the reason this comment used to
      // give (full-repo audit finding #35, MEDIUM, 2026-08-16): it
      // previously said "src/ is currently just Phase 0's env loader, and
      // the isolation suite is intentionally all `.todo()`," which was
      // true when written but has been stale since roughly Phase 2. As of
      // this fix, src/ has 33 files across all 9 build-spec phases, and
      // `test/isolation/` carries zero remaining live `.todo()`s (see
      // docs/github-governance.md's own note on this same finding). A
      // threshold gate isn't restored here regardless — that's a real,
      // separate decision (what floor, and against which report — this
      // config excludes `**/*.integration.test.ts`, so a threshold here
      // would only ever measure the fast unit suite's own coverage, never
      // the isolation suite's) worth making deliberately with real
      // coverage numbers in hand, not as a side effect of correcting a
      // stale comment. This repo's previous identity ran 95/95/90/95
      // stmt/func/branch/line — a reasonable starting point to evaluate
      // against current real numbers when that decision is made.
    },
  },
});
