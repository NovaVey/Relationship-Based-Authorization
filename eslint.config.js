// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // examples/ is illustrative documentation code (imports `express`, which
    // is not a dependency of this package) — excluded from lint/typecheck
    // the same way dist/coverage/node_modules are, rather than pulled into
    // the project's strict TS project just to satisfy the linter.
    //
    // doc-examples/ has its own separate, purpose-built tsconfig
    // (doc-examples/tsconfig.json, self-references the built package —
    // see doc-examples/README.md) and its own CI check (`npm run
    // verify:docs`) — same reasoning as examples/, excluded here rather
    // than force-fit into the main strict-typed project.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'examples/**', 'doc-examples/**'],
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
    // Plain Node scripts (not .ts) don't get typescript-eslint's automatic
    // no-undef handling for TS files, so Node's globals need declaring here.
    //
    // The no-unsafe-* rules are also off here: verify-dist-singleton.mjs
    // dynamically imports from dist/, which doesn't exist yet at lint time
    // in a fresh checkout — CI's lint-and-typecheck job never runs build
    // first (it's a separate parallel job), so those imports always type
    // as `any` there. Locally this can go unnoticed if dist/ happens to
    // already exist from a prior manual build, which is exactly how this
    // got missed once already — don't trust a local lint pass here without
    // deleting dist/ first.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
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
  eslintConfigPrettier,
);
