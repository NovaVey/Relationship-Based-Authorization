/**
 * `authz schema compile` / `authz schema publish` / `authz schema diff` /
 * `authz schema rollback` — build spec §7, plus `diff`/`rollback` (not in
 * the original spec — see `src/schema/diff.ts`'s own top doc comment for
 * why "would this candidate silently narrow access" needed a new
 * mechanism, and `getNamespaceConfigVersion`'s doc comment,
 * `src/schema/publish.ts`, for why rollback is just republishing a
 * historical version's own stored source). `compile`/`diff` never touch
 * Postgres to *decide* anything (`diff` reads the current published config
 * to compare against, but never writes); `publish`/`rollback` are the two
 * places this file actually reaches into `namespace_configs`.
 */
import { readFileSync } from 'node:fs';

import { compileSchema } from '../../schema/dsl/compiler.js';
import { formatSchemaError } from '../../schema/dsl/errors.js';
import {
  publishSchema,
  getLatestNamespaceConfig,
  getNamespaceConfigVersion,
} from '../../schema/publish.js';
import { diffNamespace, narrowingWarnings } from '../../schema/diff.js';
import type { CompiledSchema } from '../../schema/dsl/types.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { isValidIdentifier } from '../entity-ref.js';

function readSchemaFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read '${file}': ${(err as Error).message}`);
    return undefined;
  }
}

/** `authz schema compile <file>` — parse + compile, print the config or the error(s). Exit 2 on a bad schema. */
export function compileSchemaFile(file: string): void {
  const source = readSchemaFile(file);
  if (source === undefined) {
    process.exitCode = 2;
    return;
  }

  const result = compileSchema(source);
  if (!result.ok) {
    console.error(`schema: ${result.errors.length} error(s) in '${file}':`);
    for (const error of result.errors) {
      console.error(`  ${formatSchemaError(error)}`);
    }
    process.exitCode = 2;
    return;
  }

  console.log(JSON.stringify(result.schema, null, 2));
}

/** `authz schema publish <file>` — compile and write a new namespace_configs version per namespace. Exit 2 on a bad schema, 3 if Postgres is unreachable. */
export async function publishSchemaFile(file: string): Promise<void> {
  const source = readSchemaFile(file);
  if (source === undefined) {
    process.exitCode = 2;
    return;
  }

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await publishSchema(pool, source);
    if (!result.ok) {
      console.error(`schema: ${result.errors.length} error(s) in '${file}', nothing published:`);
      for (const error of result.errors) {
        console.error(`  ${error}`);
      }
      process.exitCode = 2;
      return;
    }
    for (const { namespace, version } of result.published) {
      console.log(`published ${namespace} v${version}`);
    }
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

/**
 * `authz schema diff <file>` — compiles `file` and, for every namespace it
 * declares, compares it against that namespace's currently-published
 * version (`getLatestNamespaceConfig`) using `src/schema/diff.ts`'s
 * `diffNamespace`. Prints a per-namespace, per-member summary and then a
 * loud `WARNING` block for anything `narrowingWarnings` flags — a removed
 * relation/permission, or a change this module could not prove is a pure
 * widen (see `diff.ts`'s own top doc comment for exactly what that
 * classification does and doesn't guarantee).
 *
 * Deliberately advisory, never blocking a real `publish`: this command
 * never calls `publishSchema` and never writes anything — it exists to be
 * run BEFORE `authz schema publish`, not as a gate wired into it, so a
 * caller who wants "never publish a possibly-narrowing change without a
 * human looking at it first" can script that themselves off this
 * command's own exit code, rather than this project silently deciding that
 * policy for every caller.
 *
 * Exit codes — a new, small table distinct from `compile`/`publish`'s own
 * above, since "a narrowing warning fired" is a genuinely different kind of
 * outcome than either of those two commands' own successes/failures:
 *   0  ran to completion with nothing flagged (every member unchanged/
 *      added/widen, or every namespace in the file has never been
 *      published before — nothing to compare against)
 *   1  ran to completion but at least one relation/permission was flagged
 *      `removed` or `possibly-narrowing` — see this file's own printed
 *      WARNING block for exactly which ones and why
 *   2  the candidate file failed to compile
 *   3  `DATABASE_URL` is not set, or Postgres was unreachable while
 *      fetching a namespace's current published config
 */
export async function diffSchemaFile(file: string): Promise<void> {
  const source = readSchemaFile(file);
  if (source === undefined) {
    process.exitCode = 2;
    return;
  }

  const result = compileSchema(source);
  if (!result.ok) {
    console.error(`schema: ${result.errors.length} error(s) in '${file}':`);
    for (const error of result.errors) {
      console.error(`  ${formatSchemaError(error)}`);
    }
    process.exitCode = 2;
    return;
  }

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    let anyNarrowing = false;
    for (const namespace of Object.keys(result.schema.namespaces)) {
      const oldConfig = await getLatestNamespaceConfig(pool, namespace);
      if (!oldConfig) {
        console.log(`${namespace}: never published before — nothing to compare against`);
        continue;
      }
      const oldSchema: CompiledSchema = { namespaces: { [namespace]: oldConfig } };
      const diff = diffNamespace(oldSchema, result.schema, namespace);

      console.log(`${namespace}:`);
      for (const member of diff.members) {
        const suffix = member.classification ? ` (${member.classification})` : '';
        console.log(`  ${member.kind} ${member.name}: ${member.status}${suffix}`);
      }

      const warnings = narrowingWarnings(diff);
      if (warnings.length > 0) {
        anyNarrowing = true;
        console.log(
          `  WARNING: ${warnings.length} possibly-narrowing change(s) in '${namespace}':`,
        );
        for (const warning of warnings) {
          console.log(`    - ${warning.kind} '${warning.name}': ${warning.reason}`);
        }
      }
    }
    process.exitCode = anyNarrowing ? 1 : 0;
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

/**
 * `authz schema rollback <namespace> <version>` — republishes namespace
 * `namespace`'s `version`-numbered `source_dsl` verbatim through the exact
 * same `publishSchema` path any other publish uses (see
 * `getNamespaceConfigVersion`'s own doc comment for why "rollback" IS just
 * that, and the real, disclosed consequence of it: this can bump more than
 * one namespace's version if `version`'s own source originally published
 * several namespaces together). This creates a brand NEW, later version
 * carrying the old content — it never mutates or resurrects the old row,
 * so `namespace_configs` stays exactly as append-only as it is for every
 * other publish.
 *
 * Exit codes, matching `publishSchemaFile`'s own table where the same
 * outcomes apply, plus one new code for the one outcome unique to this
 * command:
 *   0  rolled back successfully — prints every namespace/version
 *      `publishSchema` actually published, same as `publish`
 *   2  `namespace`/`version` don't name an existing published row, OR
 *      (unexpected, since a stored source_dsl compiled once already, but
 *      handled the same way as `publish`'s own compile-failure path rather
 *      than assumed impossible) that source no longer compiles
 *   3  `DATABASE_URL` is not set, or Postgres was unreachable
 */
export async function rollbackSchema(namespaceRaw: string, versionRaw: string): Promise<void> {
  if (!isValidIdentifier(namespaceRaw)) {
    console.error(`invalid namespace '${namespaceRaw}' — must be a valid identifier`);
    process.exitCode = 2;
    return;
  }
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    console.error(`invalid version '${versionRaw}' — must be a positive integer`);
    process.exitCode = 2;
    return;
  }

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const historical = await getNamespaceConfigVersion(pool, namespaceRaw, version);
    if (!historical) {
      console.error(
        `schema: no published version ${version} found for namespace '${namespaceRaw}'`,
      );
      process.exitCode = 2;
      return;
    }

    const result = await publishSchema(pool, historical.sourceDsl);
    if (!result.ok) {
      console.error(
        `schema: rollback source for ${namespaceRaw} v${version} no longer compiles, nothing published:`,
      );
      for (const error of result.errors) {
        console.error(`  ${error}`);
      }
      process.exitCode = 2;
      return;
    }
    for (const { namespace, version: publishedVersion } of result.published) {
      console.log(`published ${namespace} v${publishedVersion}`);
    }
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
