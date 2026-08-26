/**
 * The one error envelope every Fastify route in this API returns for a
 * non-2xx outcome — build spec `.claude/commands/build-authz-service.md`
 * §9 Phase 8 ("Fastify server exposing `check`/`expand`/`write`/`schema`")
 * and the `report-designer` brief's own copy rule ("errors name the fix").
 * Pure, DB-free, no Fastify import: this file only decides *shape* and
 * *status code*, never how a route gets from a thrown error to calling one
 * of these constructors — that wiring is `src/api/server.ts`'s job (main
 * agent, Phase 8), the same division `src/report/exitCodes.ts` established
 * for the CLI's own `verdict -> exit code` mapping.
 *
 * ---
 *
 * **Why every constructor returns `{ status, body }` together, not a body
 * alone plus a separate status lookup.** `src/report/exitCodes.ts` gets away
 * with a bare `verdict -> code` table because `SoundnessVerdict` is a closed
 * three-value enum with nothing else to say. An HTTP error response is
 * richer — the status code and the body are two views of the *same*
 * decision (a `TupleError[]` rejection is always 400 and always shaped this
 * way) — so keeping them paired at the one place that decision is made
 * removes an entire class of route-handler bug: a status/body mismatch from
 * looking the two up separately and getting one of them wrong. A route
 * handler calls one of these, then does exactly
 * `reply.code(result.status).send(result.body)` — nothing upstream of that
 * has to know which status belongs with which shape.
 *
 * **Why the status-code table (`API_ERROR_STATUS`) still exists as its own
 * exported, inspectable `Record`, not just inlined per constructor.** Same
 * reason `SOUNDNESS_EXIT_CODES` in `exitCodes.ts` is a table and not a
 * `switch`: "what status does code X map to" should be answerable by
 * reading one small object, not by re-deriving it from every call site that
 * happens to construct that code.
 */

import type { TupleError } from '../store/tuples.js';
import type { SchemaError } from '../schema/dsl/errors.js';
import { formatSchemaError } from '../schema/dsl/errors.js';

/**
 * Every error code this API surface can produce. Deliberately more granular
 * than a single generic `validation_failed` — `tuple_validation_failed` and
 * `schema_compile_failed` stay distinguishable at the top level (before a
 * caller even looks at `details`) because they carry structurally different
 * detail shapes (`TupleError[]` vs `SchemaError[]`/`string[]`), matching
 * this codebase's own established preference for precise, specific error
 * codes over one catch-all (`TupleError['code']`, `SchemaErrorCode` both
 * already do this within their own layers — this is the same discipline
 * applied at the API boundary).
 */
export type ApiErrorCode =
  | 'invalid_request'
  | 'tuple_validation_failed'
  | 'schema_compile_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'infrastructure_unavailable'
  | 'internal_error';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /**
     * A complete, human-readable sentence naming the fix, never a vague
     * "something went wrong" — matches the report-designer brief's own copy
     * rule and `docs/DECISIONS.md` D-047's own established example
     * (`"Postgres: <message>"` for an infrastructure failure, reused
     * verbatim below so the CLI and this API surface report the exact same
     * failure the exact same way).
     */
    message: string;
    /**
     * Present only when there's real structured detail beyond `message` —
     * every `TupleError`/`SchemaError` this operation actually produced,
     * each with its own machine-readable `code`, never flattened into
     * `message`-only text a caller would have to string-match to act on
     * programmatically.
     */
    details?: unknown;
  };
}

export interface ApiErrorResponse {
  status: number;
  body: ApiErrorBody;
}

/**
 * `ApiErrorCode -> HTTP status`. See this file's own top-of-file doc
 * comment for why this is a small standalone table rather than inlined:
 *
 * - `invalid_request` — 400. Added by `src/api/server.ts` (main agent,
 *   Phase 8) for a case this file's original brief didn't cover: a raw HTTP
 *   request body that fails structural validation (missing/mistyped field)
 *   before it ever becomes a domain call this file's other constructors
 *   know how to fail. See `invalidRequestError` below.
 * - `tuple_validation_failed` / `schema_compile_failed` — 400. Bad input,
 *   full stop — see `tupleValidationError`'s own doc comment for why every
 *   `TupleError['code']`, including `no_published_schema`, stays 400 rather
 *   than splitting some codes into a 404-shaped response.
 * - `unauthorized` — 401. A missing/wrong `ADMIN_API_KEY` on a gated write
 *   route.
 * - `forbidden` — 403. Added by `src/api/server.ts` (real, mintable,
 *   namespace-scoped DB-backed API keys — `src/api/db-api-keys.ts`): a
 *   credential that authenticated successfully but is scoped to a set of
 *   namespaces that doesn't cover this specific request's target
 *   namespace(s). Distinct from `unauthorized`/401 on purpose, following
 *   ordinary HTTP convention: 401 means "who are you, and this deployment
 *   couldn't establish that" (no credential, or one that matches nothing
 *   at all); 403 means "this deployment knows exactly who you are, and
 *   that identity's own authority doesn't reach what you're asking for."
 *   Collapsing the two into one status would force every client to parse
 *   `message` text to tell "your key is wrong" apart from "your key is
 *   real but doesn't cover this namespace" — two different, differently-
 *   actionable problems (get a valid credential, versus get one scoped
 *   more broadly, or ask for something the one you have actually covers).
 * - `not_found` — 404. An HTTP request whose method and path match no route
 *   this API registers at all — a genuine 404, distinct from a domain-level
 *   "no published schema for this namespace," which stays
 *   `tuple_validation_failed`/400 (see `tupleValidationError`'s own doc
 *   comment for why that stays 400; not repeated here). Added by
 *   `src/api/server.ts` (main agent, Phase 8): Fastify's own
 *   `setNotFoundHandler` calls `notFoundError` so an unmatched route still
 *   gets this API's own consistent error envelope instead of Fastify's
 *   default 404 body — the same division of labor already documented for
 *   `rate_limited` below.
 * - `rate_limited` — 429. Added by `src/api/server.ts` (main agent, Phase 8,
 *   alongside the `@fastify/rate-limit` registration — see that file's own
 *   doc comment and `docs/DECISIONS.md`): a caller exceeded the per-route
 *   request budget. Never produced by any function in this file directly —
 *   `@fastify/rate-limit`'s own `errorResponseBuilder` calls
 *   `rateLimitedError` to keep this one response shape even for a limit the
 *   plugin itself enforces, the same reason `invalid_request` exists for
 *   Zod's own framework-level rejections.
 * - `infrastructure_unavailable` — 503, not 500. See
 *   `infrastructureUnavailableError`'s own doc comment: this is Postgres
 *   being unreachable, the same condition the CLI reports as exit code 3
 *   (§7) — a distinct, named category from "the server had a bug," which is
 *   what a bare 500 conventionally signals to a caller or an upstream load
 *   balancer.
 * - `internal_error` — 500. The one true catch-all, reserved for something
 *   none of this API's own named operations anticipated — never produced by
 *   any function in `src/api/responses.ts` itself.
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  tuple_validation_failed: 400,
  schema_compile_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  infrastructure_unavailable: 503,
  internal_error: 500,
};

function apiError(code: ApiErrorCode, message: string, details?: unknown): ApiErrorResponse {
  return {
    status: API_ERROR_STATUS[code],
    body: {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
}

/**
 * A raw HTTP request body that fails structural validation — wrong type, a
 * required field missing, an unparseable JSON payload — before it ever
 * reaches a domain call this file's other constructors know how to fail.
 * Added by `src/api/server.ts` (main agent, Phase 8): the rest of this file
 * was built against already-computed domain results (a `WriteTupleResult`,
 * a `SchemaCompileResult`), which presuppose a well-formed request already
 * got that far — see `src/api/responses.ts`'s own top-of-file doc comment
 * ("no request-body parsing" is explicitly out of scope there). `detail` is
 * expected to be a short, specific description of what was wrong (e.g. a
 * flattened Zod issue list), matching every other constructor's "name the
 * fix" discipline in this file.
 */
export function invalidRequestError(detail: string): ApiErrorResponse {
  return apiError('invalid_request', `invalid request — ${detail}`);
}

/**
 * A rejected `tuple write` or `tuple delete` — `src/store/tuples.ts`'s
 * `WriteTupleResult`/`DeleteTupleResult` `{ ok: false; errors: TupleError[] }`
 * branch. Always 400, regardless of which `TupleError['code']` value fired
 * — including `no_published_schema`, which reads like "the namespace
 * doesn't exist" and could plausibly be argued as 404. It stays 400 here
 * deliberately: this API has no `/namespaces/:ns` resource a caller `GET`s
 * (schema config isn't one of the five operations §9 Phase 8 names), so
 * there is no *fetchable resource* whose absence 404 conventionally
 * signals — `no_published_schema` is exactly as much "this request, as
 * constructed, can't be fulfilled right now" as `undeclared_relation` or
 * `invalid_identifier` are, and treating one `TupleError` code as a
 * different HTTP status class than its siblings would force every client
 * to branch on status *and* code instead of code alone. Every individual
 * `TupleError`'s own `code` (and its already-actionable `message` — see
 * `src/store/tuples.ts`'s own `no_published_schema` message, "... run
 * `authz schema publish` before writing tuples against it") is preserved
 * verbatim in `details.errors`, so nothing about the specific failure is
 * lost by staying at one status.
 */
export function tupleValidationError(
  operation: 'write' | 'delete',
  errors: readonly TupleError[],
): ApiErrorResponse {
  return apiError(
    'tuple_validation_failed',
    `tuple ${operation} rejected — ${errors.length} error${errors.length === 1 ? '' : 's'}, see details`,
    { errors },
  );
}

/**
 * One `SchemaError` plus its ready-to-display `formatSchemaError` rendering
 * (`"line N: message"`) — so an API caller gets both the structured fields
 * (`code`, `line`, `namespace`, `member`) to act on programmatically *and*
 * the same one-line text the CLI already prints for the identical error,
 * without re-deriving it client-side.
 */
export interface ApiSchemaError extends SchemaError {
  formatted: string;
}

function toApiSchemaError(error: SchemaError): ApiSchemaError {
  return { ...error, formatted: formatSchemaError(error) };
}

/**
 * A failed `schema compile` (dry run) — `compileSchema`'s
 * `{ ok: false; errors: SchemaError[] }` branch. `details.errors` carries
 * every error's full structured shape (`ApiSchemaError` above), not just
 * `formatSchemaError`'s flattened string — this is the one schema-failure
 * path where the full `SchemaError` is actually available to this response
 * layer (see `schemaPublishError` below for why `publish`'s own failure
 * shape is deliberately different).
 */
export function schemaCompileError(errors: readonly SchemaError[]): ApiErrorResponse {
  return apiError(
    'schema_compile_failed',
    `schema failed to compile — ${errors.length} error${errors.length === 1 ? '' : 's'}, see details`,
    { errors: errors.map(toApiSchemaError) },
  );
}

/**
 * A failed `schema publish` — `publishSchema`'s
 * `{ ok: false; errors: string[] }` branch. Unlike `schemaCompileError`,
 * `details.errors` here is a plain `string[]`: `src/schema/publish.ts`
 * itself only ever fails via `compileSchema` and immediately flattens the
 * result through `formatSchemaError` before returning
 * (`compiled.errors.map(formatSchemaError)`) — the original structured
 * `SchemaError[]` is already gone by the time `PublishResult` reaches this
 * function. This is a real, and real*ized*, asymmetry between the two
 * operations' own return shapes, not a shortcut taken here: re-running
 * `compileSchema` a second time inside this response layer just to recover
 * structure it already had once would mean this "pure, DB-free response
 * shaping" file re-doing compilation work — silently coupling a response
 * builder to the compiler's own behavior, and paying that cost only for a
 * failure path whose text already names the fix (each message is still
 * `formatSchemaError`'s own "line N: ..." text — nothing about actionability
 * is lost, only the separately-addressable `code`/`line`/`namespace`/
 * `member` fields `schemaCompileError` gets to keep because it never left
 * the compiler's own output).
 */
export function schemaPublishError(errors: readonly string[]): ApiErrorResponse {
  return apiError(
    'schema_compile_failed',
    `schema publish rejected — ${errors.length} error${errors.length === 1 ? '' : 's'}, nothing published, see details`,
    { errors: [...errors] },
  );
}

/**
 * A write route called without a valid `ADMIN_API_KEY` (§9 Phase 8:
 * "`ADMIN_API_KEY`-gated writes"). The auth check itself — which header,
 * which comparison — is main-agent middleware, not this file's concern
 * (see `src/api/responses.ts`'s own top-of-file doc comment); this
 * constructor only owns the resulting response's shape once that middleware
 * has already decided the request fails. `detail` lets that middleware
 * supply the exact reason (missing header vs. wrong key) once it exists,
 * without this file hardcoding an assumption about which header scheme was
 * chosen — the default covers the common case either way.
 */
export function unauthorizedError(detail = 'missing or invalid admin API key'): ApiErrorResponse {
  return apiError('unauthorized', `unauthorized — ${detail}`);
}

/**
 * A request from a credential that authenticated successfully but whose
 * own namespace scope doesn't cover this request's target namespace(s) —
 * real, mintable, namespace-scoped DB-backed API keys
 * (`src/api/db-api-keys.ts`, `src/api/server.ts`'s
 * `findOutOfScopeNamespace`). See `API_ERROR_STATUS`'s own doc comment for
 * why this is 403, not a second flavor of `unauthorizedError`'s 401.
 * `detail` is required, not defaulted the way `unauthorizedError`'s is —
 * a bare "forbidden" names no fix; every real call site names the specific
 * out-of-scope namespace so a caller learns exactly what their credential
 * doesn't cover, matching this file's own "errors name the fix" discipline.
 */
export function forbiddenError(detail: string): ApiErrorResponse {
  return apiError('forbidden', `forbidden — ${detail}`);
}

/**
 * An HTTP request whose method and path match no route this API registers —
 * a genuine 404, never any of this file's other domain-shaped failures (see
 * `API_ERROR_STATUS`'s own doc comment for the distinction from
 * `tuple_validation_failed`'s `no_published_schema` case). Called from
 * `src/api/server.ts`'s Fastify `setNotFoundHandler` (main agent's own
 * wiring, not this file's concern — see this file's own top-of-file doc
 * comment, and the same division of labor already documented for
 * `rateLimitedError` immediately below), so an unmatched route still gets
 * this API's own consistent error envelope shape instead of Fastify's
 * default 404 body.
 */
export function notFoundError(detail = 'no route matches this method and path'): ApiErrorResponse {
  return apiError('not_found', `not found — ${detail}`);
}

/**
 * A caller exceeded a route's request budget — `@fastify/rate-limit`'s own
 * `errorResponseBuilder` hook calls this (see `src/api/server.ts`) so a
 * rate-limited response carries the exact same envelope shape as every
 * other error this API produces, rather than the plugin's own default body.
 * `retryAfterSeconds` is always present (never optional) — unlike
 * `unauthorizedError`'s free-text `detail`, a rate-limit response without a
 * concrete retry time isn't actionable: a caller needs a number to back off
 * by, not just a description of what went wrong.
 */
export function rateLimitedError(retryAfterSeconds: number): ApiErrorResponse {
  return apiError(
    'rate_limited',
    `rate limit exceeded — retry after ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}`,
  );
}

/**
 * Postgres unreachable (or any other infrastructure-level failure this API
 * surface treats the same way the CLI treats exit code 3 — §7). Status 503,
 * not 500 — see `API_ERROR_STATUS`'s own doc comment for the full reasoning;
 * in short, 503 says "this service's dependency is down, retry later" (and
 * is what most load-balancer/uptime tooling specifically watches for to
 * pull an instance from rotation), where a bare 500 conventionally means
 * "the server code itself misbehaved." `message` reuses the CLI's own exact
 * `"Postgres: <detail>"` phrasing (see every `src/cli/commands/*.ts` file's
 * identical `catch` block) so the same underlying failure reads identically
 * whether a human hit it through `authz check` or through this API.
 */
export function infrastructureUnavailableError(detail: string): ApiErrorResponse {
  return apiError('infrastructure_unavailable', `Postgres: ${detail}`);
}

/**
 * The one true catch-all — reserved for a genuinely unanticipated failure
 * (a bug), never for any outcome this API's own five operations already
 * have a named shape for. No function in `src/api/responses.ts` ever
 * constructs this; it exists only for `src/api/server.ts`'s own top-level
 * error handler to reach for when nothing else applies, exactly the role a
 * final, unlabeled `default:` branch plays in this codebase's own
 * exhaustiveness-guard convention elsewhere — the difference being an HTTP
 * response can't `throw` its way out of an unhandled case the way
 * `assertNever` does, so this is that same "this should be impossible, but
 * name it instead of crashing uninformatively" discipline expressed as a
 * response instead of a thrown error.
 */
export function internalError(
  detail = 'an unexpected error occurred handling this request',
): ApiErrorResponse {
  return apiError('internal_error', detail);
}
