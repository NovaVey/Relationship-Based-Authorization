/**
 * Production resolver (Phase 4/6) — resolution-path independent
 * re-verification, against real Postgres. `.claude/commands/build-authz-
 * service.md` §6.7, §9 Phase 6's exit criterion ("an allowed check's log
 * entry contains a path that independently re-verifies"), and §8's worked
 * chain example.
 *
 * **This file is the actual proof, not a shape assertion.** Everything
 * below — `verifyResolutionStep`/`verifyDisproofStep` and their
 * `verifyAgainstRule`/`verifyDisproofAgainstRule`/`verifyRelationDisproof`
 * helpers — is written from `src/resolve/production/resolver.ts`'s own
 * EXPORTED types and doc comments only (never its private helpers, never
 * its SQL bodies or recursion structure), the same discipline every other
 * production-resolver test file in this directory already holds itself
 * to. Every tuple-existence claim the verifier checks is confirmed with a
 * *fresh, independently-written* SQL query against the real database — it
 * never calls back into `resolver.ts`'s own query functions, and never
 * asks "does any path exist" (it only validates the *specific* chain of
 * claims a given step/disproof makes). See `test/unit/resolve/reference-
 * resolver.resolution-path.test.ts` for the same discipline applied to the
 * in-memory oracle; this file is the independent, Postgres-backed
 * counterpart, deliberately not sharing a line of verifier code with it
 * either (a bug in one verifier that happened to also exist in the other
 * would defeat the whole point).
 *
 * The "tamper" tests at the bottom prove this verifier has power — a valid
 * path/disproof is mutated one field at a time and the verifier must
 * reject every mutation (matches this project's own standing discipline,
 * D-024/D-027/D-029: a check that has never been observed failing proves
 * nothing).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../../src/store/tuples.js';
import { publishSchema, getLatestNamespaceConfig } from '../../../../src/schema/publish.js';
import type { NamespaceConfig, RewriteRule } from '../../../../src/schema/dsl/types.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import type {
  ClosureNode,
  DisproofStep,
  EntityRef,
  ResolutionStep,
} from '../../../../src/resolve/production/resolver.js';
import { runMigrations } from '../../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../src/store/migrations', import.meta.url));

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

function entityEq(a: EntityRef, b: EntityRef): boolean {
  return a.ns === b.ns && a.id === b.id;
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

interface RealTupleRow {
  subject_ns: string;
  subject_id: string;
  subject_relation: string | null;
}

async function realTuplesOn(object: EntityRef, relation: string): Promise<RealTupleRow[]> {
  const { rows } = await pool.query<RealTupleRow>(
    `select subject_ns, subject_id, subject_relation from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3`,
    [object.ns, object.id, relation],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// The independent verifier.
// ---------------------------------------------------------------------------

async function getConfigOrThrow(ns: string): Promise<NamespaceConfig> {
  const config = await getLatestNamespaceConfig(pool, ns);
  if (!config) throw new Error(`verifier: no published schema for namespace '${ns}'`);
  return config;
}

async function verifyResolutionStep(
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
      return verifyResolutionStep(subject, step.userset, step.usersetRelation, step.member);
    }
    return false;
  }

  const permission = config.permissions[name];
  if (permission) {
    return verifyAgainstRule(subject, object, permission.rewrite, step);
  }
  return false;
}

async function verifyAgainstRule(
  subject: EntityRef,
  object: EntityRef,
  rule: RewriteRule,
  step: ResolutionStep,
): Promise<boolean> {
  switch (rule.kind) {
    case 'computedUserset':
      return verifyResolutionStep(subject, object, rule.name, step);
    case 'union': {
      if (step.kind !== 'union' || !entityEq(step.object, object)) return false;
      const child = rule.children[step.branchIndex];
      if (!child) return false;
      return verifyAgainstRule(subject, object, child, step.branch);
    }
    case 'intersection': {
      if (step.kind !== 'intersection' || !entityEq(step.object, object)) return false;
      if (step.branches.length !== rule.children.length) return false;
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        const branch = step.branches[i];
        if (!child || !branch) return false;
        if (!(await verifyAgainstRule(subject, object, child, branch))) return false;
      }
      return true;
    }
    case 'exclusion': {
      if (step.kind !== 'exclusion' || !entityEq(step.object, object)) return false;
      const baseOk = await verifyAgainstRule(subject, object, rule.base, step.base);
      if (!baseOk) return false;
      return verifyDisproofAgainstRule(subject, object, rule.subtract, step.subtractDisproof);
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
      ).then(async (plain) => {
        if (plain) return true;
        // tuple-to-userset follows the edge regardless of the followed
        // tuple's own subject_relation (see resolver.ts's own doc
        // comment on listTupleSubjects) — check both shapes.
        const real = await realTuplesOn(object, rule.relation);
        return real.some(
          (r) => r.subject_ns === step.through.ns && r.subject_id === step.through.id,
        );
      });
      if (!exists) return false;
      return verifyResolutionStep(subject, step.through, rule.computedUserset, step.member);
    }
    default:
      return false;
  }
}

async function verifyDisproofAgainstRule(
  subject: EntityRef,
  object: EntityRef,
  rule: RewriteRule,
  disproof: DisproofStep,
): Promise<boolean> {
  switch (rule.kind) {
    case 'computedUserset':
      return verifyDisproofStep(subject, object, rule.name, disproof);
    case 'union': {
      if (disproof.kind !== 'unionDisproof' || !entityEq(disproof.object, object)) return false;
      if (disproof.branches.length !== rule.children.length) return false;
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        const branch = disproof.branches[i];
        if (!child || !branch) return false;
        if (!(await verifyDisproofAgainstRule(subject, object, child, branch))) return false;
      }
      return true;
    }
    case 'intersection': {
      if (disproof.kind !== 'intersectionDisproof' || !entityEq(disproof.object, object))
        return false;
      const child = rule.children[disproof.branchIndex];
      if (!child) return false;
      return verifyDisproofAgainstRule(subject, object, child, disproof.branch);
    }
    case 'exclusion': {
      if (disproof.kind !== 'exclusionDisproof' || !entityEq(disproof.object, object)) return false;
      if (disproof.reason.kind === 'baseDisproven') {
        return verifyDisproofAgainstRule(subject, object, rule.base, disproof.reason.base);
      }
      return verifyAgainstRule(subject, object, rule.subtract, disproof.reason.subtract);
    }
    case 'tupleToUserset': {
      if (disproof.kind !== 'tupleToUsersetDisproof' || !entityEq(disproof.object, object))
        return false;
      if (disproof.relation !== rule.relation) return false;
      const real = await realTuplesOn(object, rule.relation);
      if (disproof.followed.length !== real.length) return false;
      for (const t of real) {
        const entry = disproof.followed.find(
          (f) => f.through.ns === t.subject_ns && f.through.id === t.subject_id,
        );
        if (!entry) return false;
        if (
          !(await verifyDisproofStep(subject, entry.through, rule.computedUserset, entry.disproof))
        ) {
          return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/** Verifies a `BoundReachedDisproof`/`UndeclaredDisproof` leaf, or dispatches a `RelationDisproof`/combinator disproof at `(object, name)`. */
async function verifyDisproofStep(
  subject: EntityRef,
  object: EntityRef,
  name: string,
  disproof: DisproofStep,
): Promise<boolean> {
  if (disproof.kind === 'boundReached') {
    // The production resolver's own TS-level guard is opaque to this
    // verifier (it isn't re-run here) — the claim is accepted structurally
    // (object/name match) since re-deriving the exact same visited-set
    // bookkeeping the resolver used would mean re-implementing its own
    // traversal, not validating a self-contained certificate. This is the
    // one legitimate place this verifier defers rather than independently
    // re-derives — see this file's own top-of-file note and this task's
    // final report for why that's a stated, deliberate boundary, not an
    // oversight.
    return entityEq(disproof.object, object) && disproof.name === name;
  }
  if (disproof.kind === 'undeclared') {
    if (!entityEq(disproof.object, object) || disproof.name !== name) return false;
    const config = await getLatestNamespaceConfig(pool, object.ns);
    if (!config) return true;
    return !config.relations[name] && !config.permissions[name];
  }
  const config = await getConfigOrThrow(object.ns);
  const relation = config.relations[name];
  if (relation) {
    if (disproof.kind !== 'relationDisproof') return false;
    return verifyRelationDisproof(subject, object, name, disproof);
  }
  const permission = config.permissions[name];
  if (permission) {
    return verifyDisproofAgainstRule(subject, object, permission.rewrite, disproof);
  }
  return false;
}

/**
 * Verifies a `RelationDisproof` reachability certificate — see
 * `resolver.ts`'s own top-of-file doc comment for the shape. Confirmed
 * structurally, entirely against fresh Postgres queries:
 *
 * 1. Exactly one node has `depth === 0` and its `key` matches `(object,
 *    relation)` — the certificate's own claimed root.
 * 2. Every node's `tuples` list is an EXACT match (both directions) for
 *    the real tuples Postgres has on that node right now — no omission, no
 *    fabrication.
 * 3. No node's tuples include a plain match for `subject` (the whole
 *    reason the disproof holds).
 * 4. Every userset edge out of every node either lands on another node in
 *    the same certificate, or is legitimately excluded — by depth (the
 *    node's own `depth >= maxDepth`) or by cycle (the edge's target key
 *    already appears in the node's own `ancestorPath`), exactly mirroring
 *    the real SQL recursive CTE's own two independent guards
 *    (`docs/DECISIONS.md` D-026).
 */
async function verifyRelationDisproof(
  subject: EntityRef,
  object: EntityRef,
  relation: string,
  disproof: Extract<DisproofStep, { kind: 'relationDisproof' }>,
): Promise<boolean> {
  if (disproof.object.ns !== object.ns || disproof.object.id !== object.id) return false;
  if (disproof.relation !== relation) return false;

  const roots = disproof.nodes.filter((n) => n.depth === 0);
  if (roots.length !== 1) return false;
  const root = roots[0];
  if (
    !root ||
    root.key.ns !== object.ns ||
    root.key.id !== object.id ||
    root.key.relation !== relation
  ) {
    return false;
  }

  const nodeByKey = new Map<string, ClosureNode>(
    disproof.nodes.map((n) => [`${n.key.ns}:${n.key.id}#${n.key.relation}`, n]),
  );

  for (const node of disproof.nodes) {
    const real = await realTuplesOn({ ns: node.key.ns, id: node.key.id }, node.key.relation);
    if (real.length !== node.tuples.length) return false;

    for (const t of real) {
      if (t.subject_relation === null) {
        const covered = node.tuples.some(
          (claim) =>
            claim.kind === 'plain' &&
            claim.subject.ns === t.subject_ns &&
            claim.subject.id === t.subject_id,
        );
        if (!covered) return false;
        if (t.subject_ns === subject.ns && t.subject_id === subject.id) return false; // would have been a real match
        continue;
      }
      const claim = node.tuples.find(
        (c) =>
          c.kind === 'userset' &&
          c.userset.ns === t.subject_ns &&
          c.userset.id === t.subject_id &&
          c.usersetRelation === t.subject_relation,
      );
      if (!claim) return false;
      const targetKey = `${t.subject_ns}:${t.subject_id}#${t.subject_relation}`;
      if (nodeByKey.has(targetKey)) continue; // legitimate continuation
      if (node.depth >= disproof.maxDepth) continue; // excluded by depth
      const alreadyOnPath = node.ancestorPath.some(
        (k) => k.ns === t.subject_ns && k.id === t.subject_id && k.relation === t.subject_relation,
      );
      if (alreadyOnPath) continue; // excluded by cycle
      return false; // neither included nor legitimately excluded — incomplete/invalid certificate
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Positive cases: real allowed:true results, independently re-verified.
// ---------------------------------------------------------------------------

describe('a direct grant produces a path that independently re-verifies', () => {
  it('direct-grant-path-reverifies', async () => {
    const ns = uniqueName('doc');
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '  relation editor: user',
      '',
      '  permission view = viewer | editor',
      '}',
    ].join('\n');
    await publishOk(source);
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view');
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;
    expect(result.path.kind).toBe('union');

    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(ns, objectId), 'view', result.path),
    ).toBe(true);
  });
});

describe('a nested-group tuple-to-userset chain produces a path that independently re-verifies', () => {
  it('nested-group-path-reverifies', async () => {
    const groupNs = uniqueName('group');
    const folderNs = uniqueName('folder');
    const docNs = uniqueName('document');
    const source = [
      `namespace ${groupNs} {`,
      `  relation member: user | ${groupNs}#member`,
      '}',
      '',
      `namespace ${folderNs} {`,
      `  relation editor: user | ${groupNs}#member`,
      '',
      '  permission view = editor',
      '}',
      '',
      `namespace ${docNs} {`,
      `  relation parent: ${folderNs}`,
      '',
      '  permission view = parent->view',
      '}',
    ].join('\n');
    await publishOk(source);
    await writeOk(tuple(groupNs, 'eng', 'member', 'user', 'alice'));
    await writeOk(tuple(folderNs, 'design', 'editor', groupNs, 'eng', 'member'));
    await writeOk(tuple(docNs, 'readme', 'parent', folderNs, 'design'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(docNs, 'readme'), 'view');
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;
    expect(result.path.kind).toBe('tupleToUserset');
    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(docNs, 'readme'), 'view', result.path),
    ).toBe(true);
  });
});

describe('an intersection produces a path recording every branch, which independently re-verifies', () => {
  it('intersection-path-reverifies', async () => {
    const ns = uniqueName('doc');
    const source = [
      `namespace ${ns} {`,
      '  relation owner: user',
      '  relation editor: user',
      '',
      '  permission trusted_edit = editor & owner',
      '}',
    ].join('\n');
    await publishOk(source);
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'editor', 'user', 'dave'));
    await writeOk(tuple(ns, objectId, 'owner', 'user', 'dave'));

    const result = await productionCheck(
      pool,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path || result.path.kind !== 'intersection')
      throw new Error('expected intersection');
    expect(result.path.branches).toHaveLength(2);
    expect(
      await verifyResolutionStep(
        ref('user', 'dave'),
        ref(ns, objectId),
        'trusted_edit',
        result.path,
      ),
    ).toBe(true);
  });
});

describe('an exclusion produces a path with a base proof and a subtract disproof (through a nested userset), both of which independently re-verify', () => {
  it('exclusion-path-with-nested-userset-disproof-reverifies', async () => {
    const groupNs = uniqueName('group');
    const ns = uniqueName('doc');
    const source = [
      `namespace ${groupNs} {`,
      '  relation member: user',
      '}',
      '',
      `namespace ${ns} {`,
      '  relation viewer: user',
      `  relation banned: user | ${groupNs}#member`,
      '',
      '  permission unbanned_view = viewer - banned',
      '}',
    ].join('\n');
    await publishOk(source);
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'frank'));
    await writeOk(tuple(ns, objectId, 'banned', groupNs, 'exiled', 'member'));
    await writeOk(tuple(groupNs, 'exiled', 'member', 'user', 'gina'));

    const result = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path || result.path.kind !== 'exclusion') throw new Error('expected exclusion');
    expect(result.path.subtractDisproof.kind).toBe('relationDisproof');
    if (result.path.subtractDisproof.kind === 'relationDisproof') {
      // Two closure nodes: the object's own `banned` frontier and the
      // group's `member` frontier reached through it — the certificate is
      // not empty/trivial, it accounts for gina's real membership tuple.
      expect(result.path.subtractDisproof.nodes).toHaveLength(2);
    }
    expect(
      await verifyResolutionStep(
        ref('user', 'frank'),
        ref(ns, objectId),
        'unbanned_view',
        result.path,
      ),
    ).toBe(true);
  });

  it('exclusion-subtract-disproof-through-a-real-cycle-reverifies', async () => {
    // A guaranteed cyclic userset-subject nesting (grp:x <-> grp:y) inside
    // the subtract branch — the disproof certificate must show the cycle
    // edge is legitimately excluded (its target already on the
    // ancestorPath), not just that the closure happens to be small.
    const groupNs = uniqueName('grp');
    const ns = uniqueName('doc');
    const source = [
      `namespace ${groupNs} {`,
      `  relation member: user | ${groupNs}#member`,
      '}',
      '',
      `namespace ${ns} {`,
      '  relation viewer: user',
      `  relation banned: user | ${groupNs}#member`,
      '',
      '  permission unbanned_view = viewer - banned',
      '}',
    ].join('\n');
    await publishOk(source);
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'frank'));
    await writeOk(tuple(ns, objectId, 'banned', groupNs, 'x', 'member'));
    await writeOk(tuple(groupNs, 'x', 'member', groupNs, 'y', 'member'));
    await writeOk(tuple(groupNs, 'y', 'member', groupNs, 'x', 'member'));
    // A decoy naming frank elsewhere, unrelated to the cycle — see
    // docs/DECISIONS.md D-027 for why an unrelated decoy matters for
    // forcing the planner to genuinely traverse the cycle.
    const decoyNs = uniqueName('decoy');
    await publishOk([`namespace ${decoyNs} {`, '  relation member: user', '}'].join('\n'));
    await writeOk(tuple(decoyNs, 'x', 'member', 'user', 'frank'));

    const result = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;
    expect(
      await verifyResolutionStep(
        ref('user', 'frank'),
        ref(ns, objectId),
        'unbanned_view',
        result.path,
      ),
    ).toBe(true);
  });
});

describe('checks.depth reflects the actual recursion depth reached, not just the configured ceiling', () => {
  it('depth-reflects-real-recursion-not-just-the-ceiling', async () => {
    const ns = uniqueName('doc');
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '',
      '  permission view = viewer',
      '}',
    ].join('\n');
    await publishOk(source);
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view', {
      maxDepth: 25,
    });
    expect(result.allowed).toBe(true);
    // A one-hop direct grant on a permission never gets anywhere near the
    // configured ceiling — proving `depth` is a real high-water mark, not
    // an echo of whatever `maxDepth` was passed in.
    expect(result.depth).toBeLessThan(25);
    expect(result.depth).toBeGreaterThanOrEqual(1);
  });

  /**
   * Full-repo audit finding #11: the test directly above reaches its grant
   * via a *direct* tuple on the permission's own relation — SQL-side
   * frontier depth 0 — so its assertion (`depth` between 1 and 25) is
   * fully satisfied by TypeScript-level `resolve()`/`evalRewrite` depth
   * bookkeeping alone; if `sqlRelationMembershipWithWitness`'s own
   * frontier-depth folding into `WalkContext.depthReached` (see
   * `docs/DECISIONS.md` D-038: `checks.depth` is "the max of both [the
   * TS-level walk and every SQL-level recursive CTE it issued], not a
   * separately-reported pair") were deleted entirely, this test would
   * still pass. This fixture closes that gap: the permission itself is
   * shallow in the rewrite-rule tree (`permission view = viewer`, a single
   * computedUserset hop — one level, same as the fixture above), but
   * `viewer`'s own relation is reached only via three levels of nested-
   * group tuples (`group:g0#member -> group:g1#member -> group:g2#member ->
   * user:alice`), forcing the real SQL-side recursive CTE to walk several
   * frontier levels deep to find alice's membership before this check can
   * resolve `allowed: true` at all.
   *
   * The exact expected `depth` value (3) was confirmed empirically against
   * this project's own real local Postgres fixture before being trusted —
   * this project's own established "verify by actually running it"
   * standard (`docs/DECISIONS.md` D-008/D-009/D-070) — rather than assumed
   * from the informal per-hop cost language in D-069's own writeup (which
   * describes a *budget* threshold, not this field's own exact numbering
   * scheme): at `maxDepth: 25` (this permission's default-sized ceiling,
   * unconstrained for this fixture's real cost), `productionCheck` returns
   * `allowed: true, depth: 3` — strictly greater than the `direct-grant-
   * path-reverifies` fixture's own `depth: 1` for a permission of the
   * identical rewrite-rule shape, which is the load-bearing contrast: the
   * only structural difference between the two fixtures is how many levels
   * of real, stored `relation_tuples` rows separate the object from the
   * subject, and that difference is exactly what shows up in `depth` here.
   * Also independently confirmed via the same live probe that this
   * fixture's own allow/deny boundary matches `cross-resolver-agreement
   * .integration.test.ts`'s already-verified boundary for the identical
   * tuple shape (denied at `maxDepth: 3`, allowed at `maxDepth: 4`) — the
   * two files agree on where this fixture's real cost sits, from two
   * independently written test files.
   */
  it('depth-reflects-real-sql-side-recursive-cte-traversal-through-nested-group-membership-not-just-the-ts-level-walk', async () => {
    const groupNs = uniqueName('group');
    const docNs = uniqueName('doc');
    const source = [
      `namespace ${groupNs} {`,
      `  relation member: user | ${groupNs}#member`,
      '}',
      '',
      `namespace ${docNs} {`,
      `  relation viewer: user | ${groupNs}#member`,
      '  permission view = viewer',
      '}',
    ].join('\n');
    await publishOk(source);

    const objectId = uniqueName('obj');
    const g0 = uniqueName('g0');
    const g1 = uniqueName('g1');
    const g2 = uniqueName('g2');

    // doc:obj --viewer--> group:g0#member --member--> group:g1#member
    //   --member--> group:g2#member --member--> user:alice (direct grant)
    await writeOk(tuple(docNs, objectId, 'viewer', groupNs, g0, 'member'));
    await writeOk(tuple(groupNs, g0, 'member', groupNs, g1, 'member'));
    await writeOk(tuple(groupNs, g1, 'member', groupNs, g2, 'member'));
    await writeOk(tuple(groupNs, g2, 'member', 'user', 'alice'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(docNs, objectId), 'view', {
      maxDepth: 25,
    });

    expect(result.allowed).toBe(true);
    // The literal claim: a check whose permission is exactly as shallow as
    // the direct-grant fixture above (one computedUserset hop) still
    // reports a deeper `depth` here, because real SQL-side recursion was
    // genuinely required to find the grant — the number is not an echo of
    // rewrite-rule-tree shallowness alone.
    expect(result.depth).toBe(3);
    expect(result.depth).toBeGreaterThan(1);
    expect(result.depth).toBeLessThan(25);

    // Independently re-verify the produced path against fresh Postgres
    // queries too, matching this file's own established discipline for
    // every other positive fixture — a deep `depth` number paired with a
    // resolution path that doesn't actually check out would be its own
    // kind of bug.
    expect(result.path).toBeDefined();
    if (!result.path) return;
    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(docNs, objectId), 'view', result.path),
    ).toBe(true);
  });

  /**
   * Full-repo audit finding #17: `docs/DECISIONS.md` D-038 justifies
   * `checks.depth` as a high-water mark specifically because "a union with
   * three failing children before a fourth succeeds did real work at each
   * of their depths, not just the last one." Both tests above are
   * single-path — the direct-grant fixture never recurses past depth 1 at
   * all, and the nested-group fixture has exactly one branch, which
   * happens to be the one that succeeds. Neither distinguishes "reports
   * the failing branches' own depth" from "reports only the winning
   * branch's depth" — a regression that made `depthReached` reset (rather
   * than accumulate via `Math.max`) on every new union branch would still
   * pass both.
   *
   * `permission p = ra | rb | rc | rd`: `ra`/`rb`/`rc` are each declared
   * exactly like this file's own `depth-reflects-real-sql-side-recursive-
   * cte-traversal...` fixture above — a three-level nested-group chain
   * (`group:X0#member -> group:X1#member -> group:X2#member`) — but each
   * one's chain ends in a grant to someone other than the checked subject,
   * so each is a real, three-level-deep SQL-side exploration that still
   * *fails*. `rd` is a single, shallow direct grant to the checked
   * subject, declared *last* in the union so `evalRewrite`'s union loop
   * (which evaluates children in declaration order and returns on the
   * first success) genuinely evaluates — and fully explores — `ra`, `rb`,
   * and `rc` first, before ever reaching `rd`.
   */
  it('depth-reflects-a-unions-deep-failing-branches-not-just-its-shallow-winning-one', async () => {
    const groupNs = uniqueName('group');
    const docNs = uniqueName('doc');
    const source = [
      `namespace ${groupNs} {`,
      `  relation member: user | ${groupNs}#member`,
      '}',
      '',
      `namespace ${docNs} {`,
      `  relation ra: user | ${groupNs}#member`,
      `  relation rb: user | ${groupNs}#member`,
      `  relation rc: user | ${groupNs}#member`,
      '  relation rd: user',
      '',
      '  permission p = ra | rb | rc | rd',
      '}',
    ].join('\n');
    await publishOk(source);

    const objectId = uniqueName('obj');

    // Three independent three-level nested-group chains, one per failing
    // branch — each one real SQL-side recursion, each one a dead end for
    // `alice` (the grant at the bottom of each chain names `nobody`, never
    // `alice`).
    for (const [relation, prefix] of [
      ['ra', 'ga'],
      ['rb', 'gb'],
      ['rc', 'gc'],
    ] as const) {
      const g0 = uniqueName(`${prefix}0`);
      const g1 = uniqueName(`${prefix}1`);
      const g2 = uniqueName(`${prefix}2`);
      await writeOk(tuple(docNs, objectId, relation, groupNs, g0, 'member'));
      await writeOk(tuple(groupNs, g0, 'member', groupNs, g1, 'member'));
      await writeOk(tuple(groupNs, g1, 'member', groupNs, g2, 'member'));
      await writeOk(tuple(groupNs, g2, 'member', 'user', 'nobody'));
    }

    // The real, shallow grant — the only thing that actually makes this
    // check resolve `allowed: true`.
    await writeOk(tuple(docNs, objectId, 'rd', 'user', 'alice'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(docNs, objectId), 'p', {
      maxDepth: 25,
    });

    expect(result.allowed).toBe(true);
    // The literal claim: this check's own winning branch (`rd`) is exactly
    // as shallow as the direct-grant fixture at the top of this describe
    // block (which asserts `depth` between 1 and 25, typically bottoming
    // out well below 25) — if `depth` reflected only the winning branch,
    // it would land in that same shallow range here too. Instead, the
    // three failing branches evaluated first each independently drove the
    // SQL-side recursive CTE three levels deep (the same shape and the
    // same empirically-confirmed depth as this file's own nested-group
    // fixture above), and that work is what `depth` must still show.
    expect(result.depth).toBe(3);
    expect(result.depth).toBeGreaterThan(1);

    expect(result.path).toBeDefined();
    if (!result.path) return;
    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(docNs, objectId), 'p', result.path),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Power check: the verifier must actually be able to fail.
// ---------------------------------------------------------------------------

describe('the independent verifier rejects a tampered path — proving it has power, not just that it accepts what the resolver already produced', () => {
  it('rejects-a-direct-grant-step-naming-a-tuple-that-does-not-exist', async () => {
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
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));
    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view');
    if (!result.allowed || !result.path || result.path.kind !== 'union')
      throw new Error('fixture setup');

    const tampered: ResolutionStep = {
      ...result.path,
      branch: {
        ...(result.path.branch as Extract<ResolutionStep, { kind: 'directGrant' }>),
        subject: { ns: 'user', id: 'nobody' },
      },
    };
    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(ns, objectId), 'view', tampered),
    ).toBe(false);
  });

  it('rejects-a-union-step-pointing-at-an-out-of-range-branch-index', async () => {
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
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));
    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view');
    if (!result.allowed || !result.path || result.path.kind !== 'union')
      throw new Error('fixture setup');

    const tampered: ResolutionStep = { ...result.path, branchIndex: 99 };
    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(ns, objectId), 'view', tampered),
    ).toBe(false);
  });

  it('rejects-an-exclusion-path-whose-subtract-disproof-omits-a-real-closure-node', async () => {
    const groupNs = uniqueName('group');
    const ns = uniqueName('doc');
    await publishOk(
      [
        `namespace ${groupNs} {`,
        '  relation member: user',
        '}',
        '',
        `namespace ${ns} {`,
        '  relation viewer: user',
        `  relation banned: user | ${groupNs}#member`,
        '',
        '  permission unbanned_view = viewer - banned',
        '}',
      ].join('\n'),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'frank'));
    await writeOk(tuple(ns, objectId, 'banned', groupNs, 'exiled', 'member'));
    await writeOk(tuple(groupNs, 'exiled', 'member', 'user', 'gina'));

    const result = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    if (!result.allowed || !result.path || result.path.kind !== 'exclusion')
      throw new Error('fixture setup');
    if (result.path.subtractDisproof.kind !== 'relationDisproof') throw new Error('fixture setup');

    // Drop the second closure node (the group's own membership frontier) —
    // the certificate no longer accounts for gina's real tuple.
    const tamperedDisproof: DisproofStep = {
      ...result.path.subtractDisproof,
      nodes: result.path.subtractDisproof.nodes.slice(0, 1),
    };
    const tampered: ResolutionStep = { ...result.path, subtractDisproof: tamperedDisproof };
    expect(
      await verifyResolutionStep(
        ref('user', 'frank'),
        ref(ns, objectId),
        'unbanned_view',
        tampered,
      ),
    ).toBe(false);
  });

  it('rejects-a-forged-relationdisproof-that-claims-the-queried-subjects-own-real-ban-tuple-names-someone-else', async () => {
    // frank himself is banned — the real result must be denied. A
    // maliciously-constructed certificate could still claim frank's own
    // ban tuple names someone else, to fake an allow.
    const ns = uniqueName('doc');
    await publishOk(
      [
        `namespace ${ns} {`,
        '  relation viewer: user',
        '  relation banned: user',
        '',
        '  permission unbanned_view = viewer - banned',
        '}',
      ].join('\n'),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'frank'));
    await writeOk(tuple(ns, objectId, 'banned', 'user', 'frank'));

    const forged: ResolutionStep = {
      kind: 'exclusion',
      object: ref(ns, objectId),
      base: {
        kind: 'directGrant',
        object: ref(ns, objectId),
        relation: 'viewer',
        subject: ref('user', 'frank'),
      },
      subtractDisproof: {
        kind: 'relationDisproof',
        object: ref(ns, objectId),
        relation: 'banned',
        maxDepth: 25,
        nodes: [
          {
            key: { ns, id: objectId, relation: 'banned' },
            depth: 0,
            ancestorPath: [{ ns, id: objectId, relation: 'banned' }],
            tuples: [{ kind: 'plain', subject: ref('user', 'someone-else') }],
          },
        ],
      },
    };
    expect(
      await verifyResolutionStep(ref('user', 'frank'), ref(ns, objectId), 'unbanned_view', forged),
    ).toBe(false);
  });

  it('rejects-a-usersetmembership-step-naming-a-tuple-that-does-not-exist', async () => {
    const groupNs = uniqueName('group');
    const ns = uniqueName('doc');
    await publishOk([`namespace ${groupNs} {`, '  relation member: user', '}'].join('\n'));
    await publishOk(
      [`namespace ${ns} {`, `  relation editor: user | ${groupNs}#member`, '}'].join('\n'),
    );
    await writeOk(tuple(groupNs, 'eng', 'member', 'user', 'alice'));

    const forged: ResolutionStep = {
      kind: 'usersetMembership',
      object: ref(ns, 'readme'),
      relation: 'editor',
      // No such tuple: this doc's editor never names group:eng#member.
      userset: ref(groupNs, 'eng'),
      usersetRelation: 'member',
      member: {
        kind: 'directGrant',
        object: ref(groupNs, 'eng'),
        relation: 'member',
        subject: ref('user', 'alice'),
      },
    };
    expect(
      await verifyResolutionStep(ref('user', 'alice'), ref(ns, 'readme'), 'editor', forged),
    ).toBe(false);
  });
});
