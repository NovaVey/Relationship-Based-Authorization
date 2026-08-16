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
