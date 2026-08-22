/**
 * One simulated `pg.PoolClient` — the connection/transaction engine DST D0
 * builds (`docs/DST-PROPOSAL.md`): a per-connection uncommitted write
 * buffer, `BEGIN`/`COMMIT`/`ROLLBACK` handled here directly (never routed
 * through `shapes.ts`'s SQL-shape registry — these are transaction-control
 * tokens, not queries, per `docs/DST-PROPOSAL.md`'s own SQL-shape
 * inventory), and the fault classes D0/D1 themselves prove: a crash
 * injected mid-transaction (D0), and genuine cross-connection advisory-lock
 * contention (D1, `docs/DECISIONS.md` D-098).
 *
 * **Partial writes (fault class (a), `docs/DST-PROPOSAL.md`).** A
 * connection created with `crashAfterStatements: N` executes its first `N`
 * `.query()` calls normally; the `(N+1)`th throws instead of running, and
 * every query call is discarded from `state`. Once crashed, the connection
 * stays dead — **every** subsequent `.query()` call on it also throws,
 * matching real Postgres: a connection that has actually died cannot run a
 * `ROLLBACK` any more than it could run anything else. This is deliberate,
 * not an oversight, and it is exactly what surfaced the real
 * `writeTuple`/`deleteTuple`/`publishSchema` bug this same task fixed (see
 * `docs/DECISIONS.md`): a naive `catch (err) { await client.query
 * ('ROLLBACK'); throw err; }` would have thrown the *rollback's own*
 * failure instead of the original error, silently replacing it — caught by
 * this connection's own realistic "still dead" behavior, not assumed.
 *
 * **Advisory locks (D1).** The four real lock statement texts this
 * codebase issues — `tuples.ts`'s global write-log lock
 * (`pg_advisory_xact_lock($1, $2)`, two-int, xact-scoped), `publish.ts`'s
 * per-namespace lock (`pg_advisory_xact_lock(hashtext($1))`, hash,
 * xact-scoped), and `migrate.ts`'s session lock and its own explicit
 * release (`pg_advisory_lock($1, $2)` / `pg_advisory_unlock($1, $2)`,
 * two-int, session-scoped) — are matched by exact SQL text *here*, before
 * a query ever reaches `shapes.ts`'s `lookupShape`, and turned into calls
 * against `locks.ts`'s real, blocking lock engine. They live here rather
 * than as ordinary `shapes.ts` handlers because locking needs two things
 * an ordinary `ShapeHandler` doesn't have: this connection's own identity
 * (`connectionId`, so a lock can later be released "everything connection
 * 3 holds") and the ability to genuinely block — return a `Promise` that
 * doesn't settle until another connection releases the lock — which a
 * `ShapeHandler`'s synchronous `(ctx) => FakeQueryResult` signature cannot
 * express. See `locks.ts`'s own top-of-file doc comment for the queueing
 * engine itself, and this file's `LOCK_KEYS`/`acquireLockStatement` below
 * for how each of the four real texts maps onto it.
 *
 * `query()` is genuinely `async` now (D0's version deliberately wasn't —
 * see that phase's own note, superseded here): a blocked lock acquisition
 * is a real pending `Promise` that only settles when granted, so two
 * connections driven concurrently via `Promise.all([...])` actually
 * interleave at that `await`, exactly modeling one real connection
 * blocking behind another's held lock while a third, unrelated connection
 * keeps making progress.
 */
import type { FakeStoreState } from './state.js';
import { lookupShape, normalizeSql, type FakeQueryResult, type PendingOp } from './shapes.js';
import { acquireLock, releaseLock, releaseLocksForConnection } from './locks.js';

export interface FakeConnection {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<FakeQueryResult<Row>>;
  release(): void;
}

export interface FakeConnectionOptions {
  /** Test-only: after this many successful `.query()` calls on this connection, the next call throws and the connection's own uncommitted buffer and locks are discarded — see this file's own top-of-file doc comment. `undefined` (the default) never crashes. */
  crashAfterStatements?: number;
}

const enum TxState {
  Idle = 'idle',
  Open = 'open',
}

// The four real lock statement texts this codebase issues, matched by
// exact SQL text — see this file's own top-of-file doc comment. Kept
// distinct from shapes.ts's SHAPES registry deliberately: these need
// connection identity and genuine blocking, neither of which an ordinary
// ShapeHandler has access to.
const XACT_TWOINT_LOCK = normalizeSql('select pg_advisory_xact_lock($1, $2)');
const XACT_HASH_LOCK = normalizeSql('select pg_advisory_xact_lock(hashtext($1))');
const SESSION_LOCK = normalizeSql('select pg_advisory_lock($1, $2)');
const SESSION_UNLOCK = normalizeSql('select pg_advisory_unlock($1, $2)');

/**
 * Builds this engine's own opaque lock key for the two-integer
 * `(classid, objid)` form — `tuples.ts`'s write-log lock and
 * `migrate.ts`'s migrations lock each use a distinct `classid`
 * (`WRITE_LOG_LOCK_CLASSID`/`MIGRATIONS_LOCK_CLASSID`), so this key is
 * already unique per real call site without needing anything cleverer.
 */
function twoIntLockKey(params: readonly unknown[]): string {
  const [classid, objid] = params as [number, number];
  return `twoint:${classid}:${objid}`;
}

/** Builds this engine's own opaque lock key for `publish.ts`'s `hashtext($1)` form — see `locks.ts`'s own top-of-file doc comment for why the literal namespace string, not a replicated Postgres hash, is the key. */
function hashLockKey(params: readonly unknown[]): string {
  const [namespace] = params as [string];
  return `hash:${namespace}`;
}

export class FakeConnectionImpl implements FakeConnection {
  private txState: TxState = TxState.Idle;
  private pending: PendingOp[] = [];
  private dead = false;
  private statementsExecuted = 0;

  constructor(
    private readonly state: FakeStoreState,
    private readonly connectionId: number,
    private readonly options: FakeConnectionOptions = {},
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<FakeQueryResult<Row>> {
    if (this.dead) {
      throw new Error(
        'DST fake connection: query issued on a connection that has already crashed — ' +
          'matches a real dead Postgres connection, which cannot run anything either, ' +
          'including ROLLBACK',
      );
    }
    if (
      this.options.crashAfterStatements !== undefined &&
      this.statementsExecuted >= this.options.crashAfterStatements
    ) {
      this.dead = true;
      this.pending = [];
      // A genuinely dead backend releases everything it held, both
      // xact-scoped (its own now-discarded transaction) and session-scoped
      // — the D1 exit criterion this line exists for ("a session-lock-crash
      // test: the lock auto-releases when the holding connection dies",
      // `docs/DST-PROPOSAL.md`). Ordinary `.release()` back to a pool does
      // *not* reach this path and releases nothing — see `release()` below.
      releaseLocksForConnection(this.state.locks, this.connectionId, 'all');
      throw new Error(
        'DST fake connection: simulated crash — connection terminated mid-statement, ' +
          "this transaction's own uncommitted buffer was discarded",
      );
    }
    this.statementsExecuted += 1;

    const normalized = sql.trim().toUpperCase();
    if (normalized === 'BEGIN') {
      this.txState = TxState.Open;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'COMMIT') {
      const commitSeq = this.state.nextCommitSeq;
      this.state.nextCommitSeq += 1;
      for (const op of this.pending) op(this.state, commitSeq);
      this.pending = [];
      this.txState = TxState.Idle;
      // Postgres releases every transaction-scoped advisory lock this
      // session holds at COMMIT, unconditionally — not just ones acquired
      // in exactly this statement sequence. Session-scoped locks (the
      // migrations lock) are untouched here — see locks.ts's own doc
      // comment on the two lifetime models.
      releaseLocksForConnection(this.state.locks, this.connectionId, 'xact');
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK') {
      this.pending = [];
      this.txState = TxState.Idle;
      // Postgres releases xact-scoped advisory locks on ROLLBACK exactly
      // as it does on COMMIT — see the COMMIT branch's own comment above.
      releaseLocksForConnection(this.state.locks, this.connectionId, 'xact');
      return { rows: [], rowCount: 0 };
    }

    const key = normalizeSql(sql);

    if (key === XACT_TWOINT_LOCK || key === XACT_HASH_LOCK) {
      const lockKey = key === XACT_TWOINT_LOCK ? twoIntLockKey(params) : hashLockKey(params);
      await acquireLock(this.state.locks, lockKey, this.connectionId, 'xact');
      if (this.txState === TxState.Idle) {
        // Real Postgres ties pg_advisory_xact_lock to the *current*
        // transaction, including the implicit, single-statement one a bare
        // autocommit query runs inside — that implicit transaction commits
        // the instant this statement finishes, so the lock is released
        // right back, immediately. Not exercised by any real call site in
        // this codebase today (tuples.ts/publish.ts always acquire this
        // lock as the first statement after an explicit BEGIN), but a
        // fake that silently held the lock forever in this case would be a
        // real, if currently latent, fidelity gap.
        releaseLock(this.state.locks, lockKey, this.connectionId);
      }
      return { rows: [{}], rowCount: 1 } as FakeQueryResult<Row>;
    }

    if (key === SESSION_LOCK) {
      const lockKey = twoIntLockKey(params);
      await acquireLock(this.state.locks, lockKey, this.connectionId, 'session');
      return { rows: [{}], rowCount: 1 } as FakeQueryResult<Row>;
    }

    if (key === SESSION_UNLOCK) {
      const lockKey = twoIntLockKey(params);
      const released = releaseLock(this.state.locks, lockKey, this.connectionId);
      // Matches real Postgres's own pg_advisory_unlock: returns false, does
      // not throw, if this connection doesn't actually hold the lock.
      return { rows: [{ pg_advisory_unlock: released }], rowCount: 1 } as FakeQueryResult<Row>;
    }

    const handler = lookupShape(sql);
    const bufferOp = (op: PendingOp): void => {
      if (this.txState === TxState.Open) {
        this.pending.push(op);
        return;
      }
      // Autocommit — a bare query outside any BEGIN/COMMIT commits its own
      // effect immediately, matching real Postgres's own per-statement
      // implicit transaction. Not exercised by writeTuple/deleteTuple
      // (they always run inside an explicit transaction) but kept correct
      // for any future caller that issues a write outside one.
      const commitSeq = this.state.nextCommitSeq;
      this.state.nextCommitSeq += 1;
      op(this.state, commitSeq);
    };
    // The generic `Row` here is a caller-side type assertion, not a
    // runtime-verified shape — matches the real `pg` driver's own
    // `.query<Row>(...)` exactly: it doesn't validate the requested
    // generic against what actually came back either.
    return handler({ state: this.state, params, bufferOp }) as FakeQueryResult<Row>;
  }

  release(): void {
    // Nothing to release in-memory beyond what COMMIT/ROLLBACK/crash
    // already did — deliberately does *not* touch this.state.locks:
    // matches pg.PoolClient's own contract exactly (returns the connection
    // to the pool; a session-scoped advisory lock survives that and stays
    // held until an explicit unlock or the underlying session actually
    // ending — see migrate.ts's own doc comment on MIGRATIONS_LOCK_CLASSID
    // and locks.ts's own top-of-file note).
  }
}
