/**
 * Pure, DB-free response shaping for the five operations §9 Phase 8 exposes
 * over HTTP: `check`, `expand`, `tuple write`/`delete`, `schema
 * compile`/`publish`, and `health`. Every function here takes an
 * already-computed domain result — the exact same result type its CLI
 * sibling in `src/cli/commands/*.ts` already prints — and returns
 * `{ status, body }` ready for a Fastify route handler to send verbatim
 * (`reply.code(result.status).send(result.body)`). Nothing in this file
 * touches `pg`, `fastify`, or `process.env`; no route registration, no
 * `ADMIN_API_KEY` check, no request-body parsing — all of that is
 * `src/api/server.ts`'s job (main agent), consuming this file the same way
 * `src/cli/commands/soundness.ts`'s `--format` flag consumes
 * `src/report/markdown.ts`/`json.ts` (§9 Phase 7 precedent).
 *
 * ---
 *
 * **Every success status is a literal, never computed from the body.**
 * `checkResponse` always returns `200`, whether `allowed` is `true` or
 * `false` — a denial is a normal, successful answer to "is this allowed,"
 * never an error (§6.1's fail-closed discipline: the *engine* fails closed
 * by returning `false`, not by this API refusing to answer). Every mutating
 * operation (`tupleWriteResponse`, `tupleDeleteResponse`,
 * `schemaPublishResponse`) also returns `200` on success, deliberately never
 * `201` — see this file's own note on `tupleWriteResponse` for why. Status
 * codes in this file answer exactly one question, "did the request
 * complete," and nothing else; *what happened* (`allowed`, `created`,
 * `deleted`, `published`) is always a body field, never encoded into the
 * status code itself, so a client polling the identical idempotent request
 * twice sees the identical status both times.
 *
 * **No route in this file ever returns 404.** See `checkResponse`'s own doc
 * comment for `check`/`expand` against an undeclared namespace — the two
 * operations that could plausibly raise the question — and
 * `src/api/errors.ts`'s `tupleValidationError` doc comment for the
 * `no_published_schema` case on a tuple write. All resolve to a normal
 * success response or a `400`, never a `404`, because none of this API's
 * five operations exposes a fetchable-by-URI resource whose absence 404
 * conventionally signals — every one of them is a question asked *about* a
 * name that may or may not be declared, and this system already has a
 * typed, evidence-carrying way to say "not declared" inside a normal
 * response (an `undeclared` disproof/tree node, or `allowed: false`),
 * per §6.1's fail-closed discipline. If a future phase adds a genuinely
 * resource-oriented endpoint (e.g. `GET /namespaces/:ns` returning 404 for
 * one that was never published), that's a different shape of question this
 * file doesn't yet answer — see `docs/DECISIONS.md` for that as a live
 * "revisit if" rather than a decision made preemptively here.
 *
 * **Deep evidence trees are reused, never redeclared.** `path` on a check
 * response is `ResolutionStep`, imported directly from
 * `src/resolve/production/resolver.ts`; `tree` on an expand response is
 * `ExpandNode`, imported directly from `src/audit/expand.ts`. Both pass
 * through to JSON exactly as the resolver/`expand()` produced them — same
 * choice `src/report/json.ts` already made for the soundness report
 * (`docs/DECISIONS.md` D-036/D-043's own reasoning: a real evidence tree
 * reshaped for display convenience stops being independently verifiable,
 * and "allowed, trust me" is exactly the claim this whole project refuses
 * to make). Shallow query-echo fields (`subject`, `object` on a check/expand
 * response) use one small `ApiEntityRef` declared in this file instead of
 * importing `EntityRef` from two different resolver modules under two
 * different aliases — TypeScript's structural typing makes the two
 * interchangeable at every call site regardless, and this file is a
 * downstream consumer of both, not a boundary `docs/DECISIONS.md` D-022's
 * "never share code between the isolated resolvers" rule was written to
 * protect (that rule is about the two *resolvers* never depending on each
 * other; nothing stops a reporting/API layer from depending on either).
 */
import type { PerformCheckResult } from '../audit/checks.js';
import type { ResolutionStep } from '../resolve/production/resolver.js';
import type { ExpandNode } from '../audit/expand.js';
import type { WriteTupleResult, DeleteTupleResult } from '../store/tuples.js';
import type { SchemaCompileResult } from '../schema/dsl/errors.js';
import type { CompiledSchema } from '../schema/dsl/types.js';
import type { PublishResult, PublishedNamespace } from '../schema/publish.js';
import {
  tupleValidationError,
  schemaCompileError,
  schemaPublishError,
  type ApiErrorResponse,
} from './errors.js';

/** `{ ns, id }` — the same shape every resolver/`expand()` module in this codebase already declares field-for-field independently for the same concept. Used here only for shallow query-echo fields; see this file's own top-of-file doc comment for why deep evidence trees import the real type instead. */
export interface ApiEntityRef {
  ns: string;
  id: string;
}

// ---------------------------------------------------------------------------
// 1. check
// ---------------------------------------------------------------------------

export interface CheckResponseBody {
  allowed: boolean;
  subject: ApiEntityRef;
  relation: string;
  object: ApiEntityRef;
  /** The actual maximum recursion depth this check reached — `ProductionCheckResult.depth`, passed through unchanged. */
  depth: number;
  /** Present only when the caller pinned the check to a consistency token (§6.3). */
  atToken?: number;
  /**
   * Present if and only if `allowed` is `true` — mirrors
   * `ProductionCheckResult`'s own "present iff allowed" contract exactly,
   * never a placeholder empty object when denied. This IS the resolution
   * path (§6.7, §8's signature element) — the real tuple/rewrite chain the
   * engine walked, not a description of one.
   */
  path?: ResolutionStep;
}

export interface CheckApiResponse {
  status: 200;
  body: CheckResponseBody;
}

/**
 * `check` never fails at the operation level — a `PerformCheckResult` is
 * always a complete, valid answer (`allowed: true` with a path, or
 * `allowed: false` with none), including for a subject/object whose
 * namespace has no published schema at all: `productionCheck` already fails
 * closed for that case (`{ allowed: false, depth: 0 }`, no throw — see
 * `src/resolve/production/resolver.ts`'s own top-of-file doc comment), and
 * this function has no more information than that result carries. A `404`
 * would claim "this endpoint doesn't know what you're asking about," but
 * the engine *does* know — it looked, found no published schema, and
 * answered the only thing it can honestly answer about an undeclared name:
 * no path proves this is allowed. Surfacing that as anything other than a
 * normal `200 { allowed: false }` would be the API layer overriding a
 * fail-closed answer the engine already gave correctly, for no benefit to a
 * caller who gets the identical actionable information either way
 * ("denied" — not "some other status you now have to special-case").
 *
 * A genuinely unreachable database is a different condition entirely — it
 * makes `performCheck` *throw*, before this function is ever called; that
 * path is `infrastructureUnavailableError` (`src/api/errors.ts`), wired up
 * by the route handler's own `catch`, never something this function decides.
 */
export function checkResponse(
  subject: ApiEntityRef,
  relation: string,
  object: ApiEntityRef,
  result: PerformCheckResult,
  atToken?: number,
): CheckApiResponse {
  return {
    status: 200,
    body: {
      allowed: result.allowed,
      subject,
      relation,
      object,
      depth: result.depth,
      ...(atToken !== undefined ? { atToken } : {}),
      ...(result.allowed ? { path: result.path } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 2. expand
// ---------------------------------------------------------------------------

export interface ExpandResponseBody {
  object: ApiEntityRef;
  relation: string;
  /**
   * The exact subject tree `expand()` produced — `ExpandNode`, passed
   * through verbatim, recursive union/intersection/exclusion/
   * tupleToUserset/relation/cycleGuard/depthLimitReached/undeclared nodes
   * and all. See this file's own top-of-file doc comment: this is a
   * deliberate pass-through, not a reshape, for the same reason
   * `src/report/json.ts` never flattens a resolution path.
   */
  tree: ExpandNode;
}

export interface ExpandApiResponse {
  status: 200;
  body: ExpandResponseBody;
}

/**
 * Same reasoning as `checkResponse` for why this is never a `404`, applied
 * to `expand`'s own shape of the same question: `expand()` never throws for
 * an undeclared namespace or relation/permission name — it returns a tree
 * whose root (or some sub-node) is `{ kind: 'undeclared', object, name }`
 * (see `src/audit/expand.ts`'s own top-of-file doc comment, "mirrors both
 * check resolvers' own fail-closed discipline"). That node IS the answer,
 * exactly as typed and exported as every other `ExpandNode` variant — this
 * function has nothing to add by intercepting it and substituting an HTTP
 * status for what the domain type already says clearly.
 */
export function expandResponse(
  object: ApiEntityRef,
  relation: string,
  tree: ExpandNode,
): ExpandApiResponse {
  return { status: 200, body: { object, relation, tree } };
}

// ---------------------------------------------------------------------------
// 3. tuple write / delete
// ---------------------------------------------------------------------------

export interface TupleWriteResponseBody {
  token: number;
  /** `false` when the tuple already existed — still a successful write (see `src/store/tuples.ts`'s own idempotency doc comment), never an error. */
  created: boolean;
}

export type TupleWriteApiResponse =
  { status: 200; body: TupleWriteResponseBody } | ApiErrorResponse;

/**
 * `writeTuple`'s `{ ok: true, ... }` branch renders as `200`, not `201`,
 * even when `created` is `true`. This API has no `GET` for an individual
 * tuple by its own URI (`listTuplesByObject`/`listTuplesBySubject` are
 * list/filter operations, not single-resource fetches, and aren't one of
 * the five operations §9 Phase 8 names to begin with) — `201`'s own
 * convention (paired with a `Location` header pointing at the newly created
 * resource) has nothing to point at here. Using `200` uniformly, with
 * `created`/`token` as body fields, keeps the status code answering only
 * "did the write succeed" and keeps the *idempotency* signal
 * (already-existed vs. newly-created) where it belongs: in the body, next
 * to the token a caller actually needs to pin a later read to (§6.3) —
 * never inferred from a status code that would otherwise flip between `200`
 * and `201` for byte-identical repeated requests, which is exactly the kind
 * of surprising, code-carries-meaning-on-its-own behavior this file's
 * top-of-file doc comment rules out.
 */
export function tupleWriteResponse(result: WriteTupleResult): TupleWriteApiResponse {
  if (!result.ok) return tupleValidationError('write', result.errors);
  return { status: 200, body: { token: result.token, created: result.created } };
}

export interface TupleDeleteResponseBody {
  token: number;
  /** `false` when there was no such tuple to delete — still a successful, idempotent no-op, never an error. */
  deleted: boolean;
}

export type TupleDeleteApiResponse =
  { status: 200; body: TupleDeleteResponseBody } | ApiErrorResponse;

/** Mirrors `tupleWriteResponse` exactly — see its own doc comment. */
export function tupleDeleteResponse(result: DeleteTupleResult): TupleDeleteApiResponse {
  if (!result.ok) return tupleValidationError('delete', result.errors);
  return { status: 200, body: { token: result.token, deleted: result.deleted } };
}

// ---------------------------------------------------------------------------
// 4. schema compile / publish
// ---------------------------------------------------------------------------

export interface SchemaCompileResponseBody {
  schema: CompiledSchema;
}

export type SchemaCompileApiResponse =
  { status: 200; body: SchemaCompileResponseBody } | ApiErrorResponse;

/**
 * `compileSchema`'s own result, unchanged — a pure dry run with zero I/O
 * (per §9 Phase 8's own description: "no I/O"), so `200` on success (never
 * `201` — nothing is stored) and `schemaCompileError` (400, full structured
 * `SchemaError[]`) on failure.
 */
export function schemaCompileResponse(result: SchemaCompileResult): SchemaCompileApiResponse {
  if (!result.ok) return schemaCompileError(result.errors);
  return { status: 200, body: { schema: result.schema } };
}

export interface SchemaPublishResponseBody {
  published: PublishedNamespace[];
}

export type SchemaPublishApiResponse =
  { status: 200; body: SchemaPublishResponseBody } | ApiErrorResponse;

/**
 * `200`, not `201`, on success — same reasoning as `tupleWriteResponse`:
 * one `publish` call can create several `PublishedNamespace` rows at once
 * (one per namespace block in the source), so there is no single created
 * resource for a `201` + `Location` pair to name, and this API has no `GET`
 * for one namespace version by its own URI among the five named operations.
 * `published` (every namespace/version this call actually created) is the
 * complete, sufficient answer in the body.
 */
export function schemaPublishResponse(result: PublishResult): SchemaPublishApiResponse {
  if (!result.ok) return schemaPublishError(result.errors);
  return { status: 200, body: { published: result.published } };
}

// ---------------------------------------------------------------------------
// 5. health
// ---------------------------------------------------------------------------

export type HealthDatabaseStatus = { reachable: true } | { reachable: false; error: string };

export interface HealthResponseBody {
  status: 'ok' | 'unavailable';
  database: HealthDatabaseStatus;
  /**
   * Every currently-published namespace's latest version — §9 Phase 8's own
   * exact wording ("reporting DB connectivity and the current namespace
   * config versions"). Always `[]` when `database.reachable` is `false`:
   * this list can only be trustworthy if it was actually just fetched from
   * a reachable database, never a stale value from a previous successful
   * call held onto across a later failure.
   */
  namespaces: PublishedNamespace[];
}

export type HealthApiResponse =
  { status: 200; body: HealthResponseBody } | { status: 503; body: HealthResponseBody };

/**
 * The one response in this file most likely to be read directly by a human
 * (report-designer brief: "keep the same 'someone skimming decides what
 * they need to know from this alone' discipline already applied to
 * `renderHeadline`"). Three things, in the order they matter: is the
 * service's one real dependency reachable, what does that make the overall
 * `status`, and — only when reachable — what schema state is actually live
 * right now. `database.reachable: false` always forces `status: 'unavailable'`
 * and an empty `namespaces` list regardless of what the caller passes for
 * it — see `namespaces`'s own doc comment — so this function is the single
 * place that invariant holds, not something every future caller has to
 * remember to enforce itself.
 *
 * **503, not 500, when unreachable** — same reasoning as
 * `infrastructureUnavailableError` in `src/api/errors.ts`: "Postgres is
 * down" is a distinct, well-understood condition from "this route's own
 * code has a bug," and 503 is what most uptime/load-balancer tooling
 * specifically polls a health endpoint to detect. A monitoring setup that
 * alerts on any non-2xx from `/health` gets the right signal either way;
 * one that specifically distinguishes 503 from 500 gets the *more useful*
 * signal — "the dependency is down," not "the health check itself broke."
 */
export function healthResponse(
  database: HealthDatabaseStatus,
  namespaces: readonly PublishedNamespace[],
): HealthApiResponse {
  if (!database.reachable) {
    return {
      status: 503,
      body: { status: 'unavailable', database, namespaces: [] },
    };
  }
  return {
    status: 200,
    body: { status: 'ok', database, namespaces: [...namespaces] },
  };
}
