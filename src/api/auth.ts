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
