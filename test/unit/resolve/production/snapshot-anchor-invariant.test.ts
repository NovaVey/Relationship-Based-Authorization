/**
 * `guardPinnedClientForSnapshotAnchor` (`src/resolve/production/
 * resolver.ts`) — DB-free unit tests. This is the real, runtime-enforced
 * version of the ordering `assertTokenObservedOnSnapshot`'s own doc comment
 * has always depended on but, until now, only enforced by code structure —
 * see `docs/DECISIONS.md` D-139's own disclosed, then-still-open gap ("a
 * pg-side runtime check enforcing that `productionCheck`'s snapshot-
 * anchoring query always runs first ... was applied only to the in-memory
 * fake, never to the real `resolver.ts`, which still relies on code
 * structure alone").
 *
 * No Postgres, no Testcontainers: this suite drives the exported guard
 * function directly against a hand-written fake `QueryExecutor` that just
 * records calls — the guard's own logic is what's under test, independent
 * of anything Postgres-specific. `productionCheck`'s own correct-ordering
 * use of this guard is additionally re-confirmed against real Postgres —
 * see `production-check-behavior.integration.test.ts`'s `atToken pinning`
 * describe block, re-run live via LOCALVERIFY as part of landing this
 * change (this sandbox has no Docker/Testcontainers — see that file's own
 * header for the real-Postgres convention this repo otherwise uses).
 */
import { describe, expect, it } from 'vitest';

import { guardPinnedClientForSnapshotAnchor } from '../../../../src/resolve/production/resolver.js';
import type { QueryExecutor, QueryResultLike } from '../../../../src/store/query-executor.js';

const ANCHOR_QUERY_TEXT = 'select max(token) as max_token from write_log';

/** A minimal fake `QueryExecutor` that records every call it receives and returns a canned, well-typed empty result — enough to drive the guard's own logic without any real database. */
function createRecordingClient(): { client: QueryExecutor; calls: string[] } {
  const calls: string[] = [];
  const client: QueryExecutor = {
    async query<Row = Record<string, unknown>>(
      text: string,
      _params?: readonly unknown[],
    ): Promise<QueryResultLike<Row>> {
      calls.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

describe('guardPinnedClientForSnapshotAnchor — the anchor-ordering invariant', () => {
  it('throws-a-clear-internal-invariant-error-when-some-other-query-runs-before-the-anchor-query', async () => {
    const { client } = createRecordingClient();
    const guarded = guardPinnedClientForSnapshotAnchor(client);
    const decoyQuery = 'select config from namespace_configs where namespace = $1';

    // Simulates exactly the bug class this guard exists to catch: some
    // other read (here, a decoy `namespace_configs` lookup — the same shape
    // `getConfig` issues) runs on this pinned connection before
    // `assertTokenObservedOnSnapshot`'s own anchor query ever does. This is
    // the fail-check this task's own instructions require: proven live,
    // not just "the code looks right."
    let caught: unknown;
    try {
      await guarded.query(decoyQuery, ['document']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The thrown message must actually name what happened and read as an
    // internal-invariant violation, not a normal user-facing error — per
    // the task's own requirement — and must name the offending query so a
    // future debugger isn't left guessing which read broke the ordering.
    expect(message).toMatch(/internal invariant violation/i);
    expect(message).toMatch(/REPEATABLE READ/);
    expect(message).toMatch(/assertTokenObservedOnSnapshot/);
    expect(message).toContain(decoyQuery);
  });

  it('the-anchor-query-itself-running-first-succeeds-and-every-later-query-passes-through-unimpeded', async () => {
    const { client, calls } = createRecordingClient();
    const guarded = guardPinnedClientForSnapshotAnchor(client);

    // The real, correct order `productionCheck` always uses: the anchor
    // query first, then arbitrarily many other reads afterward — none of
    // which should ever be flagged, whatever their own text is.
    await expect(guarded.query(ANCHOR_QUERY_TEXT)).resolves.toEqual({ rows: [], rowCount: 0 });
    await expect(
      guarded.query('select config from namespace_configs where namespace = $1', ['document']),
    ).resolves.toEqual({ rows: [], rowCount: 0 });
    await expect(guarded.query('select * from relation_tuples')).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });

    expect(calls).toEqual([
      ANCHOR_QUERY_TEXT,
      'select config from namespace_configs where namespace = $1',
      'select * from relation_tuples',
    ]);
  });

  it('BEGIN/COMMIT/ROLLBACK never count toward "has a query run yet" — the anchor query can still legitimately be first after any number of them', async () => {
    const { client } = createRecordingClient();
    const guarded = guardPinnedClientForSnapshotAnchor(client);

    await guarded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Still the anchor query's turn — BEGIN doesn't consume "first query."
    await expect(guarded.query(ANCHOR_QUERY_TEXT)).resolves.toEqual({ rows: [], rowCount: 0 });
    await expect(guarded.query('COMMIT')).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  it('a query that runs before BEGIN has even been issued is still caught (BEGIN never ran at all)', async () => {
    const { client } = createRecordingClient();
    const guarded = guardPinnedClientForSnapshotAnchor(client);

    await expect(guarded.query('select 1')).rejects.toThrow(/internal invariant violation/i);
  });
});
