/**
 * D6 (`docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own continuation of this
 * project's `D0`-`D5` DST numbering) — the staleness invariant, the
 * centerpiece of that proposal. Property, stated the way `docs/INVARIANTS.md`'s
 * existing DST properties are stated: *a check pinned to floor `T`, running
 * concurrently with a rebuild that has not yet committed a generation whose
 * watermark `>= T`, must receive `{hit:false}` from
 * `lookupRelationMembershipIndex` for the entire duration until a generation
 * meeting that floor actually commits — never a hit sourced from a stale or
 * in-flight generation.*
 *
 * The direct DST-native analogue of `relation-index-concurrent-rebuild
 * .integration.test.ts`'s own two hand-picked real-Postgres races,
 * generalized into a seeded sweep across both of `lookupRelationMembershipIndex`'s
 * own statement boundaries (the watermark-state read; the membership-row
 * read) — `raceUnderPause` (D4) arms a pause at each, races a concurrent
 * `rebuildRelationMembershipIndex` call's own `COMMIT` against the paused
 * check, and asserts the check's own final result is never sourced from that
 * concurrent generation: `indexHit` must never be `true`, and the overall
 * `allowed` outcome must still be correct (via the unmodified live CTE
 * fallback, using the identical frozen snapshot both mechanisms share).
 *
 * Every fixture below drives the REAL, unmodified `productionCheck`/
 * `rebuildRelationMembershipIndex` — never a synthetic query — with
 * `useRelationIndex: true` forced per call (never relying on
 * `env.LEOPARD_INDEX_ENABLED`, exactly like every other DST test that
 * exercises this feature).
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { writeTuple } from '../../../../src/store/tuples.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import { rebuildRelationMembershipIndex } from '../../../../src/store/relation-index.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
  type FakeConnectionSource,
} from '../../../../src/store/dst/index.js';
import { dstSeedList, raceUnderPause } from '../../../../src/store/dst/scheduler.js';

const SCHEMA_SOURCE = [
  'namespace group {',
  '  relation member: user',
  '}',
  'namespace document {',
  '  relation viewer: user | group#member',
  '}',
].join('\n');

function compileNamespace(source: string, name: string) {
  const compiled = compileSchema(source);
  if (!compiled.ok) {
    throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  const namespace = compiled.schema.namespaces[name];
  if (!namespace) throw new Error(`fixture schema did not produce a ${name} namespace`);
  return namespace;
}

function freshSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
  seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'group'));
  return { state, source: createFakeConnectionSource(state) };
}

async function expectOk(
  result: { ok: true; token: number; created: boolean } | { ok: false },
): Promise<number> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected write to succeed');
  return result.token;
}

// ---------------------------------------------------------------------------
// Real statement-sequence accounting for a pinned, index-enabled check whose
// relation branch reaches the Leopard-index short-circuit on its first (and
// only) relation-membership sub-query — traced directly against
// `resolver.ts`'s own `resolve()`/`productionCheck` control flow, the same
// "read, not guessed" discipline `token-pin-coverage.dst.test.ts`'s own
// top-of-file doc comment demands, then confirmed empirically below (a wrong
// pause point makes `raceUnderPause` itself throw its own loud, structural
// "expected the held operation to genuinely suspend... but it settled before
// that ever happened" error, which would have failed this file's own
// `npx vitest run` immediately had either constant below been wrong):
//
//   1. BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY   (never anchors)
//   2. assertTokenObservedOnSnapshot's own floor check     (anchors here)
//   3. getConfig('document')                               (schemaCache miss)
//   4. SAVEPOINT LEOPARD_LOOKUP
//   5. lookupRelationMembershipIndex's own state read (relation_membership_index_state)
//   6. lookupRelationMembershipIndex's own row read (relation_membership_index) — only
//      reached if the state read's own watermark satisfies the caller's floor
//   7. RELEASE SAVEPOINT LEOPARD_LOOKUP (on a hit or a plain miss — never an
//      exception here, so ROLLBACK TO SAVEPOINT never fires in this file;
//      that path is D8's own dedicated coverage)
//   ... [on a miss] sqlRelationMembershipWithWitness's own frontier + tuples
//       queries, then COMMIT.
//
// `pauseAfterStatements=4` therefore pauses immediately before statement 5
// (the state read); `pauseAfterStatements=5` pauses immediately before
// statement 6 (the row read).
// ---------------------------------------------------------------------------
const PAUSE_BEFORE_STATE_READ = 4;
const PAUSE_BEFORE_ROW_READ = 5;

const SEEDS = dstSeedList('relation_index_rebuild', 8);

describe('D6 — a pinned checks own Leopard-index lookup never observes a generation its own floor is not yet entitled to, at either of the lookups own two statement boundaries', () => {
  describe('paused immediately before the watermark-state read — no rebuild has committed at all yet, on this connections own frozen snapshot', () => {
    it.each(SEEDS)(
      'seed=%s: a concurrent rebuild that commits a satisfying watermark mid-pause is never observed — the check still resolves correctly via the live CTE fallback',
      async (seed) => {
        const { source } = freshSource();
        const groupId = `eng_${seed}`;
        const documentId = `doc_${seed}`;
        const userId = `alice_${seed}`;

        await expectOk(
          await writeTuple(source, {
            objectNs: 'document',
            objectId: documentId,
            relation: 'viewer',
            subjectNs: 'group',
            subjectId: groupId,
            subjectRelation: 'member',
          }),
        );
        const flip = await writeTuple(source, {
          objectNs: 'group',
          objectId: groupId,
          relation: 'member',
          subjectNs: 'user',
          subjectId: userId,
        });
        const pinnedToken = await expectOk(flip);

        // No rebuild has EVER run yet — the index's own watermark is still
        // at its never-built default (0), strictly below pinnedToken. The
        // property under test: even once a concurrent rebuild commits a
        // watermark that WOULD satisfy this floor, this already-paused,
        // already-anchored connection must never observe it.
        const result = await raceUnderPause({
          source,
          pauseAfterStatements: PAUSE_BEFORE_STATE_READ,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: userId },
              { ns: 'document', id: documentId },
              'viewer',
              { atToken: pinnedToken, useRelationIndex: true },
            ),
          concurrentOp: async () => {
            const rebuild = await rebuildRelationMembershipIndex(source);
            expect(rebuild.published).toBe(true);
            expect(rebuild.watermarkToken).toBeGreaterThanOrEqual(pinnedToken);
          },
        });

        // The index short-circuit must have missed (correctly, per D6) —
        // the final ALLOW is sourced from the unmodified live CTE fallback,
        // reading the identical frozen pre-rebuild snapshot.
        expect(result.allowed).toBe(true);
        expect(result.indexHit).not.toBe(true);
      },
    );
  });

  describe('paused immediately before the membership-row read — an EARLIER, already-satisfying generation exists, but a SECOND, concurrent rebuild lands mid-pause', () => {
    it.each(SEEDS)(
      'seed=%s: a second concurrent rebuilds TRUNCATE+republish mid-pause is never observed by the row read — the check still resolves correctly via the live CTE fallback',
      async (seed) => {
        const { source } = freshSource();
        const groupId = `eng_${seed}`;
        const documentId = `doc_${seed}`;
        const userId = `alice_${seed}`;

        await expectOk(
          await writeTuple(source, {
            objectNs: 'document',
            objectId: documentId,
            relation: 'viewer',
            subjectNs: 'group',
            subjectId: groupId,
            subjectRelation: 'member',
          }),
        );
        const flip = await writeTuple(source, {
          objectNs: 'group',
          objectId: groupId,
          relation: 'member',
          subjectNs: 'user',
          subjectId: userId,
        });
        const pinnedToken = await expectOk(flip);

        // Establish an EARLIER generation, committed well before the pinned
        // check's own connection ever opens, whose watermark already
        // satisfies pinnedToken — this is what lets the state read (stmt 5)
        // succeed, reaching the row read (stmt 6) where this test's own
        // pause fires.
        const firstRebuild = await rebuildRelationMembershipIndex(source);
        expect(firstRebuild.published).toBe(true);
        expect(firstRebuild.watermarkToken).toBeGreaterThanOrEqual(pinnedToken);

        const result = await raceUnderPause({
          source,
          pauseAfterStatements: PAUSE_BEFORE_ROW_READ,
          heldOp: () =>
            productionCheck(
              source,
              { ns: 'user', id: userId },
              { ns: 'document', id: documentId },
              'viewer',
              { atToken: pinnedToken, useRelationIndex: true },
            ),
          concurrentOp: async () => {
            // A second rebuild — its own TRUNCATE unconditionally splices
            // the shared relation_membership_index array clean before
            // republishing, at a commitSeq strictly higher than the paused
            // connection's own frozen visibleAsOf. Per this design's own
            // "The model" section, the paused connection's own row read
            // must see the table as EMPTY at that point (real Postgres's
            // documented TRUNCATE-vs-MVCC behavior), never the first
            // rebuild's still-valid row and never the second rebuild's own
            // not-yet-entitled one.
            const secondRebuild = await rebuildRelationMembershipIndex(source);
            expect(secondRebuild.published).toBe(true);
          },
        });

        expect(result.allowed).toBe(true);
        expect(result.indexHit).not.toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // The mirror-image sanity check: with NO concurrent rebuild racing at all,
  // a check pinned against an ALREADY-satisfying, already-committed
  // generation genuinely DOES hit the index — proving the two describe
  // blocks above are actually exercising a real miss-by-staleness, not a
  // miss caused by some unrelated wiring bug that would make the index
  // never hit regardless of timing (the same "a race that never actually
  // raced proves nothing" discipline `raceUnderPause`'s own doc comment
  // already names, applied here to the *positive* control instead).
  // -------------------------------------------------------------------------
  it('control: an uncontended, already-satisfying generation genuinely IS hit — the two races above are proving a real staleness miss, not a permanently-broken lookup', async () => {
    const { source } = freshSource();
    await expectOk(
      await writeTuple(source, {
        objectNs: 'document',
        objectId: 'doc_control',
        relation: 'viewer',
        subjectNs: 'group',
        subjectId: 'eng_control',
        subjectRelation: 'member',
      }),
    );
    const flip = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng_control',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice_control',
    });
    const pinnedToken = await expectOk(flip);

    const rebuild = await rebuildRelationMembershipIndex(source);
    expect(rebuild.published).toBe(true);
    expect(rebuild.watermarkToken).toBeGreaterThanOrEqual(pinnedToken);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice_control' },
      { ns: 'document', id: 'doc_control' },
      'viewer',
      { atToken: pinnedToken, useRelationIndex: true },
    );

    expect(result.allowed).toBe(true);
    expect(result.indexHit).toBe(true);
  });
});
