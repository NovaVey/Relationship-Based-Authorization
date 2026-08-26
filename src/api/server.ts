/**
 * The Fastify server exposing the CLI's own operations over HTTP — build
 * spec §7's `authz serve`, §9 Phase 8: "Fastify server exposing
 * check/expand/write/schema per the CLI's own operations, ADMIN_API_KEY-
 * gated writes, /health reporting DB connectivity and the current
 * namespace config versions." Routing, request-body validation, and the
 * `ADMIN_API_KEY` auth wiring are main-agent territory (this file, plus
 * `src/api/auth.ts`); every response body/status this file sends is built
 * by `src/api/responses.ts`/`errors.ts` (report-designer, Phase 8) — this
 * file never constructs a response shape by hand, the same division
 * `src/cli/commands/soundness.ts`'s `--format` flag already established
 * with `src/report/` in Phase 7.
 *
 * Every route is a thin translation of an existing, already-tested domain
 * call — `performCheck`, `expand`, `writeTuple`, `deleteTuple`,
 * `compileSchema`, `publishSchema` — the exact same functions each CLI
 * command in `src/cli/commands/` already calls. Nothing new is decided
 * about permissions here; this is a second entry point into logic Phases
 * 1-6 already own, not a parallel implementation of any of it.
 *
 * **Routes are unversioned, flat, and named after the CLI operation, not
 * REST resources** (`POST /check`, not `POST /v1/checks`): §9 Phase 8's own
 * wording is "exposing check/expand/write/schema *per the CLI's own
 * operations*", and `src/api/responses.ts`'s own top-of-file doc comment
 * already establishes why this API has no resource model to version or
 * nest routes under ("none of this API's five operations exposes a
 * fetchable-by-URI resource"). Introducing `/v1/` now would be
 * anticipating a versioning need this project doesn't have yet, with zero
 * external consumers to break. See `docs/DECISIONS.md`.
 *
 * **`check` and `expand` are `POST`, not `GET`, despite being read-only.**
 * Both take a structured, nested query shape (`subject`/`object` as
 * `{ns,id}` pairs) that a flat query string would force apart into
 * `?subjectNs=&subjectId=&...`, and every other route here is already
 * `POST` for the same "structured JSON body" reason — one consistent
 * request shape across all five operations beats strict verb-purity for an
 * API with no caching layer that would benefit from `GET`'s cacheability.
 * See `docs/DECISIONS.md`.
 *
 * **`check` and `expand` require `ADMIN_API_KEY` too, not just the write
 * routes** (D-064). Either one, unauthenticated, is a public authorization
 * oracle: repeated `/check` calls let any network caller enumerate "does
 * subject X have permission Y on object Z" across the whole graph, and one
 * `/expand` call dumps the complete resolved membership tree for an
 * `object#relation` — every transitive group member, every subject with
 * access — which is exactly the kind of implicit disclosure build spec
 * rule 10 and D-050's own reasoning already rule out for writes, applied
 * here to read access instead. See `docs/DECISIONS.md` D-064.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';

import { env } from '../config/env.js';
import { performCheck } from '../audit/checks.js';
import { expand } from '../audit/expand.js';
import { listObjects, listUsers } from '../audit/list.js';
import { writeTuple, deleteTuple, type TupleKey } from '../store/tuples.js';
import { decodeToken } from '../store/tokens.js';
import { compileSchema } from '../schema/dsl/compiler.js';
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../schema/dsl/types.js';
import { publishSchema, listLatestNamespaceVersions } from '../schema/publish.js';
import { createCheckCache, type CheckCache } from '../resolve/production/cache.js';
import { checkAdminAuth, checkReadAuth } from './auth.js';
import {
  createRedisClient,
  InMemoryFloodStore,
  RedisFloodStore,
  type FloodStore,
} from './redis-store.js';
import {
  checkResponse,
  expandResponse,
  listObjectsResponse,
  listUsersResponse,
  tupleWriteResponse,
  tupleDeleteResponse,
  schemaCompileResponse,
  schemaPublishResponse,
  healthResponse,
} from './responses.js';
import {
  unauthorizedError,
  invalidRequestError,
  infrastructureUnavailableError,
  internalError,
  rateLimitedError,
  notFoundError,
  type ApiErrorResponse,
} from './errors.js';

// `identifierField()` — the same grammar `src/store/tuples.ts`'s
// `validateIdentifiers` already enforces on every tuple write/delete
// (`IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH`, `src/schema/dsl/types.ts`),
// applied here too. `/check`/`/expand` never route through `writeTuple`/
// `deleteTuple` — they call `performCheck`/`expand` directly — so before
// this fix, `entityRefSchema`'s `ns`/`id` and both routes' `relation` field
// accepted any non-empty string, with no identifier-grammar or length
// enforcement at all. Not an auth bypass: `getConfig` (the production
// resolver's namespace-config lookup) still gates on `object.ns` matching a
// real *published* namespace first, and a published namespace name is
// itself already grammar-clean by construction (it went through the DSL
// compiler to get published) — so a malformed `ns` on an unpublished
// namespace is rejected downstream regardless, just later and less clearly.
// The real damage a malformed identifier does: `src/resolve/production/
// resolver.ts` documents and depends on "no real identifier contains `:` or
// `#`" (`entityNameKey`, `parseFrontierKeyString`) to reconstruct an
// audit-trail path — an id like `'evil#hack'` can make that parsing
// silently mis-split, corrupting the resolution path an ALLOWED result
// shows its work with. And every malformed value that does clear the
// namespace-gate reaches the `checks` audit table's plain `text` columns
// permanently, with no `CHECK` constraint to catch it later. Full-repo
// audit finding #3, MEDIUM, third audit, 2026-08-17. See docs/DECISIONS.md.
function identifierField(): z.ZodString {
  return z
    .string()
    .min(1)
    .max(MAX_IDENTIFIER_LENGTH)
    .regex(IDENTIFIER_PATTERN, `must match ${IDENTIFIER_PATTERN.source}`);
}

// `.strict()` on every body schema below (full-repo audit finding #4,
// MEDIUM, fourth audit, docs/DECISIONS.md): Zod's default object behavior
// silently *drops* an unrecognized key instead of rejecting it — for a
// misspelled `atToken`/`subjectRelation` (both `.optional()`, so a typo'd
// name simply reads as "absent," never a validation error) that silently
// changes request semantics with zero signal to the caller: a mistyped
// `subjectRelation` on a tuple write silently downgrades a userset-subject
// write to a plain-entity one, and a mistyped `atToken` on a check
// silently drops the caller's intended consistency floor and runs the
// check unpinned instead. `.strict()` makes any unrecognized key a normal
// `invalid_request` 400 (via `describeZodError`, unchanged — Zod's own
// `unrecognized_keys` issue already carries a specific, readable message)
// exactly like any other malformed-body case, rather than a silent,
// undetectable behavior change.
const entityRefSchema = z.object({ ns: identifierField(), id: identifierField() }).strict();

const checkBodySchema = z
  .object({
    subject: entityRefSchema,
    relation: identifierField(),
    object: entityRefSchema,
    // An opaque, encoded consistency token (`src/store/tokens.ts`'s
    // `encodeToken`/`decodeToken`) — the exact string a write/delete
    // response's own `token` field returned, never a raw integer since
    // this project stopped exposing one (see that file's own doc comment
    // for why). Decoded, and rejected with a normal 400 on malformed
    // input, by the `/check` route handler below rather than by this
    // schema, so a bad token produces the same `invalidRequestError`
    // shape every other malformed-body case here does, not a
    // differently-worded Zod error.
    atToken: z.string().optional(),
  })
  .strict();

const expandBodySchema = z
  .object({
    object: entityRefSchema,
    relation: identifierField(),
  })
  .strict();

// `listObjects`/`listUsers` (post-audit improvement, `src/audit/list.ts`) —
// bodies mirror `checkBodySchema`/`expandBodySchema` exactly, field for
// field, for the two fields each shares with its single-object sibling.
const listObjectsBodySchema = z
  .object({
    subject: entityRefSchema,
    relation: identifierField(),
    objectNs: identifierField(),
    // Same opaque, encoded consistency token as `checkBodySchema.atToken` —
    // see that field's own comment. `listUsers` has no equivalent field:
    // `listUsers` has no `atToken` support at all (`src/audit/list.ts`'s own
    // top-of-file doc comment explains why).
    atToken: z.string().optional(),
  })
  .strict();

const listUsersBodySchema = z
  .object({
    object: entityRefSchema,
    relation: identifierField(),
  })
  .strict();

const tupleBodySchema = z
  .object({
    objectNs: z.string().min(1),
    objectId: z.string().min(1),
    relation: z.string().min(1),
    subjectNs: z.string().min(1),
    subjectId: z.string().min(1),
    subjectRelation: z.string().min(1).optional(),
    // Optional validity-window expiry (D-144) — an opaque, unvalidated
    // string here, same as `checkBodySchema.atToken` above: no
    // `format: 'date-time'` keyword and no min-length check at the schema
    // layer (grepped for an existing precedent first; there isn't one in
    // this codebase) because the actual parse-and-range-check happens in
    // the `POST /tuples` route handler below, exactly the way that route's
    // sibling `/check` already decodes `atToken` itself rather than
    // validating it here, so a malformed value gets this API's one
    // `invalid_request` shape via `invalidRequestError`, not a
    // differently-worded Zod error.
    expiresAt: z.string().optional(),
  })
  .strict();

// `.max(65_536)` (64 KiB — D-067's own "defense in depth" recommendation,
// docs/DECISIONS.md): a second, tighter ceiling than the server-wide
// `bodyLimit` (256 KiB, `buildServer` above) specifically on the one field
// that actually reaches the DSL parser/compiler D-067's own fix already
// hardened structurally. Every real schema this project has ever written
// is a few KB — 64 KiB is generous by roughly an order of magnitude over
// that while giving a maliciously oversized `source` string its own
// specific, named Zod rejection (`invalidRequestError`, via
// `describeZodError`) rather than relying solely on the blunter, whole-body
// `bodyLimit` check upstream.
const schemaSourceBodySchema = z
  .object({
    source: z.string().min(1).max(65_536, 'schema source exceeds the 64 KiB limit'),
  })
  .strict();

/** Flattens a Zod issue list into the short, specific `detail` string `invalidRequestError` expects — never just "validation failed". */
function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * `z.infer<typeof tupleBodySchema>` types `subjectRelation` as
 * `string | undefined` (an optional Zod field), which `tsconfig.json`'s
 * `exactOptionalPropertyTypes` correctly refuses to widen into `TupleKey`'s
 * own `subjectRelation?: string` — an explicit `undefined` and an absent
 * key are two different things under that setting. Mirrors the identical
 * `...(x !== undefined ? { key: x } : {})` pattern `src/cli/commands/
 * tuple.ts`'s own `buildTupleKey` already uses for the same field, for the
 * same reason.
 */
function toTupleKey(parsed: z.infer<typeof tupleBodySchema>): TupleKey {
  const { objectNs, objectId, relation, subjectNs, subjectId, subjectRelation } = parsed;
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

async function sendApiError(reply: FastifyReply, err: ApiErrorResponse): Promise<void> {
  await reply.code(err.status).send(err.body);
}

/**
 * Every route's own DB call is wrapped in this, mirroring the identical
 * `catch (err) { console.error('Postgres: ...'); process.exitCode = 3; }`
 * pattern every `src/cli/commands/*.ts` file already applies to the exact
 * same underlying calls (`performCheck`, `expand`, `writeTuple`,
 * `deleteTuple`, `publishSchema` all throw only for a genuine
 * infrastructure failure — see each function's own doc comment) — so a
 * given DB outage reports identically whether reached through the CLI or
 * this API: exit code 3 there, `503 infrastructure_unavailable` here.
 */
async function runOrInfrastructureError<T>(
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    await sendApiError(reply, infrastructureUnavailableError((err as Error).message));
    return undefined;
  }
}

/**
 * Replaces the literal `trustProxy: 1` D-082 originally shipped — Fastify
 * 5.12.1 silently dropped `number` from `trustProxy`'s accepted type, and
 * it's not a types-only change: verified live (`docs/DECISIONS.md` D-104)
 * that the underlying hop-counting mechanism `trustProxy: 1` relied on was
 * removed from Fastify's own runtime in that release too — a real socket
 * server with `trustProxy: 1` on Fastify 5.12.1 silently ignores
 * `X-Forwarded-For` entirely, always resolving `request.ip` to the raw
 * socket peer (the reverse proxy's own address, never the real client's).
 * In this project's real single-reverse-proxy deployment (Railway), that
 * collapses every distinct caller's `@fastify/rate-limit` budget into one
 * shared bucket — the exact failure class D-065/D-082 already fixed once,
 * reintroduced by the framework itself, silently, with no error anywhere.
 *
 * This function reimplements `trustProxy: 1`'s own semantics directly,
 * using the `TrustProxyFunction` form Fastify 5.12.1 still accepts
 * (`(address, hop) => boolean`, forwarded verbatim to `@fastify/proxy-addr`
 * — Fastify itself invokes this once per address in the
 * `[socket, ...X-Forwarded-For entries nearest-first]` chain, walking
 * outward from the socket; `true` means "this address is itself a trusted
 * proxy, keep walking past it," `false` means "stop here — this address is
 * the real client," and the walk never proceeds past a `false`). Hop 0 is
 * always the socket's own peer address; trusting it as a proxy (and
 * nothing past it) is exactly "trust one real hop" — the one reverse proxy
 * this deployment shape actually has, per `serve.ts`'s own binding
 * rationale, never a second, client-controlled hop.
 *
 * `Boolean(address)` guards hop 0 specifically: only treat the socket as a
 * trusted proxy if we genuinely have its address. Fastify 5.12.1's own
 * behavior change was motivated by exactly the inverse case — a socket
 * whose `remoteAddress` is itself undefined/null (documented upstream as
 * an IISNode-on-Windows edge case) previously still had its
 * `X-Forwarded-For` trusted, which is unsafe: if we don't even know who's
 * connected to us, we have no basis to trust what they claim about anyone
 * upstream of them either. This guard makes that fail closed here too —
 * an unknown socket address now falls back to that (missing) address
 * directly, exactly like Fastify 5.12.1's own hardened built-in behavior,
 * rather than trusting the header regardless.
 *
 * **Verified live, not assumed:** fetched both `fastify@5.12.0` and
 * `fastify@5.12.1` tarballs directly and diffed them (`docs/DECISIONS.md`
 * D-104) — the only relevant change is `fastify.d.ts` dropping `number`
 * from `trustProxy`'s type, matching a real, deliberate runtime rewrite in
 * the same release. This exact function was then run against a real
 * listening Fastify 5.12.1 server, hit with real HTTP requests, and its
 * `request.ip`/`request.ips` output compared byte-for-byte against a real
 * Fastify 5.12.0 server configured with the literal `trustProxy: 1` for
 * five scenarios: a single real proxy hop; a different single real hop; a
 * client-fabricated prefix ahead of the real hop (D-082's own original
 * repro — `X-Forwarded-For: 6.6.6.6, 9.9.9.9` must resolve to `9.9.9.9`,
 * never the fabricated `6.6.6.6`); no header at all (direct connection);
 * and a longer fabricated multi-hop chain. All five matched exactly. The
 * one claim this function makes that could **not** be verified the same
 * way: `light-my-request`'s own `.inject()` always substitutes its own
 * default remote address whenever a falsy one is passed, so the genuinely-
 * undefined-socket-address path above rests on reading Fastify's own
 * source and the `@fastify/proxy-addr` contract, not an executed
 * reproduction — disclosed here rather than left silently unverified.
 *
 * **What this function does not do, stated plainly (D-104 "Update, same
 * day"):** `fastify@5.12.1`'s real advisory (GHSA-3m5p-2c4r-xxw2 /
 * CVE-2026-3635, named in `#52`'s own PR body) is that numeric `trustProxy`
 * never actually inspects the connecting address before trusting it as a
 * proxy — an attacker with direct network access to the origin, bypassing
 * the real reverse proxy entirely, can spoof `X-Forwarded-*` and have it
 * trusted. `Boolean(address)` above only rejects a *literally empty*
 * address; every real TCP connection has a non-empty `remoteAddress`, so
 * hop 0 is trusted unconditionally in every realistic scenario — the same
 * structural blind spot as the numeric `1` fastify disabled, just
 * expressed as a function. This function's own, real contribution is
 * narrower than that: the IISNode/undefined-socket-address edge case
 * described above, nothing more. The actual defense against the
 * advisory's spoofing scenario, for this deployment, is Railway's network
 * topology — verified live against the real `authz-api` service (no
 * public TCP proxy configured, one ordinary HTTP-edge-proxied
 * `serviceDomain`, no direct-to-container path from the public internet) —
 * not this function. See D-104's "Update, same day" for the full
 * reasoning, including the residual (accepted, disclosed) risk from other
 * services sharing this Railway project's private network.
 */
export const trustExactlyOneRealProxyHop = (address: string, hop: number): boolean =>
  hop === 0 && Boolean(address);

export interface BuildServerOptions {
  /**
   * Overrides the Fastify/pino request logger this function would otherwise
   * build from `env.LOG_LEVEL` (full-repo audit finding #14, LOW,
   * 2026-08-16). Omitted (the default, `undefined`) preserves production
   * behavior exactly — `serve.ts` (the one production caller) never passes
   * this option, so a real `authz serve` still gets `{ level: env.LOG_LEVEL
   * }` precisely as before. Every test file that calls `buildServer(pool)`
   * now passes `{ logger: false }` explicitly instead, so hundreds of
   * per-request JSON log lines (rate-limit and 404-flooding tests alone
   * fire well over a hundred requests each) no longer interleave with the
   * Vitest summary and bury real assertion diffs in CI output. `false` is
   * Fastify's own documented way to disable its logger entirely — distinct
   * from `{ level: 'silent' }`, which still constructs a full pino instance
   * and pays its per-call overhead, just without ever writing anything.
   */
  logger?: FastifyServerOptions['logger'];

  /**
   * Overrides `authFloodGuard`'s own `LruMap` entry cap (D-105). Omitted
   * (the default, `undefined`) preserves production behavior exactly —
   * `serve.ts` never passes this, so a real `authz serve` gets the full
   * `AUTH_FLOOD_STATE_MAX_ENTRIES`. Exists purely so a test can drive real
   * eviction with a handful of requests instead of tens of thousands —
   * mirrors this interface's own `logger` override precedent above.
   */
  authFloodStateMaxEntries?: number;
}

/**
 * Async — the one await in this function's own body is load-bearing, not
 * cosmetic. `app.register(rateLimit, ...)` must be awaited *before* any
 * route is declared: Fastify only attaches a plugin's `onRoute` hook (how
 * `@fastify/rate-limit` wires itself into each route) once that plugin's
 * own registration has actually resolved — a fire-and-forget
 * `void app.register(...)` immediately followed by synchronous route
 * declarations races the plugin's own setup and silently loses every route
 * to the plugin's hook (confirmed live: without this `await`, `max`/
 * `timeWindow` are accepted with no error, but no route is ever actually
 * rate-limited — no `x-ratelimit-*` headers, no `429`, at any request
 * count). See `docs/DECISIONS.md` D-056 and this file's own doc comment on
 * the plugin registration below.
 */
export async function buildServer(
  pool: Pool,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  // `trustProxy: trustExactlyOneRealProxyHop` (originally the literal
  // `trustProxy: 1`, D-082; replaced with this function in D-104 when
  // Fastify 5.12.1 removed numeric `trustProxy` support at the runtime
  // level, not just in its types — see that function's own doc comment
  // above for the full mechanism and live verification) — `serve.ts` binds
  // `0.0.0.0` specifically so this process can be reached "from outside the
  // process (a container, a platform like Railway)" (see that file's own
  // doc comment) — a platform-hosted deployment reached this way typically
  // sits behind exactly ONE reverse proxy/load balancer hop, not an
  // arbitrary chain, and never answers client sockets directly. Without any
  // trust, every request's rate-limit key (`request.ip`, the default
  // `keyGenerator`) resolves to the proxy's own address for every caller
  // alike, collapsing every distinct real client onto one shared budget.
  // `true` was the original D-065 fix for that, but `true` means "trust
  // every hop `X-Forwarded-For` claims," including hops the *client itself*
  // prepends ahead of the one real proxy-appended hop — a caller can send
  // `X-Forwarded-For: <anything>, <real-proxy-ip>` and have `request.ip`
  // resolve to their own fabricated value, defeating every rate limit in
  // this file (confirmed live: `trustProxy: true` resolves such a request
  // to the client's own spoofed address; trusting exactly one hop from the
  // right, i.e. the address the actual reverse proxy appended — resolves it
  // correctly regardless of what the client prepends). Trusting precisely
  // the one real hop this deployment shape has, never an attacker-
  // controlled prefix, is the fix — D-082 first shipped it as the literal
  // `1`, D-104 re-expresses the identical semantics as a function once
  // Fastify's own `number` support was removed. See `docs/DECISIONS.md`
  // D-082 and D-104 for the full history and revisit conditions.
  // `bodyLimit` (D-067's own disclosed-but-not-yet-implemented "defense in
  // depth" recommendation, docs/DECISIONS.md): a hard ceiling on every
  // request body, enforced at the HTTP content-type-parsing layer, before
  // any route's own Zod validation or domain logic ever runs. Fastify
  // itself already defaults to 1,048,576 bytes (1 MiB) when this option is
  // omitted — confirmed by reading `node_modules/fastify/lib/context.js`
  // and `config-validator.js` directly, not assumed — so this codebase has
  // never actually been unbounded; the gap D-067 flagged was that the
  // ceiling was implicit and undocumented, not genuinely absent, and never
  // tuned to what this API's own five operations actually need. 262,144
  // bytes (256 KiB) is set explicitly here instead: every real payload this
  // API ever legitimately receives is small (a tuple/check/expand body is a
  // few hundred bytes at most; every schema this project has ever written,
  // including `schema/example.authz`, is a few KB) — 256 KiB is generous by
  // roughly two orders of magnitude over any legitimate use while cutting
  // a would-be attacker's usable request-body budget to a quarter of
  // Fastify's own un-tuned default, exactly the "reject a pathological
  // schema before it ever reaches the parser at all" outcome D-067's own
  // text described. See `schemaSourceBodySchema` below for a second,
  // tighter, field-specific ceiling layered on top of this one.
  const app = Fastify({
    logger: options.logger ?? { level: env.LOG_LEVEL },
    trustProxy: trustExactlyOneRealProxyHop,
    bodyLimit: 262_144,
  });

  // Opt-in horizontal-scaling readiness (post-audit improvement, unset by
  // default — see `env.REDIS_URL`'s own doc comment and
  // `src/api/redis-store.ts`'s top-of-file doc comment for the full
  // reasoning). `env.REDIS_URL` unset (the default) means `redisClient` is
  // `undefined` here and every rate/flood mechanism below keeps its exact
  // pre-existing in-process behavior — nothing else in this function
  // changes shape depending on which branch this took.
  const redisClient = env.REDIS_URL ? createRedisClient(env.REDIS_URL, app.log) : undefined;
  if (redisClient) {
    app.addHook('onClose', async () => {
      await redisClient.quit();
    });
  }

  // Framework-level errors (malformed JSON body, etc.), the rate-limit
  // plugin's own thrown rejection (see the `retryAfterSeconds` marker below
  // — `@fastify/rate-limit` communicates a limit hit by *throwing* from its
  // `errorResponseBuilder`, not by returning a body directly, so it has to
  // be recognized and reshaped here like any other framework-level error),
  // and anything an individual route handler didn't already catch — the
  // one place `internalError` (src/api/errors.ts) is actually used, exactly
  // the role its own doc comment reserves for it.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const retryAfterSeconds = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
    if (typeof retryAfterSeconds === 'number') {
      const resp = rateLimitedError(retryAfterSeconds);
      void reply.code(resp.status).send(resp.body);
      return;
    }
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      // `reply.code(error.statusCode)`, not `resp.status`: every case that
      // reached this branch before the `bodyLimit` option above existed
      // was already a genuine 400 (a malformed JSON body, an unsupported
      // content type — Fastify's own defaults for both), so hardcoding
      // `invalidRequestError`'s own 400 changed nothing in practice. A
      // request that exceeds `bodyLimit` is Fastify's own
      // `FST_ERR_CTP_BODY_TOO_LARGE`, statusCode 413 — a real, standard,
      // distinct status a well-behaved client or proxy specifically checks
      // for, and collapsing it to 400 here would silently lose that signal
      // now that this is a reachable case. The response *body* still uses
      // `invalidRequestError`'s shape (this is still, in spirit, "your
      // request as sent cannot be fulfilled" — no new `ApiErrorCode` is
      // warranted for one framework-level status among several this same
      // envelope already covers); only the status code on the wire is
      // corrected to match what actually happened.
      const resp = invalidRequestError(error.message);
      void reply.code(error.statusCode).send(resp.body);
      return;
    }
    request.log.error(error);
    const resp = internalError();
    void reply.code(resp.status).send(resp.body);
  });

  /**
   * A per-IP request budget on every route, closing a real CodeQL finding
   * (`js/missing-rate-limiting`, high severity) on `/health`: an
   * unauthenticated route that queries Postgres on every call has no
   * barrier at all against a caller hammering it — see `docs/DECISIONS.md`.
   * Registered globally (not per-route) so every current and future route
   * gets a floor by default, never something a new route can accidentally
   * launch without; individual routes below override the default via their
   * own `config.rateLimit` where a different budget is actually warranted
   * (`/health` needs headroom for legitimate load-balancer polling; the
   * `ADMIN_API_KEY`-gated write routes get a stricter budget as
   * defense-in-depth against key-guessing and write-flooding even from a
   * caller who does hold a valid key).
   *
   * `errorResponseBuilder` cannot return `rateLimitedError`'s body
   * directly — the plugin's own `applyRateLimit` does
   * `throw params.errorResponseBuilder(...)`, treating the return value as
   * the thing to throw, not the response to send (its own default
   * implementation returns a real `Error` with `.statusCode` set, never a
   * plain object). So this returns an `Error` carrying a
   * `retryAfterSeconds` marker instead, and the `setErrorHandler` above
   * recognizes that marker and produces `rateLimitedError`'s own envelope
   * from it — a caller still sees the identical `{error:{code,message}}`
   * shape every other rejection in this API uses, never the plugin's own
   * default error body; only the plumbing to get there differs from every
   * other error path in this file.
   */
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    // `@fastify/rate-limit` switches its own internal store from the
    // default in-process `LocalStore` to its bundled `RedisStore`
    // automatically once handed a truthy `redis` option (confirmed by
    // reading that plugin's own `index.js` — `settings.redis` truthy is the
    // entire condition) — nothing else about this registration, or any
    // individual route's own `config.rateLimit`, needs to change for every
    // rate-limit check in this file to share one real, cross-replica budget
    // instead of one per process. Omitted entirely (not even `redis:
    // undefined`) when `redisClient` is unset, matching this option's own
    // "falsy means default in-process store" contract.
    ...(redisClient ? { redis: redisClient } : {}),
    errorResponseBuilder: (_request, context) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(context.ttl / 1000));
      const err = new Error(
        `rate limit exceeded — retry after ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}`,
      ) as Error & { retryAfterSeconds: number };
      err.retryAfterSeconds = retryAfterSeconds;
      return err;
    },
  });

  /**
   * A request to a path/method matching no route above never fires — and
   * never has fired — any route's own `onRoute` hook, because Fastify's
   * 404 handling runs entirely outside the matched-route hook lifecycle
   * `@fastify/rate-limit` wires itself into (confirmed directly: that
   * plugin's own `index.js` attaches only via `fastify.addHook('onRoute',
   * ...)`, never a global request hook). Two consequences, both real
   * (full-repo audit findings #13 and #14, MEDIUM, 2026-08-16, both
   * reproduced live — 150 consecutive requests to a non-existent path
   * never hit a 429 where an identical run against a real route did, at
   * request 101; and a 404 returned Fastify's own raw default body,
   * `{ error, message, statusCode }`, never this API's one documented
   * `{ error: { code, message } }` envelope every other response uses):
   * an unmatched path was rate-limited by nothing at all, and any client
   * written against the documented single-envelope contract would crash
   * parsing a 404. `setNotFoundHandler` with `preHandler: app.rateLimit()`
   * is `@fastify/rate-limit`'s own documented fix for exactly this gap
   * (its README's "Preventing guessing of URLs through 404s" section) —
   * reuses the same global `max`/`timeWindow` registered immediately
   * above, since an unmatched path deserves no more headroom than a real
   * route gets. See `docs/DECISIONS.md`.
   */
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, async (_request, reply) => {
    const resp = notFoundError();
    await reply.code(resp.status).send(resp.body);
  });

  /**
   * Attached per-route (via each gated route's own `{ preHandler }` option
   * below), not as a global `app.addHook('preHandler', ...)` matched
   * against `request.url` — a URL-string match is exactly the kind of
   * fragile, easy-to-typo gate a new route could accidentally fall outside
   * of (or a public route could accidentally fall inside of) with no type
   * error to catch it. Fastify's own route-level `preHandler` option keeps
   * "which routes are gated" declared right next to each route
   * registration instead of in a separately-maintained URL list. Gates the
   * three write routes and, since D-064, `/check`/`/expand` too — despite
   * this function's name, it is no longer write-specific; every route
   * below except `/schema/compile` and `/health` calls it.
   *
   * If this sends a response (an unauthorized request), Fastify's own hook
   * lifecycle stops there — the route handler below it is never invoked;
   * see `test/unit/api/server.test.ts`'s own fail-check confirming this
   * (the domain call itself is spied on and asserted never-called for a
   * rejected write).
   *
   * **This must run before rate-limit counting on every route it gates**
   * (D-065) — every `config.rateLimit` below that pairs with this
   * preHandler sets `hook: 'preHandler'` for exactly that reason. Fastify
   * runs preHandlers in array order; `@fastify/rate-limit`'s own `onRoute`
   * hook (`node_modules/@fastify/rate-limit/index.js`'s `addRouteRateHook`)
   * appends its handler onto whatever `preHandler` a route already declared
   * at registration time rather than replacing it — since this function is
   * always assigned first, in the route's own `preHandler` option, it
   * always runs first, and if it rejects, the array short-circuits there
   * (Fastify's own preHandler chain stops at the first response-sending
   * hook) — the rate-limit handler after it never runs, so a caller who
   * never even attempts a key can never consume the budget meant to
   * protect the one who holds it. Confirmed directly by reading that
   * plugin's own source, not assumed from its public docs alone.
   */
  async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = checkAdminAuth(request.headers.authorization);
    if (!result.authorized) {
      const detail =
        result.reason === 'admin_api_key_not_configured'
          ? 'ADMIN_API_KEY is not configured for this deployment — writes are disabled'
          : 'missing or invalid admin API key';
      await sendApiError(reply, unauthorizedError(detail));
    }
  }

  /**
   * The scoped, read-only credential tier's own gate (post-audit
   * improvement, D-064's own "Revisit if" — `src/api/auth.ts`'s
   * `checkReadAuth`). Gates `/check`, `/expand`, `/list-objects`, and
   * `/list-users` — every route that only ever answers a question about the
   * tuple graph, never one that changes it. Mirrors `requireAdminAuth`'s
   * own shape exactly (same "stop the preHandler chain on rejection" Fastify
   * mechanism, same `sendApiError`), differing only in which check function
   * it calls and how it phrases an unconfigured-credential rejection.
   */
  async function requireReadAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = checkReadAuth(request.headers.authorization);
    if (!result.authorized) {
      const detail =
        result.reason === 'no_read_credential_configured'
          ? 'neither READONLY_API_KEY nor ADMIN_API_KEY is configured for this deployment — reads are disabled'
          : 'missing or invalid API key';
      await sendApiError(reply, unauthorizedError(detail));
    }
  }

  /**
   * A second, independent, much coarser limiter on every request to a
   * gated route, positioned FIRST in that route's own `preHandler` array —
   * before `requireAdminAuth`, unlike `writeRateLimit`/`gatedReadRateLimit`
   * below, which are deliberately AFTER it (D-065). Full-repo audit finding
   * #10, MEDIUM, third audit, 2026-08-17.
   *
   * **The gap this closes.** D-065 correctly moved rate-limit *counting*
   * to run after `requireAdminAuth` so a flood of wrong-key requests could
   * never exhaust the budget a legitimate key-holder needs — but the
   * necessary consequence, never weighed at the time, is that a failed-auth
   * request is now counted by NO limiter at all: `@fastify/rate-limit`
   * gives a route with its own `config.rateLimit` *only* that route's own
   * limiter, never a global fallback underneath it (confirmed by reading
   * `node_modules/@fastify/rate-limit/index.js`'s own `onRoute` hook — a
   * route-level config entirely replaces the global one for that route,
   * never layers under it), and Fastify's preHandler chain stops the
   * instant `requireAdminAuth` sends its 401 — the array's later entries,
   * including `writeRateLimit`/`gatedReadRateLimit`'s own counting hook,
   * never run (confirmed by this project's own D-065 regression test:
   * repeated wrong-key requests all return 401, never 429). So every
   * failed-auth request against `/tuples`, `/check`, `/expand`, or
   * `/schema/publish` was, by design of D-065's own fix, entirely
   * unbounded.
   *
   * **Why not just add a second `@fastify/rate-limit` limiter via
   * `app.rateLimit(options)` (the same decorator `setNotFoundHandler`
   * already uses above) instead of hand-rolling one?** Read directly from
   * that plugin's own source before ruling it out, not assumed: every
   * limiter check born from ONE `app.register(rateLimit, ...)` call —
   * whether the automatic per-route `config.rateLimit` wiring or a manual
   * `app.rateLimit(options)` call — shares one `pluginComponent.rateLimitRan`
   * flag *per request*. `rateLimitRequestHandler` sets that flag on the
   * FIRST check it runs and every subsequent check on the same request
   * returns immediately without ever calling `applyRateLimit` — a silent
   * no-op, not a second count. Registering a second `app.rateLimit(...)`
   * limiter ahead of `requireAdminAuth` would set that shared flag on
   * *every* request (auth succeeds or fails), which would then silently
   * disable `writeRateLimit`/`gatedReadRateLimit`'s own later, stricter,
   * successful-request budget entirely — not add a second layer alongside
   * it, but quietly remove the first one. A small, self-contained,
   * in-memory counter avoids that shared-flag interaction altogether, at
   * the cost of not inheriting the library's IPv6-subnet-aware key
   * normalization or Redis-store option — neither of which this narrow,
   * single-purpose guard needs.
   *
   * **Scope and threshold.** Local to this `buildServer` call (like
   * `requireAdminAuth` itself) — a fresh, empty counter per server
   * instance, never a module-level global that would leak state across
   * separate `buildServer()` calls in the same process (every test file in
   * this project builds a fresh app per test). 1000 requests per rolling
   * 60-second window per `request.ip` (the same `trustExactlyOneRealProxyHop`
   * -resolved value every other limiter in this file already uses) — deliberately
   * far more generous than `writeRateLimit`'s 20/min or
   * `gatedReadRateLimit`'s 200/min: this exists only to bound a genuine
   * flood (D-065's own scenario), never to police normal admin traffic,
   * which comes nowhere close to 1000 requests/minute from one address in
   * any real use this project has ever had.
   *
   * **Bounded, not a plain `Map` (D-105; a real full-repo-audit finding,
   * HIGH — the guard meant to bound memory usage was itself unbounded).**
   * A plain `Map<request.ip, ...>` gains one permanent entry per distinct
   * source address ever seen, with no eviction — `trustExactlyOneRealProxyHop`
   * stops header-spoofing, but it does nothing to stop an unauthenticated
   * caller who controls a routable IPv6 `/64` (cheap or free from most
   * cloud/VPS providers) from trivially presenting an effectively unlimited
   * number of distinct *real* source addresses, growing this Map without
   * bound for the life of the process. `toad-cache`'s `LruMap` (already a
   * transitive dependency of `@fastify/rate-limit`, now direct here) closes
   * this the same way `@fastify/rate-limit`'s own `LocalStore` bounds
   * itself: a `max` entry cap with LRU eviction, so memory is bounded
   * regardless of how many distinct addresses a caller can present. `max`
   * is set well above any real deployment's distinct-address count in one
   * window, so eviction only ever engages under genuine attack, matching
   * this guard's own "bound abuse, never police normal traffic" purpose.
   */
  const AUTH_FLOOD_MAX = 1000;
  const AUTH_FLOOD_WINDOW_MS = 60_000;
  const AUTH_FLOOD_STATE_MAX_ENTRIES = 50_000;

  // Backed by Redis (shared, cross-replica) when `env.REDIS_URL` is set,
  // the same pre-existing in-process `LruMap` counting otherwise — see
  // `src/api/redis-store.ts`'s own top-of-file doc comment. `FloodStore`
  // itself is the one thing that changed here; `authFloodGuard`'s own logic
  // below is otherwise unchanged from before this abstraction existed.
  const floodStore: FloodStore = redisClient
    ? new RedisFloodStore(redisClient)
    : new InMemoryFloodStore(options.authFloodStateMaxEntries ?? AUTH_FLOOD_STATE_MAX_ENTRIES);

  async function authFloodGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { count, msUntilReset } = await floodStore.increment(request.ip, AUTH_FLOOD_WINDOW_MS);
    if (count > AUTH_FLOOD_MAX) {
      const retryAfterSeconds = Math.max(1, Math.ceil(msUntilReset / 1000));
      await sendApiError(reply, rateLimitedError(retryAfterSeconds));
    }
  }

  /**
   * `[authFloodGuard, requireAdminAuth]`, in that order — every gated
   * route's own `preHandler`. See `authFloodGuard`'s own doc comment for
   * why the flood guard must run first.
   *
   * A **function that returns a fresh array on every call**, not a single
   * shared array constant handed to all five gated routes — a real bug,
   * caught live during this fix's own verification, not shipped: five
   * routes here each set `config.rateLimit`, and `@fastify/rate-limit`'s
   * own `onRoute` hook appends its counting handler onto whatever
   * `preHandler` array a route was registered with via a plain
   * `Array.prototype.push` (`node_modules/@fastify/rate-limit/index.js`'s
   * `addRouteRateHook`) — an in-place mutation. A single shared array
   * reference passed to all five `app.post`/`app.delete` calls below would
   * accumulate all five routes' own rate-limit handlers onto the *one*
   * array object every route's `preHandler` option actually points to, so
   * every gated route would run with the exact same final, fully-merged
   * preHandler array regardless of which route it was — and since every
   * limiter check born from this file's one `app.register(rateLimit, ...)`
   * call shares one "already ran" flag per request (see `authFloodGuard`'s
   * own doc comment on `rateLimitRan`), only the first of those five
   * accumulated limiter checks would ever actually count anything; the
   * other four would silently no-op on every request, regardless of route.
   * Confirmed live: `test/unit/api/rate-limit.test.ts`'s own pre-existing
   * `writeRateLimit` (20/minute) test failed with a shared array (every
   * request kept returning its real 400, never the expected 429, because
   * `/check`'s own 200/minute limiter — registered first and so appended
   * first — silently absorbed the counting for every route). A fresh array
   * per call site closes this: each route's own `preHandler` option is a
   * distinct array object, so `@fastify/rate-limit`'s per-route mutation
   * only ever touches the one array actually registered for that route.
   */
  function gatedPreHandlers(): [typeof authFloodGuard, typeof requireAdminAuth] {
    return [authFloodGuard, requireAdminAuth];
  }

  /**
   * The read-only-credential-tier counterpart of `gatedPreHandlers` above —
   * identical reasoning (a fresh array per call site, `authFloodGuard`
   * first), differing only in which auth check runs second. Used by
   * `/check`, `/expand`, `/list-objects`, and `/list-users` — every route
   * `requireReadAuth` itself is scoped to.
   */
  function gatedReadPreHandlers(): [typeof authFloodGuard, typeof requireReadAuth] {
    return [authFloodGuard, requireReadAuth];
  }

  // A stricter budget than the global default (D-056): defense-in-depth
  // against ADMIN_API_KEY-guessing and write-flooding, even from a caller
  // who does hold a valid key. `hook: 'preHandler'` (D-065) — see
  // `requireAdminAuth`'s own doc comment for why this must run after auth,
  // not before.
  const writeRateLimit = {
    config: { rateLimit: { max: 20, timeWindow: '1 minute', hook: 'preHandler' as const } },
  };

  // A more generous budget than writes get (D-064): once gated, `/check`/
  // `/expand` are expected to be called far more often in normal use than
  // an admin write is — a real integrated caller might run a check per
  // incoming request to whatever it protects. Still `hook: 'preHandler'`
  // for the identical reason `writeRateLimit` needs it.
  const gatedReadRateLimit = {
    config: { rateLimit: { max: 200, timeWindow: '1 minute', hook: 'preHandler' as const } },
  };

  // The check-result cache (post-audit improvement, closes D-028 —
  // `src/resolve/production/cache.ts`). `createCheckCache` returns
  // `undefined` — never constructing anything — for `env.CHECK_CACHE_TTL_MS`'s
  // own documented default of `0`, so a default deployment allocates nothing
  // new here and `performCheck` below runs exactly as it always has (see
  // that function's own doc comment: an `undefined` cache argument preserves
  // today's behavior byte-for-byte). `CHECK_CACHE_MAX_ENTRIES` is a plain
  // LRU bound on this cache's own memory use, independent of
  // `CHECK_CACHE_TTL_MS` — mirroring this file's own `AUTH_FLOOD_STATE_MAX_ENTRIES`
  // precedent (D-105): a cap large enough that eviction only engages under
  // genuinely heavy real traffic, never during ordinary use.
  const CHECK_CACHE_MAX_ENTRIES = 10_000;
  const checkCache: CheckCache | undefined = createCheckCache(
    CHECK_CACHE_MAX_ENTRIES,
    env.CHECK_CACHE_TTL_MS,
  );

  app.post(
    '/check',
    { preHandler: gatedReadPreHandlers(), ...gatedReadRateLimit },
    async (request, reply) => {
      const parsed = checkBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const { subject, relation, object, atToken: opaqueAtToken } = parsed.data;
      let atToken: number | undefined;
      if (opaqueAtToken !== undefined) {
        try {
          atToken = decodeToken(opaqueAtToken);
        } catch (err) {
          await sendApiError(reply, invalidRequestError((err as Error).message));
          return;
        }
      }
      const result = await runOrInfrastructureError(reply, () =>
        performCheck(
          pool,
          subject,
          object,
          relation,
          atToken !== undefined ? { atToken } : {},
          checkCache,
        ),
      );
      if (result === undefined) return;
      const resp = checkResponse(subject, relation, object, result, atToken);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.post(
    '/expand',
    { preHandler: gatedReadPreHandlers(), ...gatedReadRateLimit },
    async (request, reply) => {
      const parsed = expandBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const { object, relation } = parsed.data;
      const tree = await runOrInfrastructureError(reply, () => expand(pool, object, relation));
      if (tree === undefined) return;
      const resp = expandResponse(object, relation, tree);
      await reply.code(resp.status).send(resp.body);
    },
  );

  // Bulk reverse-lookup operations (post-audit improvement — `src/audit/
  // list.ts`). Gated by `requireReadAuth` and rate-limited exactly like
  // `/check`/`/expand` — each is, in spirit, the same "read/oracle" access
  // as a check, just answering the reverse question. Neither ever calls
  // `performCheck`, so neither is logged to the `checks` audit table — see
  // `list.ts`'s own top-of-file doc comment for why that's a deliberate,
  // disclosed gap, not an oversight.
  app.post(
    '/list-objects',
    { preHandler: gatedReadPreHandlers(), ...gatedReadRateLimit },
    async (request, reply) => {
      const parsed = listObjectsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const { subject, relation, objectNs, atToken: opaqueAtToken } = parsed.data;
      let atToken: number | undefined;
      if (opaqueAtToken !== undefined) {
        try {
          atToken = decodeToken(opaqueAtToken);
        } catch (err) {
          await sendApiError(reply, invalidRequestError((err as Error).message));
          return;
        }
      }
      const result = await runOrInfrastructureError(reply, () =>
        listObjects(pool, subject, relation, objectNs, atToken !== undefined ? { atToken } : {}),
      );
      if (result === undefined) return;
      const resp = listObjectsResponse(subject, relation, objectNs, result, atToken);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.post(
    '/list-users',
    { preHandler: gatedReadPreHandlers(), ...gatedReadRateLimit },
    async (request, reply) => {
      const parsed = listUsersBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const { object, relation } = parsed.data;
      const result = await runOrInfrastructureError(reply, () => listUsers(pool, object, relation));
      if (result === undefined) return;
      const resp = listUsersResponse(object, relation, result);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.post(
    '/tuples',
    { preHandler: gatedPreHandlers(), ...writeRateLimit },
    async (request, reply) => {
      const parsed = tupleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      // Optional validity-window expiry (D-144) — parsed here, not in
      // `tupleBodySchema` above, mirroring `/check`'s own `atToken` decode:
      // a malformed value gets this route's own `invalidRequestError` shape,
      // not a differently-worded Zod error, and `writeTuple` is never
      // called for it.
      const { expiresAt: rawExpiresAt } = parsed.data;
      let expiresAt: Date | undefined;
      if (rawExpiresAt !== undefined) {
        expiresAt = new Date(rawExpiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          await sendApiError(
            reply,
            invalidRequestError('expiresAt: not a valid ISO-8601 date string'),
          );
          return;
        }
      }
      const tuple = toTupleKey(parsed.data);
      if (expiresAt !== undefined) tuple.expiresAt = expiresAt;
      const result = await runOrInfrastructureError(reply, () => writeTuple(pool, tuple));
      if (result === undefined) return;
      // Every successful write can change a cached check's answer — see
      // `cache.ts`'s own top-of-file doc comment for why this is a
      // deliberately coarse, whole-cache invalidation, called before this
      // route's own response is sent (synchronously, in-process). Never
      // called on the `ok: false` (validation failure) branch — nothing
      // was actually written, so nothing could have gone stale.
      if (result.ok) checkCache?.clear();
      const resp = tupleWriteResponse(result);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.delete(
    '/tuples',
    { preHandler: gatedPreHandlers(), ...writeRateLimit },
    async (request, reply) => {
      const parsed = tupleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const tuple = toTupleKey(parsed.data);
      const result = await runOrInfrastructureError(reply, () => deleteTuple(pool, tuple));
      if (result === undefined) return;
      // See the identical comment on `POST /tuples` above.
      if (result.ok) checkCache?.clear();
      const resp = tupleDeleteResponse(result);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.post('/schema/compile', async (request, reply) => {
    const parsed = schemaSourceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
      return;
    }
    const result = compileSchema(parsed.data.source);
    const resp = schemaCompileResponse(result);
    await reply.code(resp.status).send(resp.body);
  });

  app.post(
    '/schema/publish',
    { preHandler: gatedPreHandlers(), ...writeRateLimit },
    async (request, reply) => {
      const parsed = schemaSourceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const result = await runOrInfrastructureError(reply, () =>
        publishSchema(pool, parsed.data.source),
      );
      if (result === undefined) return;
      // A republished namespace can change a cached check's answer even
      // with zero tuple writes (a changed rewrite rule) — see `cache.ts`'s
      // own top-of-file doc comment. Same reasoning as the two tuple routes
      // above, applied to schema publishes.
      if (result.ok) checkCache?.clear();
      const resp = schemaPublishResponse(result);
      await reply.code(resp.status).send(resp.body);
    },
  );

  // Deliberately unauthenticated — see docs/DECISIONS.md. Load-balancer /
  // uptime-monitor convention (this is the endpoint that decides whether an
  // instance stays in rotation), and nothing in the response is a
  // permission decision or a secret: namespace names/versions are schema
  // metadata, not tuple data. A higher rate-limit budget than the global
  // default — real load-balancer/uptime polling can legitimately hit this
  // far more often than a normal API caller hits any other route.
  app.get(
    '/health',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // Two independent try/catches, deliberately — not one wrapping both
      // calls (full-repo audit finding #22, MEDIUM, 2026-08-16). The
      // connectivity probe (`select 1`) and the namespace-listing query are
      // two different questions with two different honest answers: a
      // listing-query failure (e.g. an unapplied migration) with Postgres
      // itself perfectly reachable must never be reported as "database
      // unreachable" — that claim would simply be false. See
      // `src/api/responses.ts`'s `HealthNamespaceListStatus` and
      // `healthResponse` for how the two outcomes stay distinguishable on
      // the wire while both still fail closed (503). See docs/DECISIONS.md.
      try {
        await pool.query('select 1');
      } catch (err) {
        // The real driver error is logged server-side only, never forwarded
        // over the wire (full-repo audit finding #15, MEDIUM, 2026-08-16): a
        // real connection failure routinely includes internal hostnames,
        // ports, or usernames, and this route is deliberately unauthenticated
        // (load-balancer/uptime-monitor convention — see this route's own
        // top comment), so *any* network caller could previously read it.
        request.log.error({ err }, 'GET /health: connectivity probe failed');
        const resp = healthResponse(
          { reachable: false, error: 'database is unreachable' },
          { ok: false, error: 'not attempted — database unreachable' },
        );
        await reply.code(resp.status).send(resp.body);
        return;
      }

      try {
        const namespaces = await listLatestNamespaceVersions(pool);
        const resp = healthResponse({ reachable: true }, { ok: true, namespaces });
        await reply.code(resp.status).send(resp.body);
      } catch (err) {
        // Connectivity is fine (the probe above already succeeded) — this
        // is the namespace-listing query failing on its own, a different,
        // distinctly logged diagnosis. Same non-disclosure reasoning as the
        // probe-failure branch above for the wire-facing message.
        request.log.error({ err }, 'GET /health: namespace listing failed');
        const resp = healthResponse(
          { reachable: true },
          { ok: false, error: 'namespace listing failed' },
        );
        await reply.code(resp.status).send(resp.body);
      }
    },
  );

  return app;
}
