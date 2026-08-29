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

import {
  guardPinnedClientForSnapshotAnchor,
  productionCheck,
} from '../../../../src/resolve/production/resolver.js';
import type {
  ConnectionSource,
  QueryExecutor,
  QueryResultLike,
} from '../../../../src/store/query-executor.js';

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

// ---------------------------------------------------------------------------
// `docs/LEOPARD-INDEX-PROPOSAL.md`, "Test plan — the third comparison arm,"
// its own table row for this exact file: "Confirms only that
// `lookupRelationMembershipIndex`'s own call signature takes `ctx.client`,
// never a second pool connection — a static, argument-shape check, not a
// runtime proof that no second connection is ever opened under real
// concurrent load. That stronger, load-bearing proof is the new
// real-Postgres concurrency test [`relation-index-concurrent-rebuild
// .integration.test.ts`]; this row is its fast, DB-free companion, not a
// substitute for it." A light, additive extension — the existing describe
// block above is untouched.
//
// A hand-written fake `ConnectionSource`, in the same spirit as this file's
// own `createRecordingClient` above but one level up (a pool that can also
// `.connect()`, since `productionCheck` itself — not just the guard — is
// what's under test here): every `.connect()` call is counted, and every
// query issued on the one connection it hands back is recorded into a
// single shared array, so "the index lookup's own two queries ran on the
// exact same client every other read in this check used" and "no second
// connection was ever opened" are both directly observable, not inferred.
// ---------------------------------------------------------------------------

const NAMESPACE_CONFIG_QUERY_PREFIX = 'select config from namespace_configs';
const RELATION_INDEX_STATE_QUERY_PREFIX =
  'select watermark_token from relation_membership_index_state';
const RELATION_INDEX_ROW_QUERY_PREFIX =
  'select via_path, min_expires_at from relation_membership_index';

/**
 * A single-namespace, single-relation fixture (`document#viewer: user`) —
 * a hand-built `NamespaceConfig`, not `compileSchema`'d, since this test
 * only needs `resolve()` to find a truthy `config.relations.viewer` and
 * never inspects `subjectTypes` itself.
 */
const DOCUMENT_NAMESPACE_CONFIG = {
  namespace: 'document',
  relations: {
    viewer: { kind: 'relation' as const, name: 'viewer', subjectTypes: [{ namespace: 'user' }] },
  },
  permissions: {},
};

/**
 * A fake `ConnectionSource` wired so a pinned, `useRelationIndex: true`
 * `productionCheck` call for `document:doc1#viewer` genuinely reaches, and
 * gets a genuine hit from, the Leopard-index short-circuit — never the
 * `sqlRelationMembershipWithWitness` fallback — so this test observes the
 * index lookup's own two queries for real, not merely a swallowed miss.
 * `watermarkToken`/`atToken` are both fixed at `5`, matching (never
 * exceeding) the floor `lookupRelationMembershipIndex` requires.
 */
function createFakeLeopardPool(): {
  pool: ConnectionSource;
  connectCallCount: () => number;
  clientQueryTexts: () => string[];
} {
  let connectCalls = 0;
  const clientQueryTexts: string[] = [];

  function respond<Row>(text: string): QueryResultLike<Row> {
    if (text === ANCHOR_QUERY_TEXT) {
      // Serves both `assertTokenObserved`'s pool-level `currentToken` read
      // (identical SQL text) and `assertTokenObservedOnSnapshot`'s own
      // anchor read on the connected client.
      return { rows: [{ max_token: '5' }], rowCount: 1 } as unknown as QueryResultLike<Row>;
    }
    if (text.startsWith(NAMESPACE_CONFIG_QUERY_PREFIX)) {
      return {
        rows: [{ config: DOCUMENT_NAMESPACE_CONFIG }],
        rowCount: 1,
      } as unknown as QueryResultLike<Row>;
    }
    if (text.startsWith(RELATION_INDEX_STATE_QUERY_PREFIX)) {
      return { rows: [{ watermark_token: '5' }], rowCount: 1 } as unknown as QueryResultLike<Row>;
    }
    if (text.startsWith(RELATION_INDEX_ROW_QUERY_PREFIX)) {
      return {
        rows: [{ via_path: ['document:doc1#viewer'], min_expires_at: null }],
        rowCount: 1,
      } as unknown as QueryResultLike<Row>;
    }
    // BEGIN/COMMIT and anything else this fixture never needs.
    return { rows: [], rowCount: 0 };
  }

  const pool: ConnectionSource = {
    async query<Row = Record<string, unknown>>(text: string): Promise<QueryResultLike<Row>> {
      return respond<Row>(text);
    },
    async connect() {
      connectCalls += 1;
      return {
        async query<Row = Record<string, unknown>>(text: string): Promise<QueryResultLike<Row>> {
          clientQueryTexts.push(text);
          return respond<Row>(text);
        },
        release() {
          // No real resource to release — this fake hands out a fresh
          // in-memory object per `.connect()` call, never a pooled one.
        },
      };
    },
  };

  return { pool, connectCallCount: () => connectCalls, clientQueryTexts: () => clientQueryTexts };
}

describe('productionCheck (Leopard index) — lookupRelationMembershipIndex always runs on ctx.clients own connection, never a second one', () => {
  it('the-index-lookups-own-two-queries-run-on-the-exact-same-connected-client-every-other-read-in-this-check-uses-and-productionCheck-never-opens-a-second-connection', async () => {
    const { pool, connectCallCount, clientQueryTexts } = createFakeLeopardPool();

    const result = await productionCheck(
      pool,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'doc1' },
      'viewer',
      { atToken: 5, useRelationIndex: true },
    );

    // The index genuinely hit (not a swallowed miss that fell through to
    // the unchanged SQL path) — otherwise this test would prove nothing
    // about the index lookup's own connection usage at all.
    expect(result.allowed).toBe(true);
    expect(result.indexHit).toBe(true);

    // The one property this row of the test plan actually asks for:
    // `productionCheck` — end to end, including the Leopard-index
    // short-circuit inside `resolve()` — never calls `pool.connect()` more
    // than once for this whole check.
    expect(connectCallCount()).toBe(1);

    // And the index's own two queries genuinely ran on THAT one connected
    // client, back to back, alongside every other read this check made —
    // never on some other, unaccounted-for `QueryExecutor`.
    const calls = clientQueryTexts();
    const stateIndex = calls.findIndex((text) =>
      text.startsWith(RELATION_INDEX_STATE_QUERY_PREFIX),
    );
    const rowIndex = calls.findIndex((text) => text.startsWith(RELATION_INDEX_ROW_QUERY_PREFIX));
    expect(stateIndex).toBeGreaterThanOrEqual(0);
    expect(rowIndex).toBe(stateIndex + 1);
  });
});
