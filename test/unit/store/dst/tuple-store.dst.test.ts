/**
 * DST D0's own exit criterion (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md`
 * D-097): prove the storage seam is genuinely wireable — the real,
 * unmodified `writeTuple`/`deleteTuple` (`src/store/tuples.ts`) running
 * against an in-memory fake instead of real Postgres — and that one real
 * fault class (partial writes, mid-transaction crash injection) is
 * catchable through it. No Postgres, no Testcontainers, no Docker: this
 * whole file runs against pure JS state, the entire point of simulating at
 * the storage seam rather than inside Postgres itself (`docs/DECISIONS.md`
 * D-095).
 *
 * Deliberately narrow in scope, matching D0's own stated boundary: no
 * advisory-lock contention, no snapshot transactions, no recursive-CTE
 * frontier — those are D1/D2/D3's own jobs. This file only has to prove
 * `writeTuple`/`deleteTuple` genuinely work end to end through the fake,
 * and that the one fault class D0 targets is real and catchable.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import {
  writeTuple,
  deleteTuple,
  listTuplesByObject,
  listTuplesBySubject,
} from '../../../../src/store/tuples.js';
import { currentToken, assertTokenObserved } from '../../../../src/store/tokens.js';
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

describe('DST D0 — the storage seam is genuinely wireable: real writeTuple/deleteTuple against an in-memory fake, no Postgres', () => {
  it('a-real-writeTuple-call-against-the-fake-succeeds-end-to-end-and-a-real-read-back-sees-it', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    expect(result).toEqual({ ok: true, token: 1, created: true });
    expect(state.relationTuples).toHaveLength(1);
    expect(state.writeLog).toHaveLength(1);
    expect(await currentToken(source)).toBe(1);
    // assertTokenObserved must not throw for a token this same fake has
    // genuinely observed — the real consistency-token contract
    // (docs/CONSISTENCY.md), exercised through the fake exactly as it
    // would be against real Postgres.
    await expect(assertTokenObserved(source, 1)).resolves.toBeUndefined();
  });

  it('writing-the-identical-tuple-twice-is-idempotent-through-the-fake-one-row-but-a-fresh-token-each-time', async () => {
    // Mirrors writeTuple's own documented contract exactly (tuples.ts's own
    // doc comment: "Idempotent: writing an already-existing tuple doesn't
    // create a second row ... but still advances the consistency token").
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

    const first = await writeTuple(source, tuple);
    const second = await writeTuple(source, tuple);

    expect(first).toEqual({ ok: true, token: 1, created: true });
    expect(second).toEqual({ ok: true, token: 2, created: false });
    expect(state.relationTuples).toHaveLength(1);
    expect(state.writeLog).toHaveLength(2);
  });

  it('a-real-deleteTuple-call-against-the-fake-removes-the-row-and-is-idempotent-on-a-second-call', async () => {
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
    const deletedAgain = await deleteTuple(source, tuple);

    expect(deleted).toEqual({ ok: true, token: 2, deleted: true });
    expect(deletedAgain).toEqual({ ok: true, token: 3, deleted: false });
    expect(state.relationTuples).toHaveLength(0);
  });

  /**
   * D0's own flagship exit-criterion test — full reasoning in
   * `docs/DECISIONS.md` D-097. `writeTuple`'s real, unmodified statement
   * sequence inside its transaction is `BEGIN → acquireWriteLogLock →
   * INSERT relation_tuples → INSERT write_log RETURNING token → COMMIT`
   * (`src/store/tuples.ts`). Arming a crash after 3 successful statements
   * lets `BEGIN`, the lock acquire, and the tuple insert all genuinely
   * succeed on the fake connection's own buffer — then the 4th call (the
   * write-log insert) throws, simulating the connection dying at exactly
   * that point, before `COMMIT` ever runs.
   */
  it('a-crash-injected-between-the-tuple-insert-and-the-write-log-insert-leaves-neither-row-behind-and-a-real-uncrashed-retry-still-succeeds', async () => {
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

    // BEGIN (1), acquireWriteLogLock (2), INSERT relation_tuples (3) all
    // succeed; the 4th call — INSERT write_log RETURNING token — crashes.
    source.armNextConnectionCrash(3);
    await expect(writeTuple(source, tuple)).rejects.toThrow();

    // Atomicity: the tuple insert's own effect never lands, even though it
    // genuinely ran on the now-dead connection's own buffer — the whole
    // transaction never committed, so nothing from it is visible.
    expect(state.relationTuples).toHaveLength(0);
    expect(state.writeLog).toHaveLength(0);
    expect(await currentToken(source)).toBeNull();

    // A real, uncrashed retry on a fresh connection succeeds normally —
    // and gets token 1, not 2: the crashed attempt's write-log insert
    // never ran at all (the crash fired before that 4th statement), so no
    // token was burned by the failed attempt. See docs/DECISIONS.md D-097
    // for why a crash that *does* reach the write-log insert would burn a
    // token even on failure, matching real Postgres identity-column gaps.
    const result = await writeTuple(source, tuple);
    expect(result).toEqual({ ok: true, token: 1, created: true });
    expect(state.relationTuples).toHaveLength(1);
    expect(state.writeLog).toHaveLength(1);
  });

  /**
   * Control for the test above: proves the crash mechanism is real and has
   * power, rather than every write simply always succeeding regardless of
   * `armNextConnectionCrash`. Crashing after 0 statements means even
   * `BEGIN` itself never completes.
   */
  it('control-crashing-before-the-first-statement-even-runs-still-leaves-a-clean-empty-state', async () => {
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

    source.armNextConnectionCrash(0);
    await expect(writeTuple(source, tuple)).rejects.toThrow();

    expect(state.relationTuples).toHaveLength(0);
    expect(state.writeLog).toHaveLength(0);
  });

  /**
   * Control proving `armNextConnectionCrash` really is one-shot, per its
   * own doc comment (`src/store/dst/source.ts`) — a second, real write on
   * the same source after a crashed one must not itself crash.
   */
  it('control-a-crash-armed-for-one-connection-does-not-carry-over-to-the-next-one', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);

    source.armNextConnectionCrash(1);
    await expect(
      writeTuple(source, {
        objectNs: 'document',
        objectId: 'readme',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      }),
    ).rejects.toThrow();

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'bob',
    });
    expect(result.ok).toBe(true);
  });

  it('listTuplesByObject-and-listTuplesBySubject-both-see-a-real-write-through-the-fake', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    const byObject = await listTuplesByObject(source, { objectNs: 'document', objectId: 'readme' });
    const byObjectFiltered = await listTuplesByObject(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
    });
    const bySubject = await listTuplesBySubject(source, 'user', 'alice');

    for (const rows of [byObject, byObjectFiltered, bySubject]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        objectNs: 'document',
        objectId: 'readme',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      // id came back through the fake's own bigint-as-string path and was
      // coerced by rowToTuple's real Number(...) call, the same call site
      // src/store/tuples.ts's own doc comment cites as the reason this
      // matters — a plain `number` here would mean that coercion never ran.
      expect(typeof rows[0]?.id).toBe('number');
    }

    // Control: an object/subject with no writes against it sees nothing.
    expect(await listTuplesByObject(source, { objectNs: 'document', objectId: 'other' })).toEqual(
      [],
    );
    expect(await listTuplesBySubject(source, 'user', 'bob')).toEqual([]);
  });

  it('a-write-against-an-undeclared-relation-is-rejected-by-the-real-schema-validation-even-through-the-fake', async () => {
    // Proves the fake's getLatestNamespaceConfig-shaped read really is
    // wired in — writeTuple's own schema validation runs before it ever
    // opens a transaction at all, so this must reject without needing any
    // crash-injection machinery to matter.
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compiledDocumentNamespace());
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'editor', // never declared in SCHEMA_SOURCE
      subjectNs: 'user',
      subjectId: 'alice',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('undeclared_relation');
    expect(state.relationTuples).toHaveLength(0);
    expect(state.writeLog).toHaveLength(0);
  });
});
