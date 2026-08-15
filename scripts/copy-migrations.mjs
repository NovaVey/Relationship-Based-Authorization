#!/usr/bin/env node
/**
 * `tsc` only compiles `.ts` files — it never copies `src/store/migrations/
 * *.sql` into `dist/`. `src/cli/commands/doctor.ts`'s `MIGRATIONS_DIR`
 * resolves relative to its own compiled location at runtime
 * (`new URL('../../store/migrations', import.meta.url)`), so the *built*
 * CLI (`node dist/cli/index.js doctor`, exactly what `.github/workflows/
 * soundness.yml` runs) needs those `.sql` files physically present at
 * `dist/store/migrations/` — without this step `discoverMigrations` finds
 * zero migrations there and `doctor` reports a misleadingly successful
 * "0/0 applied" against a database that has none of this project's tables.
 * Found live running this project's own build spec §9 Phase 7 workflow
 * against a genuinely fresh database, not by inspection — see
 * `docs/DECISIONS.md`.
 *
 * Plain Node (`fs.cpSync`, cross-platform — no `cp`/shell built-in) so this
 * runs identically on the Windows dev environment build spec rule 8
 * requires and on a Linux CI runner, chained into `npm run build` via `&&`
 * (supported by both POSIX shells and Windows `cmd.exe`, unlike an
 * OS-specific copy command).
 */
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'store', 'migrations');
const dest = join(here, '..', 'dist', 'store', 'migrations');

if (!existsSync(src)) {
  throw new Error(`copy-migrations: source directory not found: ${src}`);
}
cpSync(src, dest, { recursive: true });
console.log(`copied migrations: ${src} -> ${dest}`);
