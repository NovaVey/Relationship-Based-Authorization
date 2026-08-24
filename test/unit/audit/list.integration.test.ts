/**
 * `listObjects`/`listUsers` (`src/audit/list.ts`) — the real, independent-
 * oracle correctness proof this codebase's own established discipline
 * requires for anything claiming to answer a bulk permission question (see
 * `docs/DECISIONS.md` and
 * `test/unit/resolve/production/cross-resolver-agreement.integration.test.ts`'s
 * own pattern): don't just unit-test the new code in isolation (see
 * `test/unit/audit/list.test.ts` for the DB-free pure-function tests) —
 * prove it agrees with an independent, already-trusted oracle.
 *
 * The oracle here is brute force, built independently of `list.ts`'s own
 * implementation: for `listUsers`, every distinct plain
 * (`subject_relation IS NULL`) `(subject_ns, subject_id)` pair anywhere in
 * `relation_tuples` (not scoped to any one namespace — a subject can be of
 * any type), each run through a real `productionCheck` against the object
 * under test; for `listObjects`, every distinct `object_id` in the target
 * namespace, each run through a real `productionCheck` against the subject
 * under test. Both oracles call `productionCheck` directly — the same
 * production resolver `list.ts` itself calls — which is deliberate and
 * sound as an *oracle for `list.ts`'s own enumeration logic* even though it
 * would be circular as a soundness oracle for `productionCheck` itself
 * (that's what the reference resolver and Phase 5's differential fuzz
 * harness are for). What this test proves is narrower and different: given
 * that `productionCheck` answers each individual `(subject, object,
 * relation)` question correctly (established elsewhere), does
 * `listObjects`'s candidate-enumeration-plus-check strategy, and does
 * `listUsers`'s tree-evaluation strategy, correctly aggregate those
 * per-pair answers into the right *set*? A bug in either aggregation
 * strategy (missing a candidate, over- or under-flattening a tree) would
 * make `list.ts`'s own result diverge from this brute-force enumeration
 * even with a perfectly correct `productionCheck` underneath both.
 *
 * The schema fixture below deliberately exercises `intersection` AND
 * `exclusion` (the two combinator kinds a naive tree-flatten gets wrong —
 * see `evaluateExpandNode`'s own doc comment in `src/audit/list.ts`), a
 * `tupleToUserset` hop, and a two-level nested userset-group membership —
 * see `describe`'s own top-of-block comment for the exact graph and the
 * hand-derived expected sets.
 *
 * Runs against a real, ephemeral Postgres container, same convention as
 * every other `*.integration.test.ts` file in this repo (`docs/
 * DECISIONS.md` D-019/D-030: every integration test starts its own
 * container, no hardcoded local connection string, no exceptions).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { productionCheck } from '../../../src/resolve/production/resolver.js';
import {
  listObjects,
  listUsers,
  LIST_OBJECTS_MAX_CANDIDATES,
  type EntityRef,
} from '../../../src/audit/list.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  pool.on('error', (err) => {
    // pg's own documented contract — see every other *.integration.test.ts
    // file in this repo for the identical guard and the identical reason
    // (a known gotcha around idle-client errors during container teardown,
    // not a bug in this file's own test logic).
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): TupleKey {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok)
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
}

function sortRefs(refs: readonly EntityRef[]): EntityRef[] {
  return [...refs].sort((a, b) =>
    a.ns === b.ns ? a.id.localeCompare(b.id) : a.ns.localeCompare(b.ns),
  );
}

function expectSameEntitySet(actual: readonly EntityRef[], expected: readonly EntityRef[]): void {
  expect(sortRefs(actual)).toEqual(sortRefs(expected));
}

// ---------------------------------------------------------------------------
// The independent, brute-force oracle — deliberately NOT using anything
// from list.ts's own candidate-enumeration or tree-evaluation code, so a
// bug in either can't hide behind an oracle that makes the identical
// mistake.
// ---------------------------------------------------------------------------

interface PlainSubjectRow {
  subject_ns: string;
  subject_id: string;
}

/** Every distinct plain subject anywhere in `relation_tuples` — not scoped to any one namespace, per this file's own top-of-file doc comment. */
async function fetchAllPlainSubjects(): Promise<EntityRef[]> {
  const { rows } = await pool.query<PlainSubjectRow>(
    `select distinct subject_ns, subject_id from relation_tuples where subject_relation is null`,
  );
  return rows.map((row) => ({ ns: row.subject_ns, id: row.subject_id }));
}

/** Brute-force "who really has this permission" — every plain subject anywhere, each run through a real productionCheck. */
async function bruteForceUsers(
  object: EntityRef,
  relationOrPermission: string,
): Promise<EntityRef[]> {
  const candidates = await fetchAllPlainSubjects();
  const allowed: EntityRef[] = [];
  for (const subject of candidates) {
    const result = await productionCheck(pool, subject, object, relationOrPermission);
    if (result.allowed) allowed.push(subject);
  }
  return allowed;
}

interface ObjectIdRow {
  object_id: string;
}

async function fetchAllObjectIds(objectNs: string): Promise<string[]> {
  const { rows } = await pool.query<ObjectIdRow>(
    `select distinct object_id from relation_tuples where object_ns = $1`,
    [objectNs],
  );
  return rows.map((row) => row.object_id);
}

/** Brute-force "which objects does this subject really have this permission on" — every object_id in the namespace, each run through a real productionCheck. */
async function bruteForceObjects(
  subject: EntityRef,
  relationOrPermission: string,
  objectNs: string,
): Promise<EntityRef[]> {
  const ids = await fetchAllObjectIds(objectNs);
  const allowed: EntityRef[] = [];
  for (const id of ids) {
    const object: EntityRef = { ns: objectNs, id };
    const result = await productionCheck(pool, subject, object, relationOrPermission);
    if (result.allowed) allowed.push(object);
  }
  return allowed;
}

describe('listUsers/listObjects agree with an independent brute-force oracle', () => {
  // The shared fixture for every test in this describe block — published
  // and written once, then read (never mutated) by every `it` below.
  //
  // Graph, by hand:
  //
  //   group:eng_backend#member -> user:alice, user:bob
  //   group:eng#member         -> group:eng_backend#member   (nested, 2 levels)
  //
  //   org:acme#member -> user:carol, group:eng#member  (=> carol, alice, bob)
  //   org:acme#banned -> user:bob
  //   org:acme#view = member - banned
  //     => {carol, alice, bob} - {bob} = {carol, alice}
  //        (bob is excluded despite being a transitive member via the
  //        nested group — the EXCLUSION trap: a naive tree-flatten would
  //        wrongly include him, since he's a real directSubjects leaf
  //        somewhere under the `member` branch)
  //
  //   folder:design#editor -> user:dave, group:eng#member  (=> dave, alice, bob)
  //   folder:design#reviewer -> user:dave
  //   folder:design#edit = editor | parent->edit  (no parent tuple on design)
  //     => {dave, alice, bob}
  //   folder:design#sensitive_review = editor & reviewer
  //     => {dave, alice, bob} & {dave} = {dave}
  //        (alice and bob are editors but not reviewers — the INTERSECTION
  //        trap: a naive tree-flatten would wrongly include them, since
  //        they're real directSubjects leaves somewhere under the `editor`
  //        branch)
  //
  //   folder:sub#parent -> folder:design        (tupleToUserset hop)
  //   folder:sub#editor -> user:erin
  //   folder:sub#edit = editor | parent->edit
  //     => {erin} | folder:design#edit({dave, alice, bob}) = {erin, dave, alice, bob}
  let groupNs: string;
  let orgNs: string;
  let folderNs: string;

  beforeAll(async () => {
    groupNs = uniqueName('group');
    orgNs = uniqueName('org');
    folderNs = uniqueName('folder');

    await publishOk(
      [
        `namespace ${groupNs} {`,
        `  relation member: user | ${groupNs}#member`,
        '}',
        '',
        `namespace ${orgNs} {`,
        `  relation member: user | ${groupNs}#member`,
        '  relation banned: user',
        '',
        '  permission view = member - banned',
        '}',
        '',
        `namespace ${folderNs} {`,
        `  relation parent: ${folderNs}`,
        `  relation editor: user | ${groupNs}#member`,
        `  relation reviewer: user | ${groupNs}#member`,
        '',
        '  permission edit = editor | parent->edit',
        '  permission sensitive_review = editor & reviewer',
        '}',
      ].join('\n'),
    );

    // Two-level nested group membership.
    await writeOk(tuple(groupNs, 'eng_backend', 'member', 'user', 'alice'));
    await writeOk(tuple(groupNs, 'eng_backend', 'member', 'user', 'bob'));
    await writeOk(tuple(groupNs, 'eng', 'member', groupNs, 'eng_backend', 'member'));

    // Exclusion fixture.
    await writeOk(tuple(orgNs, 'acme', 'member', 'user', 'carol'));
    await writeOk(tuple(orgNs, 'acme', 'member', groupNs, 'eng', 'member'));
    await writeOk(tuple(orgNs, 'acme', 'banned', 'user', 'bob'));

    // Intersection fixture.
    await writeOk(tuple(folderNs, 'design', 'editor', 'user', 'dave'));
    await writeOk(tuple(folderNs, 'design', 'editor', groupNs, 'eng', 'member'));
    await writeOk(tuple(folderNs, 'design', 'reviewer', 'user', 'dave'));

    // tupleToUserset fixture.
    await writeOk(tuple(folderNs, 'sub', 'parent', folderNs, 'design'));
    await writeOk(tuple(folderNs, 'sub', 'editor', 'user', 'erin'));
  });

  it('listUsers exactly matches the brute-force oracle, across the exclusion, intersection, and tupleToUserset+union permissions', async () => {
    const cases: Array<{ object: EntityRef; relationOrPermission: string }> = [
      { object: ref(orgNs, 'acme'), relationOrPermission: 'view' },
      { object: ref(folderNs, 'design'), relationOrPermission: 'sensitive_review' },
      { object: ref(folderNs, 'design'), relationOrPermission: 'edit' },
      { object: ref(folderNs, 'sub'), relationOrPermission: 'edit' },
    ];
    for (const { object, relationOrPermission } of cases) {
      const oracle = await bruteForceUsers(object, relationOrPermission);
      const { subjects } = await listUsers(pool, object, relationOrPermission);
      expectSameEntitySet(subjects, oracle);
    }
  });

  it('listObjects exactly matches the brute-force oracle, for a subject with PARTIAL access across the namespace (not all-or-nothing)', async () => {
    // erin: direct editor of folder:sub only, unreachable on folder:design
    // through any path — exercises the "not every candidate is allowed"
    // case, not just a subject who happens to have access everywhere.
    const oracleErin = await bruteForceObjects(ref('user', 'erin'), 'edit', folderNs);
    const { objects: objectsErin, truncated: truncatedErin } = await listObjects(
      pool,
      ref('user', 'erin'),
      'edit',
      folderNs,
    );
    expect(truncatedErin).toBe(false);
    expectSameEntitySet(objectsErin, oracleErin);
    expectSameEntitySet(objectsErin, [ref(folderNs, 'sub')]);

    // alice: reachable on BOTH folder:design (direct nested-group editor)
    // and folder:sub (via tupleToUserset through design) — the "allowed on
    // every candidate" case, for contrast with erin above.
    const oracleAlice = await bruteForceObjects(ref('user', 'alice'), 'edit', folderNs);
    const { objects: objectsAlice, truncated: truncatedAlice } = await listObjects(
      pool,
      ref('user', 'alice'),
      'edit',
      folderNs,
    );
    expect(truncatedAlice).toBe(false);
    expectSameEntitySet(objectsAlice, oracleAlice);
    expectSameEntitySet(objectsAlice, [ref(folderNs, 'design'), ref(folderNs, 'sub')]);

    // carol: zero access anywhere in this namespace — the "allowed on
    // nothing" case; listObjects must return an empty, not-truncated
    // result, never a false grant.
    const oracleCarol = await bruteForceObjects(ref('user', 'carol'), 'edit', folderNs);
    const { objects: objectsCarol, truncated: truncatedCarol } = await listObjects(
      pool,
      ref('user', 'carol'),
      'edit',
      folderNs,
    );
    expect(truncatedCarol).toBe(false);
    expectSameEntitySet(objectsCarol, oracleCarol);
    expect(objectsCarol).toEqual([]);
  });

  it('an excluded/non-intersecting subject that naive tree-flattening would wrongly include is correctly absent', async () => {
    // EXCLUSION trap: bob is a real, direct-tuple member of org:acme's
    // `member` set (transitively, via the nested group) AND a real,
    // direct-tuple member of `banned`. A naive implementation that
    // flattened every ExpandNode leaf regardless of node kind (union of
    // every directSubjects/usersets leaf anywhere in the tree, ignoring
    // that `view`'s own top node is an `exclusion`) would find bob's real
    // tuple under the `member` branch and wrongly include him. The correct
    // exclusion semantics (base minus subtract) must exclude him.
    const { subjects: orgViewSubjects } = await listUsers(pool, ref(orgNs, 'acme'), 'view');
    const orgViewIds = orgViewSubjects.map((s) => `${s.ns}:${s.id}`).sort();
    expect(orgViewIds).toContain('user:carol');
    expect(orgViewIds).toContain('user:alice');
    expect(orgViewIds).not.toContain('user:bob');

    // INTERSECTION trap: alice and bob are both real, direct-tuple members
    // of folder:design's `editor` set (transitively, via the nested
    // group), but neither is a `reviewer`. A naive flatten would find their
    // real tuples under the `editor` branch of `sensitive_review = editor &
    // reviewer` and wrongly include them. The correct intersection
    // semantics must exclude both — only dave, present in BOTH branches,
    // survives.
    const { subjects: sensitiveReviewSubjects } = await listUsers(
      pool,
      ref(folderNs, 'design'),
      'sensitive_review',
    );
    const sensitiveReviewIds = sensitiveReviewSubjects.map((s) => `${s.ns}:${s.id}`).sort();
    expect(sensitiveReviewIds).toEqual(['user:dave']);
    expect(sensitiveReviewIds).not.toContain('user:alice');
    expect(sensitiveReviewIds).not.toContain('user:bob');
  });
});

describe('listObjects truncation — LIST_OBJECTS_MAX_CANDIDATES is a real, enforced, deterministic cutoff', () => {
  it('a namespace with more than LIST_OBJECTS_MAX_CANDIDATES objects returns exactly the cap, truncated: true, and the deterministic (object_id asc) lowest-sorting slice', async () => {
    const ns = uniqueName('bulk');
    await publishOk([`namespace ${ns} {`, '  relation viewer: user', '}'].join('\n'));

    const totalObjects = LIST_OBJECTS_MAX_CANDIDATES + 50;
    const objectIds = Array.from(
      { length: totalObjects },
      (_, i) => `obj${String(i).padStart(5, '0')}`,
    );

    // Real writes, real tuples — every one of these objects genuinely has
    // `subject:alice` as a direct viewer, so every candidate really is
    // `allowed: true`; the only thing bounding the result is the cap
    // itself, not any of them being denied.
    const concurrency = 20;
    for (let start = 0; start < objectIds.length; start += concurrency) {
      const batch = objectIds.slice(start, start + concurrency);
      await Promise.all(batch.map((id) => writeOk(tuple(ns, id, 'viewer', 'user', 'alice'))));
    }

    const { objects, truncated } = await listObjects(pool, ref('user', 'alice'), 'viewer', ns);
    expect(truncated).toBe(true);
    expect(objects).toHaveLength(LIST_OBJECTS_MAX_CANDIDATES);

    // Deterministic cutoff: the returned set is EXACTLY the
    // lowest-sorting LIST_OBJECTS_MAX_CANDIDATES ids, not an arbitrary
    // subset — proves `order by object_id asc` is actually driving the
    // cutoff, not incidental query-plan ordering.
    const expectedIds = objectIds.slice(0, LIST_OBJECTS_MAX_CANDIDATES).sort();
    const returnedIds = objects.map((o) => o.id).sort();
    expect(returnedIds).toEqual(expectedIds);
  }, 60_000);
});
