/**
 * `expand()` (Phase 6) — build spec §7's `authz expand`, §9 Phase 6's exit
 * criterion ("`expand()` returns the exact subject tree for an
 * object#relation, including tuple-to-userset members"), and §6.4's cycle
 * detection/depth-budget requirement applied to a tree walk, not just a
 * boolean check.
 *
 * Runs against a real, ephemeral Postgres container, same convention as
 * every other `*.integration.test.ts` file in this repo (see
 * `docs/DECISIONS.md` D-019/D-030).
 *
 * **The cycle-termination tests below are not trusted from their own
 * passing result.** Per this project's own repeatedly-learned lesson
 * (D-024/D-027/D-029): a termination test proves nothing about the
 * specific mechanism it claims to test unless it can demonstrably fail
 * when that mechanism, and only that mechanism, is broken. This was
 * verified for real during this phase, not assumed — `expandName`'s cycle
 * guard (`src/audit/expand.ts`) was temporarily removed (only the
 * `visiting.has(key)` check; the independent depth ceiling was left
 * intact, mirroring D-024's own precedent so the depth cap alone can't be
 * what's doing the work). The test below then genuinely failed — not a
 * stack overflow (this walk is `await`-based, so each hop yields back to
 * the event loop rather than growing the native call stack) but a real
 * timeout: still running (real, sequential Postgres round trips around the
 * 2-node cycle) well past 15 seconds, versus well under a second with the
 * guard intact. The guard was then restored and confirmed byte-identical
 * before this file was considered done. See this task's own final report
 * for the exact before/after numbers observed, since re-doing that
 * mutation as part of the committed suite itself would be the same
 * "mutating a shipped source file at test-run time is unsafe" problem
 * `test/isolation/differential-soundness.fuzz.test.ts`'s own doc comment
 * already states for the synthetic-double tests elsewhere in this repo.
 *
 * **A second, independent cyclic-termination test below closes full-repo
 * audit finding #8 (MEDIUM, `docs/DECISIONS.md` D-092).** The cyclic test
 * just described drives the cycle exclusively through
 * `expandRelation`'s own userset-expansion call (a stored userset-subject
 * tuple, `group:a#member` nesting `group:b#member` nesting back to
 * `group:a#member`) — a textually and structurally distinct call site in
 * `expandRewrite`'s `tupleToUserset` branch (`src/audit/expand.ts`, the
 * recursive `expandName` call inside its `case 'tupleToUserset':`) shares
 * only the same `visiting` guard but was never independently exercised by
 * any committed test before this fix, the same class of gap D-087 (finding
 * #4) already found and fixed once for a different file
 * (`test/unit/resolve/reference-resolver.graph-shape.test.ts`). The new
 * test below drives a cycle through `permission view = viewer |
 * parent->view` with `parent` tuples forming `folder:a -> folder:b ->
 * folder:a` — a plain-relation cycle with no userset-subject nesting
 * anywhere in it, so a pass here can only be explained by the
 * `tupleToUserset` branch's own use of `visiting` actually working, not by
 * incidentally reusing coverage `expandRelation`'s test already provides.
 * Verified the identical way: `visiting.has(key)` temporarily removed,
 * confirmed this new test then hangs (a real timeout, not a stack
 * overflow, same reasoning as above), guard restored and confirmed
 * byte-identical before this file was considered done.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { expand } from '../../../src/audit/expand.js';
import type { EntityRef, ExpandNode } from '../../../src/audit/expand.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract: without this, an idle client hitting a
    // background/network-level error (most commonly this file's own container
    // being stopped in afterAll while a pooled connection was still technically
    // open, though the identical gap applies to any Pool in this file) crashes
    // the whole test run with an unhandled 'error' event, even though every
    // real assertion already passed — a known pg gotcha, not a bug in this
    // file's own test logic. Logged, not swallowed: still visible if it ever
    // fires somewhere other than expected teardown.
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

/** Collects every `directSubjects` entry anywhere in a tree, for an order-independent "who's really in this set" assertion. */
function collectDirectSubjects(node: ExpandNode): EntityRef[] {
  switch (node.kind) {
    case 'relation':
      return [
        ...node.directSubjects,
        ...node.usersets.flatMap((m) => collectDirectSubjects(m.expansion)),
      ];
    case 'union':
    case 'intersection':
      return node.children.flatMap(collectDirectSubjects);
    case 'exclusion':
      return [...collectDirectSubjects(node.base), ...collectDirectSubjects(node.subtract)];
    case 'tupleToUserset':
      return node.children.flatMap((c) => collectDirectSubjects(c.expansion));
    default:
      return [];
  }
}

function findNodeKind(node: ExpandNode, kind: ExpandNode['kind']): boolean {
  if (node.kind === kind) return true;
  switch (node.kind) {
    case 'relation':
      return node.usersets.some((m) => findNodeKind(m.expansion, kind));
    case 'union':
    case 'intersection':
      return node.children.some((c) => findNodeKind(c, kind));
    case 'exclusion':
      return findNodeKind(node.base, kind) || findNodeKind(node.subtract, kind);
    case 'tupleToUserset':
      return node.children.some((c) => findNodeKind(c.expansion, kind));
    default:
      return false;
  }
}

describe('expand() returns the exact subject tree, including tuple-to-userset and nested userset members', () => {
  it('the §8 worked-example shape: direct viewers plus editors reachable only through a nested group, via tuple-to-userset', async () => {
    const groupNs = uniqueName('group');
    const folderNs = uniqueName('folder');
    const docNs = uniqueName('document');
    await publishOk(
      [
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
        '  relation viewer: user',
        '',
        '  permission view = viewer | parent->view',
        '}',
      ].join('\n'),
    );

    await writeOk(tuple(groupNs, 'eng', 'member', 'user', 'alice'));
    await writeOk(tuple(groupNs, 'eng', 'member', 'user', 'bob'));
    await writeOk(tuple(folderNs, 'design', 'editor', groupNs, 'eng', 'member'));
    await writeOk(tuple(docNs, 'readme', 'parent', folderNs, 'design'));
    await writeOk(tuple(docNs, 'readme', 'viewer', 'user', 'carol'));

    const tree = await expand(pool, ref(docNs, 'readme'), 'view');

    expect(tree.kind).toBe('union');
    if (tree.kind !== 'union') return;
    expect(tree.children).toHaveLength(2);

    // The exact subject set — carol directly, alice and bob only via
    // tupleToUserset -> nested userset — not a flat approximation.
    const subjects = collectDirectSubjects(tree)
      .map((s) => s.id)
      .sort();
    expect(subjects).toEqual(['alice', 'bob', 'carol']);

    // Structural checks: a tupleToUserset node exists and its one followed
    // tuple's expansion bottoms out in a relation node whose usersets
    // array names the group.
    const relationBranch = tree.children.find((c) => c.kind === 'relation');
    expect(relationBranch).toBeDefined();
    if (relationBranch?.kind === 'relation') {
      expect(relationBranch.directSubjects.map((s) => s.id)).toEqual(['carol']);
    }

    const ttuBranch = tree.children.find((c) => c.kind === 'tupleToUserset');
    expect(ttuBranch).toBeDefined();
    if (ttuBranch?.kind !== 'tupleToUserset') return;
    expect(ttuBranch.relation).toBe('parent');
    expect(ttuBranch.computedUserset).toBe('view');
    expect(ttuBranch.children).toHaveLength(1);
    const through = ttuBranch.children[0];
    expect(through?.through).toEqual({ ns: folderNs, id: 'design' });
    expect(through?.expansion.kind).toBe('relation');
    if (through?.expansion.kind === 'relation') {
      expect(through.expansion.directSubjects).toHaveLength(0);
      expect(through.expansion.usersets).toHaveLength(1);
      const usersetMember = through.expansion.usersets[0];
      expect(usersetMember?.userset).toEqual({ ns: groupNs, id: 'eng' });
      expect(usersetMember?.relation).toBe('member');
      expect(usersetMember?.expansion.kind).toBe('relation');
      if (usersetMember?.expansion.kind === 'relation') {
        expect(usersetMember.expansion.directSubjects.map((s) => s.id).sort()).toEqual([
          'alice',
          'bob',
        ]);
      }
    }
  });

  it('intersection and exclusion nodes mirror the real rewrite-rule structure, not just their resolved membership', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [
        `namespace ${ns} {`,
        '  relation owner: user',
        '  relation editor: user',
        '  relation viewer: user',
        '  relation banned: user',
        '',
        '  permission trusted_edit = editor & owner',
        '  permission unbanned_view = viewer - banned',
        '}',
      ].join('\n'),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'editor', 'user', 'dave'));
    await writeOk(tuple(ns, objectId, 'owner', 'user', 'dave'));
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'frank'));
    await writeOk(tuple(ns, objectId, 'banned', 'user', 'gina'));

    const intersectionTree = await expand(pool, ref(ns, objectId), 'trusted_edit');
    expect(intersectionTree.kind).toBe('intersection');
    if (intersectionTree.kind === 'intersection') {
      expect(intersectionTree.children).toHaveLength(2);
      const relationLeaves = intersectionTree.children.filter((c) => c.kind === 'relation');
      expect(relationLeaves).toHaveLength(2);
      for (const leaf of relationLeaves) {
        if (leaf.kind === 'relation')
          expect(leaf.directSubjects.map((s) => s.id)).toEqual(['dave']);
      }
    }

    const exclusionTree = await expand(pool, ref(ns, objectId), 'unbanned_view');
    expect(exclusionTree.kind).toBe('exclusion');
    if (exclusionTree.kind === 'exclusion') {
      expect(exclusionTree.base.kind).toBe('relation');
      expect(exclusionTree.subtract.kind).toBe('relation');
      if (exclusionTree.base.kind === 'relation') {
        expect(exclusionTree.base.directSubjects.map((s) => s.id)).toEqual(['frank']);
      }
      if (exclusionTree.subtract.kind === 'relation') {
        // expand() shows both sides of an exclusion — banned's own real
        // membership (gina) is fully visible in the tree, even though
        // gina is excluded from the *checked* permission's real answer for
        // any given subject; expand answers "who's in each named set,"
        // not "who ends up authorized."
        expect(exclusionTree.subtract.directSubjects.map((s) => s.id)).toEqual(['gina']);
      }
    }
  });

  it('a cyclic group nesting terminates and the cycle guard is visible in the tree, without poisoning a real grant reachable through the same object', async () => {
    const ns = uniqueName('grp');
    await publishOk(
      [`namespace ${ns} {`, `  relation member: user | ${ns}#member`, '}'].join('\n'),
    );

    await writeOk(tuple(ns, 'a', 'member', ns, 'b', 'member'));
    await writeOk(tuple(ns, 'b', 'member', ns, 'a', 'member'));
    await writeOk(tuple(ns, 'a', 'member', 'user', 'mabel'));

    // Forced to an explicit, very large value — per docs/DECISIONS.md
    // D-024's own precedent: at expand()'s *default* depth budget, a
    // cyclic-termination test can pass even with the cycle guard fully
    // disabled, because the independent depth ceiling silently absorbs the
    // infinite recursion first. This value is large enough that the depth
    // ceiling alone could not plausibly be what terminates the walk.
    const start = performance.now();
    const tree = await expand(pool, ref(ns, 'a'), 'member', { maxDepth: 1_000_000 });
    const elapsedMs = performance.now() - start;

    expect(tree.kind).toBe('relation');
    if (tree.kind !== 'relation') return;
    // The real, direct grant is still there.
    expect(tree.directSubjects.map((s) => s.id)).toEqual(['mabel']);
    // The cyclic userset member is present, but its own expansion is a
    // cycleGuard node (a-> b -> a caught, not silently dropped and not an
    // infinite structure).
    expect(tree.usersets).toHaveLength(1);
    expect(tree.usersets[0]?.userset).toEqual({ ns, id: 'b' });
    expect(findNodeKind(tree, 'cycleGuard')).toBe(true);

    // "Did not hang" — the same discipline every cyclic-termination test in
    // this repo already holds itself to (D-024/D-027/D-029's own bound).
    expect(elapsedMs).toBeLessThan(4000);
  });

  it('a cyclic tupleToUserset chain terminates via the SAME visiting guard, exercised through a structurally different call site than the group-nesting cycle above — full-repo audit finding #8', async () => {
    // No userset-subject nesting anywhere in this fixture — `parent` is a
    // plain, single-object relation (not `folder#parent`), so the cycle
    // this test relies on can only be caught by expandRewrite's own
    // `case 'tupleToUserset':` branch calling `expandName` recursively, the
    // one call site the pre-existing group-nesting test above never
    // exercises (that one loops entirely inside `expandRelation`).
    const ns = uniqueName('folder');
    await publishOk(
      [
        `namespace ${ns} {`,
        `  relation parent: ${ns}`,
        '  relation viewer: user',
        '',
        '  permission view = viewer | parent->view',
        '}',
      ].join('\n'),
    );

    // The cycle: folder:a's view recurses (via tupleToUserset) into
    // folder:b's view, which recurses right back into folder:a's view.
    await writeOk(tuple(ns, 'a', 'parent', ns, 'b'));
    await writeOk(tuple(ns, 'b', 'parent', ns, 'a'));
    // A real, direct grant on folder:a itself — reachable through the same
    // object the cycle lives on, via the union's OTHER branch — proving
    // the guard cuts off only the cyclic branch, not the whole tree.
    await writeOk(tuple(ns, 'a', 'viewer', 'user', 'dana'));

    // Forced to an explicit, very large value — same D-024 precedent as
    // the group-nesting test above: at the default depth budget, this
    // could pass even with the guard fully disabled, because the
    // independent depth ceiling would silently absorb the infinite
    // recursion first.
    const start = performance.now();
    const tree = await expand(pool, ref(ns, 'a'), 'view', { maxDepth: 1_000_000 });
    const elapsedMs = performance.now() - start;

    expect(tree.kind).toBe('union');
    if (tree.kind !== 'union') return;
    expect(tree.children).toHaveLength(2);

    // The real, direct grant survives, unpoisoned by the cyclic branch.
    const subjects = collectDirectSubjects(tree)
      .map((s) => s.id)
      .sort();
    expect(subjects).toEqual(['dana']);

    // The cyclic branch is present but visibly terminated by the guard,
    // not silently dropped and not an infinite structure.
    expect(findNodeKind(tree, 'cycleGuard')).toBe(true);
    const ttuBranch = tree.children.find((c) => c.kind === 'tupleToUserset');
    expect(ttuBranch).toBeDefined();
    if (ttuBranch?.kind !== 'tupleToUserset') return;
    expect(ttuBranch.relation).toBe('parent');
    expect(ttuBranch.computedUserset).toBe('view');
    expect(ttuBranch.children).toHaveLength(1);
    expect(ttuBranch.children[0]?.through).toEqual({ ns, id: 'b' });
    // folder:b's own `view` union: its `viewer` branch is empty (no tuple),
    // and its `parent->view` branch loops back to folder:a's `view`, which
    // is still mid-resolution on this branch — that's exactly where the
    // guard must fire.
    const throughB = ttuBranch.children[0]?.expansion;
    expect(throughB?.kind).toBe('union');
    if (throughB?.kind !== 'union') return;
    const nestedTtuBranch = throughB.children.find((c) => c.kind === 'tupleToUserset');
    expect(nestedTtuBranch).toBeDefined();
    if (nestedTtuBranch?.kind !== 'tupleToUserset') return;
    expect(nestedTtuBranch.children).toHaveLength(1);
    expect(nestedTtuBranch.children[0]?.through).toEqual({ ns, id: 'a' });
    expect(nestedTtuBranch.children[0]?.expansion).toEqual({
      kind: 'cycleGuard',
      object: ref(ns, 'a'),
      name: 'view',
    });

    // "Did not hang" — the same discipline every cyclic-termination test in
    // this repo already holds itself to (D-024/D-027/D-029's own bound).
    expect(elapsedMs).toBeLessThan(4000);
  });

  it('a diamond-shaped graph (the same node reachable via two non-overlapping branches) is not falsely treated as a cycle', async () => {
    const ns = uniqueName('folder');
    await publishOk(
      [
        `namespace ${ns} {`,
        `  relation parent: ${ns}`,
        `  relation sibling_link: ${ns}`,
        '  relation viewer: user',
        '  relation editor: user',
        '',
        '  permission view = viewer',
        '  permission edit = editor',
        '  permission access = parent->view | sibling_link->edit',
        '}',
      ].join('\n'),
    );
    const start = uniqueName('start');
    const shared = uniqueName('shared');
    await writeOk(tuple(ns, start, 'parent', ns, shared));
    await writeOk(tuple(ns, start, 'sibling_link', ns, shared));
    await writeOk(tuple(ns, shared, 'viewer', 'user', 'lee'));
    await writeOk(tuple(ns, shared, 'editor', 'user', 'mo'));

    const tree = await expand(pool, ref(ns, start), 'access');
    expect(tree.kind).toBe('union');
    // Both branches must independently reach folder:shared and surface
    // their own real subject — a false "already visiting this node" guard
    // would incorrectly cut one of them off as a cycleGuard node.
    expect(findNodeKind(tree, 'cycleGuard')).toBe(false);
    const subjects = collectDirectSubjects(tree)
      .map((s) => s.id)
      .sort();
    expect(subjects).toEqual(['lee', 'mo']);
  });

  it('an undeclared relation or permission name resolves to an explicit undeclared node, never a throw', async () => {
    const ns = uniqueName('doc');
    await publishOk([`namespace ${ns} {`, '  relation viewer: user', '}'].join('\n'));
    const tree = await expand(pool, ref(ns, 'obj0'), 'not_a_real_name');
    expect(tree).toEqual({ kind: 'undeclared', object: ref(ns, 'obj0'), name: 'not_a_real_name' });
  });
});
