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
  { path: '/check/batch', method: 'post', gated: true },
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

// ---------------------------------------------------------------------------
// 3. buildOpenApiDocument() vs. the REAL, live route table `buildServer()`
//    actually registers — closing the one gap `EXPECTED_ROUTES` above never
//    could (D-156). `EXPECTED_ROUTES` is itself a second hand-maintained
//    list a human has to keep in sync with `server.ts` by hand — exactly
//    the same failure mode `src/api/openapi-document.ts`'s own top-of-file
//    doc comment discloses about the document it checks: two independently
//    hand-updated lists can silently drift from each other while each still
//    "passes" its own half of the comparison. Neither `EXPECTED_ROUTES` nor
//    `buildOpenApiDocument()` can catch a *new* route nobody told either of
//    them about.
//
// This block asks a different, stronger question: does Fastify's own real
// router — the thing that actually decides what a live server answers —
// agree with what `buildOpenApiDocument()` claims to document? The live
// side is captured via `buildServer`'s own `onRouteRegistered` test hook
// (`BuildServerOptions`, D-156), which is wired to Fastify's real `onRoute`
// hook — never a second transcription of `server.ts`'s routes by hand.
// ---------------------------------------------------------------------------

describe('buildOpenApiDocument() vs. the live Fastify route table', () => {
  /**
   * Fastify's own `exposeHeadRoutes` option (on by default — see
   * `node_modules/fastify/lib/config-validator.js`'s
   * `"exposeHeadRoutes":{"type":"boolean","default":true}` — and never
   * overridden in `buildServer`'s own `Fastify({...})` call) silently
   * auto-registers a `HEAD` route for every `GET` route, firing its own
   * `onRoute` event exactly like a real, human-added route would (confirmed
   * live — see this describe block's own test below, which observes both
   * `GET /health`/`GET /openapi.json` AND `HEAD /health`/`HEAD /openapi.json`
   * with nothing else asking for the HEAD pair). That's a framework-internal
   * implementation detail, not a route anyone at this project decided to
   * expose or document — HTTP's own convention (and this document's) is
   * that a documented `get` operation already implies `HEAD` support, so
   * `buildOpenApiDocument()` has never had, and should never need, a
   * separate `head` entry for either route.
   *
   * Named explicitly, one entry per real route this applies to — not a
   * blanket "ignore every HEAD request" rule — so a `HEAD`-only route
   * someone genuinely adds on purpose in the future would still show up as
   * a real, uncaught mismatch below, exactly as it should.
   */
  const IGNORED_LIVE_ROUTES = new Set(['HEAD /health', 'HEAD /openapi.json']);

  function documentedRouteSet(): Set<string> {
    const doc = buildOpenApiDocument();
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of ['get', 'post', 'delete'] as const) {
        if (item[method]) documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    return documented;
  }

  async function liveRouteSet(): Promise<Set<string>> {
    const observed: Array<{ method: string; path: string }> = [];
    const pool = { query: () => Promise.resolve() } as unknown as Pool;
    const app = await buildServer(pool, {
      logger: false,
      onRouteRegistered: (route) => observed.push(route),
    });
    try {
      return new Set(
        observed
          .map(({ method, path }) => `${method} ${path}`)
          .filter((pair) => !IGNORED_LIVE_ROUTES.has(pair)),
      );
    } finally {
      await app.close();
    }
  }

  it('observes routes beyond the ignored HEAD pair, proving onRouteRegistered is actually wired up', async () => {
    // A fail-check on the fail-check mechanism itself: if `onRouteRegistered`
    // silently stopped firing (wrong hook position, a future Fastify
    // change), every set below would just be empty and both directional
    // assertions would trivially pass with nothing to compare — a guard
    // that can't fail is not a guard. This pins the live side to a real,
    // non-empty, non-ignored set first.
    const live = await liveRouteSet();
    expect(live.size).toBeGreaterThan(0);
    expect(live.has('POST /check')).toBe(true);
    expect(live.has('GET /health')).toBe(true);
  });

  it('documents no live route it was never told about, and claims no route the live server does not actually have', async () => {
    const live = await liveRouteSet();
    const documented = documentedRouteSet();

    const registeredButUndocumented = [...live].filter((r) => !documented.has(r)).sort();
    const documentedButNotRegistered = [...documented].filter((r) => !live.has(r)).sort();

    expect(
      registeredButUndocumented,
      'server.ts registers these routes but buildOpenApiDocument() has no entry for them',
    ).toEqual([]);
    expect(
      documentedButNotRegistered,
      'buildOpenApiDocument() documents these routes but server.ts never actually registers them',
    ).toEqual([]);
  });
});
