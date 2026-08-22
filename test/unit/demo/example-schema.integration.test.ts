/**
 * The Phase 9 demo schema (`schema/example.authz`) and its seeded tuple
 * graph (`scripts/seed-example.ts`), proven against a real Postgres —
 * `.claude/commands/build-authz-service.md` §9 Phase 9's own named claim:
 * the demo graph includes "at least one deliberately-included non-obvious
 * case (a user who has access only through two levels of group nesting) so
 * the demo proves tuple-to-userset actually works, not just direct grants."
 *
 * This file publishes the REAL schema source (`readFileSync`d from
 * `schema/example.authz`, never retyped) and writes the REAL tuple graph
 * (transcribed from `scripts/seed-example.ts`'s own `TUPLES` list, which is
 * not exported so it cannot be imported directly — parity with the real
 * file is proven mechanically below, not just by eyeballing, via
 * `extractSeedTuples`, which re-parses `scripts/seed-example.ts`'s own
 * source text and asserts it is byte-for-byte identical, in order, to the
 * hand-transcribed `DEMO_TUPLES` array this file actually writes).
 *
 * The point of this file is NOT "dana is allowed edit" in isolation — a
 * bug that flattened the two-level group nesting into a single-hop
 * shortcut, or that happened to grant dana `edit` some other, unrelated
 * way, would still pass a bare `allowed === true` assertion. The real
 * claim under test is structural: the resolution path `productionCheck`
 * actually returns must be the *exact* chain hand-derived below, straight
 * from `schema/example.authz` §5's rewrite rules and the seeded tuple
 * graph — never read from `src/resolve/production/resolver.ts`'s
 * implementation to find out what it "actually does".
 *
 * **Hand derivation — `check(user:dana, edit, document:eng_handbook)`:**
 *
 * `document.edit = editor | owner | parent->edit` (a `union` of 3
 * children, in declaration order). `document:eng_handbook` has no
 * `editor`/`owner` tuple of its own, only `parent = folder:eng_docs` — so
 * branches 0 and 1 are false and branch 2 (`parent->edit`) is the only
 * true one:
 *
 *   union(document:eng_handbook, branchIndex=2)
 *     -> tupleToUserset(relation=parent, computedUserset=edit, through=folder:eng_docs)
 *
 * `folder.edit = editor | owner | parent->edit`. `folder:eng_docs` has an
 * `editor` tuple naming the userset `group:eng#member`, no `owner` tuple,
 * and no `parent` tuple of its own (only `folder:eng_backend_docs` points
 * *at* it) — so branch 0 (`editor`) is the only true one:
 *
 *     -> union(folder:eng_docs, branchIndex=0)
 *          -> usersetMembership(folder:eng_docs, editor -> group:eng#member)
 *
 * Resolving whether dana is in `group:eng#member`: `group:eng`'s `member`
 * tuples are a plain grant to `user:alice` (not dana) and a userset grant
 * to `group:eng_backend#member` — dana can only be reached through the
 * userset branch:
 *
 *               -> usersetMembership(group:eng, member -> group:eng_backend#member)
 *
 * `group:eng_backend`'s only `member` tuple is the userset
 * `group:eng_backend_interns#member` — again the userset branch:
 *
 *                    -> usersetMembership(group:eng_backend, member -> group:eng_backend_interns#member)
 *
 * `group:eng_backend_interns`'s only `member` tuple is a plain grant
 * straight to `user:dana` — terminal:
 *
 *                         -> directGrant(group:eng_backend_interns, member, user:dana)
 *
 * That is three `usersetMembership` hops (folder->group, then two levels
 * of real group nesting: eng->eng_backend, eng_backend->eng_backend_interns)
 * terminating in one `directGrant`, wrapped in one `tupleToUserset` hop
 * (document->folder via `parent`) and two `union` selections — exactly
 * §9 Phase 9's "two levels of group nesting" case, structurally, not just
 * as a pass/fail boolean.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030 (every `*.integration.test.ts` file
 * starts its own container; never a hardcoded local connection string).
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import {
  productionCheck,
  type EntityRef,
  type ResolutionStep,
} from '../../../src/resolve/production/resolver.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../../../schema/example.authz', import.meta.url));
const SEED_SCRIPT_PATH = fileURLToPath(
  new URL('../../../scripts/seed-example.ts', import.meta.url),
);

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

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

// ---------------------------------------------------------------------------
// The real "namespace:id" / "namespace:id#relation" notation parser —
// mirrors `scripts/seed-example.ts`'s own `tuple()` helper exactly (see
// this file's own parity check below), reproduced here rather than
// imported because `scripts/seed-example.ts` exports nothing (and this
// task is explicitly not allowed to modify that file to add an export).
// ---------------------------------------------------------------------------
function notationToTupleKey(object: string, relation: string, subject: string): TupleKey {
  const [objectNs, objectId] = object.split(':') as [string, string];
  const hash = subject.indexOf('#');
  const subjectRaw = hash === -1 ? subject : subject.slice(0, hash);
  const [subjectNs, subjectId] = subjectRaw.split(':') as [string, string];
  const subjectRelation = hash === -1 ? undefined : subject.slice(hash + 1);
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

// ---------------------------------------------------------------------------
// The REAL tuple graph — hand-transcribed from `scripts/seed-example.ts`'s
// own `TUPLES` list, in the same order, notation, and grouping (see that
// file's own comments for the org/group/folder/document story this
// reproduces verbatim). Not a simplified stand-in: every tuple that file
// writes is written here too, nothing added, nothing omitted — proven
// below, not just claimed, by `extractSeedTuples`.
// ---------------------------------------------------------------------------
const DEMO_TUPLES: Array<[string, string, string]> = [
  // --- org:acme membership, and the one banned member ---
  ['org:acme', 'member', 'user:alice'],
  ['org:acme', 'member', 'user:bob'],
  ['org:acme', 'member', 'user:carol'],
  ['org:acme', 'member', 'user:dana'],
  ['org:acme', 'member', 'user:erin'],
  ['org:acme', 'member', 'user:mallory'],
  ['org:acme', 'banned', 'user:mallory'],

  // --- nested groups, two levels deep ---
  ['group:eng', 'member', 'user:alice'],
  ['group:eng', 'member', 'group:eng_backend#member'],
  ['group:eng_backend', 'member', 'group:eng_backend_interns#member'],
  ['group:eng_backend_interns', 'member', 'user:dana'],
  ['group:finance', 'member', 'user:carol'],
  ['group:finance', 'member', 'user:erin'],

  // --- folder hierarchy ---
  ['folder:eng_docs', 'editor', 'group:eng#member'],
  ['folder:eng_backend_docs', 'parent', 'folder:eng_docs'],
  ['folder:finance_docs', 'viewer', 'group:finance#member'],
  ['folder:finance_docs', 'sensitive_reviewer', 'user:carol'],

  // --- documents: a mix of direct and inherited grants ---
  ['document:eng_handbook', 'parent', 'folder:eng_docs'],
  ['document:eng_backend_runbook', 'parent', 'folder:eng_backend_docs'],
  ['document:roadmap', 'viewer', 'user:bob'],
  ['document:roadmap', 'owner', 'user:alice'],
  ['document:financials', 'parent', 'folder:finance_docs'],
];

/**
 * Re-parses `scripts/seed-example.ts`'s own source text and extracts its
 * `TUPLES` array literal mechanically — so parity with `DEMO_TUPLES` above
 * is proven by comparing against the real file's actual current content on
 * every run, not asserted from memory at the moment this test was written.
 */
function extractSeedTuples(source: string): Array<[string, string, string]> {
  const declStart = source.indexOf('const TUPLES');
  if (declStart === -1) {
    throw new Error('parity check: could not find `const TUPLES` in scripts/seed-example.ts');
  }
  // `const TUPLES: Array<[string, string, string]> = [` — the type
  // annotation itself contains a `[`, so anchor on `= [`, the real start
  // of the array literal, not the first `[` after the declaration.
  const assignIdx = source.indexOf('= [', declStart);
  if (assignIdx === -1) {
    throw new Error('parity check: could not find the `= [` array literal start');
  }
  const arrayStart = assignIdx + 2;

  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }
  if (arrayEnd === -1) {
    throw new Error('parity check: unbalanced brackets while scanning the TUPLES array literal');
  }

  const block = source.slice(arrayStart, arrayEnd + 1);
  const entryPattern = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*]/g;
  const entries: Array<[string, string, string]> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    entries.push([match[1] as string, match[2] as string, match[3] as string]);
  }
  return entries;
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
}

async function seedDemoGraph(tuples: Array<[string, string, string]>): Promise<void> {
  const schemaSource = readFileSync(SCHEMA_PATH, 'utf8');
  const published = await publishSchema(pool, schemaSource);
  if (!published.ok) {
    throw new Error(`schema/example.authz failed to publish: ${published.errors.join('; ')}`);
  }
  for (const [object, relation, subject] of tuples) {
    await writeOk(notationToTupleKey(object, relation, subject));
  }
}

// ---------------------------------------------------------------------------
// Parity: the tuple graph this file writes is the REAL one.
// ---------------------------------------------------------------------------

describe('the demo tuple graph seeded in this test is the real one from scripts/seed-example.ts', () => {
  it('the-hand-transcribed-demo-tuple-list-matches-scripts-seed-example-ts-verbatim-in-order', () => {
    const seedSource = readFileSync(SEED_SCRIPT_PATH, 'utf8');
    const realTuples = extractSeedTuples(seedSource);
    expect(realTuples).toEqual(DEMO_TUPLES);
  });
});

// ---------------------------------------------------------------------------
// The positive case: dana's only path is two levels of group nesting.
// ---------------------------------------------------------------------------

describe('a user whose only path to a permission is two levels of nested group membership is granted via the real chain, not a bare allowed flag', () => {
  beforeAll(async () => {
    await seedDemoGraph(DEMO_TUPLES);
  });

  it('dana-is-allowed-edit-on-eng-handbook-only-via-the-hand-derived-tupletouserset-plus-nested-usersetmembership-chain-not-a-flattened-shortcut-or-an-unrelated-grant', async () => {
    const result = await productionCheck(
      pool,
      ref('user', 'dana'),
      ref('document', 'eng_handbook'),
      'edit',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    const top = result.path as ResolutionStep;

    // union(document:eng_handbook) -> branch 2 (parent->edit)
    expect(top.kind).toBe('union');
    if (top.kind !== 'union') throw new Error('unreachable');
    expect(top.object).toEqual(ref('document', 'eng_handbook'));
    expect(top.branchIndex).toBe(2);

    // tupleToUserset: document:eng_handbook --parent--> folder:eng_docs, recurse into `edit`
    const t2u = top.branch;
    expect(t2u.kind).toBe('tupleToUserset');
    if (t2u.kind !== 'tupleToUserset') throw new Error('unreachable');
    expect(t2u.object).toEqual(ref('document', 'eng_handbook'));
    expect(t2u.relation).toBe('parent');
    expect(t2u.computedUserset).toBe('edit');
    expect(t2u.through).toEqual(ref('folder', 'eng_docs'));

    // union(folder:eng_docs) -> branch 0 (editor)
    const folderUnion = t2u.member;
    expect(folderUnion.kind).toBe('union');
    if (folderUnion.kind !== 'union') throw new Error('unreachable');
    expect(folderUnion.object).toEqual(ref('folder', 'eng_docs'));
    expect(folderUnion.branchIndex).toBe(0);

    // usersetMembership: folder:eng_docs#editor -> group:eng#member
    const folderEditor = folderUnion.branch;
    expect(folderEditor.kind).toBe('usersetMembership');
    if (folderEditor.kind !== 'usersetMembership') throw new Error('unreachable');
    expect(folderEditor.object).toEqual(ref('folder', 'eng_docs'));
    expect(folderEditor.relation).toBe('editor');
    expect(folderEditor.userset).toEqual(ref('group', 'eng'));
    expect(folderEditor.usersetRelation).toBe('member');

    // usersetMembership: group:eng#member -> group:eng_backend#member (nesting level 1)
    const engMember = folderEditor.member;
    expect(engMember.kind).toBe('usersetMembership');
    if (engMember.kind !== 'usersetMembership') throw new Error('unreachable');
    expect(engMember.object).toEqual(ref('group', 'eng'));
    expect(engMember.relation).toBe('member');
    expect(engMember.userset).toEqual(ref('group', 'eng_backend'));
    expect(engMember.usersetRelation).toBe('member');

    // usersetMembership: group:eng_backend#member -> group:eng_backend_interns#member (nesting level 2)
    const backendMember = engMember.member;
    expect(backendMember.kind).toBe('usersetMembership');
    if (backendMember.kind !== 'usersetMembership') throw new Error('unreachable');
    expect(backendMember.object).toEqual(ref('group', 'eng_backend'));
    expect(backendMember.relation).toBe('member');
    expect(backendMember.userset).toEqual(ref('group', 'eng_backend_interns'));
    expect(backendMember.usersetRelation).toBe('member');

    // directGrant: group:eng_backend_interns#member -> user:dana (the terminal, real fact)
    const terminal = backendMember.member;
    expect(terminal.kind).toBe('directGrant');
    if (terminal.kind !== 'directGrant') throw new Error('unreachable');
    expect(terminal.object).toEqual(ref('group', 'eng_backend_interns'));
    expect(terminal.relation).toBe('member');
    expect(terminal.subject).toEqual(ref('user', 'dana'));
  });

  // -------------------------------------------------------------------------
  // Negative control: no group membership at all means no path at all.
  // -------------------------------------------------------------------------

  it('bob-who-has-no-group-membership-anywhere-in-the-graph-is-denied-edit-on-eng-handbook-proving-access-is-actually-gated-by-the-nesting', async () => {
    // Per the real seeded graph, `user:bob` is only ever named directly on
    // `org:acme#member` and `document:roadmap#viewer` — never on any
    // `group:*#member` tuple, so he has no route into `folder:eng_docs`'s
    // `editor` grant (which only names `group:eng#member`) at all.
    const result = await productionCheck(
      pool,
      ref('user', 'bob'),
      ref('document', 'eng_handbook'),
      'edit',
    );
    expect(result.allowed).toBe(false);
    expect(result.path).toBeUndefined();
  });
});
