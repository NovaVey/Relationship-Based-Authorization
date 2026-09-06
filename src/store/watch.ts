/**
 * `fetchWatchEvents` — the one primitive `GET /watch` (`src/api/server.ts`,
 * `docs/DECISIONS.md` D-174) is built on: read the next batch of
 * `write_log` rows after a given token, oldest first, optionally scoped to
 * one namespace. Everything else `/watch` needs (SSE framing, the
 * poll-interval loop, backpressure, disconnect handling) is genuinely an
 * HTTP-layer concern and lives in `server.ts` itself — this file is the
 * store-layer half, the same split `src/audit/list.ts`'s `listObjects` (a
 * pure domain function) and its `POST /list-objects` route wiring already
 * establish.
 *
 * **First reader of `write_log.tuple`'s actual contents.** Every existing
 * caller of this table (`currentToken`, `assertTokenObserved`, the Leopard
 * index's own refresh watermark) only ever reads `max(token)` — never the
 * `tuple` column itself. Confirmed live, not assumed, before writing this
 * file: `pg` auto-parses a `jsonb` column into a plain JS object (no manual
 * `JSON.parse` needed), but a `Date` field written through
 * `JSON.stringify` (`insertWriteLog`, `src/store/tuples.ts`) round-trips
 * back out as a plain ISO **string**, never a `Date` instance — so
 * `WatchTuple` below is a deliberately distinct shape from `TupleKey`
 * (`expiresAt?: string`, not `expiresAt?: Date`), not a re-import of it.
 * Reusing `TupleKey` verbatim here would silently lie about what this
 * value actually is at runtime, exactly the class of bug `docs/DECISIONS.md`
 * D-008 and `src/store/tokens.ts`'s own `bigint`-as-`string` doc comment
 * both already warn about for this same store layer.
 */
import type { QueryExecutor } from './query-executor.js';

/** The wire/storage shape `write_log.tuple` actually round-trips as — see this file's own top-of-file doc comment for why this isn't `TupleKey`. */
export interface WatchTuple {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  subjectRelation?: string;
  /** ISO 8601, present only for a tuple with a validity window (D-144) — a plain string, not a `Date` (see this file's own top-of-file comment). */
  expiresAt?: string;
}

export interface WatchEvent {
  /** `write_log.token` — pass `encodeToken(token)` to a caller, exactly like every other consistency token this API hands out; never the raw integer (`src/store/tokens.ts`). */
  token: number;
  operation: 'write' | 'delete';
  tuple: WatchTuple;
  writtenAt: Date;
}

/**
 * One poll tick's worth of work: every `write_log` row with `token >
 * afterToken`, oldest first, capped at `limit` rows — never "all of
 * them," so a caller catching up from a token far in the past (a long-idle
 * reconnect) reads in bounded batches instead of one unbounded query, the
 * same reasoning `src/audit/list.ts`'s own `LIST_OBJECTS_MAX_CANDIDATES`
 * cap gives for its own candidate scan. An empty result means "nothing new
 * since `afterToken`, as of this call" — not an error, and not a signal to
 * stop polling; the caller (`GET /watch`'s own loop) decides what an empty
 * batch means for its own pacing.
 *
 * `namespace`, when given, filters to `tuple->>'objectNs' = $namespace` —
 * confirmed live that this is a well-formed, correctly-indexed-by-neither-
 * but-still-cheap filter over a `jsonb` column (no functional index exists
 * for it today; see this file's own "Revisit if" pointer in
 * `docs/DECISIONS.md` D-174 for when that would start to matter). This is
 * the *only* filter `/watch` supports in this phase — no per-object or
 * per-relation narrowing — a deliberate scope cut, not an oversight; see
 * D-174.
 */
export async function fetchWatchEvents(
  pool: QueryExecutor,
  afterToken: number,
  options: { namespace?: string; limit?: number } = {},
): Promise<WatchEvent[]> {
  const limit = options.limit ?? WATCH_DEFAULT_BATCH_LIMIT;
  const { rows } = options.namespace
    ? await pool.query<WatchRow>(
        `select token, operation, tuple, written_at
           from write_log
          where token > $1 and tuple->>'objectNs' = $2
          order by token asc
          limit $3`,
        [afterToken, options.namespace, limit],
      )
    : await pool.query<WatchRow>(
        `select token, operation, tuple, written_at
           from write_log
          where token > $1
          order by token asc
          limit $2`,
        [afterToken, limit],
      );
  // write_log.token is a Postgres `bigint`, which `pg` returns as a
  // `string` — `Number(...)` here for the identical reason
  // `src/store/tokens.ts`'s own doc comment gives (a real, reproduced bug
  // this project already learned from once, D-008): left as a string, a
  // caller comparing two tokens compares lexicographically, not
  // numerically.
  return rows.map((row) => ({
    token: Number(row.token),
    operation: row.operation,
    tuple: row.tuple,
    writtenAt: row.written_at,
  }));
}

interface WatchRow {
  token: string;
  operation: 'write' | 'delete';
  tuple: WatchTuple;
  written_at: Date;
}

/**
 * A deliberately simple, round starting point — not derived from a load
 * test — mirroring `LIST_OBJECTS_MAX_CANDIDATES`'s own identical framing.
 * Bounds one poll tick's own query cost; a client catching up from a
 * token far in the past simply takes more ticks to reach "now," never one
 * unbounded read.
 */
export const WATCH_DEFAULT_BATCH_LIMIT = 500;
