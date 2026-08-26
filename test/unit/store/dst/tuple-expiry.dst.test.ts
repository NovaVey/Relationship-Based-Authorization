/**
 * D-144 (expiring tuples) — the live fail-check its own scope decision
 * called for: "a DST fault simulating an expiry boundary crossing
 * mid-transaction, alongside D0-D5's existing crash/lock/snapshot race
 * classes." No Postgres, no Testcontainers — this proves the same property
 * `docs/CONSISTENCY.md`'s own "Time-based revocation" section states in
 * prose, as an executable test: real Postgres's `now()` is fixed at a
 * `REPEATABLE READ` transaction's own start, so an expiry that "crosses"
 * mid-check must be invisible to a snapshot already anchored before it —
 * exactly the same composition `docs/DECISIONS.md` D-099 already proved for
 * a concurrent *write* landing mid-check, applied here to a concurrent
 * *clock advance* instead.
 *
 * `FakeStoreState.now` (`state.ts`) is the fake's own controllable clock —
 * entirely separate from `Date.now()`, which `writeTuple`'s real
 * `validateExpiresAt` check still uses to reject an already-past
 * `expiresAt` at write time (see `EXPIRES_AT` below, a real-future instant
 * so that validation passes) — the fake clock only ever governs whether a
 * tuple's `expiresAt` has been crossed from the resolver's own point of
 * view, via `source.setNow()`.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { writeTuple } from '../../../../src/store/tuples.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
} from '../../../../src/store/dst/index.js';
import { raceUnderPause } from '../../../../src/store/dst/scheduler.js';

const SCHEMA_SOURCE = [
  'namespace document {',
  '  relation viewer: user',
  '  permission view = viewer',
  '}',
].join('\n');

function compileDocumentNamespace() {
  const compiled = compileSchema(SCHEMA_SOURCE);
  if (!compiled.ok) {
    throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  const namespace = compiled.schema.namespaces.document;
  if (!namespace) throw new Error('fixture schema did not produce a document namespace');
  return namespace;
}

// A real-future instant, so writeTuple's own validateExpiresAt (which
// compares against the REAL Date.now(), never the fake clock — see this
// file's own top-of-file doc comment) accepts it. The fake clock
// (state.now, entirely separate) is what this file actually manipulates to
// simulate the expiry boundary being crossed.
const EXPIRES_AT = new Date(Date.now() + 60_000);
const PAST_EXPIRY = new Date(EXPIRES_AT.getTime() + 1_000);

describe('a check already mid-flight when its tuple’s own expiry passes still sees it as live — the snapshot anchor composes with expiry exactly like a concurrent write (D-144)', () => {
  it('a-productioncheck-paused-after-its-own-snapshot-is-anchored-is-unaffected-by-the-fake-clock-later-crossing-the-tuples-expiresAt', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileDocumentNamespace());
    const source = createFakeConnectionSource(state);

    const writeResult = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'doc1',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
      expiresAt: EXPIRES_AT,
    });
    if (!writeResult.ok)
      throw new Error(`fixture write failed: ${JSON.stringify(writeResult.errors)}`);

    // Control: before any clock manipulation, the tuple is live and the
    // check is allowed, exactly as an un-expiring grant would be.
    const before = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'doc1' },
      'view',
    );
    expect(before.allowed).toBe(true);
    expect(before.touchedExpiringTuple).toBe(true);

    // pauseAfterStatements: 2 lands right after this check's own snapshot
    // anchor point (statement 1 is `BEGIN ISOLATION LEVEL REPEATABLE READ
    // READ ONLY`; statement 2 is the first real read — getConfig's own
    // namespace_configs lookup, which is exactly where connection.ts
    // captures both `snapshotSeq` and `snapshotNow` — see that file's own
    // doc comment) and before the check's own relation_tuples read
    // (statement 3, the one this whole test is about).
    const paused = await raceUnderPause({
      source,
      pauseAfterStatements: 2,
      heldOp: () =>
        productionCheck(
          source,
          { ns: 'user', id: 'alice' },
          { ns: 'document', id: 'doc1' },
          'view',
        ),
      concurrentOp: async () => {
        // The clock advance happens while the held check is genuinely
        // suspended, already past its own anchor point — mirroring exactly
        // how D-099's own regression tests land a concurrent *write* while
        // a check is paused, applied here to the fake clock instead.
        source.setNow(PAST_EXPIRY);
      },
    });

    // The paused check's own snapshot was anchored BEFORE the clock
    // advanced — real Postgres's now() would have been fixed at this exact
    // same point, so this check must still see the tuple as live, exactly
    // as it would still see a pre-anchor row invisible to a concurrent
    // write landing after the anchor. This is the actual property under
    // test: an expiry crossing mid-transaction is invisible to a snapshot
    // already anchored before it.
    expect(paused.allowed).toBe(true);
    expect(paused.touchedExpiringTuple).toBe(true);

    // Control, the other direction: a FRESH check, opened only after the
    // clock has already advanced past expiresAt, correctly sees the tuple
    // as expired — proving the mechanism itself really works, and that the
    // paused check's own ALLOWED result above wasn't simply because expiry
    // never actually took effect at all.
    const after = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'doc1' },
      'view',
    );
    expect(after.allowed).toBe(false);
  });
});
