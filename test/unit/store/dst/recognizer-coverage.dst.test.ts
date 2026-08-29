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
  rebuildRelationMembershipIndex,
  lookupRelationMembershipIndex,
  RELATION_INDEX_REFRESH_LOCK_CLASSID,
  RELATION_INDEX_REFRESH_LOCK_OBJID,
} from '../../../../src/store/relation-index.js';
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
/** Genuinely nested (`group#member` accepted as its own member's subject type) — needed for a converging-paths (PK-collision) fixture the flat `USERSET_SCHEMA_SOURCE` above cannot express. */
const NESTED_GROUP_SCHEMA_SOURCE = [
  'namespace document {',
  '  relation viewer: user | group#member',
  '}',
  'namespace group {',
  '  relation member: user | group#member',
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
    // 21 today: the original 14 (tuple insert/delete, the write-log insert,
    // both listTuplesByObject variants, listTuplesBySubject, the max-token
    // read, getLatestNamespaceConfig, publishOne's own next-version select
    // and insert, listTupleSubjects, fetchReachableFrontier,
    // fetchTuplesOnFrontier, and (full-repo audit finding #11, 2026-08-29)
    // writeTuple's own follow-up existing-expires-at select, run only on
    // its created:false conflict path) plus 7 new ones from
    // `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "New shape handlers"
    // section: `rebuildRelationMembershipIndex`'s own watermark read, its
    // `truncate`, its batched `WITH RECURSIVE ... INSERT`, its inert
    // `rebuild_started_at` no-op update, its real `watermark_token` publish
    // update, and `lookupRelationMembershipIndex`'s own two selects (the
    // state read, the row read) — **7, not the proposal's own stated "six":
    // its "New shape handlers" section literally enumerates 6 numbered
    // items, but item 6 ("lookupRelationMembershipIndex's own two SELECTs")
    // bundles two textually-distinct queries under one bullet, so the real
    // count of new `SHAPES` map entries (one per distinct literal SQL text,
    // which is what `registeredShapeCount()` actually measures) is 7. This
    // was a genuine off-by-one in the design document's own count, found
    // while implementing it and disclosed here rather than silently
    // adjusted.** If this fails, either a shape was added without extending
    // the manifest below, or one was removed without shrinking it — either
    // way, fix the mismatch, don't just update this number.
    expect(registeredShapeCount()).toBe(21);
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

  it('writeTuple — the existing-expires-at follow-up select, on the created:false conflict path (full-repo audit finding #11, 2026-08-29)', async () => {
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

    // The identical tuple again — `created: false`, exercising the new
    // follow-up select this manifest entry exists to prove is wired up.
    const result = await writeTuple(source, tuple);
    expect(result).toEqual({
      ok: true,
      token: expect.any(Number),
      created: false,
      existingExpiresAt: null,
    });
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

  // ---------------------------------------------------------------------------
  // `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "New shape handlers" — the
  // 7 new registry entries (see this file's own count-tripwire comment above
  // for why 7, not the proposal's own stated "six"), each exercised through
  // its real production caller (`rebuildRelationMembershipIndex`/
  // `lookupRelationMembershipIndex`), never a synthetic query, per the
  // design's own explicit instruction.
  // ---------------------------------------------------------------------------

  it('rebuildRelationMembershipIndex — the watermark read, the inert rebuild_started_at update, truncate, the batched WITH RECURSIVE INSERT, and the real watermark_token publish update (5 of the 7 new shapes)', async () => {
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
    const flip = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(flip.ok).toBe(true);
    if (!flip.ok) return;

    const result = await rebuildRelationMembershipIndex(source);
    // 2, not 1 — `group:eng#member` is itself a distinct root too (the
    // "roots" CTE is `select distinct object_ns, object_id, relation from
    // relation_tuples`, and `group:eng#member` is the *object* half of the
    // second tuple written above), producing its own trivial, hop-0 index
    // row (`group:eng#member -> user:alice`, via_path length 1) in addition
    // to the transitive one reached from `document:readme#viewer` (via_path
    // length 2) — real Postgres's own batched INSERT produces the identical
    // two rows for the identical reason.
    expect(result).toEqual({
      watermarkToken: flip.token,
      rowCount: 2,
      published: true,
      lockAcquired: true,
    });
  });

  it('lookupRelationMembershipIndex — both new selects, the state read and the row read (the remaining 2 of the 7 new shapes)', async () => {
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
    const flip = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(flip.ok).toBe(true);
    if (!flip.ok) return;
    const rebuild = await rebuildRelationMembershipIndex(source);
    expect(rebuild.published).toBe(true);

    // A plain connection, exactly like `lookupRelationMembershipIndex`'s own
    // real contract ("takes `client`... never a second pool connection") —
    // no transaction wrapper is needed for this direct-call manifest entry.
    const conn = await source.connect();
    const result = await lookupRelationMembershipIndex(
      conn,
      { ns: 'document', id: 'readme' },
      'viewer',
      { ns: 'user', id: 'alice' },
      5,
      flip.token,
    );
    expect(result).toEqual({
      hit: true,
      allowed: true,
      certain: true,
      path: ['document:readme#viewer', 'group:eng#member'],
      touchedExpiringTuple: false,
    });
  });

  it('rebuildRelationMembershipIndex — the batched INSERTs own dedup tie-break keeps the SHORTEST converging path, not merely a path (a PK-collision, two independent routes to the identical subject)', async () => {
    const state = createFakeStoreState();
    seedNamespaceConfig(state, compileNamespace(NESTED_GROUP_SCHEMA_SOURCE, 'document'));
    seedNamespaceConfig(state, compileNamespace(NESTED_GROUP_SCHEMA_SOURCE, 'group'));
    const source = createFakeConnectionSource(state);

    // Route 1 (short, 1 hop): document:doc1#viewer -> group:short#member -> user:alice.
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'doc1',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'short',
      subjectRelation: 'member',
    });
    await writeTuple(source, {
      objectNs: 'group',
      objectId: 'short',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    // Route 2 (long, 2 hops): document:doc1#viewer -> group:long#member ->
    // group:mid#member -> user:alice — the SAME final (object, subject) pair
    // as route 1, reached via a strictly longer, independent path.
    await writeTuple(source, {
      objectNs: 'document',
      objectId: 'doc1',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'long',
      subjectRelation: 'member',
    });
    await writeTuple(source, {
      objectNs: 'group',
      objectId: 'long',
      relation: 'member',
      subjectNs: 'group',
      subjectId: 'mid',
      subjectRelation: 'member',
    });
    const flip = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'mid',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(flip.ok).toBe(true);
    if (!flip.ok) return;

    const rebuild = await rebuildRelationMembershipIndex(source);
    expect(rebuild.published).toBe(true);

    const conn = await source.connect();
    const result = await lookupRelationMembershipIndex(
      conn,
      { ns: 'document', id: 'doc1' },
      'viewer',
      { ns: 'user', id: 'alice' },
      10,
      flip.token,
    );
    // The SHORT route (2 nodes, 1 hop) must win — never the long one (3
    // nodes, 2 hops), even though both are real, independently-discovered
    // routes to the identical (object, subject) pair.
    expect(result).toMatchObject({
      hit: true,
      path: ['document:doc1#viewer', 'group:short#member'],
    });
  });

  it("the pg_try_advisory_xact_lock text — relation-index.ts's own non-blocking advisory lock, matched directly in connection.ts (D7)", async () => {
    // Also implicitly exercised by rebuildRelationMembershipIndex itself
    // (its own very first statement after BEGIN) — named here explicitly
    // too, showing both outcomes directly, matching this file's own
    // established precedent for "the four real advisory-lock statement
    // texts" above. The full non-blocking-lock property (of two concurrent
    // attempts, exactly one acquires and the other reports false
    // immediately, never blocking) is D7's own dedicated coverage —
    // `advisory-lock.dst.test.ts`.
    const state = createFakeStoreState();
    const source = createFakeConnectionSource(state);

    const holder = await source.connect();
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const first = await holder.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock($1, $2) as locked',
      [RELATION_INDEX_REFRESH_LOCK_CLASSID, RELATION_INDEX_REFRESH_LOCK_OBJID],
    );
    expect(first.rows[0]?.locked).toBe(true);

    const contender = await source.connect();
    await contender.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const second = await contender.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock($1, $2) as locked',
      [RELATION_INDEX_REFRESH_LOCK_CLASSID, RELATION_INDEX_REFRESH_LOCK_OBJID],
    );
    expect(second.rows[0]?.locked).toBe(false);

    await holder.query('ROLLBACK');
    await contender.query('ROLLBACK');
  });

  it("the writable REPEATABLE READ BEGIN text — rebuildRelationMembershipIndex's own transaction mode, matched directly in connection.ts", async () => {
    // Exercised implicitly by every rebuildRelationMembershipIndex call
    // above (it always opens exactly this transaction, never the read-only
    // SNAPSHOT_BEGIN form productionCheck uses) — named here explicitly too,
    // matching this file's own established "the snapshot-transaction BEGIN"
    // precedent immediately above.
    const state = createFakeStoreState();
    const source = createFakeConnectionSource(state);
    const result = await rebuildRelationMembershipIndex(source);
    expect(result).toEqual({ watermarkToken: 0, rowCount: 0, published: true, lockAcquired: true });
  });

  it("the SAVEPOINT LEOPARD_LOOKUP / RELEASE SAVEPOINT LEOPARD_LOOKUP pair — resolver.ts's own index short-circuit success path, matched directly in connection.ts", async () => {
    // The failure path (ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP + RELEASE
    // SAVEPOINT LEOPARD_LOOKUP) is D8's own dedicated coverage —
    // relation-index-savepoint-recovery.dst.test.ts — deliberately not
    // duplicated here.
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
    const flip = await writeTuple(source, {
      objectNs: 'group',
      objectId: 'eng',
      relation: 'member',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(flip.ok).toBe(true);
    if (!flip.ok) return;
    await rebuildRelationMembershipIndex(source);

    const result = await productionCheck(
      source,
      { ns: 'user', id: 'alice' },
      { ns: 'document', id: 'readme' },
      'viewer',
      { atToken: flip.token, useRelationIndex: true },
    );
    expect(result).toMatchObject({ allowed: true, indexHit: true });
  });
});
