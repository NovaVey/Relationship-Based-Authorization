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
} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';

import { env } from '../config/env.js';
import { performCheck } from '../audit/checks.js';
import { expand } from '../audit/expand.js';
import { writeTuple, deleteTuple, type TupleKey } from '../store/tuples.js';
import { compileSchema } from '../schema/dsl/compiler.js';
import { publishSchema, listLatestNamespaceVersions } from '../schema/publish.js';
import { checkAdminAuth } from './auth.js';
import {
  checkResponse,
  expandResponse,
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
  type ApiErrorResponse,
} from './errors.js';

const entityRefSchema = z.object({ ns: z.string().min(1), id: z.string().min(1) });

const checkBodySchema = z.object({
  subject: entityRefSchema,
  relation: z.string().min(1),
  object: entityRefSchema,
  atToken: z.number().int().nonnegative().optional(),
});

const expandBodySchema = z.object({
  object: entityRefSchema,
  relation: z.string().min(1),
});

const tupleBodySchema = z.object({
  objectNs: z.string().min(1),
  objectId: z.string().min(1),
  relation: z.string().min(1),
  subjectNs: z.string().min(1),
  subjectId: z.string().min(1),
  subjectRelation: z.string().min(1).optional(),
});

const schemaSourceBodySchema = z.object({ source: z.string().min(1) });

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
export async function buildServer(pool: Pool): Promise<FastifyInstance> {
  // `trustProxy: true` (D-065) — `serve.ts` binds `0.0.0.0` specifically so
  // this process can be reached "from outside the process (a container, a
  // platform like Railway)" (see that file's own doc comment) — a
  // platform-hosted deployment reached this way typically sits behind that
  // platform's own reverse proxy/load balancer rather than answering client
  // sockets directly. Without this, every request's rate-limit key
  // (`request.ip`, the default `keyGenerator`) resolves to the proxy's own
  // address for every caller alike, collapsing every distinct real client
  // onto one shared budget — a single caller could exhaust it for everyone
  // behind the same proxy. `true` trusts `X-Forwarded-For` unconditionally;
  // see `docs/DECISIONS.md` D-065 for the tradeoff this accepts and when to
  // revisit it (e.g. a deployment that genuinely answers raw sockets
  // directly, where this would let a client spoof its own rate-limit key).
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

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
      const resp = invalidRequestError(error.message);
      void reply.code(resp.status).send(resp.body);
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

  app.post(
    '/check',
    { preHandler: requireAdminAuth, ...gatedReadRateLimit },
    async (request, reply) => {
      const parsed = checkBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const { subject, relation, object, atToken } = parsed.data;
      const result = await runOrInfrastructureError(reply, () =>
        performCheck(pool, subject, object, relation, atToken !== undefined ? { atToken } : {}),
      );
      if (result === undefined) return;
      const resp = checkResponse(subject, relation, object, result, atToken);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.post(
    '/expand',
    { preHandler: requireAdminAuth, ...gatedReadRateLimit },
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

  app.post(
    '/tuples',
    { preHandler: requireAdminAuth, ...writeRateLimit },
    async (request, reply) => {
      const parsed = tupleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const tuple = toTupleKey(parsed.data);
      const result = await runOrInfrastructureError(reply, () => writeTuple(pool, tuple));
      if (result === undefined) return;
      const resp = tupleWriteResponse(result);
      await reply.code(resp.status).send(resp.body);
    },
  );

  app.delete(
    '/tuples',
    { preHandler: requireAdminAuth, ...writeRateLimit },
    async (request, reply) => {
      const parsed = tupleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await sendApiError(reply, invalidRequestError(describeZodError(parsed.error)));
        return;
      }
      const tuple = toTupleKey(parsed.data);
      const result = await runOrInfrastructureError(reply, () => deleteTuple(pool, tuple));
      if (result === undefined) return;
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
    { preHandler: requireAdminAuth, ...writeRateLimit },
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
    async (_request, reply) => {
      try {
        await pool.query('select 1');
        const namespaces = await listLatestNamespaceVersions(pool);
        const resp = healthResponse({ reachable: true }, namespaces);
        await reply.code(resp.status).send(resp.body);
      } catch (err) {
        const resp = healthResponse({ reachable: false, error: (err as Error).message }, []);
        await reply.code(resp.status).send(resp.body);
      }
    },
  );

  return app;
}
