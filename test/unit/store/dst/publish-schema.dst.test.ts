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

/**
 * Closes a real, confirmed coverage gap found by this project's own
 * mutation-testing pass (`docs/DECISIONS.md`, the entry documenting this
 * batch): `publishSchema`'s compile-failure branch (`src/schema/publish.ts`)
 * returns `{ ok: false, errors: compiled.errors.map(formatSchemaError) }` —
 * the *actual*, per-error formatted detail, not a generic placeholder.
 * Every existing test that publishes an invalid schema (including this
 * file's own `a-compile-failure-publishes-nothing-through-the-fake-either`
 * above) only ever asserted `result.ok === false`, never inspected
 * `result.errors`'s own content — so a mutation replacing the real,
 * specific compiler diagnostic with a generic, information-losing string
 * was applied live and confirmed to evade every one of them: 793/793 fast
 * tests stayed green. A caller (the CLI's `authz schema publish`, the
 * report layer) relying on `result.errors` to tell an operator *which*
 * namespace/relation/permission actually failed to compile would silently
 * lose that detail.
 */
describe('a compile failure surfaces the real compiler diagnostic, not a generic placeholder — closes a mutation-testing gap', () => {
  it('the-returned-error-names-the-actual-undeclared-relation-the-compiler-rejected', async () => {
    const { source } = freshSource();

    const result = await publishSchema(source, INVALID_SCHEMA);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `formatSchemaError` on an `undeclared_relation_reference` error names
    // the actual offending identifier — see `src/schema/dsl/errors.ts` —
    // so this is real, specific compiler detail, not a static placeholder a
    // generic "schema compilation failed" string would also satisfy.
    expect(result.errors.some((e) => e.includes('nonexistent_relation'))).toBe(true);
  });
});

/**
 * Closes a second real, confirmed coverage gap found by this project's own
 * mutation-testing pass (`docs/DECISIONS.md`, the entry documenting this
 * batch): `publishSchema`'s catch block (`src/schema/publish.ts`) wraps its
 * own cleanup `ROLLBACK` in a nested try/catch specifically so a *second*,
 * unrelated failure from a connection that's already dead can never replace
 * the real error the transaction actually failed with — the identical
 * pattern `production-check.dst.test.ts`'s own D-106 describe block already
 * regression-tests for `productionCheck`, and `src/store/tuples.ts`'s
 * `writeTuple`/`deleteTuple` catch blocks apply too (this function's own
 * doc comment cites both). Unlike D-106, this exact path had never been
 * independently proven for `publishSchema` itself — every existing test
 * that exercises a `publishSchema` failure is the pure compile-failure path
 * above, which returns *before* `client.connect()` is ever called and never
 * touches this catch block at all. A mutation removing the nested
 * try/catch (letting the cleanup `ROLLBACK`'s own failure propagate in
 * place of the real crash) was applied live and confirmed to evade every
 * existing test: 793/793 fast tests stayed green.
 */
describe('D-106-equivalent for publishSchema — a connection that dies mid-transaction never has its own real error masked by a ROLLBACK failure — closes a mutation-testing gap', () => {
  it('the-error-publishSchema-throws-is-the-original-crash-not-a-rollback-failure-error', async () => {
    const { source } = freshSource();
    // Statement 0 is `BEGIN` (publishSchema's own first query, before
    // publishOne's advisory lock) — crashAfterStatements: 1 lets that one
    // statement succeed, then crashes the very next query publishOne
    // issues (`pg_advisory_xact_lock`), reproducing "BEGIN succeeded, the
    // publish itself then failed" — exactly inside the transaction the
    // catch block's own cleanup ROLLBACK runs against.
    source.armNextConnectionCrash(1);

    await expect(publishSchema(source, DOCUMENT_SCHEMA)).rejects.toThrow(
      /simulated crash — connection terminated mid-statement/,
    );
  });

  it('control-the-same-crash-point-would-throw-a-different-rollback-failure-message-if-the-catch-blocks-own-rollback-were-unprotected', async () => {
    // Not a test of production code — a direct proof that this file's own
    // fake connection really does behave the way the finding/fix above
    // assumes: once dead, every subsequent `.query()` (including the
    // `ROLLBACK` an unprotected catch block would have issued) throws a
    // second, different error. If this ever stopped being true, the
    // "not masked" assertion above would no longer mean anything.
    const { source } = freshSource();
    source.armNextConnectionCrash(1);
    const client = await source.connect();
    await expect(client.query('BEGIN')).resolves.toBeDefined();
    await expect(
      client.query('select pg_advisory_xact_lock(hashtext($1))', ['document']),
    ).rejects.toThrow(/simulated crash — connection terminated mid-statement/);
    await expect(client.query('ROLLBACK')).rejects.toThrow(
      /query issued on a connection that has already crashed/,
    );
  });
});
