/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "A related observation,
 * found while reading, out of this document's scope to fix" section — named
 * as an open question, never previously investigated, and never previously
 * given a real regression test. Investigated directly here.
 *
 * The gap, restated: `tupleInsertHandler` (`src/store/dst/shapes.ts`) tags a
 * newly-committed row with its own commit's `commitSeq` (its real-Postgres
 * "xmin"), and every reader compares that against its own frozen
 * `visibleAsOf` snapshot ceiling (`isVisible`/`isTupleVisible`) — the correct
 * in-memory model of real Postgres `REPEATABLE READ` MVCC for inserts.
 * `tupleDeleteHandler`, before this fix, had no such tagging at all: it
 * spliced the matching row physically OUT of the shared `state.relationTuples`
 * array the instant the deleting transaction committed, with no regard for
 * any OTHER transaction's own earlier-anchored snapshot. In real Postgres, a
 * `REPEATABLE READ` transaction that anchored its snapshot BEFORE a later
 * transaction's `DELETE` commits must still see the deleted row as present
 * when it reads — a snapshot never observes the effects of a transaction
 * that committed after that snapshot was established. An unconditional
 * array splice cannot represent that: ANY read of `state.relationTuples`
 * after the splice runs would incorrectly see the row as gone, including a
 * read from a snapshot anchored before the delete ever committed.
 *
 * Confirmed real before being fixed: with `tupleDeleteHandler`'s stamp
 * replaced back with the old unconditional splice (this file's own
 * fail-check, run live — see the task's own report for the transcript), the
 * `still-sees-the-row-after-the-later-delete` assertion below fails with
 * `rowCount: 0` where `1` is required — the exact wrong-visibility symptom
 * this test exists to catch.
 *
 * Deliberately does NOT use `raceUnderPause`/`src/store/dst/scheduler.ts`'s
 * pause-and-resume choreography — unlike the D-092 phantom-witness race
 * (`production-check.dst.test.ts`), this property needs no genuine mid-
 * statement suspension to construct: connection A's snapshot anchor,
 * connection B's full delete-and-commit, and connection A's own second read
 * can all be awaited fully in sequence and the exact same real ordering
 * still holds (A anchors, THEN B commits, THEN A reads again on its own
 * already-frozen snapshot) — a real concurrency race is not what makes this
 * property true or false; commit order relative to A's own anchor is.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { writeTuple, deleteTuple, listTuplesByObject } from '../../../../src/store/tuples.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
} from '../../../../src/store/dst/index.js';

const SCHEMA_SOURCE = ['namespace document {', '  relation viewer: user', '}'].join('\n');

function compiledDocumentNamespace() {
  const compiled = compileSchema(SCHEMA_SOURCE);
  if (!compiled.ok) {
    throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  const namespace = compiled.schema.namespaces.document;
  if (!namespace) throw new Error('fixture schema did not produce a document namespace');
  return namespace;
}

/**
 * The exact literal text `src/store/tuples.ts`'s `listTuplesByObject`
 * (no relation filter) issues — copied here, not imported, so this test can
 * drive it directly against a hand-held raw connection (`source.connect()`)
 * rather than through `listTuplesByObject`'s own convenience wrapper, which
 * always opens and closes its own fresh connection and so could never stay
 * anchored to one connection's own frozen snapshot across two separate
 * reads the way this test needs. Must match `shapes.ts`'s own registered
 * key exactly after `normalizeSql`'s whitespace collapse (content, not
 * indentation, is what has to agree).
 */
const LIST_BY_OBJECT_SQL = `select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at, expires_at
     from relation_tuples where object_ns = $1 and object_id = $2
     order by id`;

describe('tupleDeleteHandler delete-tombstone visibility — a REPEATABLE READ snapshot anchored before a later DELETE commits must still see the row (docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md "tombstone" observation)', () => {
  it('a-snapshot-anchored-before-a-later-delete-still-sees-the-row-on-its-own-later-read-but-a-fresh-unpinned-read-does-not', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);
    const tuple = {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    // (a) The tuple is written and committed BEFORE connection A ever opens
    // — ordinary setup, not itself part of the race under test.
    const write = await writeTuple(source, tuple);
    expect(write.ok).toBe(true);

    // (a) continued — connection A opens a REPEATABLE READ READ ONLY
    // snapshot and anchors it with its own first real query, which also
    // sanity-checks that the pre-existing row is visible at all.
    const connA = await source.connect();
    await connA.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const beforeDelete = await connA.query(LIST_BY_OBJECT_SQL, ['document', 'readme']);
    expect(beforeDelete.rowCount).toBe(1);

    // (b) Connection B deletes the SAME tuple and commits, on a completely
    // separate connection, strictly after A's snapshot anchor above (A's
    // anchor already happened at the `beforeDelete` read; nothing here can
    // retroactively move it).
    const deleted = await deleteTuple(source, tuple);
    expect(deleted).toEqual({ ok: true, token: 2, deleted: true });

    // (c) Connection A reads again, on its own already-anchored snapshot.
    // Real Postgres REPEATABLE READ: A's snapshot must NEVER observe the
    // effect of a transaction (B's DELETE) that committed after A's own
    // anchor — so A must still see the row here, even though it was
    // genuinely, really deleted moments ago on a different connection.
    const afterDelete = await connA.query(LIST_BY_OBJECT_SQL, ['document', 'readme']);
    expect(afterDelete.rowCount).toBe(1);
    expect(afterDelete.rows[0]).toMatchObject({ subject_id: 'alice' });

    await connA.query('COMMIT');

    // Control: a FRESH, unpinned read AFTER the delete genuinely does NOT
    // see the row — proving this isn't "deletes stopped working," only that
    // an earlier-anchored snapshot must not be retroactively affected by
    // one. Runs through the real, unmodified `listTuplesByObject`, the same
    // production read path every other test in this suite already trusts.
    const fresh = await listTuplesByObject(source, { objectNs: 'document', objectId: 'readme' });
    expect(fresh).toEqual([]);
  });

  it('control-a-delete-committed-BEFORE-a-snapshot-anchors-is-correctly-invisible-to-that-snapshot-from-the-start', async () => {
    // The other half of the same MVCC rule, stated as its own control: a
    // snapshot that anchors AFTER a delete already committed must NOT see
    // the row — proving the fix didn't overcorrect into "a deleted row is
    // visible to every snapshot forever."
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);
    const tuple = {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    await writeTuple(source, tuple);
    const deleted = await deleteTuple(source, tuple);
    expect(deleted).toEqual({ ok: true, token: 2, deleted: true });

    const connA = await source.connect();
    await connA.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await connA.query(LIST_BY_OBJECT_SQL, ['document', 'readme']);
    expect(result.rowCount).toBe(0);
    await connA.query('COMMIT');
  });

  it('control-re-inserting-the-identical-key-after-a-delete-is-not-blocked-by-the-now-tombstoned-row-and-is-visible-going-forward', async () => {
    // Proves the tombstone-instead-of-splice design doesn't reintroduce a
    // different bug: `tupleInsertHandler`'s own `ON CONFLICT DO NOTHING`
    // re-check must treat a tombstoned row as gone for conflict purposes,
    // exactly like real Postgres's own current-state-only conflict check
    // does against a physically-deleted row.
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);
    const tuple = {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    await writeTuple(source, tuple);
    await deleteTuple(source, tuple);
    const reinserted = await writeTuple(source, tuple);

    expect(reinserted).toEqual({ ok: true, token: 3, created: true });
    const fresh = await listTuplesByObject(source, { objectNs: 'document', objectId: 'readme' });
    expect(fresh).toHaveLength(1);
  });
});
