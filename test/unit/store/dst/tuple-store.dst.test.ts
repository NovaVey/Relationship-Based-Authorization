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
 *
 * D0's own flagship crash test below hand-picks exactly one crash point;
 * DST D4 (`docs/DECISIONS.md` D-101) adds the seeded sweep across every
 * real crash point `docs/DST-PROPOSAL.md`'s own "Partial writes" design
 * section always called for — see that describe block's own doc comment.
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
import { dstRngFromSeed, dstSeedList } from '../../../../src/store/dst/scheduler.js';

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
    // existingExpiresAt: null — full-repo audit finding #11 (2026-08-29):
    // present on every created:false result, null here since this tuple
    // was never written with an expiresAt.
    expect(second).toEqual({ ok: true, token: 2, created: false, existingExpiresAt: null });
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

  /**
   * DST D4's own generalization of this file's flagship crash test above
   * (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md` D-101) — that test and its
   * two controls together exercise crash points 3, 0, and 1, each hand-
   * picked, with no seed variation at all. This sweeps every real
   * pre-COMMIT crash point `writeTuple`'s own statement sequence has —
   * `BEGIN`(1) → acquire the write-log lock(2) → insert
   * `relation_tuples`(3) → insert `write_log`(4) → `COMMIT`(5), so
   * `crashAfterStatements` 0 through 4 are the exhaustive, meaningful
   * range — crossed with `CRASH_SWEEP_SEEDS`, directly matching
   * `docs/DST-PROPOSAL.md`'s own "Partial writes" design section: "Swept
   * across every possible crash point, across many seeds." (An earlier
   * draft of this sweep varied only the object/subject identifiers per
   * crash point from a seed *derived from the crash point itself* — no
   * real seed dimension at all, since the identifiers can't change which
   * code path runs; an adversarial review caught this. `CRASH_SWEEP_SEEDS`
   * below is independent of `crashPoint`, so each of the 5 points is now
   * genuinely exercised against 3 different identifier fixtures.)
   *
   * Also asserts the specific token/id *burn* pattern at each point, not
   * just "atomicity holds" — `state.ts`'s own documented identity-column-
   * gap behavior (counters advance at statement-execution time, never
   * deferred to commit) means a crash at point 3 or later has already
   * allocated a `relation_tuples` id before dying, and a crash at point 4
   * has additionally already allocated a `write_log` token — both burned,
   * gapped, and never reused, exactly like a real crashed Postgres
   * transaction. Points 0-2 crash before either counter is ever touched.
   * Without this, the sweep would pass unchanged even if a regression
   * wrongly deferred counter allocation to commit time.
   */
  // DST D5 (docs/DECISIONS.md D-102) — 3 by default, on every PR; the
  // identical logic below sweeps far more when DST_SEED_COUNT is set (the
  // nightly job's own concern), no separate code path needed.
  const CRASH_SWEEP_SEEDS = dstSeedList('crash_sweep_seed', 3);

  it.each(
    [0, 1, 2, 3, 4].flatMap((crashPoint) =>
      CRASH_SWEEP_SEEDS.map((seed) => ({ crashPoint, seed })),
    ),
  )(
    'crashAfterStatements=$crashPoint seed=$seed: atomicity and the exact identity-burn pattern hold at every real pre-COMMIT crash point, across seeds',
    async ({ crashPoint, seed }) => {
      const rng = dstRngFromSeed(seed);
      const objectId = `doc_${crashPoint}_${seed}_${rng.nextIntBetween(0, 1_000_000)}`;
      const subjectId = `user_${crashPoint}_${seed}_${rng.nextIntBetween(0, 1_000_000)}`;

      const state = createFakeStoreState();
      seedNamespaceConfig(state, compiledDocumentNamespace());
      const source = createFakeConnectionSource(state);
      const tuple = {
        objectNs: 'document',
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId,
      };

      source.armNextConnectionCrash(crashPoint);
      await expect(writeTuple(source, tuple)).rejects.toThrow();

      // The actual invariant under test, at every crash point: nothing
      // from the crashed transaction's own uncommitted buffer is visible,
      // regardless of how many of its statements genuinely ran on the now-
      // dead connection before the crash discarded them.
      expect(state.relationTuples).toHaveLength(0);
      expect(state.writeLog).toHaveLength(0);

      // A real, uncrashed retry on a fresh connection still succeeds
      // normally at every crash point — the crash never left the fake
      // itself in a state that blocks further real writes.
      const retry = await writeTuple(source, tuple);
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(state.relationTuples).toHaveLength(1);
      expect(state.writeLog).toHaveLength(1);

      // The exact burn pattern — see this describe block's own doc
      // comment above for why each threshold is where it is.
      expect(retry.token).toBe(crashPoint >= 4 ? 2 : 1);
      expect(state.relationTuples[0]?.id).toBe(crashPoint >= 3 ? '2' : '1');
    },
  );

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

describe("a tuple-to-userset subject is also validated against the SUBJECT namespace's own published config — full-repo audit finding #2, DB-free counterpart of the real-Postgres suite", () => {
  // D-012's own "soft" cross-namespace check means `group` compiled and
  // published entirely separately from `document` (two independent
  // compileSchema calls below, never joined) can be referenced from
  // `document`'s own subjectTypes with nothing rejecting it at compile
  // time — exactly the multi-file authoring workflow this repo's own
  // schema/document.authz already uses for real.
  function compiledNamespace(source: string, name: string) {
    const compiled = compileSchema(source);
    if (!compiled.ok) {
      throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
    }
    const namespace = compiled.schema.namespaces[name];
    if (!namespace) throw new Error(`fixture schema did not produce a ${name} namespace`);
    return namespace;
  }

  function documentWithGroupEditor() {
    return compiledNamespace(
      [
        'namespace document {',
        '  relation editor: user | group#member | group#admin_permission | group#totally_undeclared',
        '}',
      ].join('\n'),
      'document',
    );
  }

  function groupWithMemberAndPermission() {
    return compiledNamespace(
      [
        'namespace group {',
        '  relation member: user',
        '  permission admin_permission = member',
        '}',
      ].join('\n'),
      'group',
    );
  }

  it('subjectRelation-naming-a-real-relation-on-the-published-subject-namespace-succeeds', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, documentWithGroupEditor());
    seedNamespaceConfig(state, groupWithMemberAndPermission());
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'editor',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });

    expect(result).toEqual({ ok: true, token: 1, created: true });
  });

  it('subjectRelation-naming-a-PERMISSION-on-the-published-subject-namespace-is-rejected', async () => {
    // The exact gap the audit found: production's SQL-only membership walk
    // has no notion of permissions and would silently dead-end on this
    // tuple, false-denying access the reference resolver would grant.
    const state = createFakeStoreState();
    seedNamespaceConfig(state, documentWithGroupEditor());
    seedNamespaceConfig(state, groupWithMemberAndPermission());
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'editor',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'admin_permission',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('subject_relation_is_a_permission');
    expect(state.relationTuples).toHaveLength(0);
  });

  it('subjectRelation-naming-nothing-at-all-on-the-published-subject-namespace-is-rejected', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, documentWithGroupEditor());
    seedNamespaceConfig(state, groupWithMemberAndPermission());
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'editor',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'totally_undeclared',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('undeclared_subject_relation');
  });

  it('subjectRelation-pointing-at-a-subject-namespace-with-NO-seeded-config-at-all-is-not-rejected-by-this-check', async () => {
    // `group` is deliberately never seeded here — publish order must stay
    // unconstrained (see validateAgainstSchema's own doc comment): a
    // `document` schema referencing a not-yet-published `group` must keep
    // working exactly as it always did.
    const state = createFakeStoreState();
    seedNamespaceConfig(state, documentWithGroupEditor());
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'editor',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });

    expect(result).toEqual({ ok: true, token: 1, created: true });
  });
});
