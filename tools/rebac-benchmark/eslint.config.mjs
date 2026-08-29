// @ts-check
// Deliberately its own config, not a root eslint.config.js edit — this
// tool is scoped to its own directory (docs/BENCHMARK-PROPOSAL.md plus
// tools/rebac-benchmark/ are this change's own file-touch boundary).
// Spreads the ROOT config wholesale (never forked/copied by hand —
// D-114) so this directory gets the identical typed-lint rules as
// everywhere else, then adds only what THIS directory alone needs: a
// `projectService` pointed at this tool's own tsconfig.json.
//
// One deliberate, confirmed-live divergence from
// tools/schema-verifier/eslint.config.mjs's own otherwise-identical
// pattern: that file adds its own `vitest.config.ts`/
// `vitest.nightly.config.ts` to `allowDefaultProject` instead of
// `ignores`. Doing the same here tips a REPO-WIDE, cross-directory limit
// typescript-eslint enforces — `projectService`'s "too many files (>8)
// have matched the default project" safety cap counts every nested
// config's own `allowDefaultProject` matches together, not scoped per
// directory, and a full `npx eslint .` from the repo root was already
// sitting at exactly 8 (the limit) before this tool existed. Adding a
// 9th tipped it into a hard, repo-wide lint failure — confirmed live,
// not theorized. `ignores` instead means this file is never typed-linted
// at all (same treatment root's own config gives `dist/`/`coverage/`),
// which costs nothing real: it is not part of this tool's own logic
// under test, only its test runner's configuration.
import tseslint from 'typescript-eslint';

import rootConfig from '../../eslint.config.js';

export default tseslint.config(
  {
    // Same reasoning as `eslint.config.mjs`'s own self-reference below:
    // plain, unlinted infrastructure, not an exemption from review (both
    // get that from every human/Claude reading them directly).
    ignores: ['eslint.config.mjs', 'vitest.config.ts'],
  },
  ...rootConfig,
  {
    // Relative to this directory once nested-config discovery selects
    // this file as governing — not to the repo root.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // No explicit `project`: `projectService` already auto-discovers
        // this tool's own tsconfig.json per linted file — setting both is
        // a hard typescript-eslint error (confirmed by schema-verifier's
        // own config comment; not re-verified here since the mechanism is
        // identical).
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
