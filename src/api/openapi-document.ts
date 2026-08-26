/**
 * `buildOpenApiDocument()` — a hand-written, hand-maintained OpenAPI 3.0.3
 * document describing every real HTTP route `src/api/server.ts` registers
 * today: `POST /check`, `POST /check/batch`, `POST /expand`,
 * `POST /list-objects`, `POST /list-users`, `POST /tuples`, `DELETE /tuples`,
 * `POST /schema/compile`, `POST /schema/publish`, `GET /health`, and this
 * module's own consumer, `GET /openapi.json`. `POST /check/batch` was added
 * to this file after its own initial build — see `checkBatchOperation()`'s
 * own doc comment below for why it reuses `checkOperation()`'s schemas
 * rather than re-transcribing them, and this file's "disclosed, not
 * automatic" note above for why a human had to notice and add it by hand.
 *
 * **No new dependency.** No `zod-to-openapi`, no `@fastify/swagger`, no
 * schema-introspection of any kind — every JSON Schema object below was
 * transcribed by hand from the real Zod body schema (or real response
 * shape) it describes, the same way a human reads `server.ts`/
 * `responses.ts`/`errors.ts` and writes down what they say. That means this
 * document can drift from the code it describes if a route changes and
 * this file isn't updated to match — a real, accepted cost, not an
 * oversight. See "Disclosed, not automatic" below for why that tradeoff is
 * deliberate here, matching a convention this codebase already has.
 *
 * **Exactly one function builds this document — never two independently
 * hand-written copies.** Both `scripts/generate-openapi.ts` (writes
 * `docs/openapi.json` to disk) and `GET /openapi.json` in `src/api/
 * server.ts` (serves it live) call `buildOpenApiDocument()` from this one
 * module. A second, separately-maintained copy of this document — one for
 * the file, one for the route — would be exactly the kind of silent-drift
 * risk this module's own single-source-of-truth design exists to prevent.
 *
 * **Why this module lives in `src/api/`, not `scripts/` (deviating from
 * this generator's own build-spec-adjacent naming suggestion of
 * `scripts/openapi-document.ts`).** `tsconfig.build.json` (`npm run build`)
 * sets `rootDir: "src"` and `include: ["src/**\/*.ts"]` specifically so
 * `dist/`'s output layout matches `package.json`'s own `bin` entry (see
 * that file's own top-of-file comment for the exact breakage this
 * prevents) — every file `tsc` compiles under that config must resolve
 * under `src/`. `src/api/server.ts` importing a module from `scripts/`
 * (outside `rootDir`) would break that build the same way importing from
 * `test/` would. Living here, alongside `responses.ts`/`errors.ts` (the two
 * other files this module reads to build its schemas), keeps the real
 * import graph — `server.ts` importing a same-directory sibling — exactly
 * as unremarkable as every other `src/api/*.ts` import in this file, while
 * `scripts/generate-openapi.ts` reaches in the same direction
 * `scripts/seed-example.ts` already does for `src/schema/publish.js`/
 * `src/store/tuples.js`: a plain relative import from `scripts/` into
 * `src/`, run directly via `tsx`, no build step required.
 *
 * **Disclosed, not automatic — the same convention `src/store/dst/
 * shapes.ts`'s `registeredShapeCount()` already established for its own
 * manifest.** That function doesn't derive its count from anything else
 * that could itself drift — it's a number a human updates by hand
 * alongside the `SHAPES` map, with `test/unit/store/dst/
 * recognizer-coverage.dst.test.ts`'s own manifest catching the case where
 * the two fall out of sync. This file makes the identical bet: nothing
 * here introspects `checkBodySchema`/`tupleBodySchema`/etc. at runtime to
 * *derive* a JSON Schema (that's exactly the `zod-to-openapi`-shaped
 * dependency this generator was built to avoid) — every schema below is a
 * plain object literal a human wrote by reading the real Zod schema, and
 * stays correct only for as long as a human keeps it matching. **If you add
 * or change a route in `src/api/server.ts`, you must add or update its
 * operation builder and its entry in `buildOpenApiDocument()`'s own `paths`
 * object below by hand — nothing enforces that automatically.**
 * `test/unit/api/openapi.test.ts` is the
 * closest thing to a coverage gate this has (it fails if a route this file
 * knows about stops existing on the live server, or if the live server's
 * `GET /openapi.json` ever disagrees with this function), but it cannot
 * catch a *new* route this file was never told about — that gap is
 * accepted and disclosed here, not hidden.
 */

// ---------------------------------------------------------------------------
// Minimal local types for an OpenAPI 3.0.3 document. Not a full JSON Schema/
// OpenAPI type-checker — this project doesn't want the dependency a real one
// would pull in (see this file's own top-of-file "No new dependency" note),
// and the actual per-field correctness of every JSON Schema object below is
// a hand-maintained, disclosed responsibility (also see above), not
// something a type would enforce anyway. `JsonSchema` is deliberately a
// loose `Record<string, unknown>` for exactly that reason: it lets every
// schema object below be written the way a human would write JSON Schema —
// `type`/`properties`/`required`/`$ref`/etc. — without this file also having
// to model JSON Schema's own grammar.
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

export interface OpenApiSecurityScheme {
  type: 'http';
  scheme: 'bearer';
  description: string;
}

export interface OpenApiResponseObject {
  description: string;
  content?: { 'application/json': { schema: JsonSchema } };
}

export interface OpenApiOperation {
  summary: string;
  /** Always includes this operation's real rate-limit budget as plain text — see build step 2's own instruction and every per-route builder below. */
  description: string;
  /** `[{ bearerAuth: [] }]` for a gated route, `[]` for an unauthenticated one — never omitted, so a reader never has to consult the document's (absent) root-level `security` to know which applies. */
  security: Array<Record<string, string[]>>;
  requestBody?: {
    required: true;
    content: { 'application/json': { schema: JsonSchema } };
  };
  responses: Record<string, OpenApiResponseObject>;
}

export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  delete?: OpenApiOperation;
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: { bearerAuth: OpenApiSecurityScheme };
    schemas: Record<string, JsonSchema>;
  };
}

// ---------------------------------------------------------------------------
// Reusable JSON Schema fragments, transcribed by hand from the real Zod
// schemas in `src/api/server.ts`.
// ---------------------------------------------------------------------------

/**
 * `identifierField()` (`src/api/server.ts`): `z.string().min(1).max(63)
 * .regex(/^[a-z][a-z0-9_]*$/)` — used for every `ns`/`id`/`relation`/
 * `objectNs` field on `/check`, `/expand`, `/list-objects`, `/list-users`
 * (never for `/tuples`' fields — see `tupleFieldSchema` below for why those
 * are a plain, unconstrained string instead). `63` and the pattern are
 * transcribed from `MAX_IDENTIFIER_LENGTH`/`IDENTIFIER_PATTERN`
 * (`src/schema/dsl/types.ts`) by hand, not imported — this file's whole
 * point is to be a plain, dependency-free JSON value, and a JSON Schema
 * `pattern` has to be a plain string regex source either way, so importing
 * the `RegExp` itself would buy nothing beyond one more place this document
 * could subtly diverge from what it renders (e.g. if the source is ever
 * written with flags a JSON Schema `pattern` can't represent).
 */
const identifierSchema: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z][a-z0-9_]*$',
};

/**
 * `entityRefSchema` (`src/api/server.ts`): `z.object({ ns: identifierField(),
 * id: identifierField() }).strict()` — every `subject`/`object` field on
 * `/check`, `/expand`, `/list-objects`, `/list-users`. `.strict()` is why
 * `additionalProperties` is `false`, not omitted — see `server.ts`'s own
 * doc comment on `.strict()` for why an unrecognized key must be a rejection,
 * never a silently-dropped field.
 */
const entityRefSchema: JsonSchema = {
  type: 'object',
  properties: { ns: identifierSchema, id: identifierSchema },
  required: ['ns', 'id'],
  additionalProperties: false,
};

/**
 * The five plain `z.string().min(1)` fields on `tupleBodySchema`
 * (`src/api/server.ts`) — deliberately *not* `identifierSchema` above.
 * `tupleBodySchema` never routes through the identifier grammar
 * `checkBodySchema`/etc. enforce, because `writeTuple`/`deleteTuple`
 * (`src/store/tuples.ts`) already run their own `validateIdentifiers` pass
 * against the same grammar downstream — see `server.ts`'s own top-of-file
 * doc comment ("`identifierField()` ... applied here too") for the
 * historical fix that added the grammar to the *check/expand* side
 * specifically, contrasted with the tuple routes, which already had it one
 * layer down. Reproducing that asymmetry exactly, rather than "tidying" it
 * into one shared schema, is the entire point of a hand-transcribed
 * document: it describes what the real Zod schema validates, not what
 * would look more consistent.
 */
const tupleFieldSchema: JsonSchema = { type: 'string', minLength: 1 };

/**
 * `ApiEntityRef` (`src/api/responses.ts`) — `{ ns: string; id: string }`,
 * used for every response's query-echo/result entity fields. Unlike
 * `entityRefSchema` above (a *request*-body constraint transcribed from
 * `identifierField()`'s own grammar), a response's `ns`/`id` are values this
 * API is echoing back or has already resolved — there is no additional
 * grammar constraint to state on the way out, so this is a plain
 * `{ ns: string, id: string }` object, no `pattern`/`maxLength`.
 */
const apiEntityRefSchema: JsonSchema = {
  type: 'object',
  properties: { ns: { type: 'string' }, id: { type: 'string' } },
  required: ['ns', 'id'],
};

/**
 * `ResolutionStep` (`src/resolve/production/resolver.ts`) and `ExpandNode`
 * (`src/audit/expand.ts`) — the real resolution-path/subject-tree evidence
 * `checkResponse`/`expandResponse` pass through verbatim (see
 * `responses.ts`'s own top-of-file doc comment: "a real evidence tree
 * reshaped for display convenience stops being independently verifiable").
 * Both are deeply recursive, multi-variant discriminated unions (union/
 * intersection/exclusion/tupleToUserset/relation/cycleGuard/
 * depthLimitReached/undeclared node kinds, each with its own shape) — a
 * faithful JSON Schema for either would itself be a multi-hundred-line
 * `oneOf` this generator's own hand-maintained, no-introspection design
 * doesn't attempt to keep in lockstep with two independently-evolving
 * union types in two different modules. Documented here as an opaque,
 * structured object instead, with a pointer to the real source of truth —
 * an honest disclosure of this generator's own scope limit, not a silent
 * gap.
 */
const evidenceTreeSchema: JsonSchema = {
  type: 'object',
  description:
    'A real, recursive evidence node — ResolutionStep (src/resolve/production/resolver.ts) for a check `path`, ExpandNode (src/audit/expand.ts) for an expand `tree`. Structure intentionally not modeled field-by-field here; read the cited source type for the authoritative shape.',
};

/**
 * `CompiledSchema` (`src/schema/dsl/types.ts`) — `{ namespaces:
 * Record<string, NamespaceConfig> }`, itself a compiled representation of
 * every relation/permission/rewrite-rule in the source DSL. Same "opaque,
 * disclosed" treatment as `evidenceTreeSchema` above, for the same reason:
 * `NamespaceConfig`'s own rewrite-rule union is a separate, independently-
 * evolving type this hand-maintained document doesn't attempt to mirror
 * field-by-field.
 */
const compiledSchemaSchema: JsonSchema = {
  type: 'object',
  description:
    'CompiledSchema (src/schema/dsl/types.ts) — { namespaces: Record<string, NamespaceConfig> }. Structure intentionally not modeled field-by-field here; read the cited source type for the authoritative shape.',
};

/**
 * `PublishedNamespace` (`src/schema/publish.ts`) — `{ namespace: string;
 * version: number }`. Flat and small enough to transcribe exactly, unlike
 * the two opaque types above.
 */
const publishedNamespaceSchema: JsonSchema = {
  type: 'object',
  properties: { namespace: { type: 'string' }, version: { type: 'number' } },
  required: ['namespace', 'version'],
};

/**
 * `ApiErrorBody` (`src/api/errors.ts`) — the one error envelope every route
 * in this API returns for a non-2xx outcome. `code` is the exact
 * `ApiErrorCode` union that file exports; `details` is deliberately
 * untyped (`schema: {}`, i.e. "any JSON value") because its real shape
 * varies by which constructor produced it (`TupleError[]` for
 * `tuple_validation_failed`, `ApiSchemaError[]` for `schema_compile_failed`
 * from `/schema/compile`, a plain `string[]` for the same code from
 * `/schema/publish` — see `errors.ts`'s own `schemaPublishError` doc
 * comment for why that asymmetry is real, not an oversight) — reused as-is
 * here rather than picking one shape and misdescribing the others.
 */
const apiErrorSchema: JsonSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          enum: [
            'invalid_request',
            'tuple_validation_failed',
            'schema_compile_failed',
            'unauthorized',
            'not_found',
            'rate_limited',
            'infrastructure_unavailable',
            'internal_error',
          ],
        },
        message: { type: 'string' },
        details: {},
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

// ---------------------------------------------------------------------------
// Shared response objects, referencing the schemas above.
// ---------------------------------------------------------------------------

function jsonResponse(description: string, schema: JsonSchema): OpenApiResponseObject {
  return { description, content: { 'application/json': { schema } } };
}

const errorResponseRef: JsonSchema = { $ref: '#/components/schemas/ApiError' };

const RESPONSE_400 = jsonResponse(
  '400 — invalid_request, tuple_validation_failed, or schema_compile_failed (see ApiErrorCode). Body always the shared ApiError envelope.',
  errorResponseRef,
);
const RESPONSE_401 = jsonResponse(
  '401 — unauthorized (missing/invalid bearer token, or no credential configured for this deployment).',
  errorResponseRef,
);
const RESPONSE_429 = jsonResponse(
  '429 — rate_limited. Body includes a human-readable retry-after in `error.message`.',
  errorResponseRef,
);
const RESPONSE_503 = jsonResponse(
  '503 — infrastructure_unavailable (Postgres unreachable).',
  errorResponseRef,
);

const BEARER_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const NO_SECURITY: Array<Record<string, string[]>> = [];

// ---------------------------------------------------------------------------
// Per-route operation builders. One function per route in `src/api/
// server.ts`, in the exact order they're registered there.
// ---------------------------------------------------------------------------

// Hoisted out of checkOperation() below so checkBatchOperation() can reuse
// them verbatim as its own per-item request/response shape, rather than
// re-transcribing the same fields a second time — checkBatchBodySchema
// (src/api/server.ts) reuses checkBodySchema directly as its per-item
// schema, and checkBatchResponse (src/api/responses.ts) builds each result
// via the identical checkResponse call /check itself uses, so this
// document's two schema objects mirror that same one-definition discipline.
const checkRequestSchema: JsonSchema = {
  type: 'object',
  properties: {
    subject: entityRefSchema,
    relation: identifierSchema,
    object: entityRefSchema,
    atToken: {
      type: 'string',
      description:
        "An opaque, encoded consistency token from a prior write/delete response's own `token` field (src/store/tokens.ts). Optional — omit to check against the latest committed state.",
    },
  },
  required: ['subject', 'relation', 'object'],
  additionalProperties: false,
};
const checkResponseSchema: JsonSchema = {
  type: 'object',
  properties: {
    allowed: { type: 'boolean' },
    subject: apiEntityRefSchema,
    relation: { type: 'string' },
    object: apiEntityRefSchema,
    depth: { type: 'number' },
    atToken: { type: 'string', description: 'Present only when the request supplied atToken.' },
    path: {
      ...evidenceTreeSchema,
      description: `${evidenceTreeSchema.description as string} Present if and only if \`allowed\` is true.`,
    },
  },
  required: ['allowed', 'subject', 'relation', 'object', 'depth'],
};

function checkOperation(): OpenApiOperation {
  return {
    summary: 'Is subject related to object via relation?',
    description:
      'Gated by requireReadAuth (ADMIN_API_KEY or READONLY_API_KEY). Rate limit: 200 requests/minute per client (gatedReadRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked.',
    security: BEARER_SECURITY,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: checkRequestSchema } },
    },
    responses: {
      '200': jsonResponse(
        'The check result — always a complete answer, never a 404.',
        checkResponseSchema,
      ),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

// Added after this generator's own initial build — `POST /check/batch`
// didn't exist yet in the worktree that wrote the rest of this file (see
// this module's own top-of-file "disclosed, not automatic" doc comment for
// why a new route needs a human to notice and add it here by hand). The
// per-item request/response shape is `checkOperation()`'s own
// `requestSchema`/`responseSchema` verbatim — `checkBatchBodySchema`
// (src/api/server.ts) reuses `checkBodySchema` directly as its per-item
// schema, and `checkBatchResponse` (src/api/responses.ts) builds each
// result via the identical `checkResponse` call `/check` itself uses — so
// this operation reuses those two schema objects rather than re-transcribing
// the same fields a third time.
function checkBatchOperation(): OpenApiOperation {
  const requestSchema: JsonSchema = {
    type: 'object',
    properties: {
      checks: {
        type: 'array',
        items: checkRequestSchema,
        minItems: 1,
        maxItems: 50,
        description:
          'Each item is exactly one /check request body. Rejected outright (400), never silently truncated, past 50 items.',
      },
    },
    required: ['checks'],
    additionalProperties: false,
  };
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: checkResponseSchema,
        description:
          'One entry per input item, same order as the request — never reordered by however the underlying checks actually resolve.',
      },
    },
    required: ['results'],
  };
  return {
    summary: 'Up to 50 independent checks in one call, order-preserving.',
    description:
      'Gated by requireReadAuth (ADMIN_API_KEY or READONLY_API_KEY). Rate limit: 20 requests/minute per client — lower than /check itself because each item is a full, independent graph walk, not a cheap lookup.',
    security: BEARER_SECURITY,
    requestBody: { required: true, content: { 'application/json': { schema: requestSchema } } },
    responses: {
      '200': jsonResponse('One result per input item, same order as the request.', responseSchema),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

function expandOperation(): OpenApiOperation {
  const requestSchema: JsonSchema = {
    type: 'object',
    properties: { object: entityRefSchema, relation: identifierSchema },
    required: ['object', 'relation'],
    additionalProperties: false,
  };
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: {
      object: apiEntityRefSchema,
      relation: { type: 'string' },
      tree: evidenceTreeSchema,
    },
    required: ['object', 'relation', 'tree'],
  };
  return {
    summary: 'The resolved subject tree for object#relation.',
    description:
      'Gated by requireReadAuth (ADMIN_API_KEY or READONLY_API_KEY). Rate limit: 200 requests/minute per client (gatedReadRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked.',
    security: BEARER_SECURITY,
    requestBody: { required: true, content: { 'application/json': { schema: requestSchema } } },
    responses: {
      '200': jsonResponse(
        'The full resolved subject tree — always a complete answer, never a 404.',
        responseSchema,
      ),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

function listObjectsOperation(): OpenApiOperation {
  const requestSchema: JsonSchema = {
    type: 'object',
    properties: {
      subject: entityRefSchema,
      relation: identifierSchema,
      objectNs: identifierSchema,
      atToken: {
        type: 'string',
        description:
          "An opaque, encoded consistency token from a prior write/delete response's own `token` field (src/store/tokens.ts). Optional.",
      },
    },
    required: ['subject', 'relation', 'objectNs'],
    additionalProperties: false,
  };
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: {
      subject: apiEntityRefSchema,
      relation: { type: 'string' },
      objectNs: { type: 'string' },
      objects: { type: 'array', items: apiEntityRefSchema },
      truncated: {
        type: 'boolean',
        description:
          'true means this is a possibly-incomplete answer, not "the real answer happens to be small."',
      },
      atToken: { type: 'string', description: 'Present only when the request supplied atToken.' },
    },
    required: ['subject', 'relation', 'objectNs', 'objects', 'truncated'],
  };
  return {
    summary:
      'Every object of a given namespace that subject has relation on (bulk reverse lookup).',
    description:
      'Gated by requireReadAuth (ADMIN_API_KEY or READONLY_API_KEY). Rate limit: 200 requests/minute per client (gatedReadRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked. Not logged to the checks audit table (see src/audit/list.ts).',
    security: BEARER_SECURITY,
    requestBody: { required: true, content: { 'application/json': { schema: requestSchema } } },
    responses: {
      '200': jsonResponse('Every object confirmed via a real, live check.', responseSchema),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

function listUsersOperation(): OpenApiOperation {
  const requestSchema: JsonSchema = {
    type: 'object',
    properties: { object: entityRefSchema, relation: identifierSchema },
    required: ['object', 'relation'],
    additionalProperties: false,
  };
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: {
      object: apiEntityRefSchema,
      relation: { type: 'string' },
      subjects: { type: 'array', items: apiEntityRefSchema },
    },
    required: ['object', 'relation', 'subjects'],
  };
  return {
    summary:
      'Every concrete subject with relation on object (bulk reverse lookup). No atToken support.',
    description:
      'Gated by requireReadAuth (ADMIN_API_KEY or READONLY_API_KEY). Rate limit: 200 requests/minute per client (gatedReadRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked. Not logged to the checks audit table (see src/audit/list.ts).',
    security: BEARER_SECURITY,
    requestBody: { required: true, content: { 'application/json': { schema: requestSchema } } },
    responses: {
      '200': jsonResponse('Every concrete subject resolved down to.', responseSchema),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

/** Shared by POST/DELETE /tuples — identical `tupleBodySchema` request shape either way. */
function tupleRequestSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      objectNs: tupleFieldSchema,
      objectId: tupleFieldSchema,
      relation: tupleFieldSchema,
      subjectNs: tupleFieldSchema,
      subjectId: tupleFieldSchema,
      subjectRelation: {
        ...tupleFieldSchema,
        description: 'Present only for a userset-subject tuple (e.g. group:eng#member). Optional.',
      },
    },
    required: ['objectNs', 'objectId', 'relation', 'subjectNs', 'subjectId'],
    additionalProperties: false,
  };
}

function tupleWriteOperation(): OpenApiOperation {
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Opaque, encoded consistency token — pass verbatim as a later atToken.',
      },
      created: {
        type: 'boolean',
        description: 'false when the tuple already existed — still a successful write.',
      },
    },
    required: ['token', 'created'],
  };
  return {
    summary: 'Write a relation tuple.',
    description:
      'Gated by requireAdminAuth (ADMIN_API_KEY only). Rate limit: 20 requests/minute per client (writeRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked.',
    security: BEARER_SECURITY,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tupleRequestSchema() } },
    },
    responses: {
      '200': jsonResponse(
        'The tuple write succeeded (idempotently, if it already existed).',
        responseSchema,
      ),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

function tupleDeleteOperation(): OpenApiOperation {
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Opaque, encoded consistency token — pass verbatim as a later atToken.',
      },
      deleted: {
        type: 'boolean',
        description: 'false when there was no such tuple — still a successful, idempotent no-op.',
      },
    },
    required: ['token', 'deleted'],
  };
  return {
    summary: 'Delete a relation tuple.',
    description:
      'Gated by requireAdminAuth (ADMIN_API_KEY only). Rate limit: 20 requests/minute per client (writeRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked.',
    security: BEARER_SECURITY,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tupleRequestSchema() } },
    },
    responses: {
      '200': jsonResponse(
        'The tuple delete succeeded (idempotently, if there was nothing to delete).',
        responseSchema,
      ),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

function schemaCompileOperation(): OpenApiOperation {
  const requestSchema: JsonSchema = {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        minLength: 1,
        maxLength: 65_536,
        description:
          'One or more `namespace { ... }` DSL blocks. 64 KiB ceiling, tighter than the server-wide 256 KiB body limit.',
      },
    },
    required: ['source'],
    additionalProperties: false,
  };
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: { schema: compiledSchemaSchema },
    required: ['schema'],
  };
  return {
    summary:
      'Parse + compile a namespace DSL source string. Pure dry run — no I/O, nothing stored.',
    description:
      'Unauthenticated — see docs/DECISIONS.md. Rate limit: 100 requests/minute per client, the server-wide default budget (no per-route override), on top of the 1000 requests/minute per-IP authFloodGuard that does NOT apply here since this route has no auth gate to guard.',
    security: NO_SECURITY,
    requestBody: { required: true, content: { 'application/json': { schema: requestSchema } } },
    responses: {
      '200': jsonResponse('Compiled successfully.', responseSchema),
      '400': RESPONSE_400,
      '429': RESPONSE_429,
    },
  };
}

function schemaPublishOperation(): OpenApiOperation {
  const responseSchema: JsonSchema = {
    type: 'object',
    properties: { published: { type: 'array', items: publishedNamespaceSchema } },
    required: ['published'],
  };
  return {
    summary:
      'Compile and publish a new namespace_configs version for every namespace block in source.',
    description:
      'Gated by requireAdminAuth (ADMIN_API_KEY only). Rate limit: 20 requests/minute per client (writeRateLimit), on top of the 1000 requests/minute per-IP authFloodGuard applied before auth is even checked.',
    security: BEARER_SECURITY,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              source: {
                type: 'string',
                minLength: 1,
                maxLength: 65_536,
                description:
                  'One or more `namespace { ... }` DSL blocks. 64 KiB ceiling, tighter than the server-wide 256 KiB body limit.',
              },
            },
            required: ['source'],
            additionalProperties: false,
          },
        },
      },
    },
    responses: {
      '200': jsonResponse(
        'Published successfully — one entry per namespace block in source.',
        responseSchema,
      ),
      '400': RESPONSE_400,
      '401': RESPONSE_401,
      '429': RESPONSE_429,
      '503': RESPONSE_503,
    },
  };
}

function healthOperation(): OpenApiOperation {
  const bodySchema: JsonSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'unavailable'] },
      database: {
        oneOf: [
          { type: 'object', properties: { reachable: { const: true } }, required: ['reachable'] },
          {
            type: 'object',
            properties: { reachable: { const: false }, error: { type: 'string' } },
            required: ['reachable', 'error'],
          },
        ],
      },
      namespaces: {
        oneOf: [
          {
            type: 'object',
            properties: {
              ok: { const: true },
              namespaces: { type: 'array', items: publishedNamespaceSchema },
            },
            required: ['ok', 'namespaces'],
          },
          {
            type: 'object',
            properties: { ok: { const: false }, error: { type: 'string' } },
            required: ['ok', 'error'],
          },
        ],
      },
    },
    required: ['status', 'database', 'namespaces'],
  };
  return {
    summary: 'Database connectivity and every currently-published namespace version.',
    description:
      'Unauthenticated — load-balancer/uptime-monitor convention, no permission decision or secret in the response (docs/DECISIONS.md). Rate limit: 300 requests/minute per client, a higher-than-default per-route override for legitimate load-balancer polling headroom.',
    security: NO_SECURITY,
    responses: {
      '200': jsonResponse(
        'database.reachable and the namespace-listing query both succeeded.',
        bodySchema,
      ),
      '429': RESPONSE_429,
      '503': jsonResponse(
        'Either database.reachable is false, or the namespace-listing query itself failed — the two are independently diagnosed (see src/api/responses.ts healthResponse). Same body shape as 200.',
        bodySchema,
      ),
    },
  };
}

function openApiDocumentOperation(): OpenApiOperation {
  return {
    summary: 'This OpenAPI 3.0.3 document, as JSON.',
    description:
      'Unauthenticated, like /health and /schema/compile — nothing in this document is a secret or a permission decision. Rate limit: 100 requests/minute per client, the server-wide default budget (no per-route override, the same convention /schema/compile already uses for a route with no external dependency and no reason for extra polling headroom).',
    security: NO_SECURITY,
    responses: {
      '200': jsonResponse('The exact document buildOpenApiDocument() produces.', {
        type: 'object',
      }),
      '429': RESPONSE_429,
    },
  };
}

// ---------------------------------------------------------------------------
// The document itself.
// ---------------------------------------------------------------------------

/**
 * `0.1.0` — kept in sync with `package.json`'s own `version` field by hand,
 * matching `src/cli/index.ts`'s own identical `packageVersion` constant and
 * its identical doc comment ("kept in sync with package.json by hand until
 * a version-injection step exists"). Update both together.
 */
const API_VERSION = '0.1.0';

/**
 * Builds the complete OpenAPI 3.0.3 document for this API's real HTTP
 * surface. Pure and side-effect-free — no filesystem, no network, no
 * `process.env` — so `scripts/generate-openapi.ts` and `GET /openapi.json`
 * (`src/api/server.ts`) can both call it and get byte-for-byte the same
 * result every time.
 */
// As of this writing, `src/api/server.ts` has no `POST /check/batch` route
// (checked directly against that file's current content, not assumed) —
// so it has no entry below. If/when that route (or any other new route) is
// added to `server.ts`, add a matching operation builder and `paths` entry
// here by hand at the same time; see this file's own top-of-file
// "Disclosed, not automatic" note for why nothing catches that
// automatically.
export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Relationship-Based Authorization API',
      version: API_VERSION,
      description:
        'Fine-grained, relationship-based authorization service (Zanzibar-style) exposed over HTTP — the same check/expand/write/schema operations `authz` (the CLI) already exposes, plus two bulk reverse-lookup operations with no CLI command of their own. This document is hand-written and hand-maintained (src/api/openapi-document.ts) — not derived by introspecting the real Zod schemas at build time — so it can drift from the live server if a route changes without a matching update here; GET /openapi.json always serves whatever this document currently says, straight from the same buildOpenApiDocument() function scripts/generate-openapi.ts uses to write docs/openapi.json.',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            "Authorization: Bearer <key>. The four read/list routes (/check, /expand, /list-objects, /list-users) accept either ADMIN_API_KEY or READONLY_API_KEY; the three write routes (POST/DELETE /tuples, /schema/publish) accept ADMIN_API_KEY only (see each operation's own description). Compared with node:crypto timingSafeEqual, not ===. If the relevant key(s) are unset for a deployment, every request to a gated route is rejected — never silently allowed.",
        },
      },
      schemas: {
        EntityRef: entityRefSchema,
        ApiEntityRef: apiEntityRefSchema,
        PublishedNamespace: publishedNamespaceSchema,
        ApiError: apiErrorSchema,
      },
    },
    paths: {
      '/check': { post: checkOperation() },
      '/check/batch': { post: checkBatchOperation() },
      '/expand': { post: expandOperation() },
      '/list-objects': { post: listObjectsOperation() },
      '/list-users': { post: listUsersOperation() },
      '/tuples': { post: tupleWriteOperation(), delete: tupleDeleteOperation() },
      '/schema/compile': { post: schemaCompileOperation() },
      '/schema/publish': { post: schemaPublishOperation() },
      '/health': { get: healthOperation() },
      '/openapi.json': { get: openApiDocumentOperation() },
    },
  };
}
