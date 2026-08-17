#!/usr/bin/env node
/**
 * `authz` — the CLI surface described in
 * .claude/commands/build-authz-service.md §7. Only commands that actually
 * exist are registered; a stub for a command before its phase lands would
 * be exactly the "half-finished implementation" this project's own rules
 * warn against.
 */
import { Command, CommanderError } from 'commander';

import { doctor } from './commands/doctor.js';
import { compileSchemaFile, publishSchemaFile } from './commands/schema.js';
import { tupleWrite, tupleDelete } from './commands/tuple.js';
import { check } from './commands/check.js';
import { soundnessRun } from './commands/soundness.js';
import { expandCli } from './commands/expand.js';
import { serve } from './commands/serve.js';

const packageName = 'authz';
const packageVersion = '0.1.0'; // kept in sync with package.json by hand until a version-injection step exists

const program = new Command();

program
  .name(packageName)
  .description('Relationship-based authorization service CLI')
  .version(packageVersion)
  // Makes Commander throw a `CommanderError` instead of calling
  // `process.exit` directly on a usage error (its own documented
  // mechanism) — see the `try`/`catch` around `parseAsync` below for why.
  .exitOverride();

program
  .command('doctor')
  .description('Check that DATABASE_URL is reachable and report migration status')
  .action(async () => {
    await doctor();
  });

const schema = program.command('schema').description('Namespace DSL schema operations');

schema
  .command('compile')
  .description('Parse and compile a namespace DSL file; print the config or the error(s)')
  .argument('<file>', 'path to a .authz schema file')
  .action((file: string) => {
    compileSchemaFile(file);
  });

schema
  .command('publish')
  .description('Compile a namespace DSL file and write a new namespace_configs version')
  .argument('<file>', 'path to a .authz schema file')
  .action(async (file: string) => {
    await publishSchemaFile(file);
  });

const tuple = program.command('tuple').description('Relation tuple operations');

tuple
  .command('write')
  .description('Write a relation tuple; prints the returned consistency token')
  .argument('<object>', "namespace:id, e.g. 'document:readme'")
  .argument('<relation>', 'relation name')
  .argument(
    '<subject>',
    "namespace:id or namespace:id#relation, e.g. 'user:alice' or 'group:eng#member'",
  )
  .action(async (object: string, relation: string, subject: string) => {
    await tupleWrite(object, relation, subject);
  });

tuple
  .command('delete')
  .description('Delete a relation tuple; prints the returned consistency token')
  .argument('<object>', "namespace:id, e.g. 'document:readme'")
  .argument('<relation>', 'relation name')
  .argument(
    '<subject>',
    "namespace:id or namespace:id#relation, e.g. 'user:alice' or 'group:eng#member'",
  )
  .action(async (object: string, relation: string, subject: string) => {
    await tupleDelete(object, relation, subject);
  });

program
  .command('check')
  .description('Check whether a subject has a relation or permission on an object')
  .argument('<subject>', "namespace:id, e.g. 'user:alice'")
  .argument('<relation>', 'relation or permission name')
  .argument('<object>', "namespace:id, e.g. 'document:readme'")
  .option(
    '--at-token <n>',
    'pin the check to a consistency token returned by an earlier write/delete',
  )
  .option('--path', 'print the real resolution path an ALLOWED result was reached through')
  .action(
    async (
      subject: string,
      relation: string,
      object: string,
      options: { atToken?: string; path?: boolean },
    ) => {
      await check(subject, relation, object, options);
    },
  );

program
  .command('expand')
  .description('Print the resolved subject tree for a relation or permission on an object')
  .argument('<object>', "namespace:id, e.g. 'document:readme'")
  .argument('<relation>', 'relation or permission name')
  .action(async (object: string, relation: string) => {
    await expandCli(object, relation);
  });

const soundness = program.command('soundness').description('Differential-soundness fuzzing');

soundness
  .command('run')
  .description(
    "Run Phase 5's differential fuzz against both resolvers; print and persist the report",
  )
  .option('--queries <n>', 'number of random queries to run (defaults to SOUNDNESS_FUZZ_QUERIES)')
  .option('--seed <s>', 'reproduce a specific run (defaults to SOUNDNESS_FUZZ_SEED, else random)')
  .option('--format <text|markdown|json>', 'output format (default: text)')
  .option(
    '--dry-run',
    'run for real and print the same result, but delete every row this run creates before returning — nothing persists',
  )
  .option(
    '--progress <n>',
    'print "checked X/Y queries" to stderr every n completed queries (default: no progress output)',
  )
  .action(
    async (options: {
      queries?: string;
      seed?: string;
      format?: string;
      dryRun?: boolean;
      progress?: string;
    }) => {
      await soundnessRun(options);
    },
  );

program
  .command('serve')
  .description('Start the Fastify API server (check/expand/write/schema over HTTP)')
  .action(async () => {
    await serve();
  });

/**
 * With no `exitOverride()`, Commander calls `process.exit` directly from
 * deep inside `parseAsync` on any usage error (a typo'd flag, a missing
 * argument, an unknown subcommand) — *before* control ever reaches an
 * individual command's own `.action()` handler. That default exit code is
 * always `1` (confirmed by reading `node_modules/commander/lib/command.js`
 * directly: every real usage error funnels through `Command.error()`,
 * whose own `exitCode = config.exitCode || 1` default is never overridden
 * with anything else anywhere in that library) — which collides with
 * `authz soundness run`'s own security-significant exit code 1 ("verdict
 * unsound — at least one `false_grant`, always blocking", see
 * `src/cli/commands/soundness.ts`'s own top-of-file exit-code table): a
 * plain CLI usage mistake would exit with the exact same code this project
 * reserves for a real, blocking security finding, indistinguishable to any
 * script or CI step that branches on exit code alone (full-repo audit
 * finding #16, MEDIUM, 2026-08-16 — see `docs/DECISIONS.md`).
 *
 * `exitOverride()` above makes Commander throw that same `CommanderError`
 * here instead, so it can be remapped before anything actually exits.
 * Commander itself only ever constructs two exit codes — confirmed by the
 * same source read, no other value is ever passed to `_exit`/`CommanderError`
 * anywhere in `commander/lib/*.js`: `0` for `--help`/`--version` (a
 * non-error display, left untouched) and `1` for every real usage error,
 * remapped here to `2` — this project's own established "malformed
 * argument" convention, already used by every command's own argument
 * validation (e.g. `soundnessRun`'s `--queries`/`--format` checks,
 * `check.ts`'s `--at-token` check) — so a Commander-level usage error now
 * reads identically to every other kind of malformed-CLI-input failure,
 * and never collides with `0`, `1`, or `3` as used anywhere in this CLI.
 */
try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (!(err instanceof CommanderError)) throw err;
  process.exitCode = err.exitCode === 1 ? 2 : err.exitCode;
}
