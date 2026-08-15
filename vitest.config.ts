import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests (currently just RLS-against-real-Postgres) need
    // Docker and live in their own vitest project — see
    // vitest.integration.config.ts / `npm run test:integration` — so
    // contributors without Docker aren't blocked on the fast unit suite,
    // and this suite's coverage numbers aren't skewed by a slow outlier.
    exclude: ['test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/types.ts'],
      // Regression (LOW): these sat at 80/80/75/80 while actual coverage
      // was ~98.5/99/96.5/99 (stmt/func/branch/line) — a threshold gate
      // that loose wouldn't catch a real coverage regression until it lost
      // roughly 20 points, which is not a meaningful safety net for a
      // security-focused package. Raised to sit a few points below actual,
      // close enough to catch a real regression, with enough headroom that
      // legitimate new code (which is rarely 100% branch-covered on day
      // one) doesn't fail CI outright — re-measure and adjust these when
      // they drift too far from real coverage in either direction.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
