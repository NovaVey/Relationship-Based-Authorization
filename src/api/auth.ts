/**
 * The `ADMIN_API_KEY` check — build spec §9 Phase 8 ("`ADMIN_API_KEY`-gated
 * writes") and its own exit criterion ("an unauthenticated write attempt is
 * rejected"), extended by D-064 to gate `/check`/`/expand` too, not just
 * the three write routes — this function itself is unchanged either way; it
 * was already generic (a header in, an authorized/not verdict out), only
 * `server.ts`'s own set of callers grew. Main-agent territory per
 * `src/api/responses.ts`'s own top-of-file doc comment ("no `ADMIN_API_KEY`
 * check ... all of that is `src/api/server.ts`'s job"); split into its own
 * file rather than inlined in `server.ts` so the comparison logic itself —
 * the one piece of this that's actually security-sensitive — is a small,
 * independently readable, independently testable unit.
 *
 * `checkReadAuth` below (post-audit improvement, D-064's own "Revisit if")
 * is this file's second export — the scoped, read-only credential tier that
 * "Revisit if" clause names. `checkAdminAuth` itself needed no change for
 * it: the two functions are independent, and every write route keeps using
 * `checkAdminAuth` exclusively.
 *
 * Scheme: `Authorization: Bearer <key>`, compared against `env.ADMIN_API_KEY`
 * with `node:crypto`'s `timingSafeEqual` rather than `===` — a key
 * comparison is exactly the kind of secret-equality check where a
 * short-circuiting string comparison leaks how many leading bytes matched
 * through response-time variance. The length check ahead of it necessarily
 * leaks *whether the lengths matched* (an unequal-length pair can never
 * reach `timingSafeEqual`, which throws on mismatched buffer lengths) — an
 * accepted, standard tradeoff; hiding key *length* would need every
 * candidate padded to a fixed size for no real benefit, since the key's
 * length isn't the secret, its contents are.
 *
 * **If `ADMIN_API_KEY` itself is unset, every write is rejected — never
 * silently allowed.** `.env.example` ships it blank (`ADMIN_API_KEY=`,
 * optional per `src/config/env.ts`, matching this project's own "never
 * invent a secret" rule — a value can't be defaulted in code). A service
 * with no configured admin key has no way to distinguish an authorized
 * caller from anyone else, and "no configured secret" failing open into
 * "any caller may write" would be exactly the kind of implicit grant
 * build spec rule 10 rules out project-wide, applied here to
 * configuration instead of a relation tuple. See `docs/DECISIONS.md`.
 */
import { timingSafeEqual } from 'node:crypto';

import { env } from '../config/env.js';
import type { QueryExecutor } from '../store/query-executor.js';
import { validateDbApiKey } from './db-api-keys.js';

/**
 * Constant-time-content string comparison (see this file's own top-of-file
 * doc comment for what "constant-time" does and doesn't cover here).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extracts the bearer token from a raw `Authorization` header value, or `undefined` if the header is missing or not `Bearer`-shaped. */
function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) return undefined;
  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return undefined;
  const token = authorizationHeader.slice(prefix.length);
  return token.length > 0 ? token : undefined;
}

export type AdminAuthResult =
  | { authorized: true }
  | { authorized: false; reason: 'admin_api_key_not_configured' | 'missing_or_invalid_key' };

/**
 * The one function every write route's `preHandler` calls. Pure with
 * respect to the request — takes the raw header value, never the whole
 * Fastify request object, so it's testable with a plain string and needs
 * no Fastify fixture.
 */
export function checkAdminAuth(authorizationHeader: string | undefined): AdminAuthResult {
  if (!env.ADMIN_API_KEY) {
    return { authorized: false, reason: 'admin_api_key_not_configured' };
  }
  const supplied = extractBearerToken(authorizationHeader);
  if (supplied === undefined || !safeEqual(supplied, env.ADMIN_API_KEY)) {
    return { authorized: false, reason: 'missing_or_invalid_key' };
  }
  return { authorized: true };
}

export type ReadAuthResult =
  | { authorized: true }
  | { authorized: false; reason: 'no_read_credential_configured' | 'missing_or_invalid_key' };

/**
 * The scoped, read-only credential tier `docs/DECISIONS.md` D-064's own
 * "Revisit if" names: "A deployment genuinely needs a caller class that can
 * check/expand without holding the full admin key... that's a real reason to
 * add a second, narrower credential tier." Gates `/check`, `/expand`,
 * `/list-objects`, and `/list-users` — every route that only ever *answers a
 * question about* the tuple graph, never one that can change it. The three
 * write routes (`/tuples` POST/DELETE, `/schema/publish`) stay
 * `checkAdminAuth`-only; nothing about this function widens what a
 * `READONLY_API_KEY` holder can do to write access.
 *
 * A caller is authorized if the supplied bearer token matches *either*
 * `env.READONLY_API_KEY` *or* `env.ADMIN_API_KEY` — the full admin key must
 * keep working on the read routes exactly as it did before this credential
 * tier existed (D-064's own original behavior), never regress a deployment
 * that has only ever configured `ADMIN_API_KEY` into having to mint a second
 * key it never needed. Checks the (cheaper to reason about) dedicated
 * `READONLY_API_KEY` first, falling through to `ADMIN_API_KEY` only if that
 * one either isn't configured or didn't match — the order has no
 * authorization-relevant effect (both branches, when reached, run the same
 * `safeEqual` constant-time-content comparison this file's own top-of-file
 * doc comment already establishes the reasoning for), it only affects which
 * of the two configured secrets a non-matching key's comparison spends time
 * against, which leaks nothing beyond what `checkAdminAuth` alone already
 * discloses (length equality against whichever key it's compared to).
 *
 * `no_read_credential_configured` (distinct from `checkAdminAuth`'s
 * `admin_api_key_not_configured`) fires only when *neither* key is set —
 * matching `checkAdminAuth`'s own "no configured secret must never fail
 * open" rule, applied here to two possible secrets instead of one: a
 * deployment with truly nothing configured rejects every read exactly as it
 * always has, never silently allowing unauthenticated access because a
 * second, unrelated key variable happens to be the one someone checks for.
 */
export function checkReadAuth(authorizationHeader: string | undefined): ReadAuthResult {
  if (!env.READONLY_API_KEY && !env.ADMIN_API_KEY) {
    return { authorized: false, reason: 'no_read_credential_configured' };
  }
  const supplied = extractBearerToken(authorizationHeader);
  if (supplied === undefined) {
    return { authorized: false, reason: 'missing_or_invalid_key' };
  }
  if (env.READONLY_API_KEY && safeEqual(supplied, env.READONLY_API_KEY)) {
    return { authorized: true };
  }
  if (env.ADMIN_API_KEY && safeEqual(supplied, env.ADMIN_API_KEY)) {
    return { authorized: true };
  }
  return { authorized: false, reason: 'missing_or_invalid_key' };
}

/**
 * `checkAdminAuthDb`/`checkReadAuthDb` below (post-audit improvement,
 * D-064's own "Revisit if" carried one step further — `src/api/
 * db-api-keys.ts`'s real, mintable, DB-backed credential tier,
 * `migration 0007_api_keys.sql`) — the async counterparts of
 * `checkAdminAuth`/`checkReadAuth` above, which are themselves **completely
 * unchanged** by this addition: every existing caller of the synchronous
 * functions keeps working byte-for-byte as before, and the two new
 * functions below are additive wrappers around them, never a replacement.
 *
 * **The shape of the fallback: try the cheap, synchronous, static-key check
 * first; only reach into Postgres if that fails.** A deployment that never
 * mints a single `api_keys` row and only ever presents its static
 * `ADMIN_API_KEY`/`READONLY_API_KEY` sees **zero** behavior change from
 * this file existing at all — the static check succeeds on the first line
 * of each function below, and `validateDbApiKey` is never called, so
 * there's no added latency, no added database round trip, nothing. Even a
 * request that presents no credential at all (no `Authorization` header,
 * or one that isn't `Bearer`-shaped) short-circuits before touching the
 * database — `extractBearerToken` returning `undefined` means there is no
 * candidate raw key for `validateDbApiKey` to even hash and look up, so
 * this returns the static check's own result unchanged rather than
 * spending a query on a request nothing so much as claims to be
 * authenticated. Only a request that supplies an actual bearer token which
 * does NOT match the configured static key ever reaches the database — the
 * one case where checking a second, independent credential source is
 * genuinely necessary to answer "is this caller authorized" honestly.
 *
 * **Role enforcement happens here, not in `validateDbApiKey`.**
 * `validateDbApiKey` (`src/api/db-api-keys.ts`) answers one question —
 * "does this raw key match a live, non-revoked, non-expired row, and if
 * so, what role/scopes does it carry" — with no opinion on which routes a
 * given role may reach; that's this file's job, the same division of
 * labor `checkAdminAuth`/`checkReadAuth` themselves already establish
 * relative to `src/api/server.ts`. `checkAdminAuthDb` requires
 * `match.role === 'admin'` exactly — a `readonly`-role DB key must NEVER
 * pass an admin check, the identical asymmetry `checkReadAuth`'s own
 * `READONLY_API_KEY` already has relative to the write routes today, now
 * extended to the DB-backed tier. `checkReadAuthDb` accepts *either* role —
 * mirroring `checkReadAuth`'s own "the full admin key also authorizes
 * reads" rule (a `READONLY_API_KEY` env var authorizes reads; an
 * `ADMIN_API_KEY` env var, which can do strictly more, also authorizes
 * reads) applied to the DB tier: an `admin`-role DB key can do everything a
 * `readonly`-role one can, so it would be a pure, pointless regression for
 * it to be refused on a read route a `readonly`-role key of the same
 * deployment could pass.
 *
 * **A wrong-role match reports the same `missing_or_invalid_key` reason a
 * nonexistent key would, never a distinguishable "wrong role" reason** —
 * mirrors `validateDbApiKey`'s own "a caller learns nothing that
 * distinguishes a revoked key from one that never existed" discipline
 * (`src/api/db-api-keys.ts`'s own top-of-file doc comment), extended here
 * to cover role mismatch too: a `readonly`-role key prodding at
 * `POST /tuples` should not learn from the *shape* of its rejection that
 * its key is real but merely underprivileged, versus simply wrong.
 *
 * **Once a static check's own failure reason has been superseded by an
 * actual database lookup, this file never reports the static check's own
 * `..._not_configured` reason again — even if that's what the static check
 * itself returned.** `admin_api_key_not_configured`/
 * `no_read_credential_configured` mean "this deployment has no way to
 * authorize this request," which stops being an honest claim the moment a
 * real DB lookup was attempted and simply didn't match — the deployment
 * plainly *does* have a way to authorize requests (the DB tier), this
 * particular supplied credential just wasn't one. So both functions below
 * return the static result's own `..._not_configured` reason **only** on
 * the fast, DB-untouched path (no bearer token supplied at all); the moment
 * `validateDbApiKey` is actually consulted and comes back empty or
 * wrong-role, the reported reason collapses to the same
 * `missing_or_invalid_key` a wrong static key already produces — one
 * failure reason for "you presented something, and it matched nothing,"
 * regardless of which tier(s) were checked. The alternative — querying
 * `api_keys` a second time, purely to decide whether any row exists at all
 * so this file could keep reporting "not configured" precisely — would
 * spend a real database round trip on every failed auth attempt solely to
 * make an error message marginally more specific, and would leak "does
 * this deployment have any DB-backed keys at all" as a side channel to an
 * unauthenticated caller; neither is worth it for a distinction that
 * doesn't change what a legitimate caller needs to do next (present a
 * valid credential, whichever tier it comes from).
 *
 * **A genuine infrastructure failure (Postgres unreachable, mid-lookup) is
 * never caught or reshaped here — it propagates as a thrown error,
 * unchanged.** Neither function below has any way to honestly answer
 * "authorized" or "not authorized" without actually completing the lookup;
 * swallowing the error and returning `authorized: false` would misreport a
 * real infrastructure outage as "you supplied the wrong key," and — far
 * worse — swallowing it and returning `authorized: true` would be exactly
 * the "no configured secret/lookup fails open" hazard this project's own
 * rule 10 rules out project-wide, now applied to a failed *lookup* instead
 * of a missing *configuration*. `src/api/server.ts`'s
 * `requireAdminAuth`/`requireReadAuth` are what actually catch this and
 * map it to `infrastructureUnavailableError` (503) — the identical
 * "genuine DB outage is a distinct, honestly-reported failure class, never
 * silently folded into a different one" discipline this codebase already
 * applies to every other route's own domain call.
 */
export type AdminAuthDbResult =
  | { authorized: true; scopes: string[] | null }
  | { authorized: false; reason: 'admin_api_key_not_configured' | 'missing_or_invalid_key' };

export type ReadAuthDbResult =
  | { authorized: true; scopes: string[] | null }
  | { authorized: false; reason: 'no_read_credential_configured' | 'missing_or_invalid_key' };

/**
 * `checkAdminAuth` first; only on failure, and only when a bearer token was
 * actually supplied, falls back to `validateDbApiKey` and requires
 * `role === 'admin'` exactly. `scopes: null` on a static-key match — a
 * static env-var key's authority is unscoped (every namespace), exactly as
 * it's always been; `src/api/server.ts` enforces scope only when this
 * result's own `scopes` is a real, non-null array. See this file's own
 * doc comment immediately above for the full reasoning behind every choice
 * here.
 */
export async function checkAdminAuthDb(
  pool: QueryExecutor,
  authorizationHeader: string | undefined,
): Promise<AdminAuthDbResult> {
  const staticResult = checkAdminAuth(authorizationHeader);
  if (staticResult.authorized) return { authorized: true, scopes: null };

  const supplied = extractBearerToken(authorizationHeader);
  if (supplied === undefined) return staticResult;

  const match = await validateDbApiKey(pool, supplied);
  if (!match || match.role !== 'admin') {
    return { authorized: false, reason: 'missing_or_invalid_key' };
  }
  return { authorized: true, scopes: match.scopes };
}

/**
 * `checkReadAuth` first; only on failure, and only when a bearer token was
 * actually supplied, falls back to `validateDbApiKey` and accepts EITHER
 * role (`admin` or `readonly`) — mirroring `checkReadAuth`'s own "either
 * `READONLY_API_KEY` or the full `ADMIN_API_KEY` authorizes a read" rule,
 * carried over to the DB-backed tier. See this file's own doc comment
 * above `AdminAuthDbResult` for the full reasoning behind every choice
 * here.
 */
export async function checkReadAuthDb(
  pool: QueryExecutor,
  authorizationHeader: string | undefined,
): Promise<ReadAuthDbResult> {
  const staticResult = checkReadAuth(authorizationHeader);
  if (staticResult.authorized) return { authorized: true, scopes: null };

  const supplied = extractBearerToken(authorizationHeader);
  if (supplied === undefined) return staticResult;

  const match = await validateDbApiKey(pool, supplied);
  if (!match) {
    return { authorized: false, reason: 'missing_or_invalid_key' };
  }
  return { authorized: true, scopes: match.scopes };
}
