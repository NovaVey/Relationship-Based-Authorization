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
import {
  compileSchemaFile,
  publishSchemaFile,
  diffSchemaFile,
  rollbackSchema,
} from './commands/schema.js';
import { tupleWrite, tupleDelete } from './commands/tuple.js';
import { check } from './commands/check.js';
import { soundnessRun } from './commands/soundness.js';
import { expandCli } from './commands/expand.js';
import { serve } from './commands/serve.js';
import { auditVerify, auditAnchor } from './commands/audit.js';
import { apikeyCreate, apikeyRevoke, apikeyList } from './commands/apikey.js';
import { privescCli } from './commands/privesc.js';
import { leopardRefresh, leopardStatus } from './commands/leopard.js';

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

schema
  .command('diff')
  .description(
    "Compile a namespace DSL file and compare it against each namespace's currently-published version, warning about any change that isn't a provable widen",
  )
  .argument('<file>', 'path to a .authz schema file')
  .action(async (file: string) => {
    await diffSchemaFile(file);
  });

schema
  .command('rollback')
  .description(
    'Republish a namespace at an earlier published version, exactly as originally compiled',
  )
  .argument('<namespace>', 'namespace name')
  .argument('<version>', 'the published version number to roll back to')
  .action(async (namespace: string, version: string) => {
    await rollbackSchema(namespace, version);
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
  .option(
    '--expires-at <iso8601>',
    'optional validity-window expiry (ISO-8601) — the tuple is treated as absent once this instant passes (D-144)',
  )
  .action(
    async (object: string, relation: string, subject: string, options: { expiresAt?: string }) => {
      await tupleWrite(object, relation, subject, options);
    },
  );

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
    '--at-token <token>',
    'pin the check to the opaque consistency token returned by an earlier write/delete',
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

// Full-repo audit finding #13 (2026-08-29): this description no longer
// covered its own contents once `privesc` (a privilege-escalation/policy-
// drift scanner, unrelated to hash chains) was nested under this group —
// a user skimming top-level `--help` for it had no textual signal that
// `audit` is where to look.
const audit = program
  .command('audit')
  .description('Audit-trail integrity and access-policy review operations');

audit
  .command('verify')
  .description(
    "Walk the checks table's hash chain and report either every chained row verified " +
      '(chain intact) or the first row whose stored hash does not match a fresh recomputation',
  )
  .option(
    '--anchor-file <path>',
    'also compare against every entry in this out-of-band anchor file (authz audit anchor) — ' +
      'detects a full, consistent forward chain rewrite the internal walk alone cannot (D-148)',
  )
  .action(async (options: { anchorFile?: string }) => {
    await auditVerify(options);
  });

audit
  .command('anchor')
  .description(
    "Append one new entry recording the checks hash chain's current tip to a local, " +
      'append-only file — the out-of-band anchor D-148 names as the fix for a privileged ' +
      'database user rewriting the chain forward consistently',
  )
  .option(
    '--file <path>',
    'anchor file to append to (defaults to ./audit-anchor.ndjson in the current working directory)',
  )
  .action(async (options: { file?: string }) => {
    await auditAnchor(options);
  });

// Real, mintable, DB-backed API keys (src/api/db-api-keys.ts) — a third
// credential tier alongside the two static env-var keys (ADMIN_API_KEY/
// READONLY_API_KEY). See src/cli/commands/apikey.ts's own top-of-file doc
// comment for the full CLI contract and exit-code table.
const apikey = program
  .command('apikey')
  .description(
    'Real, DB-backed API key operations — a third credential tier alongside ADMIN_API_KEY/READONLY_API_KEY',
  );

apikey
  .command('create')
  .description('Create a new API key; prints the raw key exactly once')
  .requiredOption('--role <admin|readonly>', 'the role this key authorizes')
  .option(
    '--scope <ns1,ns2>',
    'comma-separated namespace names this key is restricted to (omit for unscoped — every namespace)',
  )
  .option(
    '--expires-at <iso8601>',
    'an ISO 8601 timestamp this key stops working at (omit for never-expiring)',
  )
  .option('--name <label>', 'a human-readable label for this key (defaults to a generated name)')
  .action(async (options: { role: string; scope?: string; expiresAt?: string; name?: string }) => {
    await apikeyCreate(options);
  });

apikey
  .command('revoke')
  .description('Revoke an API key by id; the key is rejected immediately on every future use')
  .argument('<id>', 'the numeric id printed by `authz apikey list`/`create`')
  .action(async (id: string) => {
    await apikeyRevoke(id);
  });

apikey
  .command('list')
  .description('List every API key (id, name, role, scopes, timestamps) — never a hash or raw key')
  .action(async () => {
    await apikeyList();
  });

audit
  .command('privesc')
  .description(
    'Report every real subject currently able to reach a relation or permission on an ' +
      'object, each with its own real resolution path — a policy-drift detector for a ' +
      'security reviewer',
  )
  .argument('<object>', "namespace:id, e.g. 'document:sensitive-doc'")
  .argument('<relation>', 'relation or permission name')
  .option(
    '--expected <subjects>',
    "comma-separated 'namespace:id' allow-list; flags any other subject found as " +
      'UNEXPECTED and any listed subject not found as MISSING',
  )
  .action(async (object: string, relation: string, options: { expected?: string }) => {
    await privescCli(object, relation, options);
  });

// The Leopard index (Phase A, docs/LEOPARD-INDEX-PROPOSAL.md) — an opt-in,
// offline-computed acceleration structure for pinned relation-membership
// checks. See src/cli/commands/leopard.ts's own top-of-file doc comment
// for the full CLI contract and exit-code table.
const leopard = program
  .command('leopard')
  .description(
    'Leopard-index (nested-group membership acceleration) operational commands — see docs/LEOPARD-INDEX-PROPOSAL.md',
  );

leopard
  .command('refresh')
  .description(
    'Rebuild the Leopard index from the current relation_tuples; runnable regardless of LEOPARD_INDEX_ENABLED',
  )
  .option(
    '--dry-run',
    'compute the rebuild for real and report the result, but roll back — nothing is persisted',
  )
  .option('--format <text|json>', 'output format (default: text)')
  .action(async (options: { dryRun?: boolean; format?: string }) => {
    await leopardRefresh(options);
  });

leopard
  .command('status')
  .description(
    'Report the Leopard index freshness state — disabled, enabled-never-built, or enabled-built',
  )
  .option('--format <text|json>', 'output format (default: text)')
  .action(async (options: { format?: string }) => {
    await leopardStatus(options);
  });

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
