/**
 * Minimal, framework-agnostic HTTP types shared by every middleware factory
 * in this kit.
 *
 * These are intentionally *structural* subsets of what Express (and most
 * Express-alike frameworks — Connect, Fastify with its Express-compat layer,
 * etc.) already provide, so `express.Request` / `express.Response` satisfy
 * them with zero adapter code. We avoid a hard dependency on `express`'s
 * types so this package stays framework-light; consumers get full
 * type-compatibility for free via structural typing.
 *
 * Deliberately no `[key: string]: unknown` index signature here, even
 * though real request/response objects always carry extra framework- and
 * app-specific properties (`req.user`, `res.locals`, etc.) — TypeScript
 * only allows a *declared* type (like `express.Request`) to satisfy a
 * target type that has an index signature if the declared type also has a
 * matching one, and Express's own types don't. Adding one back here would
 * silently break `Middleware` (and therefore every `createXMiddleware()`
 * factory) against real `express.Request` / `express.Response` again —
 * see the regression test in `test/tenant/middleware.test.ts` /
 * `test/rbac/middleware.test.ts` guarding this. Code that needs to read an
 * arbitrary property off a `Req extends MinimalRequest` (e.g.
 * {@link ../rbac/middleware.js!subjectFromRequestRoles}) casts through
 * `Record<string, unknown>` locally instead.
 */

export interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  hostname?: string;
  method?: string;
  url?: string;
}

export interface MinimalResponse {
  statusCode?: number;
  status(code: number): this;
  json(body: unknown): this;
  setHeader(name: string, value: string | number): this;
}

export type NextFunction = (err?: unknown) => void;

export type Middleware<
  Req extends MinimalRequest = MinimalRequest,
  Res extends MinimalResponse = MinimalResponse,
> = (req: Req, res: Res, next: NextFunction) => void;
