/**
 * Proves, against a real Postgres-backed tuple store, that the check engine
 * never resolves a permission for which no relation path actually exists.
 *
 * This is the direct descendant of this repo's previous identity's
 * `test/integration/rls-postgres.integration.test.ts`, which proved "a
 * tenant only sees its own rows" against real row-level-security policies.
 * See `test/isolation/README.md` for the full lineage. The property is the
 * same at one more level of generality: a `tenant_id` match was always just
 * the simplest possible relation path (one hop, one column). A graph walk
 * over relation tuples is the general case; "no path" replaces "no
 * matching tenant_id" as the thing that must always deny.
 *
 * Needs Docker; will run in its own vitest project (see
 * vitest.integration.config.ts) via `npm run test:integration`, kept
 * separate from the default `npm test` so contributors without Docker
 * aren't blocked on the fast unit suite — same reasoning as the file this
 * replaces.
 *
 * Every test below was `.todo()` until the tuple store (Phase 2) and the
 * production check engine (Phase 4) existed — see
 * `.claude/commands/build-authz-service.md`. Both now exist, so every test
 * in this file is un-skipped and implemented for real, per this file's own
 * rule: "a `.todo()` staying red past its phase's exit criteria is a sign
 * the phase isn't actually done."
 *
 * Setup matches the plan sketched in the original `.todo()`-only version
 * of this file: a fresh `PostgreSqlContainer` per run (`@testcontainers/
 * postgresql`, already a devDependency), migrations applied via this
 * project's own `runMigrations` — the same mechanism `test/unit/store/
 * tuple-store.integration.test.ts` uses (see `docs/DECISIONS.md` D-019 for
 * why a hardcoded local connection string doesn't work in CI). The "seeded
 * as an admin connection" plan this file's own original comment
 * anticipated still holds — every fixture below writes its tuples through
 * the same `writeTuple`/`deleteTuple` any caller would use, on a plain
 * `Pool` pointed at the container, with no special privilege. Every
 * fixture uses a `uniqueName`-generated namespace/object/subject id
 * (matching `tuple-store.integration.test.ts`'s own convention) so tests
 * are safe to run in any order against a database that is never truncated
 * between them.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, deleteTuple, type TupleKey } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { productionCheck } from '../../src/resolve/production/resolver.js';
import { runMigrations } from '../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

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
// See test/unit/resolve/production/cross-resolver-agreement.integration
// .test.ts's own comment on this same pattern — a random per-worker salt,
// not just `Date.now()`, is required to avoid real cross-file collisions on
// shared prefixes like 'doc' when vitest runs multiple
// *.integration.test.ts files in parallel worker threads that can start
// within the same wall-clock millisecond.
const processSalt = Math.random().toString(36).slice(2, 10);
/** A fresh lowercase identifier, unique across this and sibling test files/workers, matching IDENTIFIER_PATTERN. */
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

interface Ref {
  ns: string;
  id: string;
}

function ref(ns: string, id: string): Ref {
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

/** §5's own `document` shape: owner/editor/viewer relations, `view` union permission. */
function documentSource(ns: string): string {
  return [
    `namespace ${ns} {`,
    '  relation owner: user',
    '  relation editor: user',
    '  relation viewer: user',
    '',
    '  permission view = viewer | editor | owner',
    '}',
  ].join('\n');
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
}

describe('a subject only resolves permissions reachable through an actual relation-tuple path', () => {
  it('checking (user:alice, viewer, document:readme) returns allowed when a viewer tuple exists directly', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'viewer');
    expect(result.allowed).toBe(true);
  });

  it('checking (user:bob, viewer, document:readme) returns denied when no tuple or rewrite path reaches bob at all — the direct analog of "a tenant only sees its own rows"', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    // Nothing written for bob at all — the object may or may not have
    // other tuples, but none of them name bob as subject.
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const result = await productionCheck(pool, ref('user', 'bob'), ref(ns, objectId), 'viewer');
    expect(result.allowed).toBe(false);
  });

  it("a relation tuple granting user:alice on document:readme is never used to resolve a check for user:bob on the same object, even though both share the object — the core invariant, restated: alice's edge is not a substitute for bob's own", async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const aliceResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    const bobResult = await productionCheck(pool, ref('user', 'bob'), ref(ns, objectId), 'view');

    expect(aliceResult.allowed).toBe(true);
    expect(bobResult.allowed).toBe(false);
  });

  it('checking a different subject against the same object, same connection, changes the resolution — the analog of "switching the session tenant id changes what is visible, same connection"', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    // Same `pool` instance for both calls — this project has no
    // session-scoped "current tenant"/"current subject" concept at all
    // (unlike the RLS predecessor's `SET app.tenant_id`); every check
    // states its own subject explicitly, so switching subjects between
    // calls on one connection pool must change the answer with nothing
    // else changed.
    const aliceResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    const bobResult = await productionCheck(pool, ref('user', 'bob'), ref(ns, objectId), 'view');

    expect(aliceResult.allowed).toBe(true);
    expect(bobResult.allowed).toBe(false);
  });

  it('fails closed: check() returns denied when the object has zero relation tuples of any kind — the analog of "no rows are visible when no tenant context has been set"', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    // Never written to by anything at all.
    const objectId = uniqueName('readme');

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view');
    expect(result.allowed).toBe(false);
  });

  it('revoking (deleting) the one tuple a check depended on makes the very next check on the same subject/object deny — no caching layer may serve a stale grant past the write that removed it', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    const t = tuple(ns, objectId, 'viewer', 'user', 'alice');
    await writeOk(t);

    const beforeRevoke = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    expect(beforeRevoke.allowed).toBe(true);

    const deleteResult = await deleteTuple(pool, t);
    expect(deleteResult.ok).toBe(true);

    // Deliberately unpinned (no `atToken`) — this is the "no caching layer
    // may serve a stale grant" claim in its strongest, ordinary-usage form:
    // even a plain, unpinned check must see the revoke on its very next
    // call, matching `CHECK_CACHE_TTL_MS=0` (no cache, §6.6) and §6.1's "no
    // cached, precomputed permission that isn't provably derivable from
    // current tuples on demand."
    const afterRevoke = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    expect(afterRevoke.allowed).toBe(false);
  });

  it("writing a tuple for one namespace's relation never grants a permission in an unrelated namespace that happens to share subject or object ids — cross-namespace bleed is the multi-tenant-kit failure mode, restated", async () => {
    // Two structurally-identical but distinct namespaces, deliberately
    // sharing the exact same object id and subject id — the only thing
    // that differs is the namespace itself.
    const nsA = uniqueName('doc');
    const nsB = uniqueName('doc');
    await publishOk(documentSource(nsA));
    await publishOk(documentSource(nsB));
    const sharedObjectId = uniqueName('readme');
    const sharedSubjectId = uniqueName('alice');

    // Grant only in nsA.
    await writeOk(tuple(nsA, sharedObjectId, 'viewer', 'user', sharedSubjectId));

    const inGrantedNamespace = await productionCheck(
      pool,
      ref('user', sharedSubjectId),
      ref(nsA, sharedObjectId),
      'view',
    );
    const inUnrelatedNamespace = await productionCheck(
      pool,
      ref('user', sharedSubjectId),
      ref(nsB, sharedObjectId),
      'view',
    );

    expect(inGrantedNamespace.allowed).toBe(true);
    // nsB never received any tuple at all — the shared object/subject ids
    // must not leak the nsA grant across the namespace boundary.
    expect(inUnrelatedNamespace.allowed).toBe(false);
  });

  it('group nesting resolves transitively: user:alice in group:eng, group:eng granted editor on folder:design, alice checks as editor on folder:design with no direct tuple to alice at all — tuple-to-userset, the mechanism a flat tenant_id column had no equivalent of', async () => {
    const gns = uniqueName('group');
    const fns = uniqueName('folder');
    const source = [
      `namespace ${gns} {`,
      `  relation member: user | ${gns}#member`,
      '}',
      '',
      `namespace ${fns} {`,
      `  relation editor: user | ${gns}#member`,
      '}',
    ].join('\n');
    await publishOk(source);

    const eng = uniqueName('eng');
    const design = uniqueName('design');
    // alice is a direct member of group:eng.
    await writeOk(tuple(gns, eng, 'member', 'user', 'alice'));
    // group:eng's members are granted `editor` on folder:design — a
    // stored-tuple userset subject, no tuple anywhere names alice directly.
    await writeOk(tuple(fns, design, 'editor', gns, eng, 'member'));

    const result = await productionCheck(pool, ref('user', 'alice'), ref(fns, design), 'editor');
    expect(result.allowed).toBe(true);
  });

  it('a cyclic group nesting (group:a nests group:b nests group:a) terminates the walk and resolves denied rather than hanging or crashing — a genuinely new failure mode a single-hop tenant check never had to face', async () => {
    const gns = uniqueName('group');
    const source = [`namespace ${gns} {`, `  relation member: user | ${gns}#member`, '}'].join(
      '\n',
    );
    await publishOk(source);

    const a = uniqueName('a');
    const b = uniqueName('b');
    const decoyObject = uniqueName('decoy');
    // The cycle: a's members include b's members, and vice versa. Neither
    // node grants real membership to anyone.
    await writeOk(tuple(gns, a, 'member', gns, b, 'member'));
    await writeOk(tuple(gns, b, 'member', gns, a, 'member'));
    // Decoy tuple (docs/DECISIONS.md D-027): a real, unrelated grant naming
    // the checked subject elsewhere in `relation_tuples`. Without this,
    // Postgres's query planner can prune the recursive CTE's join entirely
    // because the checked subject never appears anywhere in the table at
    // all — passing "fast" even with zero cycle protection, which would
    // make this test unable to actually distinguish working cycle
    // detection from none.
    await writeOk(tuple(gns, decoyObject, 'member', 'user', 'zoe'));

    const start = performance.now();
    const result = await productionCheck(pool, ref('user', 'zoe'), ref(gns, a), 'member');
    const elapsedMs = performance.now() - start;

    expect(result.allowed).toBe(false);
    // "Did not hang" — a generous bound, not a performance assertion. See
    // `test/unit/resolve/production/cross-resolver-agreement.integration
    // .test.ts`'s own cyclic describe block for the same fixture shape run
    // at an explicit, huge `maxDepth` specifically to isolate cycle
    // detection from `CHECK_MAX_DEPTH`'s own independent depth ceiling —
    // this test uses the default budget (25) instead, matching this test's
    // own name ("terminates the walk"), which the default budget alone
    // already guarantees regardless of cycle detection; the huge-maxDepth
    // variant is what actually isolates cycle detection as the mechanism
    // doing the work.
    expect(elapsedMs).toBeLessThan(4000);
  });

  it('a check pinned to the consistency token returned by a just-completed write observes that write — the token/write ordering the old suite never had to model, because a single-row RLS check has no equivalent staleness window', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    const t = tuple(ns, objectId, 'viewer', 'user', 'alice');

    const writeResult = await writeTuple(pool, t);
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) return;

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view', {
      atToken: writeResult.token,
    });
    expect(result.allowed).toBe(true);
  });

  it('a check NOT pinned to a token, issued concurrently with a revoking write, never observes a permission strictly newer than its own start — bounded staleness, not an unbounded one; see docs/DECISIONS.md for the consistency model chosen', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('readme');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));

    // "Concurrently" is operationalized here with a real, deterministic
    // Postgres transaction rather than a wall-clock race (which could not
    // give this test a reliable, non-flaky outcome): a second connection
    // opens a transaction, issues the revoking delete, but does NOT commit
    // it yet. §6.3's stated model is plain: an unpinned check is a
    // best-effort read of *current committed state*, "bounded by ordinary
    // transaction visibility, not by any additional staleness this project
    // introduces." An uncommitted delete on another connection is exactly
    // the case that model has to get right — the revoke has not actually
    // happened yet as far as any other transaction is concerned, so an
    // unpinned check running now must still see the pre-revoke state; it
    // must not somehow observe a write that, from every other session's
    // point of view, hasn't happened yet.
    const revokerClient = await pool.connect();
    try {
      await revokerClient.query('BEGIN');
      await revokerClient.query(
        `delete from relation_tuples
         where object_ns = $1 and object_id = $2 and relation = $3
           and subject_ns = $4 and subject_id = $5`,
        [ns, objectId, 'viewer', 'user', 'alice'],
      );

      const duringUncommittedRevoke = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(ns, objectId),
        'view',
      );
      expect(duringUncommittedRevoke.allowed).toBe(true);

      await revokerClient.query('COMMIT');
    } finally {
      revokerClient.release();
    }

    // Now that the revoke has actually committed, a fresh unpinned check
    // must observe it — proving the check above wasn't just permanently
    // stale, only correctly bounded to what had actually committed as of
    // when it ran.
    const afterCommit = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    expect(afterCommit.allowed).toBe(false);
  });
});

/**
 * Regression coverage carried over in spirit from the predecessor's
 * per-command (SELECT/INSERT/DELETE-only) policy suite: narrow, specific
 * rewrite-rule shapes each get their own real-database proof rather than
 * being asserted only against the reference resolver (differential-
 * soundness.fuzz.test.ts) or the SQL/config text a compiler emits.
 */
describe('rewrite-rule shapes execute correctly against a real Postgres-backed tuple store', () => {
  function combinatorSource(ns: string): string {
    return [
      `namespace ${ns} {`,
      '  relation owner: user',
      '  relation editor: user',
      '  relation viewer: user',
      '  relation banned: user',
      '',
      '  permission any_access = viewer | editor | owner',
      '  permission trusted_edit = editor & owner',
      '  permission unbanned_view = viewer - banned',
      '}',
    ].join('\n');
  }

  it('a union rewrite rule (viewer := owner | editor | viewer) grants via any one of its branches independently', async () => {
    const ns = uniqueName('doc');
    await publishOk(combinatorSource(ns));

    const viewerObj = uniqueName('obj');
    await writeOk(tuple(ns, viewerObj, 'viewer', 'user', 'alice'));
    const viewerResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, viewerObj),
      'any_access',
    );
    expect(viewerResult.allowed).toBe(true);

    const editorObj = uniqueName('obj');
    await writeOk(tuple(ns, editorObj, 'editor', 'user', 'carol'));
    const editorResult = await productionCheck(
      pool,
      ref('user', 'carol'),
      ref(ns, editorObj),
      'any_access',
    );
    expect(editorResult.allowed).toBe(true);

    const ownerObj = uniqueName('obj');
    await writeOk(tuple(ns, ownerObj, 'owner', 'user', 'erin'));
    const ownerResult = await productionCheck(
      pool,
      ref('user', 'erin'),
      ref(ns, ownerObj),
      'any_access',
    );
    expect(ownerResult.allowed).toBe(true);
  });

  it('an intersection rewrite rule (must satisfy two relations at once) denies when only one branch resolves', async () => {
    const ns = uniqueName('doc');
    await publishOk(combinatorSource(ns));
    const objectId = uniqueName('obj');
    // dave is an editor but never an owner — a union would grant this, an
    // intersection must not.
    await writeOk(tuple(ns, objectId, 'editor', 'user', 'dave'));

    const onlyOneBranch = await productionCheck(
      pool,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );
    expect(onlyOneBranch.allowed).toBe(false);

    // Control: once both branches are satisfied, it allows — proving the
    // denial above is the intersection actually doing its job, not a bug
    // that denies everything.
    await writeOk(tuple(ns, objectId, 'owner', 'user', 'dave'));
    const bothBranches = await productionCheck(
      pool,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );
    expect(bothBranches.allowed).toBe(true);
  });

  it('an exclusion rewrite rule (viewer but not banned) denies a subject who would otherwise resolve via the positive branch once the exclusion tuple is present', async () => {
    const ns = uniqueName('doc');
    await publishOk(combinatorSource(ns));
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'frank'));

    const beforeBan = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    expect(beforeBan.allowed).toBe(true);

    // frank is still a viewer — the base branch alone would grant this
    // under a union. Adding the `banned` tuple must flip the answer: this
    // is the combinator doing the work, not an absence of tuples.
    await writeOk(tuple(ns, objectId, 'banned', 'user', 'frank'));
    const afterBan = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    expect(afterBan.allowed).toBe(false);
  });

  it('a tuple-to-userset rewrite rule (this#viewer := parent#editor) resolves through a real parent-folder tuple chain of depth 3', async () => {
    const ns = uniqueName('folder');
    const source = [
      `namespace ${ns} {`,
      `  relation parent: ${ns}`,
      '  relation editor: user',
      '',
      '  permission view = editor | parent->view',
      '}',
    ].join('\n');
    await publishOk(source);

    const a = uniqueName('a');
    const b = uniqueName('b');
    const c = uniqueName('c');
    // a --parent--> b --parent--> c (depth 3 total: a's view depends on
    // b's view, which depends on c's view/editor — three levels).
    await writeOk(tuple(ns, a, 'parent', ns, b));
    await writeOk(tuple(ns, b, 'parent', ns, c));
    await writeOk(tuple(ns, c, 'editor', 'user', 'grace'));

    const reachable = await productionCheck(pool, ref('user', 'grace'), ref(ns, a), 'view');
    expect(reachable.allowed).toBe(true);

    const unreachable = await productionCheck(pool, ref('user', 'henry'), ref(ns, a), 'view');
    expect(unreachable.allowed).toBe(false);
  });
});
