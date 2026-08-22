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
   */
  armNextConnectionPause(afterStatements: number): { resume: () => void };
}

/** One armed pause, fully self-contained — see `armNextConnectionPause`'s own doc comment for why this is a dedicated object per arming rather than a single shared field. */
interface ArmedPause {
  afterStatements: number;
  gate: Promise<void>;
}

class FakeConnectionSourceImpl implements FakeConnectionSource {
  private readonly autocommitConnection: FakeConnectionImpl;
  private armedCrash: number | undefined;
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
    if (this.armedPause !== undefined) {
      options.pauseAfterStatements = this.armedPause.afterStatements;
      options.pauseGate = this.armedPause.gate;
    }
    this.armedPause = undefined;
    return Promise.resolve(new FakeConnectionImpl(this.state, this.nextConnectionId++, options));
  }

  armNextConnectionCrash(afterStatements: number): void {
    this.armedCrash = afterStatements;
  }

  armNextConnectionPause(afterStatements: number): { resume: () => void } {
    // The gate (and its resolver) is built here, at arm time, and captured
    // entirely by this one arming's own closure — never a shared mutable
    // field on `this`. Two armings in a row, each followed by its own
    // `.connect()` before the first is ever resumed, therefore can never
    // cross-resolve each other's gate: each `resume` callback only ever
    // knows about the one `resolveGate` it closed over.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.armedPause = { afterStatements, gate };
    return {
      resume: () => {
        resolveGate();
      },
    };
  }
}

export function createFakeConnectionSource(state: FakeStoreState): FakeConnectionSource {
  return new FakeConnectionSourceImpl(state);
}
