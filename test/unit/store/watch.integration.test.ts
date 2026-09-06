/**
 * `fetchWatchEvents` (`src/store/watch.ts`, D-174) against a real,
 * ephemeral Postgres — proves the real SQL (ordering, the `token > $1`
 * cursor, the `tuple->>'objectNs'` namespace filter, the batch `limit`)
 * and the real `jsonb` round-trip it depends on, complementing
 * `test/unit/store/watch.test.ts`'s DB-free query-construction/row-mapping
 * proof. `docs/DECISIONS.md` D-019/D-030's own `PostgreSqlContainer`
 * convention — a fresh container per file, no shared state across
 * `*.integration.test.ts` files.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, deleteTuple, type TupleKey } from '../../../src/store/tuples.js';
import { fetchWatchEvents } from '../../../src/store/watch.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { publishSchema } from '../../../src/schema/publish.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

// `writeTuple` rejects a write against any namespace with no published
// schema (`no_published_schema`) — both namespaces this file's own
// fixtures use (`document`, and `folder` for the namespace-filter test)
// need a real, published schema before any tuple below can be written.
const FIXTURE_SCHEMA = `
namespace document {
  relation viewer: user
}

namespace folder {
  relation owner: user
}
`;

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
  const published = await publishSchema(pool, FIXTURE_SCHEMA);
  if (!published.ok) {
    throw new Error(`fixture schema failed to publish: ${published.errors.join('; ')}`);
  }
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

function tuple(overrides: Partial<TupleKey> = {}): TupleKey {
  return {
    objectNs: 'document',
    objectId: 'readme',
    relation: 'viewer',
    subjectNs: 'user',
    subjectId: 'alice',
    ...overrides,
  };
}

describe('fetchWatchEvents against a real write_log', () => {
  it('returns-nothing-new-when-afterToken-is-already-current', async () => {
    const before = await fetchWatchEvents(pool, 1_000_000_000);
    expect(before).toEqual([]);
  });

  it('one-real-write-produces-one-event-with-a-real-monotonic-token-and-the-exact-tuple-fields', async () => {
    const baseline = (await fetchWatchEvents(pool, 0)).length;
    const result = await writeTuple(pool, tuple({ objectId: 'watch_basic_doc' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await fetchWatchEvents(pool, result.token - 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      token: result.token,
      operation: 'write',
      tuple: tuple({ objectId: 'watch_basic_doc' }),
    });
    expect(events[0]?.writtenAt).toBeInstanceOf(Date);

    // Sanity: this write is genuinely new relative to the whole table, not
    // just relative to its own token - 1.
    const fromTheBeginning = await fetchWatchEvents(pool, 0);
    expect(fromTheBeginning.length).toBeGreaterThan(baseline);
  });

  it('a-delete-produces-an-event-with-operation-delete', async () => {
    const written = await writeTuple(pool, tuple({ objectId: 'watch_delete_doc' }));
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const deleted = await deleteTuple(pool, tuple({ objectId: 'watch_delete_doc' }));
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;

    const events = await fetchWatchEvents(pool, deleted.token - 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.operation).toBe('delete');
    expect(events[0]?.token).toBe(deleted.token);
  });

  it('multiple-writes-come-back-oldest-first-by-real-token-order', async () => {
    const first = await writeTuple(pool, tuple({ objectId: 'watch_order_a' }));
    const second = await writeTuple(pool, tuple({ objectId: 'watch_order_b' }));
    const third = await writeTuple(pool, tuple({ objectId: 'watch_order_c' }));
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    const events = await fetchWatchEvents(pool, first.token - 1);
    expect(events.map((e) => e.token)).toEqual([first.token, second.token, third.token]);
    expect(events.map((e) => e.tuple.objectId)).toEqual([
      'watch_order_a',
      'watch_order_b',
      'watch_order_c',
    ]);
  });

  it('a-namespace-filter-excludes-a-write-to-a-different-namespace', async () => {
    const before = await writeTuple(pool, tuple({ objectId: 'watch_ns_before' }));
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const otherNs = await writeTuple(
      pool,
      tuple({ objectNs: 'folder', objectId: 'watch_ns_other', relation: 'owner' }),
    );
    const sameNs = await writeTuple(pool, tuple({ objectId: 'watch_ns_same' }));
    expect(otherNs.ok && sameNs.ok).toBe(true);
    if (!otherNs.ok || !sameNs.ok) return;

    const filtered = await fetchWatchEvents(pool, before.token, { namespace: 'document' });
    expect(filtered.map((e) => e.token)).toEqual([sameNs.token]);
    expect(filtered.every((e) => e.tuple.objectNs === 'document')).toBe(true);

    const unfiltered = await fetchWatchEvents(pool, before.token);
    expect(unfiltered.map((e) => e.token)).toEqual([otherNs.token, sameNs.token]);
  });

  it('limit-caps-the-batch-and-later-calls-continue-from-the-last-delivered-token', async () => {
    const anchor = await writeTuple(pool, tuple({ objectId: 'watch_limit_anchor' }));
    expect(anchor.ok).toBe(true);
    if (!anchor.ok) return;
    const written = [];
    for (let i = 0; i < 5; i++) {
      const result = await writeTuple(pool, tuple({ objectId: `watch_limit_${i}` }));
      expect(result.ok).toBe(true);
      if (result.ok) written.push(result.token);
    }

    const firstBatch = await fetchWatchEvents(pool, anchor.token, { limit: 2 });
    expect(firstBatch.map((e) => e.token)).toEqual(written.slice(0, 2));

    const secondBatch = await fetchWatchEvents(pool, firstBatch[1]!.token, { limit: 2 });
    expect(secondBatch.map((e) => e.token)).toEqual(written.slice(2, 4));

    const rest = await fetchWatchEvents(pool, secondBatch[1]!.token);
    expect(rest.map((e) => e.token)).toEqual(written.slice(4));
  });
});
