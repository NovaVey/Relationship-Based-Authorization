/**
 * Loads and validates the process environment before anything else runs.
 * Fails fast with a specific, actionable message rather than letting a
 * missing `DATABASE_URL` surface later as an opaque connection error three
 * layers down.
 *
 * This is the one piece of Phase 0 scaffolding intentionally checked in
 * ahead of the phased build described in
 * `.claude/commands/build-authz-service.md` — every later phase needs
 * config to exist before it needs any domain logic, the same way this
 * project's own sibling services (see docs/DECISIONS.md) each did. The
 * schema below reflects the full env footprint documented in that build
 * spec's §2, matching `.env.example` exactly — later phases consume
 * variables this file already validates; they don't add new ones without
 * updating both files in the same commit.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// quiet: true — dotenv's own startup tip line otherwise prints ahead of
// every CLI command's actual output, including `authz --help`.
dotenv.config({ path: path.resolve(moduleDir, '../../.env'), quiet: true });

/**
 * Preprocesses the raw `''` blank-placeholder shape to `undefined` before
 * an inner schema runs — the one mechanism `optionalString`, `optionalNumber`,
 * and `optionalEnum` below all share, factored out once rather than
 * duplicated three times (full-repo audit finding #12, LOW, third audit,
 * 2026-08-17). `.env.example` commits every optional/defaulted var with a
 * blank value (`KEY=`) as a "leave this to pick up the default" convention;
 * dotenv parses that as the empty string, never as an absent key.
 */
function blankToUndefined<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

/**
 * An optional string — for env vars that `.env.example` commits with a
 * blank value (`KEY=`) as a "fill this in" placeholder. A plain
 * `z.string().min(minLength).optional()` rejects that exact blank shape
 * outright (an empty string isn't `undefined`, so `.optional()` alone
 * doesn't help) — caught live running `authz doctor` against a real `.env`
 * copied from the example and only partially filled in.
 * `blankToUndefined` is what actually makes "optional" mean optional here.
 * `minLength` defaults to `1` (DATABASE_URL/SOUNDNESS_FUZZ_SEED's own
 * requirement — non-empty if present at all); `ADMIN_API_KEY` below passes
 * a higher one (finding #10, MEDIUM, third audit: a trivially short admin
 * key is easy to guess or brute-force).
 */
function optionalString(minLength = 1, message?: string) {
  return blankToUndefined(z.string().min(minLength, message).optional());
}

/**
 * A defaulted numeric env field (`PORT`, `CHECK_MAX_DEPTH`,
 * `CHECK_CACHE_TTL_MS`, `SOUNDNESS_FUZZ_QUERIES`, `MAX_CONCURRENCY`) — every
 * one of these shipped a plain `.default(...)` with no `blankToUndefined`
 * preprocessing until this fix (full-repo audit finding #12), so a blank
 * `.env` placeholder line failed validation outright instead of resolving
 * to the documented default: `z.coerce.number()` on `''` does NOT
 * coincidentally behave like "absent" the way a missing key does —
 * `Number('') === 0`, not `NaN` — so `PORT=` produced `too_small` (0 isn't
 * `.positive()`), never fell through to `.default(3000)`. Confirmed live
 * via `EnvSchema.safeParse({ PORT: '' })` before this fix, and again after
 * to confirm the corrected behavior. Latent, not live: `.env.example`
 * never ships any of these six fields blank today.
 */
function optionalNumber(schema: z.ZodType<number>) {
  return blankToUndefined(schema);
}

/** Same `blankToUndefined` treatment, for the two defaulted enum fields (`NODE_ENV`, `LOG_LEVEL`). */
function optionalEnum<T extends z.ZodType<string>>(schema: T) {
  return blankToUndefined(schema);
}

export const EnvSchema = z.object({
  // Deliberately optional at this layer — see docs/DECISIONS.md D-008.
  // `authz --help` and other commands that touch no store must work on a
  // fresh clone with no `.env` at all; anything that actually needs
  // Postgres (starting with `authz doctor`) checks for this itself and
  // fails with a specific, actionable message at the point of use instead
  // of crashing before the CLI has even parsed its arguments.
  DATABASE_URL: optionalString(),
  PORT: optionalNumber(z.coerce.number().int().positive().default(3000)),
  // Currently informational only — its only consumer anywhere in `src/`
  // is `doctor.ts`'s own startup line, which just prints it back. Unlike
  // `LOG_LEVEL` (which does drive real Fastify logger config), setting
  // `NODE_ENV=production` today changes no logging format, error
  // verbosity, or other runtime behavior — full-repo audit finding #14
  // (LOW, fourth audit), disclosed explicitly here the same way
  // `CHECK_CACHE_TTL_MS`'s own D-028 entry (`docs/DECISIONS.md`) discloses
  // that variable's placeholder status, so a future reader doesn't assume
  // this one already does something it doesn't.
  NODE_ENV: optionalEnum(z.enum(['development', 'test', 'production']).default('development')),
  LOG_LEVEL: optionalEnum(z.enum(['debug', 'info', 'warn', 'error']).default('info')),

  // Graph-walk recursion/BFS depth budget — see build spec §6.4 (cycle
  // detection and termination).
  CHECK_MAX_DEPTH: optionalNumber(z.coerce.number().int().positive().default(25)),
  // 0 disables the check-result cache entirely.
  CHECK_CACHE_TTL_MS: optionalNumber(z.coerce.number().int().nonnegative().default(0)),

  // Differential-soundness fuzz run — see build spec §6.2 and §9 Phase 5.
  SOUNDNESS_FUZZ_QUERIES: optionalNumber(z.coerce.number().int().positive().default(5000)),
  SOUNDNESS_FUZZ_SEED: optionalString(),

  MAX_CONCURRENCY: optionalNumber(z.coerce.number().int().positive().default(8)),

  // `.min(32)` (finding #10, MEDIUM, third audit, 2026-08-17): a startup
  // with a trivially short admin key now fails fast with a clear message
  // rather than silently accepting one an attacker could plausibly guess or
  // brute-force. Still optional — an unset `ADMIN_API_KEY` is a deliberate,
  // documented state (D-008, `src/api/auth.ts`), not an error: it disables
  // not just the write routes (`POST`/`DELETE /tuples`, `POST
  // /schema/publish`) but, since D-064, the read routes `/check` and
  // `/expand` too (gating those the same way is what closed unauthenticated
  // relationship-graph enumeration — full-repo audit finding, fourth
  // audit, confirmed this comment itself understated that scope until
  // then; `.env.example`'s own comment for this same variable already
  // stated it correctly).
  ADMIN_API_KEY: optionalString(
    32,
    'ADMIN_API_KEY must be at least 32 characters — a short key is easy to guess or brute-force',
  ),

  // A second, narrower credential tier (post-audit improvement, D-064's own
  // "Revisit if" clause: "A deployment genuinely needs a caller class that
  // can check/expand without holding the full admin key... that's a real
  // reason to add a second, narrower credential tier"). Authorizes only the
  // read/oracle routes (`/check`, `/expand`, `/list-objects`, `/list-users`)
  // — never `/tuples` or `/schema/publish`, which stay `ADMIN_API_KEY`-only.
  // Same `.min(32)` treatment as `ADMIN_API_KEY` for the same reason (finding
  // #10, MEDIUM, third audit). Optional and unset by default: an unset
  // `READONLY_API_KEY` changes nothing — the read routes still accept
  // `ADMIN_API_KEY` exactly as before D-064's own "Revisit if" fires; see
  // `src/api/auth.ts`'s `checkReadAuth`.
  READONLY_API_KEY: optionalString(
    32,
    'READONLY_API_KEY must be at least 32 characters — a short key is easy to guess or brute-force',
  ),

  // Opt-in, unset by default (post-audit improvement — horizontal-scaling
  // readiness). When set, a real `ioredis` client is constructed from this
  // URL and handed to `@fastify/rate-limit`'s own bundled `redis` option
  // (replacing its default in-process `LocalStore`) and to this project's own
  // hand-rolled `authFloodGuard` counter — see `src/api/server.ts` — so every
  // rate/flood budget is shared across however many replicas of this process
  // are running behind the same reverse proxy, instead of each replica
  // silently keeping its own independent, smaller-than-configured budget (the
  // multi-replica gap `CHECK_CACHE_TTL_MS`'s own single-process cache and
  // `authFloodState`'s own in-memory `LruMap` both still have — see that
  // variable's own doc comment, and `docs/DECISIONS.md`). Left unset (the
  // default), this changes nothing: every rate-limit/flood-guard mechanism
  // keeps its exact pre-existing in-process behavior, byte-for-byte, and this
  // codebase's own single-instance deployment (Railway, one `authz-api`
  // service, per `docs/DECISIONS.md` D-104) never constructs a Redis client
  // at all.
  REDIS_URL: optionalString(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
