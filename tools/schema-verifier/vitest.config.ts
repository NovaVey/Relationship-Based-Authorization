// Deliberately its own config, not a root `vitest.config.ts` edit — see
// `tsconfig.json`'s own comment on why: this branch's file-touch
// discipline scopes it to `tools/schema-verifier/` plus two docs files.
// The root config's `test.include` (`test/**/*.test.ts`) would never
// discover a test file living under `tools/schema-verifier/test/` anyway
// — this file exists so `npx vitest run --config
// tools/schema-verifier/vitest.config.ts` (or `--root
// tools/schema-verifier`) can run this module's own suite independently,
// without the root project's config ever needing to know this directory
// exists.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // §8b's own nightly differential job (k = 3, "up to 3 objects per
    // type," build spec's own wording) is deliberately excluded from the
    // default (PR-speed) run — matching this repo's own root
    // vitest.config.ts precedent for `*.integration.test.ts` — since it's
    // explicitly meant to be slow ("this is slow and that's fine; run it
    // nightly, not on PRs"). Run it directly with `npx vitest run --config
    // tools/schema-verifier/vitest.nightly.config.ts`; see that file's own
    // comment for why a second config exists instead of an `--exclude`
    // flag here. Actual CI scheduling (a workflow that runs this on a
    // cron) is deliberately deferred to §9, "CLI and CI" — see
    // docs/DECISIONS.md D-120 — and stays outside this branch's own
    // file-touch discipline until then.
    exclude: ['**/*.nightly.test.ts'],
  },
});
