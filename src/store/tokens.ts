/**
 * The consistency token — build spec §6.3. `write_log.token` (a generated
 * column always equal to that row's own `id` — see the 0001 migration's own
 * comment) is a monotonic marker every write/delete advances. A caller that
 * pins a read to token T is expressing "this read must reflect everything
 * up to and including T" — not "give me a snapshot as of exactly T": on one
 * Postgres instance, with no replica lag to hide, ordinary transaction
 * visibility already guarantees a query started after a commit sees it.
 * What actually needs enforcing is narrower and checkable: T must be a
 * token this database has actually observed by the time the pinned read
 * runs — `assertTokenObserved` is that check, made concrete rather than an
 * unexamined "eventually consistent."
 *
 * `token`/`id` are Postgres `bigint` columns, and `pg` returns a `bigint`
 * to JavaScript as a **string**, never coerced to `number` on its own —
 * `bigint` can exceed `Number.MAX_SAFE_INTEGER` and `pg` refuses to risk
 * silently losing precision. Left uncoerced, that string leaks into every
 * comparison here (`>` compares strings lexicographically, not
 * numerically) and produces a real, silent correctness bug once two tokens
 * being compared have different digit counts — found and reproduced
 * against a real database during Phase 2's own test-authoring pass (see
 * `docs/DECISIONS.md`). `Number(...)` immediately after every query result
 * — not a global `pg.types.setTypeParser` registration — is the fix:
 * explicit at the one place it matters, rather than a module-load-order
 * side effect a caller has to know exists (this project already learned
 * that lesson once, the hard way — see D-008).
 */
import type { QueryExecutor } from './query-executor.js';

/** The highest token this database has issued so far, or `null` if no write has ever happened. */
export async function currentToken(pool: QueryExecutor): Promise<number | null> {
  const { rows } = await pool.query<{ max_token: string | null }>(
    'select max(token) as max_token from write_log',
  );
  const raw = rows[0]?.max_token;
  return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * Throws if `token` is higher than every token this database has observed
 * — the property build spec §6.3 states as non-negotiable: "a check pinned
 * to token T never returns a result that ignores a write with token ≤ T."
 * A pinned read calls this immediately before it reads, so an unobservable
 * token fails loudly instead of silently reading current state and calling
 * it a match for a pin it never actually satisfied.
 *
 * `Number(token)` here too: a caller may hold a token value that arrived
 * as a raw `pg` `bigint` string upstream (see this file's own doc comment)
 * despite this parameter's declared `number` type — TypeScript's static
 * type doesn't survive a value's actual round trip through JSON or a
 * database driver, so this is a real runtime hazard, not a redundant
 * defensive check.
 *
 * `Number.isInteger(requested)` is checked explicitly, before the
 * `observed` comparison, rather than left to fall out of `requested >
 * observed` on its own (full-repo audit finding #9, MEDIUM, 2026-08-16):
 * `NaN > observed` — and every other `>`/`<`/`>=`/`<=` comparison
 * involving `NaN` — evaluates to `false` in JavaScript, never `true`, so a
 * malformed token (`Number('not-a-token')`, `Number(undefined)`, a caller
 * that passed a non-integer) would silently pass this "has this been
 * observed" check instead of throwing — the exact inverse of what a
 * consistency check must do with an input it cannot make sense of. Every
 * *current* caller (`src/api/server.ts`'s Zod `atToken: z.number().int()
 * .nonnegative().optional()` schema, `src/cli/commands/check.ts`'s own
 * `Number.isInteger(atToken)` guard) already validates before reaching
 * here, so this never fires against either of today's real call paths —
 * this is a defensive boundary check for `ProductionCheckOptions.atToken`,
 * a public type any future caller could hand a malformed value through
 * directly, not a fix for an observed bug in either existing caller.
 */
export async function assertTokenObserved(pool: QueryExecutor, token: number): Promise<void> {
  const requested = Number(token);
  if (!Number.isInteger(requested) || requested < 0) {
    throw new Error(
      `consistency token ${JSON.stringify(token)} is not a valid token — a consistency token ` +
        `must be a non-negative integer returned by an earlier write or delete`,
    );
  }
  const observed = await currentToken(pool);
  if (observed === null || requested > observed) {
    throw new Error(
      `consistency token ${requested} has not been observed by this database ` +
        `(highest known token: ${observed ?? 'none — no writes yet'})`,
    );
  }
}
