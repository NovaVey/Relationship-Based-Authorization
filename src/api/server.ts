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
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
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

export function buildServer(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  // Framework-level errors (malformed JSON body, etc.) and anything an
  // individual route handler didn't already catch — the one place
  // `internalError` (src/api/errors.ts) is actually used, exactly the role
  // its own doc comment reserves for it.
  app.setErrorHandler((error: FastifyError, request, reply) => {
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
   * Attached per-route (via each write route's own `{ preHandler }` option
   * below), not as a global `app.addHook('preHandler', ...)` matched
   * against `request.url` — a URL-string match is exactly the kind of
   * fragile, easy-to-typo gate a new route could accidentally fall outside
   * of (or a read route could accidentally fall inside of) with no type
   * error to catch it. Fastify's own route-level `preHandler` option keeps
   * "which routes are gated" declared right next to each route
   * registration instead of in a separately-maintained URL list.
   *
   * If this sends a response (an unauthorized request), Fastify's own hook
   * lifecycle stops there — the route handler below it is never invoked;
   * see `test/unit/api/server.test.ts`'s own fail-check confirming this
   * (the domain call itself is spied on and asserted never-called for a
   * rejected write).
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

  app.post('/check', async (request, reply) => {
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
  });

  app.post('/expand', async (request, reply) => {
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
  });

  app.post('/tuples', { preHandler: requireAdminAuth }, async (request, reply) => {
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
  });

  app.delete('/tuples', { preHandler: requireAdminAuth }, async (request, reply) => {
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
  });

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

  app.post('/schema/publish', { preHandler: requireAdminAuth }, async (request, reply) => {
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
  });

  // Deliberately unauthenticated — see docs/DECISIONS.md. Load-balancer /
  // uptime-monitor convention (this is the endpoint that decides whether an
  // instance stays in rotation), and nothing in the response is a
  // permission decision or a secret: namespace names/versions are schema
  // metadata, not tuple data.
  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('select 1');
      const namespaces = await listLatestNamespaceVersions(pool);
      const resp = healthResponse({ reachable: true }, namespaces);
      await reply.code(resp.status).send(resp.body);
    } catch (err) {
      const resp = healthResponse({ reachable: false, error: (err as Error).message }, []);
      await reply.code(resp.status).send(resp.body);
    }
  });

  return app;
}
