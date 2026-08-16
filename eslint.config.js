// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // .claude/workflows/**: Workflow-tool scripts, not conventional ES
    // modules — they use a bare top-level `await`/`return` (the Workflow
    // tool wraps the whole file body in an async function at run time; see
    // its own tool description). A plain top-level `return` crashes
    // typescript-eslint's typed rules (confirmed live:
    // `@typescript-eslint/no-misused-promises` throws "Non-null Assertion
    // Failed: Expected node to have a parent" trying to walk up from the
    // return statement to its enclosing function, which doesn't exist at
    // module scope) rather than reporting a normal lint error — excluding
    // them here, the same way dist/coverage/node_modules already are, is
    // the correct fix, not a looser `allowDefaultProject` entry (tried
    // first; it gets past the "not found by project service" error but
    // hits this same crash once actually parsed).
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.claude/workflows/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.js', '*.config.ts', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
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
  {
    // `deletePublishedNamespaceVersion` (src/schema/publish.ts) exists for
    // exactly one caller — src/soundness/runner.ts's dry-run cleanup — per
    // that function's own doc comment (full-repo audit finding #26). This
    // block turns that "must not be reached for general use" contract into
    // a lint failure for anyone but that one caller, rather than leaving it
    // enforced only by the comment. `patterns` (gitignore-style glob over
    // the import *specifier text*) rather than `paths` (exact string
    // match): every current importer of src/schema/publish.ts uses a
    // different `../` depth depending on its own location
    // (`../schema/publish.js`, `../../schema/publish.js`,
    // `../../../src/schema/publish.js`, ...), and `**/schema/publish.js`
    // matches all of them uniformly instead of needing one literal entry
    // per depth (and silently missing a future importer at a depth nobody
    // listed). The second, unanchored `publish.js` entry covers the one
    // depth `**/schema/publish.js` can't reach on its own: a hypothetical
    // future file added directly inside src/schema/ itself, sibling to
    // publish.ts, importing it via `./publish.js` (no `schema/` segment in
    // that specifier at all) — verified both patterns' actual match
    // behavior directly against the `ignore` package this rule uses
    // internally across every real specifier shape above plus that one,
    // not assumed from reading the rule's docs alone. Scoped to
    // `src/**/*.ts` only — see `deletePublishedNamespaceVersion`'s own doc
    // comment for why `test/**` is deliberately excluded (a legitimate
    // test spies on this exact export via a namespace import, which this
    // rule would also flag).
    files: ['src/**/*.ts'],
    ignores: ['src/soundness/runner.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/schema/publish.js', 'publish.js'],
              importNames: ['deletePublishedNamespaceVersion'],
              message:
                'deletePublishedNamespaceVersion exists for exactly one caller — ' +
                "src/soundness/runner.ts's dry-run cleanup. See its own doc comment " +
                'in src/schema/publish.ts before adding a new caller.',
            },
          ],
        },
      ],
    },
  },
  {
    // Plain Node ESM tooling scripts run directly by `npm run build` /
    // .github/workflows/*.yml — never part of the type-checked src/ build
    // (see eslint.config.js's own `allowDefaultProject` entry for these),
    // so they fall back to loosely-typed `any` under the default project
    // and need Node's own runtime globals declared by hand rather than
    // through tsconfig's `lib`/`types`.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  eslintConfigPrettier,
);
