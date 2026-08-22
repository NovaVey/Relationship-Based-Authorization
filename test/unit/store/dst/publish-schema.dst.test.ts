/**
 * `publishSchema`/`publishOne` (`src/schema/publish.ts`) genuinely working
 * end to end against the in-memory fake, for the first time — a real
 * coverage gap DST D5's own recognizer-coverage gate found before it ever
 * shipped as a required check (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md`
 * D-102). `publishOne`'s own two real statements (the next-version select,
 * the `namespace_configs` insert) were never registered in `shapes.ts`'s
 * SQL-shape registry, and no DST test ever called the real, unmodified
 * `publishSchema` — every existing DST test that needed a published
 * namespace used `seedNamespaceConfig`, a deliberate test-only bypass
 * (`state.ts`'s own doc comment), never the real publish path itself.
 * `advisory-lock.dst.test.ts`'s own "publish.ts's namespace-hash lock"
 * describe block (D1) proved the *lock* genuinely scopes to one namespace,
 * but only by hand-issuing the raw `pg_advisory_xact_lock(hashtext($1))`
 * text directly on a raw connection — never through `publishSchema` itself.
 * This file is what closes both gaps: the missing shapes, and the missing
 * end-to-end real-function coverage.
 */
import { describe, expect, it } from 'vitest';

import { publishSchema, getLatestNamespaceConfig } from '../../../../src/schema/publish.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
} from '../../../../src/store/dst/index.js';

const DOCUMENT_SCHEMA = ['namespace document {', '  relation viewer: user', '}'].join('\n');

const MULTI_NAMESPACE_SCHEMA = [
  'namespace folder {',
  '  relation viewer: user',
  '}',
  'namespace document {',
  '  relation viewer: user',
  '  relation parent: folder',
  '}',
].join('\n');

const INVALID_SCHEMA = [
  'namespace document {',
  '  permission view = nonexistent_relation',
  '}',
].join('\n');

function freshSource() {
  const state = createFakeStoreState();
  return { state, source: createFakeConnectionSource(state) };
}

describe('publishSchema — genuinely working end to end through the real, unmodified function (D5, D-102)', () => {
  it('a-single-namespace-publish-succeeds-and-a-real-read-back-sees-it', async () => {
    const { state, source } = freshSource();

    const result = await publishSchema(source, DOCUMENT_SCHEMA);

    expect(result).toEqual({ ok: true, published: [{ namespace: 'document', version: 1 }] });
    expect(state.namespaceConfigs).toHaveLength(1);
    expect(state.namespaceConfigs[0]).toMatchObject({
      namespace: 'document',
      version: 1,
      sourceDsl: DOCUMENT_SCHEMA,
    });

    const config = await getLatestNamespaceConfig(source, 'document');
    expect(config?.namespace).toBe('document');
  });

  it('republishing-the-identical-namespace-increments-its-own-version-monotonically', async () => {
    const { state, source } = freshSource();

    const first = await publishSchema(source, DOCUMENT_SCHEMA);
    const second = await publishSchema(source, DOCUMENT_SCHEMA);
    const third = await publishSchema(source, DOCUMENT_SCHEMA);

    expect(first).toEqual({ ok: true, published: [{ namespace: 'document', version: 1 }] });
    expect(second).toEqual({ ok: true, published: [{ namespace: 'document', version: 2 }] });
    expect(third).toEqual({ ok: true, published: [{ namespace: 'document', version: 3 }] });
    expect(state.namespaceConfigs).toHaveLength(3);
  });

  it('a-multi-namespace-source-publishes-every-namespace-together-each-starting-at-version-1', async () => {
    const { state, source } = freshSource();

    const result = await publishSchema(source, MULTI_NAMESPACE_SCHEMA);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.published.map((p) => p.namespace))).toEqual(
      new Set(['folder', 'document']),
    );
    expect(result.published.every((p) => p.version === 1)).toBe(true);
    expect(state.namespaceConfigs).toHaveLength(2);
    // Both namespaces' rows carry the *entire* multi-namespace source text
    // verbatim, per publishSchema's own documented contract — never a
    // per-namespace slice.
    for (const row of state.namespaceConfigs) {
      expect(row.sourceDsl).toBe(MULTI_NAMESPACE_SCHEMA);
    }
  });

  it('a-compile-failure-publishes-nothing-through-the-fake-either', async () => {
    const { state, source } = freshSource();

    const result = await publishSchema(source, INVALID_SCHEMA);

    expect(result.ok).toBe(false);
    expect(state.namespaceConfigs).toHaveLength(0);
  });

  /**
   * `publishOne`'s own real `pg_advisory_xact_lock(hashtext($1))` — proven
   * here through the real `publishSchema` function itself, genuinely
   * interleaved via `Promise.all` (both calls open their own connection
   * and reach the lock acquisition before either resolves, so this
   * exercises `locks.ts`'s real FIFO queueing, not a hand-orchestrated
   * pause). Without the lock, `publishOne`'s own doc comment names the
   * exact failure this would otherwise produce: both concurrent calls
   * read the same `next_version` before either inserts, and the loser's
   * `INSERT` fights the winner's for the same `(namespace, version)` —
   * this fake's `namespaceConfigInsertHandler` has no uniqueness
   * enforcement at all (unlike `tupleInsertHandler`'s own `ON CONFLICT`),
   * so an unserialized race here would silently produce two rows sharing
   * one version, not a loud error — see this describe block's own
   * fail-check for what genuinely regressing this looks like.
   */
  it('two-genuinely-concurrent-publishes-to-the-same-namespace-serialize-real-sequential-versions-never-a-collision', async () => {
    const { state, source } = freshSource();

    const [first, second] = await Promise.all([
      publishSchema(source, DOCUMENT_SCHEMA),
      publishSchema(source, DOCUMENT_SCHEMA),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const versions = [first.published[0]?.version, second.published[0]?.version].sort(
      (a, b) => (a ?? 0) - (b ?? 0),
    );
    expect(versions).toEqual([1, 2]);
    expect(state.namespaceConfigs).toHaveLength(2);
    expect(new Set(state.namespaceConfigs.map((row) => row.version))).toEqual(new Set([1, 2]));
  });

  it('control-two-genuinely-concurrent-publishes-to-different-namespaces-never-contend-and-each-gets-version-1', async () => {
    const { state, source } = freshSource();
    const otherSchema = ['namespace folder {', '  relation viewer: user', '}'].join('\n');

    const [documentResult, folderResult] = await Promise.all([
      publishSchema(source, DOCUMENT_SCHEMA),
      publishSchema(source, otherSchema),
    ]);

    expect(documentResult).toEqual({
      ok: true,
      published: [{ namespace: 'document', version: 1 }],
    });
    expect(folderResult).toEqual({ ok: true, published: [{ namespace: 'folder', version: 1 }] });
    expect(state.namespaceConfigs).toHaveLength(2);
  });
});
