/**
 * DB-free wiring test for `expand()`'s own transaction (D-107, second
 * full-repo audit finding #3) — proves every `relation_tuples` read goes
 * through the one pinned connection this call opens, never the raw `pool`
 * directly, using a mocked `ConnectionSource`/`QueryExecutor` the same way
 * `test/unit/api/server.test.ts` mocks its own pool. Everything else about
 * `expand()`'s real behavior (the actual subject tree shape, cycle safety,
 * tuple-to-userset hops) is already covered by
 * `test/unit/audit/expand.integration.test.ts` against real Postgres — this
 * file's only job is the property a real-Postgres test can assert on but
 * can't make deterministic: which object's `.query()` gets called for what,
 * and in what order.
 */
import { describe, expect, it, vi } from 'vitest';

import { expand } from '../../../src/audit/expand.js';
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { NamespaceConfig } from '../../../src/schema/dsl/types.js';
import type { ConnectionSource } from '../../../src/store/query-executor.js';

function compileDocumentNamespace(): NamespaceConfig {
  const compiled = compileSchema(
    ['namespace document {', '  relation viewer: user', '  permission view = viewer', '}'].join(
      '\n',
    ),
  );
  if (!compiled.ok) {
    throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  const namespace = compiled.schema.namespaces.document;
  if (!namespace) throw new Error('fixture schema did not produce a document namespace');
  return namespace;
}

describe('D-107: expand() runs every relation_tuples read on one pinned connection, inside one transaction', () => {
  it('relation-tuples-reads-go-through-the-connected-client-never-the-raw-pool-directly', async () => {
    const namespaceConfig = compileDocumentNamespace();
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes('namespace_configs')) {
        return { rows: [{ config: namespaceConfig }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const clientRelease = vi.fn();
    const client = { query: clientQuery, release: clientRelease };
    const poolConnect = vi.fn(async () => client);
    // Never expected to be called at all — see the assertion below.
    const poolQuery = vi.fn(async (_sql: string) => {
      throw new Error(
        'unexpected: nothing should call pool.query() directly — getConfig now runs on ' +
          'the pinned client, closing the connection-exhaustion deadlock (docs/DECISIONS.md)',
      );
    });
    const pool = { query: poolQuery, connect: poolConnect } as unknown as ConnectionSource;

    const result = await expand(pool, { ns: 'document', id: 'readme' }, 'viewer');

    // Sanity: a real, well-formed relation leaf came back, not a thrown
    // error or an `undeclared` node from a mock miswired badly enough to
    // make expand() give up before ever reaching fetchTuplesOn.
    expect(result).toEqual({
      kind: 'relation',
      object: { ns: 'document', id: 'readme' },
      relation: 'viewer',
      directSubjects: [],
      usersets: [],
    });

    expect(poolConnect).toHaveBeenCalledTimes(1);
    expect(clientRelease).toHaveBeenCalledTimes(1);

    const clientSqlCalls = clientQuery.mock.calls.map(([sql]) => sql);
    expect(clientSqlCalls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(clientSqlCalls.at(-1)).toBe('COMMIT');
    expect(clientSqlCalls.some((sql) => sql.includes('relation_tuples'))).toBe(true);

    // The connection-exhaustion-deadlock fix (`docs/DECISIONS.md`, the
    // entry closing D-140's own "Revisit if"): `getConfig`'s
    // `namespace_configs` lookup now runs on this same pinned client too —
    // a check/expand call only ever needs exactly one connection from the
    // pool for its entire life, never two. `pool.query()` itself is never
    // called at all once a connection has been obtained; only
    // `pool.connect()` is (asserted above).
    expect(poolQuery).not.toHaveBeenCalled();
    expect(clientSqlCalls.some((sql) => sql.includes('namespace_configs'))).toBe(true);
  });

  it('a-thrown-error-mid-walk-still-releases-the-connection-and-attempts-a-guarded-rollback', async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes('relation_tuples')) throw new Error('simulated read failure');
      if (sql.includes('namespace_configs')) {
        return { rows: [{ config: compileDocumentNamespace() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const clientRelease = vi.fn();
    const client = { query: clientQuery, release: clientRelease };
    const pool = {
      // Never expected to be called — see the sibling test's own identical assertion.
      query: vi.fn(async () => {
        throw new Error('unexpected: nothing should call pool.query() directly');
      }),
      connect: vi.fn(async () => client),
    } as unknown as ConnectionSource;

    await expect(expand(pool, { ns: 'document', id: 'readme' }, 'viewer')).rejects.toThrow(
      'simulated read failure',
    );

    const clientSqlCalls = clientQuery.mock.calls.map(([sql]) => sql);
    expect(clientSqlCalls).toContain('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });
});
