/**
 * DST D5's own "required, always-on recognizer-coverage gate"
 * (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md` D-102) — the structural
 * backstop `docs/DST-PROPOSAL.md`'s own "Two grafts" section names as the
 * fix for this design's own sharpest self-disclosed risk: "a closed set of
 * fifteen shapes" is a fact about today's code, not a guarantee the design
 * enforces on its own, and nothing stops a future ordinary feature from
 * turning one plain shape into genuinely conditional SQL with no single
 * commit where the "trivial, closed set" premise quietly stopped being
 * true.
 *
 * This is not a test of *correctness* — every other `*.dst.test.ts` file
 * already owns that. This file's own job is narrower and more structural:
 * an explicit, readable manifest of every real production function this
 * fake's SQL-shape registry claims to model, each called for real against
 * a fresh fake, asserting none throws `lookupShape`'s own "no shape
 * registered" error — plus a count tripwire (`registeredShapeCount()`)
 * proving the registry's own size matches exactly what this manifest
 * expects, so a shape added without a matching entry here (or a manifest
 * entry whose shape silently stopped being registered) is a loud, named
 * failure, never silent drift. Directly closes the exact failure class
 * D2's own adversarial review already found once for real: `listTupleSubjects`
 * was registered correctly but nothing exercised it (`docs/DECISIONS.md`
 * D-099) — this manifest is what makes that specific class of gap
 * structurally impossible to reintroduce unnoticed, for every shape, not
 * just the one that already bit this project once.
 *
 * Five further real SQL texts this project issues are matched directly in
 * `connection.ts`, before a query ever reaches `shapes.ts`'s own registry
 * at all (the four advisory-lock statements plus the snapshot-transaction
 * `BEGIN`) — see that file's own top-of-file doc comment. They are outside
 * `registeredShapeCount()`'s own count (a different registry entirely) but
 * are still named here, each exercised by its own manifest entry below, for
 * the identical reason: every real SQL text this codebase issues belongs
 * on one list somewhere a reviewer can point to.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import {
  writeTuple,
  deleteTuple,
  listTuplesByObject,
  listTuplesBySubject,
  WRITE_LOG_LOCK_CLASSID,
  WRITE_LOG_LOCK_OBJID,
} from '../../../../src/store/tuples.js';
import { currentToken, assertTokenObserved } from '../../../../src/store/tokens.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import { publishSchema, getLatestNamespaceConfig } from '../../../../src/schema/publish.js';
import { MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID } from '../../../../src/store/migrate.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
} from '../../../../src/store/dst/index.js';
import { registeredShapeCount } from '../../../../src/store/dst/shapes.js';

const SCHEMA_SOURCE = ['namespace document {', '  relation viewer: user', '}'].join('\n');
const USERSET_SCHEMA_SOURCE = [
  'namespace document {',
  '  relation viewer: user | group#member',
  '  permission view = viewer',
  '}',
  'namespace group {',
  '  relation member: user',
  '}',
].join('\n');
const TUPLE_TO_USERSET_SCHEMA_SOURCE = [
  'namespace folder {',
  '  relation viewer: user',
  '  permission view = viewer',
  '}',
  'namespace document {',
  '  relation parent: folder',
  '  relation viewer: user',
  '  permission view = viewer | parent->view',
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

describe('the SQL-shape registry — an exact-count tripwire (D5, D-102)', () => {
  it('registeredShapeCount-matches-exactly-what-this-files-own-manifest-below-expects', () => {
    // 13 today: tuple insert/delete, the write-log insert, both
    // listTuplesByObject variants, listTuplesBySubject, the max-token
    // read, getLatestNamespaceConfig, publishOne's own next-version select
    // and insert, listTupleSubjects, fetchReachableFrontier,
    // fetchTuplesOnFrontier. If this fails, either a shape was added
    // without extending the manifest below, or one was removed without
    // shrinking it — either way, fix the mismatch, don't just update this
    // number.
    expect(registeredShapeCount()).toBe(13);
  });
});

describe('the manifest — every real production call site this fake claims to model, exercised for real (D5, D-102)', () => {
  it('writeTuple — the tuple insert, the write-log insert, and (on a schema-invalid write) latestNamespaceConfigHandler', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);

    const result = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(result.ok).toBe(true);
  });

  it('deleteTuple — the tuple delete shape', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);
    const tuple = {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };
    await writeTuple(source, tuple);

    const result = await deleteTuple(source, tuple);
    expect(result.ok).toBe(true);
  });

  it('listTuplesByObject — both the unfiltered and relation-filtered shapes', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    const unfiltered = await listTuplesByObject(source, {
      objectNs: 'document',
      objectId: 'readme',
    });
    const filtered = await listTuplesByObject(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
    });
    expect(unfiltered).toHaveLength(1);
    expect(filtered).toHaveLength(1);
  });

  it('listTuplesBySubject — the subject-indexed shape', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    const rows = await listTuplesBySubject(source, 'user', 'alice');
    expect(rows).toHaveLength(1);
  });

  it('currentToken and assertTokenObserved — the max-token shape', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);
    const write = await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(write.ok).toBe(true);
    if (!write.ok) return;

    expect(await currentToken(source)).toBe(write.token);
    await expect(assertTokenObserved(source, write.token)).resolves.toBeUndefined();
  });

  it('getLatestNamespaceConfig — the namespace-config read shape', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);

    const config = await getLatestNamespaceConfig(source, 'document');
    expect(config?.namespace).toBe('document');
  });

  it("publishSchema — publishOne's own next-version-select and namespace_configs-insert shapes (D5, D-102)", async () => {
    const state = createFakeStoreState();
    const source = createFakeConnectionSource(state);

    const result = await publishSchema(source, SCHEMA_SOURCE);
    expect(result).toEqual({ ok: true, published: [{ namespace: 'document', version: 1 }] });
  });

  it('productionCheck — a userset-subject edge, exercising fetchReachableFrontier and fetchTuplesOnFrontier', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(USERSET_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });
    await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );
    expect(result.allowed).toBe(true);
  });

  it('productionCheck via a tuple-to-userset rewrite (parent->view) — the listTupleSubjects shape', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 'folder'));
    seedNamespaceConfig(state, compileNamespace(TUPLE_TO_USERSET_SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'parent',
      subjectNs: 'folder',
      subjectId: 'docs',
    });
    await writeTuple(source, {
      objectNs: 'folder',
      objectId: 'docs',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'view',
    );
    expect(result.allowed).toBe(true);
  });

  it('the four real advisory-lock statement texts — matched directly in connection.ts, outside registeredShapeCount()', async () => {
    const state = createFakeStoreState();
    const source = createFakeConnectionSource(state);

    // WRITE_LOG_LOCK_CLASSID/OBJID — the global, transaction-scoped
    // write-log lock (tuples.ts), two-int xact form.
    const writeLogConn = await source.connect();
    await writeLogConn.query('BEGIN');
    await writeLogConn.query('select pg_advisory_xact_lock($1, $2)', [
      WRITE_LOG_LOCK_CLASSID,
      WRITE_LOG_LOCK_OBJID,
    ]);
    await writeLogConn.query('COMMIT');

    // publish.ts's own namespace-hash lock, single-bigint xact form.
    const publishConn = await source.connect();
    await publishConn.query('BEGIN');
    await publishConn.query('select pg_advisory_xact_lock(hashtext($1))', ['document']);
    await publishConn.query('COMMIT');

    // migrate.ts's own session-scoped lock, two-int form, plus its own
    // explicit unlock — the fourth and fifth real texts.
    const migrationsConn = await source.connect();
    await migrationsConn.query('select pg_advisory_lock($1, $2)', [
      MIGRATIONS_LOCK_CLASSID,
      MIGRATIONS_LOCK_OBJID,
    ]);
    const unlockResult = await migrationsConn.query<{ pg_advisory_unlock: boolean }>(
      'select pg_advisory_unlock($1, $2)',
      [MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID],
    );
    expect(unlockResult.rows[0]?.pg_advisory_unlock).toBe(true);
  });

  it("the snapshot-transaction BEGIN — resolver.ts's own REPEATABLE READ text, matched directly in connection.ts", async () => {
    // Exercised implicitly by every productionCheck call above (it always
    // opens exactly this transaction) — named here explicitly too, so this
    // manifest's own reader doesn't have to infer it from a different
    // entry's own side effect.
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(SCHEMA_SOURCE, 'document'));
    const source = createFakeConnectionSource(state);
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'viewer',
    );
    expect(result.allowed).toBe(true);
  });
});
