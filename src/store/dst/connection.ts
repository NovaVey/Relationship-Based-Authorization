/**
 * One simulated `pg.PoolClient` — the connection/transaction engine DST D0
 * builds (`docs/DST-PROPOSAL.md`): a per-connection uncommitted write
 * buffer, `BEGIN`/`COMMIT`/`ROLLBACK` handled here directly (never routed
 * through `shapes.ts`'s SQL-shape registry — these are transaction-control
 * tokens, not queries, per `docs/DST-PROPOSAL.md`'s own SQL-shape
 * inventory), and the one fault class D0 itself proves: a crash injected
 * mid-transaction.
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
 */
import type { FakeStoreState } from './state.js';
import { lookupShape, type FakeQueryResult, type PendingOp } from './shapes.js';

export interface FakeConnection {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<FakeQueryResult<Row>>;
  release(): void;
}

export interface FakeConnectionOptions {
  /** Test-only: after this many successful `.query()` calls on this connection, the next call throws and the connection's own uncommitted buffer is discarded — see this file's own top-of-file doc comment. `undefined` (the default) never crashes. */
  crashAfterStatements?: number;
}

const enum TxState {
  Idle = 'idle',
  Open = 'open',
}

export class FakeConnectionImpl implements FakeConnection {
  private txState: TxState = TxState.Idle;
  private pending: PendingOp[] = [];
  private dead = false;
  private statementsExecuted = 0;

  constructor(
    private readonly state: FakeStoreState,
    private readonly options: FakeConnectionOptions = {},
  ) {}

  // Deliberately not `async` — everything here is synchronous in-memory
  // work, no real I/O to await. A synchronous throw from a non-async
  // function still propagates correctly through an `await` at any real
  // call site (see writeTuple's own catch block, which this connection's
  // "still dead after a crash" behavior specifically exists to exercise) —
  // JS's await mechanics catch a synchronous throw during expression
  // evaluation exactly like an awaited rejection.
  query<Row = Record<string, unknown>>(
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
      throw new Error(
        'DST fake connection: simulated crash — connection terminated mid-statement, ' +
          "this transaction's own uncommitted buffer was discarded",
      );
    }
    this.statementsExecuted += 1;

    const normalized = sql.trim().toUpperCase();
    if (normalized === 'BEGIN') {
      this.txState = TxState.Open;
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (normalized === 'COMMIT') {
      const commitSeq = this.state.nextCommitSeq;
      this.state.nextCommitSeq += 1;
      for (const op of this.pending) op(this.state, commitSeq);
      this.pending = [];
      this.txState = TxState.Idle;
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (normalized === 'ROLLBACK') {
      this.pending = [];
      this.txState = TxState.Idle;
      return Promise.resolve({ rows: [], rowCount: 0 });
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
    return Promise.resolve(
      handler({ state: this.state, params, bufferOp }) as FakeQueryResult<Row>,
    );
  }

  release(): void {
    // Nothing to release in-memory — matches pg.PoolClient's own contract
    // (returns the connection to the pool) closely enough that callers'
    // `finally { client.release(); }` blocks behave identically either way.
  }
}
