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
