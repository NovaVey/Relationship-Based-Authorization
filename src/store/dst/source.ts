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
}

class FakeConnectionSourceImpl implements FakeConnectionSource {
  private readonly autocommitConnection: FakeConnectionImpl;
  private armedCrash: number | undefined;

  constructor(private readonly state: FakeStoreState) {
    this.autocommitConnection = new FakeConnectionImpl(state);
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<FakeQueryResult<Row>> {
    return this.autocommitConnection.query<Row>(sql, params);
  }

  // Deliberately not `async` — see connection.ts's own identical note.
  connect(): Promise<QueryExecutor & { release(): void }> {
    const options: FakeConnectionOptions =
      this.armedCrash === undefined ? {} : { crashAfterStatements: this.armedCrash };
    this.armedCrash = undefined;
    return Promise.resolve(new FakeConnectionImpl(this.state, options));
  }

  armNextConnectionCrash(afterStatements: number): void {
    this.armedCrash = afterStatements;
  }
}

export function createFakeConnectionSource(state: FakeStoreState): FakeConnectionSource {
  return new FakeConnectionSourceImpl(state);
}
