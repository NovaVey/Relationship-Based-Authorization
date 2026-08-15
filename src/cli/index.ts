#!/usr/bin/env node
/**
 * `authz` — the CLI surface described in
 * .claude/commands/build-authz-service.md §7. Only commands that actually
 * exist are registered; a stub for `schema`/`tuple`/`check`/etc. before
 * their phases land would be exactly the "half-finished implementation"
 * this project's own rules warn against. `doctor` is the one real command
 * so far (Phase 0) — everything else appears here as its phase lands.
 */
import { Command } from 'commander';

import { doctor } from './commands/doctor.js';

const packageName = 'authz';
const packageVersion = '0.1.0'; // kept in sync with package.json by hand until a version-injection step exists

const program = new Command();

program
  .name(packageName)
  .description('Relationship-based authorization service CLI')
  .version(packageVersion);

program
  .command('doctor')
  .description('Check that DATABASE_URL is reachable and report migration status')
  .action(async () => {
    await doctor();
  });

await program.parseAsync(process.argv);
