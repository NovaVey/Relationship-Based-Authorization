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
 *
 * `dest` is removed before every copy — a full-repo audit finding
 * (`docs/DECISIONS.md`, the entry documenting this fix): `cpSync` alone is
 * a *merge*, not a mirror, and `npm run build` never cleans `dist/` first
 * (it's gitignored, so it persists across incremental local builds). A
 * migration deleted or renamed in `src/` would otherwise silently survive
 * in a stale `dist/`, and `discoverMigrations` (`src/store/migrate.ts`)
 * applies every `*.sql` file it finds there with no cross-check against
 * `src/` — the built CLI could re-apply a migration nobody intends to run
 * anymore. CI is unaffected either way (every job starts from a fresh
 * checkout, so `dest` never pre-exists before this runs), but local
 * incremental builds are exactly where this bites.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'store', 'migrations');
const dest = join(here, '..', 'dist', 'store', 'migrations');

if (!existsSync(src)) {
  throw new Error(`copy-migrations: source directory not found: ${src}`);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`copied migrations: ${src} -> ${dest}`);
