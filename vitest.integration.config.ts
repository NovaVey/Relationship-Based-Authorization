import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts (the fast, Docker-free unit suite run by
// `npm test`) — these tests start real containers (currently Postgres, via
// testcontainers) and can take significantly longer, so they're opt-in via
// `npm run test:integration` and run as their own CI job rather than
// gating the default test suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    // Container startup (image pull + Postgres boot) can take a while,
    // especially on a cold CI cache — give it more room than the unit
    // suite's default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
