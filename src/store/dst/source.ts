/**
 * The fake, drop-in stand-in for a real `pg.Pool` at DST's one seam
 * (`src/store/query-executor.ts`'s `ConnectionSource`) — the thing a test
 * actually constructs and hands to `writeTuple`/`deleteTuple`/
 * `getLatestNamespaceConfig`/`currentToken` in place of a real `Pool`.
 *
 * A bare `.query()` call (no surrounding transaction — how
 * `getLatestNamespaceConfig`, `currentToken`, `listTuplesByObject`, and
 * `listTuplesBySubject` all run) is answered by one shared, long-lived
 * `FakeConnectionImpl` whose own transaction state never opens (it's never
 * sent `BEGIN`), so every write on it — none exist in D0's own call
 * surface, but see `connection.ts`'s own autocommit branch — would commit
 * immediately, matching real Postgres's own implicit one-statement
 * transaction for a bare `pool.query(...)` call. This connection is never
 * eligible for crash injection: fault class (a) (partial writes) is
 * specifically about a *multi-statement transaction* dying mid-way, which
 * only `.connect()`'s own explicit-transaction connections model.
 */
import type { ConnectionSource, QueryExecutor } from '../query-executor.js';
import type { FakeStoreState } from './state.js';
import { FakeConnectionImpl, type FakeConnectionOptions } from './connection.js';
import type { FakeQueryResult } from './shapes.js';

export interface FakeConnectionSource extends ConnectionSource {
  /**
   * Test-only: arms a one-shot crash for the *next* connection opened via
   * `.connect()` — after `afterStatements` successful `.query()` calls on
   * that one connection, its next call throws and its own uncommitted
   * buffer is discarded (see `connection.ts`'s own doc comment for fault
   * class (a)). Cleared the moment that one `.connect()` call happens; does
   * not arm every future connection.
   */
  armNextConnectionCrash(afterStatements: number): void;
  /**
   * D2 (`docs/DECISIONS.md` D-099), test-only: arms a one-shot pause for
   * the *next* connection opened via `.connect()` — after `afterStatements`
   * successful `.query()` calls on that one connection, its `(afterStatements
   * + 1)`th call genuinely suspends (a real pending `Promise`, exactly like
   * a blocked lock acquisition) until the returned `resume` callback is
   * called. See `connection.ts`'s own top-of-file doc comment on why this
   * exists — it's the DST-native replacement for the real `LOCK TABLE`
   * trick `docs/DECISIONS.md` D-092's own regression test needed to
   * manufacture a controllable race window against real Postgres. Cleared
   * the moment that one `.connect()` call happens, same one-shot contract
   * as `armNextConnectionCrash`.
   *
   * Also returns `fired`, a `Promise` that resolves the instant the pause
   * genuinely triggers on whichever connection consumed this arming — DST
   * D4's `raceUnderPause` (`src/store/dst/scheduler.ts`, `docs/DECISIONS.md`
   * D-101) awaits this directly instead of *guessing* "probably paused by
   * now" from a fixed microtask-flush budget, which a full-repo adversarial
   * review found was silently vacuous for slower-settling operations (see
   * that decision's own writeup for the concrete counterexample). `fired`
   * never resolves at all if this arming's `.connect()` call never actually
   * reaches its own armed statement count — a caller racing it against the
   * operation's own completion (as `raceUnderPause` does) is how that gets
   * detected, not a timeout here.
   */
  armNextConnectionPause(afterStatements: number): { resume: () => void; fired: Promise<void> };
  /**
   * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The genuinely new fault
   * class," test-only: arms a one-shot poison for the *next* connection
   * opened via `.connect()` — after `afterStatements` successful `.query()`
   * calls on that one connection, its `(afterStatements + 1)`th call throws
   * an injected error AND poisons the connection (every later statement
   * fails with `current transaction is aborted...` until a `ROLLBACK` or a
   * `ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP`) — see `connection.ts`'s own
   * top-of-file doc comment and `FakeConnectionOptions.poisonAfterStatements`
   * for the full fault-class writeup. Mirrors `armNextConnectionCrash`'s
   * exact one-shot-arming shape precisely: cleared the moment that one
   * `.connect()` call happens, does not arm every future connection.
   */
  armNextConnectionPoison(afterStatements: number): void;
  /**
   * D-144 (expiring tuples), test-only: sets the fake store's own
   * controllable "current time" (`FakeStoreState.now`) — the ONLY clock
   * every expiry filter (`shapes.ts`, `frontier.ts`) ever consults. Takes
   * effect immediately and for every connection sharing this state,
   * including one already mid-transaction: matches real Postgres's own
   * `REPEATABLE READ` semantics, where `now()` is fixed per-transaction at
   * its own snapshot anchor (`connection.ts`'s `snapshotNow`), not
   * globally — a transaction already anchored keeps its own frozen instant
   * regardless of a later `setNow` call; only a transaction that anchors
   * *after* this call observes the new value. See `state.ts`'s own
   * `FakeStoreState.now` doc comment for why this exists at all rather than
   * a real wall-clock read.
   */
  setNow(now: Date): void;
}

/** One armed pause, fully self-contained — see `armNextConnectionPause`'s own doc comment for why this is a dedicated object per arming rather than a single shared field. */
interface ArmedPause {
  afterStatements: number;
  gate: Promise<void>;
  notifyFired: () => void;
}

class FakeConnectionSourceImpl implements FakeConnectionSource {
  private readonly autocommitConnection: FakeConnectionImpl;
  private armedCrash: number | undefined;
  private armedPoison: number | undefined;
  private armedPause: ArmedPause | undefined;
  // Every FakeConnectionImpl needs its own stable identity for D1's lock
  // engine (`locks.ts`, `connection.ts`) — "release everything connection N
  // holds" needs an N. Scoped to this one source/state instance, not a
  // module-level counter, so two independent tests' connection ids don't
  // depend on how many other tests happened to run first.
  private nextConnectionId = 1;

  constructor(private readonly state: FakeStoreState) {
    this.autocommitConnection = new FakeConnectionImpl(state, this.nextConnectionId++);
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<FakeQueryResult<Row>> {
    return this.autocommitConnection.query<Row>(sql, params);
  }

  // Deliberately not `async` — see connection.ts's own identical note.
  connect(): Promise<QueryExecutor & { release(): void }> {
    const options: FakeConnectionOptions = {};
    if (this.armedCrash !== undefined) {
      options.crashAfterStatements = this.armedCrash;
    }
    this.armedCrash = undefined;
    if (this.armedPoison !== undefined) {
      options.poisonAfterStatements = this.armedPoison;
    }
    this.armedPoison = undefined;
    if (this.armedPause !== undefined) {
      options.pauseAfterStatements = this.armedPause.afterStatements;
      options.pauseGate = this.armedPause.gate;
      options.notifyPauseFired = this.armedPause.notifyFired;
    }
    this.armedPause = undefined;
    return Promise.resolve(new FakeConnectionImpl(this.state, this.nextConnectionId++, options));
  }

  armNextConnectionCrash(afterStatements: number): void {
    this.armedCrash = afterStatements;
  }

  armNextConnectionPoison(afterStatements: number): void {
    this.armedPoison = afterStatements;
  }

  armNextConnectionPause(afterStatements: number): { resume: () => void; fired: Promise<void> } {
    // The gate/fired pair (and their resolvers) are built here, at arm
    // time, and captured entirely by this one arming's own closure — never
    // a shared mutable field on `this`. Two armings in a row, each followed
    // by its own `.connect()` before the first is ever resumed, therefore
    // can never cross-resolve each other's promises: each `resume` callback
    // only ever knows about the one `resolveGate` it closed over, and
    // `notifyFired` only ever resolves the one `fired` this same arming
    // returned.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let resolveFired!: () => void;
    const fired = new Promise<void>((resolve) => {
      resolveFired = resolve;
    });
    this.armedPause = { afterStatements, gate, notifyFired: resolveFired };
    return {
      resume: () => {
        resolveGate();
      },
      fired,
    };
  }

  setNow(now: Date): void {
    this.state.now = now;
  }
}

export function createFakeConnectionSource(state: FakeStoreState): FakeConnectionSource {
  return new FakeConnectionSourceImpl(state);
}
