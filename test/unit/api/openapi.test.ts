/**
 * `buildOpenApiDocument()` (`src/api/openapi-document.ts`) and its one
 * live consumer, `GET /openapi.json` (`src/api/server.ts`).
 *
 * DB-free throughout — `buildOpenApiDocument()` itself touches no I/O, and
 * the `GET /openapi.json` route below is exercised via `app.inject`
 * (Fastify's own no-real-server test mechanism), the identical pattern
 * `test/unit/api/server.test.ts` already established for every other route
 * in this file with a plain `{ query: vi.fn() }` stand-in `Pool` — this
 * route never touches `pool` at all, so even that minimal fixture is more
 * than it needs, but it's supplied anyway to keep `buildServer`'s own
 * signature satisfied exactly like every other test file that builds one.
 *
 * Two things this file proves:
 * 1. The document itself is structurally valid OpenAPI shape (`openapi`,
 *    `info`, `paths` present), every route this generator was built to
 *    describe actually has an entry, and every gated route's operation
 *    object actually carries a `bearerAuth` security requirement (never a
 *    silently-forgotten one — see `src/api/openapi-document.ts`'s own
 *    "disclosed, not automatic" doc comment for why nothing *else* catches
 *    that mistake).
 * 2. `GET /openapi.json` serves *the exact same* document the standalone
 *    `buildOpenApiDocument()` call produces — proving there is really only
 *    one function building this document, never a second copy embedded in
 *    the route handler that could quietly drift from the first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildOpenApiDocument, type OpenApiOperation } from '../../../src/api/openapi-document.js';
import { buildServer } from '../../../src/api/server.js';

// ---------------------------------------------------------------------------
// Every route `src/api/server.ts` registers today, and whether it's gated
// behind `bearerAuth` — kept here, by hand, as the test's own independent
// checklist against what `buildOpenApiDocument()` claims to document. See
// `src/api/openapi-document.ts`'s own top-of-file doc comment: this file
// cannot catch a *new* route nobody told either side about, only a mismatch
// between the two once both are told.
// ---------------------------------------------------------------------------

interface ExpectedRoute {
  path: string;
  method: 'get' | 'post' | 'delete';
  gated: boolean;
}

const EXPECTED_ROUTES: ExpectedRoute[] = [
  { path: '/check', method: 'post', gated: true },
  { path: '/expand', method: 'post', gated: true },
  { path: '/list-objects', method: 'post', gated: true },
  { path: '/list-users', method: 'post', gated: true },
  { path: '/tuples', method: 'post', gated: true },
  { path: '/tuples', method: 'delete', gated: true },
  { path: '/schema/compile', method: 'post', gated: false },
  { path: '/schema/publish', method: 'post', gated: true },
  { path: '/health', method: 'get', gated: false },
  { path: '/openapi.json', method: 'get', gated: false },
];

function referencesBearerAuth(operation: OpenApiOperation): boolean {
  return operation.security.some((requirement) => Object.hasOwn(requirement, 'bearerAuth'));
}

// ---------------------------------------------------------------------------
// 1. buildOpenApiDocument() itself.
// ---------------------------------------------------------------------------

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument();

  it('has the top-level keys a valid OpenAPI 3.0.3 document requires', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info).toBeTypeOf('object');
    expect(doc.info.title).toBeTypeOf('string');
    expect(doc.info.version).toBeTypeOf('string');
    expect(doc.paths).toBeTypeOf('object');
  });

  it('declares a bearerAuth security scheme', () => {
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      description: expect.any(String),
    });
  });

  it.each(EXPECTED_ROUTES)('documents $method $path', ({ path, method }) => {
    const pathItem = doc.paths[path];
    expect(pathItem, `no path entry for ${path}`).toBeDefined();
    const operation = pathItem?.[method];
    expect(operation, `no ${method} operation for ${path}`).toBeDefined();
    expect(operation?.responses['200']).toBeDefined();
    expect(operation?.description.length).toBeGreaterThan(0);
  });

  it.each(EXPECTED_ROUTES.filter((r) => r.gated))(
    'gates $method $path behind the bearerAuth security scheme',
    ({ path, method }) => {
      const operation = doc.paths[path]?.[method];
      expect(operation).toBeDefined();
      expect(referencesBearerAuth(operation as OpenApiOperation)).toBe(true);
    },
  );

  it.each(EXPECTED_ROUTES.filter((r) => !r.gated))(
    'does not gate $method $path behind any security requirement',
    ({ path, method }) => {
      const operation = doc.paths[path]?.[method];
      expect(operation).toBeDefined();
      expect(operation?.security).toEqual([]);
    },
  );

  it('documents no route this generator was never told about beyond the expected set', () => {
    const documentedPairs = new Set<string>();
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const method of ['get', 'post', 'delete'] as const) {
        if (item[method]) documentedPairs.add(`${method.toUpperCase()} ${route}`);
      }
    }
    const expectedPairs = new Set(
      EXPECTED_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`),
    );
    expect(documentedPairs).toEqual(expectedPairs);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /openapi.json serves exactly what buildOpenApiDocument() produces.
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = { query: () => Promise.resolve() } as unknown as Pool;
    app = await buildServer(pool, { logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('is unauthenticated and returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
  });

  it('returns exactly the same document buildOpenApiDocument() produces standalone', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const served = JSON.parse(res.payload);
    expect(served).toEqual(buildOpenApiDocument());
  });
});
