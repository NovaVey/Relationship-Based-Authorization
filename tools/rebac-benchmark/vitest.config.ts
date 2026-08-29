// Deliberately standalone, matching `tsconfig.json`'s own reasoning
// (this tool's own doc comment there): no `authz`/OpenFGA/SpiceDB
// instance is reachable from these tests, and none is needed — they
// cover only the engine-agnostic pieces (`src/workload.ts`, `src/prng.ts`,
// `src/stats.ts`) that have no network dependency at all. Everything that
// DOES need a live engine is exercised by actually running the harness
// (see README.md), not by a mocked unit test pretending to be one.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
