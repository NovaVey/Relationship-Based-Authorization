// A second, minimal config — not a CLI-flag override of
// `vitest.config.ts`'s own `exclude`, which does not work: vitest's
// `--exclude` CLI flag *appends* to the config's own exclude list rather
// than replacing it (confirmed directly — `--exclude ""` still left
// `*.nightly.test.ts` excluded). This file exists solely to give
// `.github/workflows/schema-verifier.yml`'s own nightly job a clean,
// explicit way to run exactly the file `vitest.config.ts` deliberately
// excludes from every other run.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.nightly.test.ts'],
  },
});
