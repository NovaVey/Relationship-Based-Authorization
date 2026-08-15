#!/usr/bin/env node
/**
 * Type-checks and runs every file in doc-examples/ — see
 * doc-examples/README.md for what that directory is and why it exists (in
 * short: two real bugs shipped in past releases because a doc sample that
 * "looked right" was never actually compiled or run against the real
 * package; this turns that one-off manual sweep into a permanent check).
 *
 * doc-examples/ imports via the package's own public name
 * (@novavey/multi-tenant-security-kit/...), resolved through this repo's
 * own package.json `exports` map against the *built* dist/ — so dist/ must
 * already exist. Run via `npm run verify:docs`, after `npm run build`.
 */

import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));

if (!existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` before `npm run verify:docs`.');
  process.exit(1);
}

let failed = false;

// 1. Typecheck doc-examples/typecheck/*.ts
{
  const result = spawnSync('npx', ['tsc', '--noEmit', '-p', 'doc-examples/tsconfig.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    failed = true;
    console.error('verify:docs — doc-examples/typecheck/*.ts failed to type-check.');
  } else {
    console.log('verify:docs — doc-examples/typecheck/*.ts: OK.');
  }
}

// 2. Run doc-examples/run/*.mjs
{
  const runDir = fileURLToPath(new URL('../doc-examples/run', import.meta.url));
  const files = readdirSync(runDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort();

  for (const file of files) {
    const result = spawnSync(process.execPath, [`doc-examples/run/${file}`], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      failed = true;
      console.error(`verify:docs — doc-examples/run/${file} failed.`);
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('verify:docs — all doc-examples type-check and run correctly. OK.');
