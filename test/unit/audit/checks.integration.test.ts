/**
 * `performCheck` (`src/audit/checks.ts`, Phase 6) — the "every check,
 * allowed or denied, is logged" and "an allowed check's log entry contains
 * a path that independently re-verifies" halves of `.claude/commands/
 * build-authz-service.md` §9 Phase 6's exit criterion, §6.7, and D-042's
 * failure contract.
 *
 * **Scope, deliberately narrow.** This file does NOT retest
 * `productionCheck`'s own resolution-path *construction* logic (see
 * `test/unit/resolve/production/production-resolution-path.integration
 * .test.ts`, 11 tests) or `expand()`'s own tree-building logic (see
 * `test/unit/audit/expand.integration.test.ts`, 5 tests) — both already
 * thoroughly, independently proven. What was untested before this file:
 * does `performCheck` actually write one `checks` row per real call, with
 * the shape §4/§6.7 promise, and — the part that matters most — does the
 * *persisted, round-tripped* `resolution_path` (a JS object ->
 * `JSON.stringify` -> Postgres `jsonb` -> a **fresh** `select`, never the
 * in-process value `performCheck` happened to return) still independently
 * re-verify against the real tuple graph? A resolver can build a perfectly
 * correct path in memory and still have a storage bug silently corrupt it
 * (a stray `JSON.stringify` on the wrong value, a column that truncates,
 * numeric precision loss) — proving *that specific hop* is this file's job.
 *
 * The round-trip verifier below (`verifyStep`/`verifyRule`) is written
 * fresh, from `src/resolve/production/resolver.ts`'s and `src/schema/dsl/
 * types.ts`'s own EXPORTED types only (never resolver.ts's private
 * helpers, its SQL bodies, or its recursion structure) — the same
 * discipline `production-resolution-path.integration.test.ts`'s own
 * verifier already holds itself to. It is a genuinely independent piece of
 * code, not an import of that file's verifier (nothing there is exported)
 * and not a copy-paste of it either — every tuple-existence claim is
 * confirmed with its own fresh SQL query against the real database, never
 * by calling back into `resolver.ts`'s own query functions.
 *
 * It deliberately covers only the rewrite-rule kinds this file's own
 * fixtures exercise — `directGrant`, `usersetMembership`, `union`,
 * `intersection`, `tupleToUserset` — not `exclusion`/`DisproofStep`.
 * Exclusion's proof-plus-disproof shape is already the subject of
 * extensive, dedicated coverage in the sibling file (including a nested
 * userset disproof and a disproof through a real cycle); re-deriving a
 * second independent verifier for it here would test the same claim twice
 * without adding new evidence about the one property this file actually
 * exists to check — jsonb round-trip fidelity. The two fixtures below
 * (union+directGrant, intersection+tupleToUserset) already exercise a real
 * number (`branchIndex`), a real array (`branches`, length 2), and three
 * levels of nested discriminated-union objects, which is the full shape
 * inventory `ResolutionStep` has outside of `exclusion`/`DisproofStep`.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030 (every `*.integration.test.ts` file
 * starts its own container; never a hardcoded local connection string).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema, getLatestNamespaceConfig } from '../../../src/schema/publish.js';
import type { RewriteRule } from '../../../src/schema/dsl/types.js';
import { performCheck } from '../../../src/audit/checks.js';
import type { EntityRef, ResolutionStep } from '../../../src/resolve/production/resolver.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = new URL('../../../src/store/migrations', import.meta.url).pathname;

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

afterEach(() => {
  vi.restoreAllMocks();
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

async function writeOk(t: TupleKey): Promise<number> {
  const result = await writeTuple(pool, t);
  if (!result.ok)
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  return result.token;
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
}

function entityEq(a: EntityRef, b: EntityRef): boolean {
  return a.ns === b.ns && a.id === b.id;
}

// ---------------------------------------------------------------------------
// Fresh row read-back — a real `select`, never the in-process return value.
// ---------------------------------------------------------------------------

interface CheckRow {
  id: string;
  subject_ns: string;
  subject_id: string;
  relation: string;
  object_ns: string;
  object_id: string;
  allowed: boolean;
  consistency_token: string | null; // bigint -> string over the wire (D-018)
  resolution_path: unknown;
  depth: number;
  duration_ms: number | null;
  checked_at: Date;
}

async function fetchLatestCheckRow(
  subject: EntityRef,
  relation: string,
  object: EntityRef,
): Promise<CheckRow> {
  const { rows } = await pool.query<CheckRow>(
    `select * from checks
     where subject_ns = $1 and subject_id = $2 and relation = $3
       and object_ns = $4 and object_id = $5
     order by checked_at desc
     limit 1`,
    [subject.ns, subject.id, relation, object.ns, object.id],
  );
  const row = rows[0];
  if (!row) throw new Error('expected a checks row to have been inserted, found none');
  return row;
}

async function countCheckRows(
  subject: EntityRef,
  relation: string,
  object: EntityRef,
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from checks
     where subject_ns = $1 and subject_id = $2 and relation = $3
       and object_ns = $4 and object_id = $5`,
    [subject.ns, subject.id, relation, object.ns, object.id],
  );
  return Number(rows[0]?.count ?? '0');
}

// ---------------------------------------------------------------------------
// Fresh, independently-written Postgres queries — never resolver.ts's own.
// ---------------------------------------------------------------------------

async function tupleExists(
  object: EntityRef,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation: string | null,
): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3
       and subject_ns = $4 and subject_id = $5
       and coalesce(subject_relation, '') = coalesce($6, '')`,
    [object.ns, object.id, relation, subjectNs, subjectId, subjectRelation],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The independent round-trip verifier — see this file's own top-of-file
// doc comment for exactly what it does and does not cover.
// ---------------------------------------------------------------------------

async function verifyStep(
  subject: EntityRef,
  object: EntityRef,
  name: string,
  step: ResolutionStep,
): Promise<boolean> {
  const config = await getLatestNamespaceConfig(pool, object.ns);
  if (!config) return false;

  const relation = config.relations[name];
  if (relation) {
    if (step.kind === 'directGrant') {
      if (!entityEq(step.object, object) || step.relation !== name) return false;
      if (!entityEq(step.subject, subject)) return false;
      return tupleExists(object, name, subject.ns, subject.id, null);
    }
    if (step.kind === 'usersetMembership') {
      if (!entityEq(step.object, object) || step.relation !== name) return false;
      const exists = await tupleExists(
        object,
        name,
        step.userset.ns,
        step.userset.id,
        step.usersetRelation,
      );
      if (!exists) return false;
      return verifyStep(subject, step.userset, step.usersetRelation, step.member);
    }
    return false;
  }

  const permission = config.permissions[name];
  if (permission) return verifyRule(subject, object, permission.rewrite, step);
  return false;
}

async function verifyRule(
  subject: EntityRef,
  object: EntityRef,
  rule: RewriteRule,
  step: ResolutionStep,
): Promise<boolean> {
  switch (rule.kind) {
    case 'computedUserset':
      return verifyStep(subject, object, rule.name, step);
    case 'union': {
      if (step.kind !== 'union' || !entityEq(step.object, object)) return false;
      if (typeof step.branchIndex !== 'number') return false; // number must survive the round trip
      const child = rule.children[step.branchIndex];
      if (!child) return false;
      return verifyRule(subject, object, child, step.branch);
    }
    case 'intersection': {
      if (step.kind !== 'intersection' || !entityEq(step.object, object)) return false;
      if (!Array.isArray(step.branches)) return false; // array must survive the round trip
      if (step.branches.length !== rule.children.length) return false;
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        const branch = step.branches[i];
        if (!child || !branch) return false;
        if (!(await verifyRule(subject, object, child, branch))) return false;
      }
      return true;
    }
    case 'tupleToUserset': {
      if (step.kind !== 'tupleToUserset' || !entityEq(step.object, object)) return false;
      if (step.relation !== rule.relation || step.computedUserset !== rule.computedUserset)
        return false;
      const exists = await tupleExists(
        object,
        rule.relation,
        step.through.ns,
        step.through.id,
        null,
      );
      if (!exists) return false;
      return verifyStep(subject, step.through, rule.computedUserset, step.member);
    }
    // exclusion intentionally not handled — see this file's own top-of-file
    // doc comment for why that's a deliberate scope boundary, not a gap.
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Every check, allowed or denied, is logged.
// ---------------------------------------------------------------------------

describe('performCheck logs every check, allowed or denied', () => {
  it('an-allowed-check-inserts-a-checks-row-with-a-non-null-resolution-path-and-real-metadata', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const subject = ref('user', 'alice');
    const object = ref(ns, objectId);
    const result = await performCheck(pool, subject, object, 'view');
    expect(result.allowed).toBe(true);

    const row = await fetchLatestCheckRow(subject, 'view', object);
    expect(row.allowed).toBe(true);
    expect(row.subject_ns).toBe('user');
    expect(row.subject_id).toBe('alice');
    expect(row.relation).toBe('view');
    expect(row.object_ns).toBe(ns);
    expect(row.object_id).toBe(objectId);
    expect(row.resolution_path).not.toBeNull();
    expect(row.resolution_path).not.toBeUndefined();

    expect(Number.isInteger(row.depth)).toBe(true);
    expect(row.depth).toBeGreaterThanOrEqual(0);

    expect(row.duration_ms).not.toBeNull();
    expect(Number.isInteger(row.duration_ms as number)).toBe(true);
    expect(row.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('a-denied-check-inserts-a-checks-row-with-allowed-false-and-a-null-resolution-path', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    // No tuple written at all — bob has no path to anything here.

    const subject = ref('user', 'bob');
    const object = ref(ns, objectId);
    const result = await performCheck(pool, subject, object, 'view');
    expect(result.allowed).toBe(false);

    const row = await fetchLatestCheckRow(subject, 'view', object);
    expect(row.allowed).toBe(false);
    // Strictly SQL NULL — never an empty object, never omitted from the
    // row (the row itself must exist; only the column is null).
    expect(row.resolution_path).toBeNull();
    expect(Number.isInteger(row.depth)).toBe(true);
    expect(row.depth).toBeGreaterThanOrEqual(0);
  });

  it('a-check-pinned-via-attoken-persists-that-token-and-an-unpinned-check-persists-null', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    const token = await writeOk(tuple(ns, objectId, 'viewer', 'user', 'carol'));

    const subject = ref('user', 'carol');
    const object = ref(ns, objectId);

    await performCheck(pool, subject, object, 'view', { atToken: token });
    const pinnedRow = await fetchLatestCheckRow(subject, 'view', object);
    expect(pinnedRow.consistency_token).not.toBeNull();
    // bigint over the wire is a string (D-018) — compare numerically, not
    // lexicographically, or this assertion would be quietly meaningless
    // the moment token digit counts differ.
    expect(Number(pinnedRow.consistency_token)).toBe(token);

    await performCheck(pool, subject, object, 'view');
    const unpinnedRow = await fetchLatestCheckRow(subject, 'view', object);
    expect(unpinnedRow.consistency_token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// An allowed check's persisted, round-tripped path independently re-verifies.
// ---------------------------------------------------------------------------

describe("an allowed check's persisted, round-tripped resolution path independently re-verifies", () => {
  it('the-persisted-path-for-a-union-plus-direct-grant-check-round-trips-through-jsonb-and-reverifies', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [
        `namespace ${ns} {`,
        '  relation viewer: user',
        '  relation editor: user',
        '',
        '  permission view = viewer | editor',
        '}',
      ].join('\n'),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'dana'));

    const subject = ref('user', 'dana');
    const object = ref(ns, objectId);
    const result = await performCheck(pool, subject, object, 'view');
    expect(result.allowed).toBe(true);

    const row = await fetchLatestCheckRow(subject, 'view', object);
    expect(row.resolution_path).not.toBeNull();
    // Never the in-process value — this is what the driver parsed back
    // from the jsonb column on a fresh select.
    const path = row.resolution_path as ResolutionStep;
    expect(path.kind).toBe('union');
    if (path.kind === 'union') {
      expect(typeof path.branchIndex).toBe('number');
      expect(path.branch.kind).toBe('directGrant');
    }
    expect(await verifyStep(subject, object, 'view', path)).toBe(true);
  });

  it('the-persisted-path-for-an-intersection-and-nested-tupletouserset-check-round-trips-through-jsonb-and-reverifies', async () => {
    const folderNs = uniqueName('folder');
    const docNs = uniqueName('doc');
    await publishOk(
      [
        `namespace ${folderNs} {`,
        '  relation editor: user',
        '',
        '  permission view = editor',
        '}',
        '',
        `namespace ${docNs} {`,
        '  relation editor: user',
        `  relation parent: ${folderNs}`,
        '',
        '  permission trusted_edit = editor & parent->view',
        '}',
      ].join('\n'),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(docNs, objectId, 'editor', 'user', 'erin'));
    await writeOk(tuple(docNs, objectId, 'parent', folderNs, 'design'));
    await writeOk(tuple(folderNs, 'design', 'editor', 'user', 'erin'));

    const subject = ref('user', 'erin');
    const object = ref(docNs, objectId);
    const result = await performCheck(pool, subject, object, 'trusted_edit');
    expect(result.allowed).toBe(true);

    const row = await fetchLatestCheckRow(subject, 'trusted_edit', object);
    expect(row.resolution_path).not.toBeNull();
    const path = row.resolution_path as ResolutionStep;
    expect(path.kind).toBe('intersection');
    if (path.kind === 'intersection') {
      expect(Array.isArray(path.branches)).toBe(true);
      expect(path.branches).toHaveLength(2);
      const kinds = path.branches.map((b) => b.kind).sort();
      expect(kinds).toEqual(['directGrant', 'tupleToUserset']);
    }
    expect(await verifyStep(subject, object, 'trusted_edit', path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-042: a failed checks audit-log write fails the whole check.
// ---------------------------------------------------------------------------

describe('a failed checks audit-log write fails the whole check operation (D-042)', () => {
  it('a-failed-checks-insert-throws-and-discards-the-already-computed-answer-instead-of-returning-it', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    // A real grant — if the audit write failure were swallowed, this check
    // would compute allowed:true underneath and this test would only catch
    // the bug if it actually verifies the caller never sees that answer.
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'faye'));

    const subject = ref('user', 'faye');
    const object = ref(ns, objectId);

    // Simulates an infrastructure fault on exactly one query — the
    // `checks` insert — while every other query `productionCheck` issues
    // underneath still runs for real against real Postgres. This is not
    // mocking the thing under test; it's the same "vi.spyOn one specific
    // failure mode" isolation `test/unit/cli/soundness.test.ts` already
    // established for Phase 5.
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<unknown>;
    const spy = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      const text: unknown = args[0];
      if (typeof text === 'string' && text.trim().toLowerCase().startsWith('insert into checks')) {
        throw new Error('simulated checks audit-log write failure');
      }
      return originalQuery(...args);
    }) as any);

    await expect(performCheck(pool, subject, object, 'view')).rejects.toThrow(
      /simulated checks audit-log write failure/,
    );

    spy.mockRestore();

    // The discarded answer never made it into the audit trail either — no
    // partial/incomplete row for this attempt.
    expect(await countCheckRows(subject, 'view', object)).toBe(0);

    // And the engine itself is unaffected by the mock having been removed:
    // a real, un-mocked call for the same subject/object now succeeds and
    // logs normally, proving the throw above was really about the audit
    // write, not some side effect that broke the pool.
    const result = await performCheck(pool, subject, object, 'view');
    expect(result.allowed).toBe(true);
    expect(await countCheckRows(subject, 'view', object)).toBe(1);
  });
});
