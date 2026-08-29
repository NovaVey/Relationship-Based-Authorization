/**
 * D8 (`docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own continuation of this
 * project's `D0`-`D5` DST numbering) — the fallback-resilience invariant, the
 * risky one. Property: *an injected mid-lookup statement failure, at any
 * point inside `lookupRelationMembershipIndex`'s own two statements, is
 * always followed by a successful, `SAVEPOINT`-recovered fallback to
 * `sqlRelationMembershipWithWitness` — never a second, uncaught error
 * cascading from the same now-poisoned connection.* This is the direct DST
 * reproduction target for the exact bug class D-163 found live (`docs/
 * DECISIONS.md` D-163, point 3): a real `lock_timeout` racing a concurrent
 * rebuild's own `TRUNCATE` poisoned the whole transaction, and the
 * `catch`-without-`SAVEPOINT` first draft let the immediately-following live
 * CTE fallback throw a *second*, uncaught error on the same poisoned
 * connection.
 *
 * `poisonAfterStatements` (`connection.ts`, `source.ts`'s
 * `armNextConnectionPoison`) is swept across both of
 * `lookupRelationMembershipIndex`'s own statement boundaries — the
 * watermark-state read and the membership-row read — driving the REAL,
 * unmodified `productionCheck` end to end, never a synthetic query, at both
 * an ALLOW and a DENY outcome, so a fix that only correctly recovers on the
 * ALLOW path (or vice versa) cannot pass silently.
 *
 * **This file's own fail-check, required before it can be trusted (per the
 * design proposal's own explicit demand) — reported in full in this task's
 * own final report, not just asserted here:** `resolve()`'s
 * `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair was temporarily removed,
 * reproducing the exact pre-D-163 shape (a bare `try { idx = await
 * lookupRelationMembershipIndex(...); } catch { idx = { hit: false }; }`,
 * with no `SAVEPOINT` statements at all), and every test below was confirmed
 * to fail — a second, uncaught "current transaction is aborted" error
 * propagating straight out of `productionCheck` — at every one of the four
 * cases (both boundaries × both outcomes), before the fix was restored and
 * every test confirmed green again, with `git diff` showing zero remaining
 * changes to `resolver.ts`.
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

// See relation-index-rebuild.dst.test.ts's own top-of-file doc comment for
// the full statement-by-statement derivation of these two constants — the
// identical pinned, index-enabled statement sequence both files drive.
const POISON_AT_STATE_READ = 4;
const POISON_AT_ROW_READ = 5;

describe('D8 — an injected mid-lookup statement failure is always followed by a successful SAVEPOINT-recovered fallback, never a second uncaught error', () => {
  describe('poisoned at the watermark-state read (the very first statement lookupRelationMembershipIndex issues — no prior rebuild needed)', () => {
    it('ALLOW case: the check still resolves allowed, via the live CTE fallback, with zero uncaught throws', async () => {
      const { source } = freshSource();
      await expectOk(
        await writeTuple(source, {
          objectNs: 'document',
          objectId: 'doc1',
          relation: 'viewer',
          subjectNs: 'group',
          subjectId: 'eng',
          subjectRelation: 'member',
        }),
      );
      const flip = await writeTuple(source, {
        objectNs: 'group',
        objectId: 'eng',
        relation: 'member',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      const pinnedToken = await expectOk(flip);

      source.armNextConnectionPoison(POISON_AT_STATE_READ);
      const result = await productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'doc1' },
        'viewer',
        { atToken: pinnedToken, useRelationIndex: true },
      );

      expect(result.allowed).toBe(true);
      // Never sourced from the index — this was a poison-induced miss, not
      // a genuine hit.
      expect(result.indexHit).toBeUndefined();
    });

    it('DENY case: the check still resolves denied (exhaustively, not a mere truncation), via the live CTE fallback, with zero uncaught throws', async () => {
      const { source } = freshSource();
      // The document->group edge exists, but nobody is ever granted
      // group:eng#member — a real, exhaustively-provable DENY, not a
      // depth/cycle truncation.
      const structuralWrite = await writeTuple(source, {
        objectNs: 'document',
        objectId: 'doc1',
        relation: 'viewer',
        subjectNs: 'group',
        subjectId: 'eng',
        subjectRelation: 'member',
      });
      const pinnedToken = await expectOk(structuralWrite);

      source.armNextConnectionPoison(POISON_AT_STATE_READ);
      const result = await productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'doc1' },
        'viewer',
        { atToken: pinnedToken, useRelationIndex: true },
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('unreachable');
      expect(result.certain).toBe(true);
      expect(result.indexHit).toBeUndefined();
    });
  });

  describe('poisoned at the membership-row read (an earlier, already-satisfying rebuild exists, so the state read succeeds first)', () => {
    it('ALLOW case: the check still resolves allowed, via the live CTE fallback, with zero uncaught throws', async () => {
      const { source } = freshSource();
      await expectOk(
        await writeTuple(source, {
          objectNs: 'document',
          objectId: 'doc1',
          relation: 'viewer',
          subjectNs: 'group',
          subjectId: 'eng',
          subjectRelation: 'member',
        }),
      );
      const flip = await writeTuple(source, {
        objectNs: 'group',
        objectId: 'eng',
        relation: 'member',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      const pinnedToken = await expectOk(flip);

      const rebuild = await rebuildRelationMembershipIndex(source);
      expect(rebuild.published).toBe(true);
      expect(rebuild.watermarkToken).toBeGreaterThanOrEqual(pinnedToken);

      source.armNextConnectionPoison(POISON_AT_ROW_READ);
      const result = await productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'doc1' },
        'viewer',
        { atToken: pinnedToken, useRelationIndex: true },
      );

      expect(result.allowed).toBe(true);
      expect(result.indexHit).toBeUndefined();
    });

    it('DENY case: the check still resolves denied (exhaustively, not a mere truncation), via the live CTE fallback, with zero uncaught throws', async () => {
      const { source } = freshSource();
      const structuralWrite = await writeTuple(source, {
        objectNs: 'document',
        objectId: 'doc1',
        relation: 'viewer',
        subjectNs: 'group',
        subjectId: 'eng',
        subjectRelation: 'member',
      });
      const pinnedToken = await expectOk(structuralWrite);

      const rebuild = await rebuildRelationMembershipIndex(source);
      expect(rebuild.published).toBe(true);
      expect(rebuild.watermarkToken).toBeGreaterThanOrEqual(pinnedToken);

      source.armNextConnectionPoison(POISON_AT_ROW_READ);
      const result = await productionCheck(
        source,
        { ns: 'user', id: 'alice' },
        { ns: 'document', id: 'doc1' },
        'viewer',
        { atToken: pinnedToken, useRelationIndex: true },
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('unreachable');
      expect(result.certain).toBe(true);
      expect(result.indexHit).toBeUndefined();
    });
  });
});
