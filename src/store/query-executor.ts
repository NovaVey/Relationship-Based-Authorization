/**
 * The narrow, structural connection types this store layer accepts instead
 * of concrete `pg.Pool`/`pg.PoolClient` — DST D0 (`docs/DST-PROPOSAL.md`),
 * finishing the one precedent this project already had for this exact
 * move: `src/schema/publish.ts`'s `publishOne` has always taken a
 * `{ query: ... }` shape narrower than the real `Pool` class, rather than
 * `Pool` itself — because `publishOne` only ever calls `.query()`, never
 * anything else `Pool`-specific. `QueryExecutor` below is that same idea,
 * named and shared, so `publishOne` and every function in this module
 * (`getLatestNamespaceConfig`, `currentToken`, `assertTokenObserved`,
 * `listTuplesByObject`, `listTuplesBySubject`) all narrow to one identical
 * named type instead of each inventing their own ad hoc duplicate.
 *
 * `query`'s own signature is hand-written here, not `Pool['query']`
 * verbatim — `pg`'s real `.query()` is heavily overloaded (a `Submittable`
 * stream, a `QueryArrayConfig`, a `QueryConfig`, or plain text+values), and
 * nothing anywhere in this codebase ever calls it any way but the last,
 * simplest one: `query(text, params)`. Reusing `Pool['query']` verbatim
 * would force any *implementer* of this interface (DST's fake store,
 * `src/store/dst/connection.ts`) to satisfy all four overloads just to
 * type-check, for three shapes nothing here ever uses. A real `Pool`/
 * `PoolClient` still satisfies this narrower signature structurally (one of
 * its own overloads *is* this exact `(text, params) => Promise<{rows,
 * rowCount}>` shape), so every existing caller keeps working unchanged —
 * see this file's own "why this matters" note below.
 *
 * `ConnectionSource` extends `QueryExecutor` with `.connect()` — the shape
 * `writeTuple`/`deleteTuple` need, since they open their own transaction
 * rather than running inside one a caller already holds open.
 *
 * Why this matters beyond naming: a real `pg.Pool`/`pg.PoolClient` already
 * satisfies both types structurally (TypeScript structural typing, not a
 * declared `implements`), so **every existing caller in this codebase
 * keeps working with zero changes** — CLI composition roots, API routes,
 * `src/soundness/runner.ts`'s real differential-fuzz harness all continue
 * passing a real `Pool` exactly as before. What changes is what the
 * *callee* is willing to accept: no longer only the one concrete `pg`
 * class, but anything — including, eventually, an in-memory deterministic
 * stand-in (`src/store/dst/`) — that honestly implements this same small
 * surface. Narrowing the accepted type, never widening what's required of
 * a caller, is the whole reason this is a safe, non-breaking change.
 */

/** The one query-result shape this store layer's own code actually reads (`rows`, `rowCount`) — a real `pg.QueryResult` is a superset of this. */
export interface QueryResultLike<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

/** Anything that can run a parameterized query and return rows — the one primitive this store layer's plain reads/writes need. */
export interface QueryExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
}

/** A `QueryExecutor` that can also hand out its own dedicated connection for a multi-statement transaction — what `writeTuple`/`deleteTuple`/`runMigrations`/`publishSchema` need to open their own `BEGIN`/`COMMIT`/`ROLLBACK`. */
export interface ConnectionSource extends QueryExecutor {
  connect(): Promise<QueryExecutor & { release(): void }>;
}
