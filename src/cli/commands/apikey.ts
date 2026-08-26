/**
 * `authz apikey create|revoke|list` — CLI surface for the real, mintable,
 * DB-backed API-key credential tier (`src/api/db-api-keys.ts`, migration
 * `0007_api_keys.sql`), a third tier alongside the two static env-var keys
 * (`ADMIN_API_KEY`/`READONLY_API_KEY`, `src/api/auth.ts`). Mirrors this
 * project's own established CLI shape exactly — `src/cli/commands/
 * tuple.ts`'s validate-then-connect-then-report structure, `src/cli/
 * commands/audit.ts`'s "print exactly what happened, nothing vaguer"
 * output discipline, and every command's own `DATABASE_URL` check +
 * `getPool()`/`closePool()` lifecycle.
 *
 * Exit codes follow §7's table as every other command in this CLI already
 * applies it (see `tuple.ts`): 0 the operation completed and printed a
 * real answer, 2 a malformed argument (bad `--role`, bad `--scope` entry,
 * a non-future `--expires-at`, a non-numeric `revoke` id, an id that
 * doesn't name a currently-active key), 3 an infrastructure failure
 * (`DATABASE_URL` unset, or a thrown error from `db-api-keys.ts` once a
 * pool exists). Every malformed-argument check below runs BEFORE the
 * `DATABASE_URL` check, same as `tuple.ts`'s own `tupleWrite`/`tupleDelete`
 * — a bad flag is reported as the argument error it is regardless of
 * whether a database happens to be configured.
 */
import { createApiKey, revokeApiKey, listApiKeys, type ApiKeyRole } from '../../api/db-api-keys.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { isValidIdentifier } from '../entity-ref.js';
import { MAX_IDENTIFIER_LENGTH } from '../../schema/dsl/types.js';

function isValidRole(value: string): value is ApiKeyRole {
  return value === 'admin' || value === 'readonly';
}

/**
 * `--scope ns1,ns2` -> `['ns1', 'ns2']`. Returns `undefined` when `raw`
 * itself is `undefined` (the flag was never passed at all — an unscoped
 * key). Whitespace around each name is trimmed (`--scope 'ns1, ns2'` reads
 * the same as `--scope ns1,ns2`) and empty segments are dropped (a
 * trailing comma or doubled comma doesn't silently produce a
 * zero-length "namespace"). Does NOT reject a resulting empty array
 * itself — `apikeyCreate` below does that explicitly, with a message
 * naming exactly why `--scope ''`/`--scope ','` isn't the same request as
 * omitting `--scope` altogether.
 */
function parseScopeFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export interface ApiKeyCreateOptions {
  role: string;
  scope?: string;
  expiresAt?: string;
  name?: string;
}

export async function apikeyCreate(options: ApiKeyCreateOptions): Promise<void> {
  if (!isValidRole(options.role)) {
    console.error(`invalid --role '${options.role}' — must be 'admin' or 'readonly'`);
    process.exitCode = 2;
    return;
  }
  // `options.role` is narrowed to `ApiKeyRole` from here on — captured into
  // its own binding so every later reference (the DB call, the printed
  // summary) sees the narrowed type, not the original `string` parameter.
  const role: ApiKeyRole = options.role;

  const scopes = parseScopeFlag(options.scope);
  if (scopes !== undefined) {
    if (scopes.length === 0) {
      console.error(
        'invalid --scope — must name at least one namespace (e.g. --scope document,folder); ' +
          'omit --scope entirely for an unscoped key instead of passing an empty value',
      );
      process.exitCode = 2;
      return;
    }
    for (const ns of scopes) {
      if (!isValidIdentifier(ns)) {
        console.error(
          `invalid --scope namespace '${ns}' — must be a valid identifier (lowercase snake_case, ` +
            `starts with a letter, ≤${MAX_IDENTIFIER_LENGTH} characters)`,
        );
        process.exitCode = 2;
        return;
      }
    }
  }

  let expiresAt: Date | undefined;
  if (options.expiresAt !== undefined) {
    const parsed = new Date(options.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      console.error(
        `invalid --expires-at '${options.expiresAt}' — must be a valid ISO 8601 timestamp`,
      );
      process.exitCode = 2;
      return;
    }
    if (parsed.getTime() <= Date.now()) {
      console.error(`invalid --expires-at '${options.expiresAt}' — must be in the future`);
      process.exitCode = 2;
      return;
    }
    expiresAt = parsed;
  }

  if (options.name !== undefined && options.name.trim().length === 0) {
    console.error('invalid --name — must not be empty or all whitespace');
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
    const result = await createApiKey(pool, {
      name: options.name ?? `${role}-key-${new Date().toISOString()}`,
      role,
      ...(scopes !== undefined ? { scopes } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });

    const scopeSummary = scopes ? `scoped to: ${scopes.join(', ')}` : 'unscoped — every namespace';
    const expirySummary = expiresAt ? `expires ${expiresAt.toISOString()}` : 'never expires';
    console.log(
      `API key created — id ${result.id}, role ${role}, ${scopeSummary}, ${expirySummary}.`,
    );
    console.log('');
    console.log('================================================================');
    console.log('  RAW KEY — THIS WILL NEVER BE SHOWN AGAIN. Store it now:');
    console.log('');
    console.log(`  ${result.rawKey}`);
    console.log('');
    console.log('  If this is lost, there is no way to recover it — revoke this');
    console.log('  key (`authz apikey revoke <id>`) and create a new one instead.');
    console.log('================================================================');
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

export async function apikeyRevoke(idRaw: string): Promise<void> {
  // Pure, DB-free shape check before this reaches `revokeApiKey` (which
  // performs the identical check again — defense in depth, not redundant,
  // mirroring `tupleWrite`'s own identical two-layer `validateIdentifiers`
  // precedent — a future caller of `revokeApiKey` directly still gets the
  // same guard even if it bypasses this CLI command entirely). Failing
  // here first means a non-numeric id is reported as the argument error it
  // is (exit code 2) regardless of whether `DATABASE_URL` happens to be
  // configured, matching every other command in this CLI.
  if (!/^\d+$/.test(idRaw)) {
    console.error(`invalid api key id '${idRaw}' — must be a non-negative integer`);
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
    const revoked = await revokeApiKey(pool, idRaw);
    if (!revoked) {
      console.error(
        `no active api key with id '${idRaw}' — either it doesn't exist or it was already revoked`,
      );
      process.exitCode = 2;
      return;
    }
    console.log(`API key ${idRaw} revoked.`);
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

/** `revokedAt`/`expiresAt` -> the one-word status `apikeyList` prints — never a hash or raw key, mirroring `listApiKeys`'s own "never selects key_hash, by construction" contract one layer up. */
function apiKeyStatus(expiresAt: Date | null, revokedAt: Date | null): string {
  if (revokedAt !== null) return `revoked ${revokedAt.toISOString()}`;
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    return `expired ${expiresAt.toISOString()}`;
  }
  return 'active';
}

export async function apikeyList(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const keys = await listApiKeys(pool);
    if (keys.length === 0) {
      console.log('(no API keys exist)');
      return;
    }
    for (const key of keys) {
      const scopeText = key.scopes ? key.scopes.join(',') : '(unscoped)';
      console.log(
        `${key.id}\trole=${key.role}\tstatus=${apiKeyStatus(key.expiresAt, key.revokedAt)}\t` +
          `scopes=${scopeText}\tname=${key.name}`,
      );
    }
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
