#!/usr/bin/env node
/**
 * `authz` — the CLI surface described in
 * .claude/commands/build-authz-service.md §7. Only commands that actually
 * exist are registered; a stub for a command before its phase lands would
 * be exactly the "half-finished implementation" this project's own rules
 * warn against. Not yet registered: `serve` (Phase 8).
 */
import { Command } from 'commander';

import { doctor } from './commands/doctor.js';
import { compileSchemaFile, publishSchemaFile } from './commands/schema.js';
import { tupleWrite, tupleDelete } from './commands/tuple.js';
import { check } from './commands/check.js';
import { soundnessRun } from './commands/soundness.js';
import { expandCli } from './commands/expand.js';

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
  .action(
    async (subject: string, relation: string, object: string, options: { atToken?: string }) => {
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
  .action(async (options: { queries?: string; seed?: string }) => {
    await soundnessRun(options);
  });

await program.parseAsync(process.argv);
