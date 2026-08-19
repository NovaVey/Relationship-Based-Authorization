/**
 * Real-Postgres integration tests for the tuple store — build spec §4
 * (data model), §6.1 (tuples are facts), §6.3 (consistency tokens), §9
 * Phase 2's exit criteria, and §10's "Tuple store (Phase 2)" test list.
 *
 * Runs against a real, ephemeral Postgres container (`@testcontainers/
 * postgresql`, already a devDependency) with the Phase 2 migrations
 * applied via this project's own `runMigrations` — the same mechanism
 * `vitest.integration.config.ts`'s own doc comment and `test/isolation/
 * permission-resolution.integration.test.ts`'s setup note both anticipate,
 * not a connection string hardcoded to any one environment's local
 * fixture. `ubuntu-latest` GitHub Actions runners have Docker preinstalled
 * (see `.github/workflows/ci.yml`'s `test-integration` job comment), so
 * this needs no extra CI setup; locally it needs a running Docker daemon.
 * Kept out of `npm test` (see `vitest.config.ts`'s `exclude`) by the
 * `.integration.test.ts` suffix — run via `npm run test:integration`.
 *
 * On `getPool()`/`src/store/client.ts`: that module reads
 * `env.DATABASE_URL` at import time (`src/config/env.ts`'s `export const
 * env = loadEnv()` runs once, the first time anything imports it, and
 * `client.ts`'s pool is a module-level singleton) — so pointing it at a
 * container whose connection details aren't known until `beforeAll` runs
 * is exactly the ordering hazard that singleton can't accommodate. Every
 * function this file actually exercises — `writeTuple`, `deleteTuple`,
 * `listTuplesByObject`, `listTuplesBySubject` (`src/store/tuples.ts`),
 * `currentToken`, `assertTokenObserved` (`src/store/tokens.ts`),
 * `publishSchema`, `getLatestNamespaceConfig` (`src/schema/publish.ts`) —
 * takes a `pg.Pool` as an explicit argument rather than reaching for that
 * singleton, so this file sidesteps the hazard entirely by constructing
 * its own dedicated `Pool` against the container it starts, never
 * importing `src/store/client.ts` or `src/config/env.ts` at all.
 *
 * Every fixture below uses a namespace/object/subject id unique to that
 * test (see `uniqueName`) rather than a shared fixed name — tests share
 * one container's database with no truncation between them and must be
 * safe to run concurrently and in any order.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import {
  writeTuple,
  deleteTuple,
  listTuplesByObject,
  listTuplesBySubject,
  WRITE_LOG_LOCK_CLASSID,
  WRITE_LOG_LOCK_OBJID,
  type TupleKey,
} from '../../../src/store/tuples.js';
import { currentToken, assertTokenObserved } from '../../../src/store/tokens.js';
import { publishSchema, getLatestNamespaceConfig } from '../../../src/schema/publish.js';
import { productionCheck } from '../../../src/resolve/production/resolver.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
/** A fresh lowercase identifier, unique to this process, matching IDENTIFIER_PATTERN. */
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uniqueCounter}`;
}

/**
 * §5's own `document` namespace shape, minus the `group#member` subject
 * type on `editor`/`viewer` (not needed by anything in this file — the
 * subject-type-rejection test below only needs a relation that accepts
 * `user` and *not* a userset subject, and doesn't need a second namespace
 * to exist to prove it). `owner`/`editor`/`viewer` relations, `view`/`edit`
 * permissions, exactly per §5's grammar.
 */
function documentSchemaSource(ns: string): string {
  return [
    `namespace ${ns} {`,
    '  relation owner: user',
    '  relation editor: user',
    '  relation viewer: user',
    '',
    '  permission view = viewer | editor | owner',
    '  permission edit = editor | owner',
    '}',
  ].join('\n');
}

async function publishDocumentSchema(ns: string): Promise<void> {
  const result = await publishSchema(pool, documentSchemaSource(ns));
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

describe('a write returns a strictly increasing consistency token', () => {
  it('a-writes-token-is-strictly-increasing-across-multiple-distinct-writes', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);
    const objectId = uniqueName('obj');

    const first = await writeTuple(pool, {
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    const second = await writeTuple(pool, {
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'bob',
    });
    const third = await writeTuple(pool, {
      objectNs: ns,
      objectId,
      relation: 'editor',
      subjectNs: 'user',
      subjectId: 'carol',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    // `WriteTupleResult.token` is documented as `number` (src/store/
    // tuples.ts) — a token has to actually be that type for a caller to
    // compare it numerically at all, which is the whole point of the next
    // two assertions.
    expect(typeof first.token).toBe('number');
    expect(typeof second.token).toBe('number');
    expect(typeof third.token).toBe('number');

    expect(second.token).toBeGreaterThan(first.token);
    expect(third.token).toBeGreaterThan(second.token);
  });
});

describe('deleting a tuple is immediately invisible to a read pinned to a post-delete token — §6.3', () => {
  it('deleting-a-tuple-is-immediately-invisible-to-a-read-pinned-to-a-post-delete-token', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);
    const objectId = uniqueName('obj');
    const tuple: TupleKey = {
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    const writeResult = await writeTuple(pool, tuple);
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) return;

    // Confirm it's actually there before deleting it — otherwise "invisible
    // after delete" would be vacuously true.
    const beforeDelete = await listTuplesByObject(pool, { objectNs: ns, objectId });
    expect(beforeDelete).toHaveLength(1);

    const deleteResult = await deleteTuple(pool, tuple);
    expect(deleteResult.ok).toBe(true);
    if (!deleteResult.ok) return;
    expect(deleteResult.deleted).toBe(true);
    // `DeleteTupleResult.token` is documented as `number` (src/store/
    // tuples.ts) — required for the ordering comparison right below to mean
    // what it says.
    expect(typeof writeResult.token).toBe('number');
    expect(typeof deleteResult.token).toBe('number');
    expect(deleteResult.token).toBeGreaterThan(writeResult.token);

    // A read pinned to the delete's own token must observe it (and every
    // write at or before it) — the token/write ordering §6.3 states as
    // non-negotiable.
    await expect(assertTokenObserved(pool, deleteResult.token)).resolves.not.toThrow();

    const afterDelete = await listTuplesByObject(pool, { objectNs: ns, objectId });
    expect(afterDelete).toHaveLength(0);
  });
});

describe('writing the same tuple twice is idempotent, not a duplicate row — §6.1', () => {
  it('writing-the-same-tuple-twice-is-idempotent-not-a-duplicate-row', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);
    const objectId = uniqueName('obj');
    const tuple: TupleKey = {
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    const first = await writeTuple(pool, tuple);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);

    const second = await writeTuple(pool, tuple);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Idempotent as a fact: no second row.
    expect(second.created).toBe(false);
    // But the store still owes the caller a fresh, strictly higher token —
    // "the caller asked the store to ensure this fact holds" (see
    // src/store/tuples.ts's own doc comment on writeTuple). Documented as
    // `number`, which the ordering assertion right below depends on.
    expect(typeof first.token).toBe('number');
    expect(typeof second.token).toBe('number');
    expect(second.token).toBeGreaterThan(first.token);

    const rows = await listTuplesByObject(pool, { objectNs: ns, objectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
  });
});

describe('a malformed namespace, relation, or id is rejected before it reaches the database', () => {
  /**
   * Duplicated from `test/isolation/identifier-and-tuple-validation.fuzz
   * .test.ts`'s `INJECTION_PAYLOAD_CORPUS` rather than imported from it:
   * importing a named export from a `*.test.ts` file causes Vitest to
   * execute (and re-register, under *this* file) every top-level
   * `describe`/`it` in the imported module too — confirmed empirically
   * while writing this file. Duplicating the literal corpus here is the
   * safer option; keep the two in sync by hand if either changes.
   */
  const NUL = String.fromCharCode(0);
  const NEWLINE = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const INJECTION_PAYLOAD_CORPUS = [
    'document; DROP TABLE relation_tuples; --',
    'document" OR "1"="1',
    "document' OR '1'='1",
    'document/*',
    '--',
    'document' + NUL,
    'document' + NEWLINE,
    'document' + TAB,
    ' document',
    'document ',
    '"document"',
    "'document'",
    'document;',
    '1document',
    '',
    ' ',
    'document-type',
    '../../etc/passwd',
    '<script>alert(1)</script>',
    'document' + LINE_SEPARATOR,
    'a'.repeat(1000),
  ];

  /**
   * A `Pool` pointed at a port nothing listens on. `writeTuple` validates
   * identifiers (`validateIdentifiers`, pure, no I/O) strictly before it
   * ever calls `validateAgainstSchema` (which does query Postgres) — so
   * proving "before it reaches the database" means proving this pool is
   * never actually queried. If it were, the attempt fails fast
   * (`connectionTimeoutMillis`) and this test fails loudly with a
   * connection error instead of quietly getting the wrong result.
   */
  const unreachablePool = new Pool({
    connectionString: 'postgres://nobody:nothing@127.0.0.1:1/unreachable',
    connectionTimeoutMillis: 300,
  });

  afterAll(async () => {
    await unreachablePool.end();
  });

  const baseTuple: TupleKey = {
    objectNs: 'document',
    objectId: 'readme',
    relation: 'viewer',
    subjectNs: 'user',
    subjectId: 'alice',
  };

  const fieldPositions: Array<{ label: string; build: (payload: string) => TupleKey }> = [
    { label: 'object namespace', build: (p) => ({ ...baseTuple, objectNs: p }) },
    { label: 'object id', build: (p) => ({ ...baseTuple, objectId: p }) },
    { label: 'relation', build: (p) => ({ ...baseTuple, relation: p }) },
    { label: 'subject namespace', build: (p) => ({ ...baseTuple, subjectNs: p }) },
    { label: 'subject id', build: (p) => ({ ...baseTuple, subjectId: p }) },
  ];

  it('a-malformed-namespace-relation-or-id-is-rejected-before-it-reaches-the-database', async () => {
    for (const { label, build } of fieldPositions) {
      for (const payload of INJECTION_PAYLOAD_CORPUS) {
        const result = await writeTuple(unreachablePool, build(payload));
        expect(
          result.ok,
          `expected ${label} payload ${JSON.stringify(payload)} to be rejected`,
        ).toBe(false);
        if (result.ok) continue;
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.every((e) => e.code === 'invalid_identifier')).toBe(true);
      }
    }
  });

  /**
   * The mirror image of the `writeTuple` test directly above, against the
   * identical corpus and the identical unreachable-database pool — full-
   * repo audit finding #32: `writeTuple`'s malformed-identifier rejection
   * had this exact injection-shaped/malformed corpus behind it;
   * `deleteTuple` (`src/store/tuples.ts`) shares `validateIdentifiers` per
   * its own doc comment ("`const identifierErrors =
   * validateIdentifiers(tuple);`" appears at the top of both `writeTuple`
   * and `deleteTuple`), but nothing previously exercised that sharing for
   * `deleteTuple` specifically. A future refactor that gave `deleteTuple`
   * its own, weaker validation path (e.g. skipping validation on the
   * reasoning that "a delete can't create anything, so a malformed
   * identifier is harmless") would go undetected without this.
   */
  it('a-malformed-namespace-relation-or-id-is-also-rejected-by-deleteTuple-before-it-reaches-the-database', async () => {
    for (const { label, build } of fieldPositions) {
      for (const payload of INJECTION_PAYLOAD_CORPUS) {
        const result = await deleteTuple(unreachablePool, build(payload));
        expect(
          result.ok,
          `expected ${label} payload ${JSON.stringify(payload)} to be rejected by deleteTuple`,
        ).toBe(false);
        if (result.ok) continue;
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.every((e) => e.code === 'invalid_identifier')).toBe(true);
      }
    }
  });
});

describe('a tuple write is validated against the latest published schema for its namespace', () => {
  it('writing-a-tuple-whose-relation-does-not-exist-on-the-published-namespace-is-rejected', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);

    const result = await writeTuple(pool, {
      objectNs: ns,
      objectId: uniqueName('obj'),
      relation: 'not_a_declared_relation',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'undeclared_relation')).toBe(true);
  });

  it('writing-a-tuple-against-a-namespace-with-no-published-schema-is-rejected-with-a-specific-error-not-a-generic-failure', async () => {
    // Never published in this or any other test — uniqueName guarantees no
    // prior `publishSchema` call could have created a config for it.
    const ns = uniqueName('never_published_ns');

    const result = await writeTuple(pool, {
      objectNs: ns,
      objectId: uniqueName('obj'),
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('no_published_schema');
  });

  it('writing-a-tuple-where-the-relation-name-is-actually-a-permission-on-the-published-namespace-is-rejected', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);

    // 'view' is a permission on this namespace (see documentSchemaSource),
    // never a relation — §5's own non-negotiable, enforced again at write
    // time per src/store/tuples.ts's own doc comment.
    const result = await writeTuple(pool, {
      objectNs: ns,
      objectId: uniqueName('obj'),
      relation: 'view',
      subjectNs: 'user',
      subjectId: 'alice',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'relation_is_a_permission')).toBe(true);
  });

  it('a-subject-type-not-declared-for-a-relation-is-rejected', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);

    // 'viewer' only accepts subject type 'user' (see documentSchemaSource)
    // — a group#member userset subject was never declared for it.
    const result = await writeTuple(pool, {
      objectNs: ns,
      objectId: uniqueName('obj'),
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'subject_type_not_allowed')).toBe(true);
  });
});

describe('republishing a namespace with a new relation makes the write path (getLatestNamespaceConfig) pick it up immediately — full-repo audit finding #18', () => {
  // The sibling describe block above only ever publishes a namespace once
  // per test — none of it proves `getLatestNamespaceConfig` (the function
  // that actually gates every real write via `validateAgainstSchema`, and
  // `productionCheck`'s own schema lookup) picks up a *second* published
  // version for a namespace it already knew about, rather than continuing
  // to validate against a stale, cached-looking v1. This publishes the
  // same namespace twice — v1, then v2 adding a brand-new relation — and
  // proves the write path can't see that relation until the exact moment
  // v2 is published, then immediately can.
  it('a-relation-that-only-exists-in-v2-is-rejected-before-republish-and-accepted-immediately-after-republishing-the-same-namespace', async () => {
    const ns = uniqueName('doc_v2');

    // v1: `owner` only — no `collaborator` relation exists yet.
    const v1Source = [
      `namespace ${ns} {`,
      '  relation owner: user',
      '',
      '  permission view = owner',
      '}',
    ].join('\n');
    const published1 = await publishSchema(pool, v1Source);
    expect(published1.ok).toBe(true);
    if (!published1.ok) return;
    expect(published1.published).toEqual([{ namespace: ns, version: 1 }]);

    // A tuple valid only under v1 writes cleanly against it.
    const v1Write = await writeTuple(pool, {
      objectNs: ns,
      objectId: uniqueName('obj'),
      relation: 'owner',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(v1Write.ok).toBe(true);

    // The control half of the proof: a tuple against `collaborator` — a
    // relation v1 never declared — is rejected right now, before any
    // republish. Without this, a later successful write against
    // `collaborator` couldn't be distinguished from a write-path bug that
    // never actually validated the relation name at all.
    const beforeRepublish = await writeTuple(pool, {
      objectNs: ns,
      objectId: uniqueName('obj'),
      relation: 'collaborator',
      subjectNs: 'user',
      subjectId: 'bob',
    });
    expect(beforeRepublish.ok).toBe(false);
    if (beforeRepublish.ok) return;
    expect(beforeRepublish.errors.some((e) => e.code === 'undeclared_relation')).toBe(true);

    // Republish the SAME namespace as v2, adding `collaborator` and
    // widening `view` to include it.
    const v2Source = [
      `namespace ${ns} {`,
      '  relation owner: user',
      '  relation collaborator: user',
      '',
      '  permission view = owner | collaborator',
      '}',
    ].join('\n');
    const published2 = await publishSchema(pool, v2Source);
    expect(published2.ok).toBe(true);
    if (!published2.ok) return;
    expect(published2.published).toEqual([{ namespace: ns, version: 2 }]);

    // The actual claim under test: writeTuple now accepts a tuple valid
    // only under v2 — the exact relation that was rejected moments ago,
    // proving getLatestNamespaceConfig re-read the namespace and picked up
    // the new version rather than continuing to validate against v1.
    const objectId = uniqueName('obj');
    const v2Write = await writeTuple(pool, {
      objectNs: ns,
      objectId,
      relation: 'collaborator',
      subjectNs: 'user',
      subjectId: 'bob',
    });
    expect(v2Write.ok).toBe(true);
    if (!v2Write.ok) return;
    expect(v2Write.created).toBe(true);

    // Confirm getLatestNamespaceConfig itself — the function this finding
    // names directly — really does return v2's shape now, not just that
    // the write happened to succeed for some unrelated reason.
    const latestConfig = await getLatestNamespaceConfig(pool, ns);
    expect(latestConfig?.relations['collaborator']).toBeDefined();

    // Optional per this finding's own suggestion: a check() against the
    // new v2-only relation resolves correctly too, proving the production
    // resolver's own getLatestNamespaceConfig call picked up v2 as well,
    // not just the write path.
    const checkResult = await productionCheck(
      pool,
      { ns: 'user', id: 'bob' },
      { ns, id: objectId },
      'view',
    );
    expect(checkResult.allowed).toBe(true);
  });
});

describe('listTuplesByObject and listTuplesBySubject return exactly the rows a sequence of writes and deletes implies', () => {
  it('list-tuples-by-object-and-by-subject-reflect-exactly-the-writes-and-deletes-applied-not-more-not-fewer', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);
    const objectA = uniqueName('obj_a');
    const objectB = uniqueName('obj_b');
    const alice = uniqueName('alice');
    const bob = uniqueName('bob');

    // alice: viewer + editor on object A, viewer on object B
    // bob: viewer on object A only
    const writes: TupleKey[] = [
      { objectNs: ns, objectId: objectA, relation: 'viewer', subjectNs: 'user', subjectId: alice },
      { objectNs: ns, objectId: objectA, relation: 'editor', subjectNs: 'user', subjectId: alice },
      { objectNs: ns, objectId: objectB, relation: 'viewer', subjectNs: 'user', subjectId: alice },
      { objectNs: ns, objectId: objectA, relation: 'viewer', subjectNs: 'user', subjectId: bob },
    ];
    for (const tuple of writes) {
      const result = await writeTuple(pool, tuple);
      expect(result.ok).toBe(true);
    }

    // Revoke bob's viewer on object A.
    const del = await deleteTuple(pool, {
      objectNs: ns,
      objectId: objectA,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: bob,
    });
    expect(del.ok).toBe(true);

    const onObjectA = await listTuplesByObject(pool, { objectNs: ns, objectId: objectA });
    expect(onObjectA).toHaveLength(2);
    expect(
      onObjectA
        .map((r) => ({ relation: r.relation, subjectId: r.subjectId }))
        .sort((a, b) => a.relation.localeCompare(b.relation)),
    ).toEqual([
      { relation: 'editor', subjectId: alice },
      { relation: 'viewer', subjectId: alice },
    ]);

    const onObjectAViewersOnly = await listTuplesByObject(pool, {
      objectNs: ns,
      objectId: objectA,
      relation: 'viewer',
    });
    expect(onObjectAViewersOnly).toHaveLength(1);
    expect(onObjectAViewersOnly[0]?.subjectId).toBe(alice);

    const aliceTuples = await listTuplesBySubject(pool, 'user', alice);
    expect(aliceTuples).toHaveLength(3);
    expect(
      aliceTuples
        .map((r) => ({ objectId: r.objectId, relation: r.relation }))
        .sort((a, b) => (a.objectId + a.relation).localeCompare(b.objectId + b.relation)),
    ).toEqual(
      [
        { objectId: objectA, relation: 'editor' },
        { objectId: objectA, relation: 'viewer' },
        { objectId: objectB, relation: 'viewer' },
      ].sort((a, b) => (a.objectId + a.relation).localeCompare(b.objectId + b.relation)),
    );

    // bob's only tuple was the one just revoked — nothing left naming bob.
    const bobTuples = await listTuplesBySubject(pool, 'user', bob);
    expect(bobTuples).toHaveLength(0);
  });

  it('a-listed-tuple-rows-id-is-returned-as-a-number-matching-its-documented-type-not-a-raw-bigint-string', async () => {
    const ns = uniqueName('doc');
    await publishDocumentSchema(ns);
    const objectId = uniqueName('obj');
    const write = await writeTuple(pool, {
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(write.ok).toBe(true);

    const rows = await listTuplesByObject(pool, { objectNs: ns, objectId });
    expect(rows).toHaveLength(1);
    // TupleRow.id is declared `number` in src/store/tuples.ts.
    expect(typeof rows[0]?.id).toBe('number');
  });
});

describe('a token pinned beyond what this database has observed is rejected, not silently treated as satisfied — §6.3', () => {
  it('assert-token-observed-throws-for-a-token-higher-than-any-write-this-database-has-seen', async () => {
    const highest = await currentToken(pool);
    // Explicit `Number(...)` coercion deliberately, rather than trusting
    // `currentToken`'s declared `number | null` return type at face value
    // — see the next describe block, which found that trust misplaced.
    const impossiblyHighToken = Number(highest ?? 0) + 1_000_000;
    await expect(assertTokenObserved(pool, impossiblyHighToken)).rejects.toThrow();
  });
});

/**
 * A real defect found while writing the tests above, not a hypothetical:
 * Postgres returns a `bigint` column (`write_log.token`, `write_log.id`,
 * `relation_tuples.id`) to `pg` as a JS **string**, never coerced to
 * `number`, because a bigint can exceed `Number.MAX_SAFE_INTEGER` and `pg`
 * refuses to silently lose precision — confirmed directly against this
 * environment's own Postgres (`typeof result.rows[0].token === 'string'`).
 * Nothing in `src/store/client.ts` or `src/store/tokens.ts` registers a
 * custom type parser (`pg.types.setTypeParser`) to convert it, despite
 * `WriteTupleResult.token`, `DeleteTupleResult.token`, `currentToken`'s
 * return type, and `TupleRow.id` all being declared `number` in
 * `src/store/tuples.ts`/`src/store/tokens.ts`.
 *
 * This is silent everywhere a token happens to get compared against
 * another value of the same digit count (the overwhelmingly common case in
 * a short-lived test), which is exactly why the three tests above (each
 * comparing two tokens minted moments apart, almost always the same digit
 * count) don't surface it on their own — they only catch it via the
 * `typeof ... toBe('number')` assertions added specifically to check the
 * documented contract, not by accident.
 *
 * It stops being silent the moment two tokens of *different* digit counts
 * are compared with a plain `>` — which `assertTokenObserved`
 * (`src/store/tokens.ts`) does on every single call, and which is exactly
 * what "pin a check to a token returned by an earlier write" (§6.3's core
 * guarantee, and the CLI's own future `--at-token` flag per §7) does in
 * completely ordinary, expected use, not an edge case.
 */
describe('a real defect: assertTokenObserved compares tokens as strings, not numbers, once digit counts differ', () => {
  /**
   * Deterministic and cheap regardless of how large this shared database's
   * token counter already is (it is never truncated between test runs):
   * derived directly from whatever `currentToken` reports right now,
   * without needing to perform any filler writes to "wait for" a digit
   * boundary. `candidate` is a real, already-elapsed token — any value
   * strictly below `observedNumeric` was, by construction of a
   * `generated always as identity` column with no rollbacks in this test
   * run, already committed to `write_log` before `observedNumeric` was —
   * so `assertTokenObserved(pool, candidate)` must never throw for it.
   *
   * Constructed as the longest all-'9' digit string shorter than
   * `observedNumeric`'s own string form that still lexicographically sorts
   * *above* it — i.e., exactly the shape a bigint-as-string comparison
   * gets backwards: fewer digits, larger leading digit, numerically
   * smaller, string-comparison "greater".
   */
  function findWronglyRejectableToken(observedNumeric: number): number | undefined {
    const observedStr = String(observedNumeric);
    for (let len = observedStr.length - 1; len >= 1; len -= 1) {
      const candidate = '9'.repeat(len);
      if (candidate > observedStr && Number(candidate) <= observedNumeric) {
        return Number(candidate);
      }
    }
    return undefined;
  }

  it('a-token-that-was-already-observed-is-never-rejected-by-assert-token-observed-merely-because-it-has-fewer-digits-than-the-current-token', async () => {
    const observedRaw = await currentToken(pool);
    const observedNumeric = Number(observedRaw ?? 0);
    const candidate = findWronglyRejectableToken(observedNumeric);
    if (candidate === undefined) {
      // Only possible if the live token counter's decimal form is made
      // entirely of the digit 9 at every prefix length (e.g. exactly 9,
      // 99, 999, ...) at the moment this test runs against this shared,
      // never-truncated database — vanishingly unlikely, but fail loudly
      // rather than silently skip a soundness-adjacent assertion.
      throw new Error(
        `could not construct a test case for the current token counter value (${observedNumeric}) — rerun`,
      );
    }

    // The adversarial part: pass `candidate` as the *string* pg actually
    // returns from a real write's `.token` field, cast through `unknown`
    // to simulate a caller who trusted `WriteTupleResult.token`'s
    // documented `number` type, exactly as a well-typed caller of this
    // store would. A caller who already (correctly) distrusts the type and
    // coerces first does not hit this — the point is that nothing requires
    // them to.
    const candidateAsPgWouldReturnIt = String(candidate) as unknown as number;

    await expect(assertTokenObserved(pool, candidateAsPgWouldReturnIt)).resolves.not.toThrow();
  });
});

describe('fail-closed: an unreachable database fails a store operation rather than silently succeeding or returning an empty result', () => {
  const unreachablePool = new Pool({
    connectionString: 'postgres://nobody:nothing@127.0.0.1:1/unreachable',
    connectionTimeoutMillis: 300,
  });

  afterAll(async () => {
    await unreachablePool.end();
  });

  it('an-unreachable-database-makes-a-tuple-write-throw-rather-than-silently-succeed-or-silently-deny', async () => {
    // Well-formed identifiers throughout, so this exercises the schema
    // lookup (a real query) rather than being short-circuited by identifier
    // validation the way the "malformed identifier" tests above are.
    await expect(
      writeTuple(unreachablePool, {
        objectNs: 'document',
        objectId: 'readme',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      }),
    ).rejects.toThrow();
  });

  it('an-unreachable-database-makes-a-tuple-read-throw-rather-than-silently-return-an-empty-result', async () => {
    await expect(
      listTuplesByObject(unreachablePool, { objectNs: 'document', objectId: 'readme' }),
    ).rejects.toThrow();
  });
});

/**
 * The regression test for the full-repo audit's HIGH-severity finding on
 * `assertTokenObserved`/`writeTuple`/`deleteTuple` — `write_log.token` is a
 * `bigint generated always as identity` column, allocated non-
 * transactionally at INSERT-statement-execution time, so its allocation
 * order carries no guaranteed relationship to commit order on its own.
 * Without a serializing lock, a slow-to-commit transaction A (lower token)
 * and a fast, unrelated transaction B (higher token) could commit in the
 * order B-then-A: a caller who pinned a check to B's token would pass
 * `assertTokenObserved` (`max(token)` already covers B) while A's
 * lower-or-equal-numbered write was still genuinely uncommitted — exactly
 * the violation `docs/CONSISTENCY.md` states as non-negotiable ("a check
 * pinned to token T never returns a result that ignores a write with token
 * ≤ T"). See `src/store/tuples.ts`'s own `acquireWriteLogLock` doc comment
 * for the fix (a global `pg_advisory_xact_lock($1, $2)`, first statement
 * after `BEGIN`, in both `writeTuple` and `deleteTuple`) and
 * `docs/DECISIONS.md` for the decision entry.
 *
 * Cannot be meaningfully unit-tested with a single connection — the whole
 * bug is about the relationship between two *independently committed*
 * transactions, so every test below drives two real, separate connections
 * against real Postgres (one raw `pg.Client`, held open and uncommitted on
 * purpose, plus the real `writeTuple`/`deleteTuple` functions called
 * concurrently through the shared `pool`) rather than mocking anything.
 *
 * Each test acquires the *exact* production lock
 * (`WRITE_LOG_LOCK_CLASSID`/`WRITE_LOG_LOCK_OBJID`, exported from
 * `src/store/tuples.ts` for exactly this purpose — see that export's own
 * doc comment) from the raw client, mirroring the literal sequence
 * `writeTuple`/`deleteTuple` themselves run (`BEGIN`; acquire the lock;
 * insert into `relation_tuples`/delete from it; insert into `write_log`
 * `RETURNING token`) — this proves the *real* production lock genuinely
 * blocks the *real* production functions, not a same-shaped-but-different
 * lock that only coincidentally matches today.
 */
describe('a token pinned to a just-observed write never ignores an earlier, still-committing write — the inverted-commit-order race this store must never allow (full-repo audit finding, HIGH)', () => {
  let raceContainer: StartedPostgreSqlContainer;
  let racePool: Pool;
  let raceNs: string;

  beforeAll(async () => {
    raceContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    racePool = new Pool({ connectionString: raceContainer.getConnectionUri() });
    await runMigrations(racePool, MIGRATIONS_DIR);
    raceNs = uniqueName('race_doc');
    const published = await publishSchema(racePool, documentSchemaSource(raceNs));
    if (!published.ok) {
      throw new Error(`race fixture schema failed to publish: ${published.errors.join('; ')}`);
    }
  }, 120_000);

  afterAll(async () => {
    await racePool.end();
    await raceContainer.stop();
  });

  /** Waits `ms`, purely to give a wrongly-unblocked promise every chance to have already settled. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('a-writeTuple-call-genuinely-blocks-behind-an-earlier-uncommitted-transaction-holding-the-same-global-lock-and-observes-it-once-unblocked', async () => {
    const objectA = uniqueName('obj_a');
    const objectB = uniqueName('obj_b');

    const clientA = new Client({ connectionString: raceContainer.getConnectionUri() });
    await clientA.connect();

    try {
      // Client A: mirror writeTuple's own transaction, by hand, acquiring
      // the *real* production lock — BEGIN; acquire; insert into
      // relation_tuples; insert into write_log RETURNING token — then hold
      // the transaction open, uncommitted, exactly the "slow to commit"
      // half of the race.
      await clientA.query('BEGIN');
      await clientA.query('select pg_advisory_xact_lock($1, $2)', [
        WRITE_LOG_LOCK_CLASSID,
        WRITE_LOG_LOCK_OBJID,
      ]);
      await clientA.query(
        `insert into relation_tuples
           (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
         values ($1, $2, 'viewer', 'user', 'alice', null)`,
        [raceNs, objectA],
      );
      const aWriteLog = await clientA.query<{ token: string }>(
        `insert into write_log (operation, tuple) values ('write', $1) returning token`,
        [
          JSON.stringify({
            objectNs: raceNs,
            objectId: objectA,
            relation: 'viewer',
            subjectNs: 'user',
            subjectId: 'alice',
          }),
        ],
      );
      const tokenA = Number(aWriteLog.rows[0]?.token);
      expect(Number.isInteger(tokenA)).toBe(true);

      // Concurrently, the REAL writeTuple, for an entirely unrelated
      // object — this is the "unrelated concurrent write" the finding
      // itself describes, not a write racing for the same row.
      let bSettled = false;
      const bPromise = writeTuple(racePool, {
        objectNs: raceNs,
        objectId: objectB,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'bob',
      }).then(
        (r) => {
          bSettled = true;
          return r;
        },
        (e: unknown) => {
          bSettled = true;
          throw e;
        },
      );

      // Give B every chance to have wrongly raced ahead of A.
      await sleep(500);
      expect(bSettled).toBe(false);

      // Only now does A commit — the fix's whole point is that B could not
      // have gotten this far without A finishing first.
      await clientA.query('COMMIT');

      const bResult = await bPromise;
      expect(bResult.ok).toBe(true);
      if (!bResult.ok) return;
      const tokenB = bResult.token;

      // B's token must be strictly higher — it could not even allocate its
      // own token until A released the lock by committing.
      expect(tokenB).toBeGreaterThan(tokenA);

      // The actual invariant under test: a check pinned to B's token must
      // never ignore A's write (tokenA <= tokenB).
      await expect(assertTokenObserved(racePool, tokenB)).resolves.not.toThrow();
      const aRows = await listTuplesByObject(racePool, { objectNs: raceNs, objectId: objectA });
      expect(aRows).toHaveLength(1);
      expect(aRows[0]?.subjectId).toBe('alice');
    } finally {
      await clientA.end();
    }
  });

  it('a-deleteTuple-call-also-blocks-behind-an-earlier-uncommitted-transaction-holding-the-same-global-lock-proving-the-lock-is-shared-across-writes-and-deletes-not-per-operation-or-per-table', async () => {
    const objectC = uniqueName('obj_c');
    const objectD = uniqueName('obj_d');

    // Seed a tuple to delete, and one for the "held" side to delete by
    // hand — both writes complete and commit before the timed race begins,
    // so only the delete-side transactions are actually being raced here.
    const seedD = await writeTuple(racePool, {
      objectNs: raceNs,
      objectId: objectD,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'dave',
    });
    expect(seedD.ok).toBe(true);

    const clientA = new Client({ connectionString: raceContainer.getConnectionUri() });
    await clientA.connect();

    try {
      // Client A: mirror deleteTuple's own transaction by hand, holding the
      // *same* global lock a concurrent writeTuple must also acquire.
      await clientA.query('BEGIN');
      await clientA.query('select pg_advisory_xact_lock($1, $2)', [
        WRITE_LOG_LOCK_CLASSID,
        WRITE_LOG_LOCK_OBJID,
      ]);
      await clientA.query(
        `delete from relation_tuples
         where object_ns = $1 and object_id = $2 and relation = 'viewer'
           and subject_ns = 'user' and subject_id = 'dave'`,
        [raceNs, objectD],
      );
      const aWriteLog = await clientA.query<{ token: string }>(
        `insert into write_log (operation, tuple) values ('delete', $1) returning token`,
        [
          JSON.stringify({
            objectNs: raceNs,
            objectId: objectD,
            relation: 'viewer',
            subjectNs: 'user',
            subjectId: 'dave',
          }),
        ],
      );
      const tokenA = Number(aWriteLog.rows[0]?.token);
      expect(Number.isInteger(tokenA)).toBe(true);

      // Concurrently, a real writeTuple — a different operation entirely —
      // for an unrelated object.
      let bSettled = false;
      const bPromise = writeTuple(racePool, {
        objectNs: raceNs,
        objectId: objectC,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'carol',
      }).then(
        (r) => {
          bSettled = true;
          return r;
        },
        (e: unknown) => {
          bSettled = true;
          throw e;
        },
      );

      await sleep(500);
      expect(bSettled).toBe(false);

      await clientA.query('COMMIT');

      const bResult = await bPromise;
      expect(bResult.ok).toBe(true);
      if (!bResult.ok) return;
      const tokenB = bResult.token;

      expect(tokenB).toBeGreaterThan(tokenA);
      await expect(assertTokenObserved(racePool, tokenB)).resolves.not.toThrow();

      // A's delete (dave's viewer tuple on objectD) must already be
      // committed and observable — the revoke that was "in flight" while
      // B's unrelated write raced it.
      const daveRows = await listTuplesByObject(racePool, { objectNs: raceNs, objectId: objectD });
      expect(daveRows).toHaveLength(0);
    } finally {
      await clientA.end();
    }
  });
});
