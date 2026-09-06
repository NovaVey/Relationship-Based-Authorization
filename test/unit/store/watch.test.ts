/**
 * `src/store/watch.ts`'s `fetchWatchEvents` — the one query `GET /watch`
 * (D-174) is built on. DB-free by design, mirroring `test/unit/store/
 * tokens.test.ts`'s own precedent for this store layer: a fake `Pool`
 * whose `query` records exactly what SQL/params it was called with, so
 * this file can pin the query-construction branching (namespace filter
 * present vs. absent, the default batch limit) and the row-to-`WatchEvent`
 * mapping without a real database. `test/unit/store/watch.integration.test.ts`
 * is the real-Postgres counterpart proving the SQL itself, and the jsonb
 * round-trip it depends on, actually behave this way against a live
 * server.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  fetchWatchEvents,
  WATCH_DEFAULT_BATCH_LIMIT,
  type WatchTuple,
} from '../../../src/store/watch.js';

const SAMPLE_TUPLE: WatchTuple = {
  objectNs: 'document',
  objectId: 'readme',
  relation: 'viewer',
  subjectNs: 'user',
  subjectId: 'alice',
};

/** A fake `Pool` whose `query` resolves with a canned row set, recording exactly what SQL text and params it was called with. */
function poolWithRows(
  rows: Array<{
    token: string;
    operation: 'write' | 'delete';
    tuple: WatchTuple;
    written_at: Date;
  }>,
): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows }));
  return { pool: { query } as unknown as Pool, query };
}

describe('fetchWatchEvents — query construction', () => {
  it('no-namespace-filter-omits-the-tuple-objectns-clause-and-uses-two-params', async () => {
    const { pool, query } = poolWithRows([]);
    await fetchWatchEvents(pool, 42);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/objectNs/);
    expect(sql).toMatch(/token > \$1/);
    expect(sql).toMatch(/order by token asc/);
    expect(params).toEqual([42, WATCH_DEFAULT_BATCH_LIMIT]);
  });

  it('a-namespace-filter-adds-the-tuple-objectns-clause-as-a-third-param', async () => {
    const { pool, query } = poolWithRows([]);
    await fetchWatchEvents(pool, 42, { namespace: 'document' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/tuple->>'objectNs' = \$2/);
    expect(params).toEqual([42, 'document', WATCH_DEFAULT_BATCH_LIMIT]);
  });

  it('an-explicit-limit-overrides-watch-default-batch-limit', async () => {
    const { pool, query } = poolWithRows([]);
    await fetchWatchEvents(pool, 0, { limit: 7 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([0, 7]);
  });

  it('an-empty-result-set-returns-an-empty-array-not-an-error', async () => {
    const { pool } = poolWithRows([]);
    await expect(fetchWatchEvents(pool, 0)).resolves.toEqual([]);
  });
});

describe('fetchWatchEvents — row mapping', () => {
  it('coerces-the-bigint-token-string-to-a-real-number-per-d-008', async () => {
    // write_log.token is a Postgres bigint, which `pg` returns as a string
    // — the identical D-008 lesson `src/store/tokens.ts` already documents
    // for this same table. A caller comparing two un-coerced token strings
    // would compare lexicographically, not numerically.
    const writtenAt = new Date('2026-01-01T00:00:00.000Z');
    const { pool } = poolWithRows([
      { token: '9007199254740991', operation: 'write', tuple: SAMPLE_TUPLE, written_at: writtenAt },
    ]);
    const events = await fetchWatchEvents(pool, 0);
    expect(events).toEqual([
      { token: 9007199254740991, operation: 'write', tuple: SAMPLE_TUPLE, writtenAt },
    ]);
    expect(typeof events[0]?.token).toBe('number');
  });

  it('preserves-row-order-oldest-first-exactly-as-the-query-produced-it', async () => {
    const rows = [1, 2, 3].map((n) => ({
      token: String(n),
      operation: 'write' as const,
      tuple: { ...SAMPLE_TUPLE, objectId: `doc-${n}` },
      written_at: new Date(2026, 0, n),
    }));
    const { pool } = poolWithRows(rows);
    const events = await fetchWatchEvents(pool, 0);
    expect(events.map((e) => e.token)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.tuple.objectId)).toEqual(['doc-1', 'doc-2', 'doc-3']);
  });

  it('passes-a-delete-operation-through-unchanged', async () => {
    const { pool } = poolWithRows([
      { token: '5', operation: 'delete', tuple: SAMPLE_TUPLE, written_at: new Date() },
    ]);
    const events = await fetchWatchEvents(pool, 0);
    expect(events[0]?.operation).toBe('delete');
  });

  it('a-tuple-with-subjectRelation-and-expiresAt-round-trips-both-fields-as-plain-strings', async () => {
    // Confirmed live against a real Postgres jsonb column before writing
    // this file: expiresAt (written through JSON.stringify(Date)) comes
    // back as a plain ISO string, never a `Date` instance — this is
    // exactly why `WatchTuple` is a distinct type from `TupleKey`, not a
    // reuse of it. See src/store/watch.ts's own top-of-file doc comment.
    const tuple: WatchTuple = {
      ...SAMPLE_TUPLE,
      subjectRelation: 'member',
      expiresAt: '2026-12-31T00:00:00.000Z',
    };
    const { pool } = poolWithRows([
      { token: '1', operation: 'write', tuple, written_at: new Date() },
    ]);
    const events = await fetchWatchEvents(pool, 0);
    expect(events[0]?.tuple.subjectRelation).toBe('member');
    expect(typeof events[0]?.tuple.expiresAt).toBe('string');
    expect(events[0]?.tuple.expiresAt).toBe('2026-12-31T00:00:00.000Z');
  });
});
