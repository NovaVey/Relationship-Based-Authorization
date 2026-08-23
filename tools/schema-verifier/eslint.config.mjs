// @ts-check
// Deliberately its own config, not a root eslint.config.js edit — same
// branch-discipline reason as tsconfig.json/vitest.config.ts's own
// comments: this branch is scoped to tools/schema-verifier/ plus two docs
// files. Spreads the ROOT config wholesale (never forked/copied by hand —
// see D-114 on why a second copy of anything this project already has one
// of is a drift risk to avoid) so this directory gets the exact same
// typed-lint rules as everywhere else, then adds only what this directory
// alone needs: a `projectService` pointed at this tool's own tsconfig.json
// (matching how tsconfig.json/vitest.config.ts already look outside their
// own directory for the same "import the parser, don't reimplement it"
// reason), an `allowDefaultProject` entry for this tool's own
// vitest.config.ts, and the identical test-file rule relaxation the root
// config already grants `test/**/*.ts` — whose glob, anchored at the repo
// root, does not reach `tools/schema-verifier/test/**` on its own.
import tseslint from 'typescript-eslint';

import rootConfig from '../../eslint.config.js';

export default tseslint.config(
  {
    // This file's own self-reference is the one case nested-config
    // discovery can't resolve cleanly (confirmed live: even with itself
    // listed in its own `allowDefaultProject` below, ESLint still governs
    // its own parsing with the root config's list, not this one) — same
    // treatment root's own config gives `dist/`/`coverage/`/etc.: plain,
    // unlinted infrastructure, not a claim this file's contents are
    // exempt from real review (they get that from every human/Claude
    // reading it directly).
    ignores: ['eslint.config.mjs'],
  },
  ...rootConfig,
  {
    // `files` here is relative to *this config file's own directory*
    // once ESLint's nested-config discovery selects it as the governing
    // config for a file under `tools/schema-verifier/` — not to the repo
    // root the way the spread-in `rootConfig` blocks' own `files`
    // patterns are (confirmed empirically: a `tools/schema-verifier/`-
    // prefixed pattern here never matched anything at all, silently).
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Also relative to this directory — matches this file's own
          // bare name, not a `tools/schema-verifier/`-prefixed one.
          allowDefaultProject: [
            'vitest.config.ts',
            'vitest.nightly.config.ts',
            'eslint.config.mjs',
          ],
        },
        // No explicit `project` here: `projectService` (above) already
        // auto-discovers the nearest real tsconfig.json per linted file
        // (this tool's own `tools/schema-verifier/tsconfig.json` for
        // everything under `src/`/`test/`) — setting both is a hard
        // typescript-eslint error ("project does nothing when
        // projectService is enabled"), confirmed live.
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
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
