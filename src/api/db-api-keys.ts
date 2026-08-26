/**
 * Real, mintable, DB-backed API keys — a third credential tier alongside
 * this project's two static env-var keys, `ADMIN_API_KEY`/`READONLY_API_KEY`
 * (`src/api/auth.ts`, `migration 0008_api_keys.sql`). Where the static keys
 * are a fixed pair of secrets baked into a deployment's environment, a row
 * in `api_keys` is a real credential an operator can mint, scope to a
 * subset of namespaces, time-box, and revoke on demand — everything
 * `docs/DECISIONS.md` D-064's own "Revisit if" clause anticipated the
 * static two-tier scheme would eventually need once a deployment had more
 * than a couple of caller classes to manage.
 *
 * This file owns exactly the credential's own lifecycle — generate, hash,
 * store, list, revoke, validate — and nothing about HTTP, Fastify, or which
 * routes a given role/scope may reach. `src/api/auth.ts`'s
 * `checkAdminAuthDb`/`checkReadAuthDb` are the only callers of
 * `validateDbApiKey`; `src/cli/commands/apikey.ts` is the only caller of
 * `createApiKey`/`revokeApiKey`/`listApiKeys`. Nothing here decides how a
 * `role`/`scopes` pair gets enforced against a specific request — that's
 * `src/api/server.ts`'s job, the same "this file only computes a result;
 * something else decides what a route does with it" division `src/api/
 * responses.ts`'s own top-of-file doc comment already establishes for a
 * different pair of concerns.
 *
 * ---
 *
 * **The raw key is never stored, anywhere, in any form that could be
 * reversed back into it.** `key_hash` is a plain SHA-256 hex digest
 * (`hashApiKey`) of the raw key — a deterministic *lookup* key, not a
 * secret this table needs its own confidentiality protection for: even a
 * full dump of `api_keys` (or a stray `select *`, or `authz apikey list`)
 * never hands back a usable credential. This is deliberately plain SHA-256
 * via `node:crypto`'s `createHash`, **not** `timingSafeEqual` or a
 * slow/salted KDF like `scrypt`/`bcrypt` — and that's a real, considered
 * choice, not an oversight: `src/api/auth.ts`'s static-key comparison
 * (`safeEqual`) needs `timingSafeEqual` because it's comparing a supplied
 * value against one *specific*, already-known secret, where response-time
 * variance could leak how many leading bytes matched. `validateDbApiKey`
 * below is a different shape of operation entirely — a **lookup**, not a
 * compare-against-one-known-value — matching a supplied raw key against
 * whichever of potentially many stored rows (if any) it hashes to, via an
 * indexed `where key_hash = $1` equality lookup. There is no
 * "how-many-bytes-matched" timing channel to close for an *index lookup*:
 * either the hash exists as a key in the index or it doesn't, and a plain
 * SHA-256 digest already gives that lookup exactly what it needs (a fast,
 * deterministic, effectively-collision-free key) — the way a real API-key
 * system (Stripe's, GitHub's) uses a fast digest for lookup and reserves
 * constant-time comparison for a different step, if at all. A KDF's own
 * deliberate slowness (`scrypt`'s whole point is making a brute-force
 * *guessing* attack expensive) buys nothing extra here either: the raw key
 * this file mints is 256 bits of `crypto.randomBytes` (`generateRawApiKey`)
 * — an offline brute-force search over the *hash* is already computationally
 * infeasible regardless of how fast or slow the hash function is, so a slow
 * KDF would only add real per-request latency to every legitimate lookup
 * for a threat model plain high-entropy generation already closes.
 *
 * **Revocation and expiry are enforced in exactly one place, one query,
 * every time.** `validateDbApiKey`'s own `select` carries `revoked_at is
 * null and (expires_at is null or expires_at > now())` directly in its
 * `WHERE` clause — never a separate post-fetch check in application code
 * that a future edit could accidentally skip. A revoked or expired key is
 * indistinguishable, from this function's own return type, from a key that
 * was never minted at all (`null`, either way) — `src/api/auth.ts`'s
 * callers never see *why* a lookup failed, matching `checkAdminAuth`'s own
 * established "a wrong key and an absent key both just fail" discipline
 * (never leak which specific reason a credential didn't work).
 */
import { randomBytes, createHash } from 'node:crypto';

import type { QueryExecutor } from '../store/query-executor.js';
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../schema/dsl/types.js';

/** Mirrors `checkAdminAuth`/`checkReadAuth`'s own two-tier split exactly — see the `0008_api_keys.sql` migration's own `role` column comment for why there is, and will only ever be, exactly these two values. */
export type ApiKeyRole = 'admin' | 'readonly';

// ---------------------------------------------------------------------------
// Generation and hashing
// ---------------------------------------------------------------------------

/**
 * A fresh, 256-bit random secret — `crypto.randomBytes(32)` (a real,
 * cryptographically-secure source, `node:crypto`'s own CSPRNG, never
 * `Math.random()`), base64url-encoded so the printed key is a single
 * `[A-Za-z0-9_-]` token safe to paste into a shell argument, an
 * `Authorization: Bearer <key>` header, or a `.env` file with no quoting or
 * escaping ever required. 32 bytes (256 bits) of entropy makes an offline
 * guessing attack against the raw key itself computationally infeasible
 * regardless of how many keys this table ever holds — see this file's own
 * top-of-file doc comment for why that's also what makes a fast, unsalted
 * hash the right tool for `hashApiKey` below, not a weakness this file
 * compensates for with a slow KDF instead.
 */
export function generateRawApiKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The deterministic lookup key `key_hash` stores and `validateDbApiKey`
 * looks up by — a plain SHA-256 hex digest of the raw key, via
 * `node:crypto`'s `createHash`. Deliberately **not** `timingSafeEqual`
 * (there is no fixed value here to compare against — see this file's own
 * top-of-file doc comment for the full reasoning) and deliberately not a
 * slow/salted KDF (the 256 bits of entropy `generateRawApiKey` already
 * provides makes a KDF's own deliberate slowness pure per-request cost with
 * no corresponding security benefit against a random key already
 * infeasible to guess or brute-force).
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateApiKeyInput {
  name: string;
  role: ApiKeyRole;
  /**
   * `undefined`/`null` = unscoped (every namespace) — the exact same
   * unrestricted reach a static `ADMIN_API_KEY`/`READONLY_API_KEY` match
   * already has. A non-empty array restricts this key to only the
   * namespace names it lists. **Never pass an empty array meaning
   * "unscoped" — this function rejects it outright** (see the thrown-error
   * case below); a caller wanting an unscoped key omits this field or
   * passes `null`/`undefined` explicitly, never `[]`.
   */
  scopes?: readonly string[] | null;
  /** `undefined` = never expires. Rejected outright if it names a moment at or before "now" — see the thrown-error case below. */
  expiresAt?: Date;
}

export interface CreateApiKeyResult {
  /**
   * `api_keys.id`, kept as the plain `string` `pg` itself returns for a
   * `bigint` column (never coerced with `Number(...)`) — this project's own
   * established D-018 convention (see `src/store/tokens.ts`'s top-of-file
   * doc comment for the full reasoning) for an id that is only ever
   * displayed, echoed, or used as an opaque equality key, never compared or
   * arithmetic'd on — exactly `id`'s own role in this file and in
   * `src/cli/commands/apikey.ts`.
   */
  id: string;
  /**
   * The raw, unhashed key — **this is the only value ever returned that
   * can authenticate as this credential, and this is the only response
   * that will ever contain it.** Neither this function nor anything else
   * in this codebase persists it anywhere; once this call returns, the
   * only copy that still exists is whatever the caller does with this
   * field. `src/cli/commands/apikey.ts`'s `apikeyCreate` prints it with an
   * explicit, unmissable "shown once" warning for exactly this reason.
   */
  rawKey: string;
}

/** Same "at least one namespace, never an empty array" and identifier-grammar checks `src/api/server.ts`'s own `identifierField()` already applies to every namespace name this API accepts elsewhere — reused here (via the same `IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH`) so a scope namespace name is held to the identical grammar a real namespace name must satisfy to ever be published in the first place. */
function assertValidScopes(scopes: readonly string[] | null | undefined): void {
  if (scopes === null || scopes === undefined) return;
  if (scopes.length === 0) {
    throw new Error(
      'scopes must name at least one namespace — pass undefined/null for an unscoped key ' +
        'instead of an empty array (an empty array would mean "restricted to zero ' +
        'namespaces," never "unscoped," and this function refuses to guess which one a ' +
        'caller actually meant)',
    );
  }
  for (const ns of scopes) {
    if (ns.length === 0 || ns.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(ns)) {
      throw new Error(
        `invalid scope namespace '${ns}' — must be a valid identifier (lowercase snake_case, ` +
          `starts with a letter, ≤${MAX_IDENTIFIER_LENGTH} characters)`,
      );
    }
  }
}

/**
 * Generates a fresh raw key, hashes it, inserts the new row, and returns
 * `{id, rawKey}` — the RAW key is handed back exactly once, here, and never
 * again by anything in this codebase (`listApiKeys` below never selects
 * `key_hash`, let alone a raw key it never even stores).
 *
 * Rejects, by throwing, before ever touching the database:
 * - `scopes` that is a non-null empty array, or that names anything that
 *   isn't a valid namespace identifier (`assertValidScopes` above);
 * - `expiresAt` at or before the current moment — an already-expired key
 *   would be created only to immediately fail every future
 *   `validateDbApiKey` lookup (`expires_at > now()`), which is never a
 *   useful state to mint on purpose. Mirrors this codebase's own
 *   established "reject a nonsensical value at creation time rather than
 *   silently accepting a credential that can never do anything" discipline
 *   for `relation_tuples`' own validated fields (`src/store/tuples.ts`'s
 *   `validateIdentifiers`).
 * - `name` that is empty or all whitespace — `api_keys.name` is `not null`
 *   at the schema level, but a value that is technically non-null and
 *   still meaningless (`''`, `'   '`) would defeat this column's whole
 *   purpose (a human-readable label an operator can recognize in `authz
 *   apikey list`).
 *
 * `pool: QueryExecutor` — the narrowest structural type this function
 * actually needs (one `INSERT ... RETURNING`, no multi-statement
 * transaction), matching this store layer's own established "narrow to
 * exactly what's used" convention (`src/store/query-executor.ts`'s own
 * top-of-file doc comment).
 */
export async function createApiKey(
  pool: QueryExecutor,
  input: CreateApiKeyInput,
): Promise<CreateApiKeyResult> {
  if (input.name.trim().length === 0) {
    throw new Error('name must not be empty');
  }
  assertValidScopes(input.scopes);
  if (input.expiresAt !== undefined && input.expiresAt.getTime() <= Date.now()) {
    throw new Error(
      `expiresAt (${input.expiresAt.toISOString()}) must be in the future — an already-expired ` +
        'key would be rejected by every future lookup the moment it was created',
    );
  }

  const rawKey = generateRawApiKey();
  const keyHash = hashApiKey(rawKey);
  // `null`, never `undefined` or `[]` — see this input field's own doc
  // comment above and `assertValidScopes`'s rejection of `[]` immediately
  // above; by the time this line runs, `input.scopes` is either
  // `null`/`undefined` (unscoped) or a real, non-empty, already-validated
  // array. `[...input.scopes]` copies it into a plain mutable array `pg`
  // can serialize as a `text[]` parameter — `input.scopes` itself may be a
  // `readonly` array a caller still holds a reference to.
  const scopes = input.scopes ? [...input.scopes] : null;

  const { rows } = await pool.query<{ id: string }>(
    `insert into api_keys (name, key_hash, role, scopes, expires_at)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [input.name, keyHash, input.role, scopes, input.expiresAt ?? null],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    // Unreachable in practice — a successful `INSERT ... RETURNING id`
    // against a table whose `id` column is `NOT NULL` (every `PRIMARY KEY`
    // is) always returns exactly one row. Named rather than left to throw
    // an opaque "cannot read properties of undefined" a few lines further
    // down, matching this codebase's own established
    // `assertNever`-adjacent "this should be impossible, but name it
    // instead of crashing uninformatively" discipline.
    throw new Error('insert into api_keys returned no row');
  }
  return { id, rawKey };
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

/**
 * Sets `revoked_at = now()` for the key with this `id`, but only
 * `where revoked_at is null` — revoking an already-revoked key is a real
 * no-op (this `UPDATE` matches zero rows), never a second, later timestamp
 * silently overwriting the true original revocation moment. Returns
 * whether a row was **actually** updated: `true` only for a real,
 * previously-not-revoked key that this call just revoked; `false` for a
 * nonexistent id or a key that was already revoked — this function
 * deliberately does not distinguish those two `false` cases from each
 * other (an id an operator has to guess at either way; the actionable
 * information — "did my revoke request just take effect" — is identical
 * regardless of which reason it didn't).
 *
 * `id` stays a plain `string` all the way through — never parsed with
 * `Number(...)`/`parseInt` — matching `CreateApiKeyResult.id`'s own D-018
 * treatment. Rejects, by throwing, an `id` that isn't a bare non-negative
 * integer string before it ever reaches Postgres: this table's real
 * primary key is an actual `bigint`, so a non-numeric `id` could never
 * match a row anyway, but letting it reach a raw SQL comparison would
 * surface as an opaque driver-level `invalid input syntax for type bigint`
 * instead of a clear, named validation error — the same "fail with a
 * specific, actionable message before the database ever sees a malformed
 * value" discipline `src/store/tuples.ts`'s own identifier validation
 * already applies one layer up from its own SQL.
 */
export async function revokeApiKey(pool: QueryExecutor, id: string): Promise<boolean> {
  if (!/^\d+$/.test(id)) {
    throw new Error(`invalid api key id '${id}' — must be a non-negative integer`);
  }
  const { rowCount } = await pool.query(
    `update api_keys set revoked_at = now() where id = $1 and revoked_at is null`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ApiKeyListing {
  id: string;
  name: string;
  role: ApiKeyRole;
  scopes: string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface ApiKeyListingRow {
  id: string;
  name: string;
  role: ApiKeyRole;
  scopes: string[] | null;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

/**
 * Every API key that has ever been created — **never `key_hash`, never a
 * raw key, by construction of this query's own `SELECT` list**, not by a
 * field being stripped out afterward. There is no code path in this file
 * that could accidentally widen this list to include the hash later
 * without a reviewer seeing it happen right here, in the one place this
 * table is ever read in bulk. Ordered by `id asc` — creation order, stable
 * and deterministic across repeated calls against unchanged data, matching
 * `src/schema/publish.ts`'s own `listLatestNamespaceVersions` precedent for
 * "a listing operation orders by something meaningful, never left to
 * whatever order Postgres happens to return."
 *
 * Never throws for the ordinary "no keys exist yet" case — returns `[]`. A
 * genuinely unreachable database still throws, unchanged from every other
 * function in this file.
 */
export async function listApiKeys(pool: QueryExecutor): Promise<ApiKeyListing[]> {
  const { rows } = await pool.query<ApiKeyListingRow>(
    `select id, name, role, scopes, created_at, expires_at, revoked_at
     from api_keys
     order by id asc`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }));
}

// ---------------------------------------------------------------------------
// validate — the one function on this credential tier's real request path
// ---------------------------------------------------------------------------

export interface DbApiKeyMatch {
  id: string;
  role: ApiKeyRole;
  scopes: string[] | null;
}

/**
 * Hashes `rawKey` and looks it up — `null` if no row's `key_hash` matches,
 * or if it matches a row that is revoked or expired. All three conditions
 * live in this one query's own `WHERE` clause (`key_hash = $1 and
 * revoked_at is null and (expires_at is null or expires_at > now())`),
 * never split into "look it up, then separately check revoked/expired in
 * application code" — a single source of truth for what makes a key
 * currently valid, checked at the exact moment of the read that matters, not
 * a snapshot that could go stale between two round trips. This is the one
 * function on this credential tier's real request-serving path
 * (`src/api/auth.ts`'s `checkAdminAuthDb`/`checkReadAuthDb`, called on
 * every request whose static-key check already failed) — everything else
 * in this file is an operator-driven, `authz apikey`-CLI-only operation.
 *
 * Deliberately returns `null` for every failure reason alike (no match,
 * revoked, expired) rather than a discriminated result naming which —
 * mirrors `checkAdminAuth`'s own established "a wrong key and an absent key
 * both just fail, identically" discipline (`src/api/auth.ts`'s top-of-file
 * doc comment): a caller presenting a revoked key learns nothing that
 * distinguishes it from a caller who typo'd a key that never existed,
 * closing off "is this a real key that used to work" as a side channel a
 * malicious prober could otherwise use to enumerate which raw keys were
 * ever real.
 */
export async function validateDbApiKey(
  pool: QueryExecutor,
  rawKey: string,
): Promise<DbApiKeyMatch | null> {
  const keyHash = hashApiKey(rawKey);
  const { rows } = await pool.query<{ id: string; role: ApiKeyRole; scopes: string[] | null }>(
    `select id, role, scopes
     from api_keys
     where key_hash = $1
       and revoked_at is null
       and (expires_at is null or expires_at > now())`,
    [keyHash],
  );
  const row = rows[0];
  return row ? { id: row.id, role: row.role, scopes: row.scopes } : null;
}
