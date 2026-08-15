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
      // No thresholds yet: src/ is currently just Phase 0's env loader, and
      // the isolation suite is intentionally all `.todo()` until the
      // phases in .claude/commands/build-authz-service.md that implement
      // what it tests land — see docs/DECISIONS.md. Restore thresholds
      // (this repo's previous identity ran 95/95/90/95 stmt/func/branch/
      // line) once there's real implementation coverage to hold a floor
      // under; a threshold gate against near-zero coverage would either
      // fail immediately or be set so low it catches nothing.
    },
  },
});
