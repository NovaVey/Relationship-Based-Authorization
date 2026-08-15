/**
 * `authz schema compile` / `authz schema publish` — build spec §7.
 * `compile` never touches Postgres (pure, per Phase 1); `publish` is the
 * one place a schema file actually reaches the database.
 */
import { readFileSync } from 'node:fs';

import { compileSchema } from '../../schema/dsl/compiler.js';
import { formatSchemaError } from '../../schema/dsl/errors.js';
import { publishSchema } from '../../schema/publish.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';

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
