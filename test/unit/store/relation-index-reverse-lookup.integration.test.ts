/**
 * The reverse-lookup accelerant for `listObjects` (D-175, `docs/REVERSE-
 * LOOKUP-PROPOSAL.md`) — the LOCALVERIFY-grade live reproduction of
 * `fetchReverseIndexCandidates`'s own query behavior end-to-end against
 * real Postgres, mirroring `relation-index.integration.test.ts`'s own role
 * for the Leopard index's forward direction: every assertion below is
 * derived from `fetchReverseIndexCandidates`'s own doc comments
 * (`src/store/relation-index.ts`) and `docs/REVERSE-LOOKUP-PROPOSAL.md`'s
 * own gate descriptions, proving real SQL behavior the DST fake
 * (`test/unit/store/dst/relation-index-reverse-lookup.dst.test.ts`) can
 * only assert by construction (it never runs the actual query text against
 * a real planner/executor).
 *
 * **No "Candidate F"-equivalent maxDepth test here — a deliberate scope
 * boundary, not an oversight.** The forward-lookup Leopard index's own
 * `lookupRelationMembershipIndex` takes a caller-supplied `maxDepth` and
 * gates a hit on the stored `via_path`'s own length, because a hit
 * bypasses `productionCheck`'s own SQL depth walk entirely — there is no
 * second, independent depth check downstream. `fetchReverseIndexCandidates`
 * has no analogous gate, and needs none: it doesn't even return `via_path`,
 * only `object_id`, and every one of its own candidates is unconditionally
 * re-verified through the real, unmodified `productionCheck` — with the
 * caller's own real `maxDepth` — before `listObjects` ever reports it. A
 * candidate reachable only via a path longer than the caller's own budget
 * simply fails that re-verification and is correctly excluded, the same
 * way any other denied candidate is; this is `listObjects`'s pre-existing
 * "narrows which ids get checked, never what a check itself decides"
 * property (`src/audit/list.ts`'s own top-of-file doc comment) doing its
 * job, not a gap this file needs to separately prove.
 *
 * **This project's own established `PostgreSqlContainer` convention**
 * (`docs/DECISIONS.md` D-019/D-030), matching every sibling
 * `*.integration.test.ts` file, including `relation-index.integration
 * .test.ts` itself.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, deleteTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { listObjects, type EntityRef } from '../../../src/audit/list.js';
import {
  fetchReverseIndexCandidates,
  rebuildRelationMembershipIndex,
} from '../../../src/store/relation-index.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Fixture helpers — matching this repo's own established integration-test
// conventions (see e.g. `relation-index.integration.test.ts`).
// ---------------------------------------------------------------------------

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

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

async function writeOk(t: TupleKey): Promise<{ token: number }> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
  return { token: result.token };
}

function nestedGroupSchemaSource(groupNs: string, docNs: string): string {
  return [
    `namespace ${groupNs} {`,
    `  relation member: user | ${groupNs}#member`,
    '}',
    '',
    `namespace ${docNs} {`,
    `  relation viewer: user | ${groupNs}#member`,
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Direct/zero-hop grants and nested-depth reachability, both found by one
// accelerated candidate query.
// ---------------------------------------------------------------------------

describe('fetchReverseIndexCandidates finds both a direct (zero-hop) grant and a grant reached only through a multi-hop nested-group chain, in one call', () => {
  it('a-direct-grant-and-a-two-hop-nested-group-grant-to-the-same-subject-are-both-returned', async () => {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    await publishOk(nestedGroupSchemaSource(groupNs, docNs));

    // Zero-hop: doc:doc_a#viewer -> plain grant to alice.
    await writeOk(tuple(docNs, 'doc_a', 'viewer', 'user', 'alice'));
    // Two hops: doc:doc_b#viewer -> group:g1#member -> group:g2#member -> plain grant to alice.
    await writeOk(tuple(docNs, 'doc_b', 'viewer', groupNs, 'g1', 'member'));
    await writeOk(tuple(groupNs, 'g1', 'member', groupNs, 'g2', 'member'));
    await writeOk(tuple(groupNs, 'g2', 'member', 'user', 'alice'));
    // A distractor: a different subject, must never appear in alice's own result.
    await writeOk(tuple(docNs, 'doc_c', 'viewer', 'user', 'not_alice'));

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);

    const result = await fetchReverseIndexCandidates(
      pool,
      ref('user', 'alice'),
      'viewer',
      docNs,
      10,
    );
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect([...result.objectIds].sort()).toEqual(['doc_a', 'doc_b']);
      expect(result.truncated).toBe(false);
    }

    // End-to-end confirmation via the real production entry point.
    const endToEnd = await listObjects(pool, ref('user', 'alice'), 'viewer', docNs, {
      useRelationIndex: true,
    });
    expect([...endToEnd.objects].map((o) => o.id).sort()).toEqual(['doc_a', 'doc_b']);
    expect(endToEnd.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Truncation — the lowest-sorting-slice guarantee, against real data (the
// DST test already proves this by construction; this proves the real
// `order by object_id asc limit $5` SQL behaves identically).
// ---------------------------------------------------------------------------

describe('truncation keeps exactly the lowest-sorting object_id slice, against real Postgres data, not merely an arbitrary limit-sized subset', () => {
  it('seven-real-grants-capped-at-a-limit-of-five-keeps-exactly-the-five-lowest-sorting-ids', async () => {
    const docNs = uniqueName('doc');
    await publishOk([`namespace ${docNs} {`, '  relation viewer: user', '}'].join('\n'));

    // Deliberately out of insertion order — object_id ascending is the
    // contract, not insertion order.
    const ids = ['doc_g', 'doc_c', 'doc_e', 'doc_a', 'doc_f', 'doc_b', 'doc_d'];
    for (const id of ids) {
      await writeOk(tuple(docNs, id, 'viewer', 'user', 'alice'));
    }

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);

    const result = await fetchReverseIndexCandidates(
      pool,
      ref('user', 'alice'),
      'viewer',
      docNs,
      5,
    );
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.objectIds).toEqual(['doc_a', 'doc_b', 'doc_c', 'doc_d', 'doc_e']);
      expect(result.truncated).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 2's own regression guard — a real grant written strictly after the
// rebuild's own watermark must never be silently missing from listObjects,
// because the accelerant must correctly refuse to engage at all.
// ---------------------------------------------------------------------------

describe('a real grant written after the rebuild watermark is never silently missing — the accelerant correctly refuses (gate 2), and listObjects still finds it via the live fallback', () => {
  it('a-grant-written-after-the-rebuilds-own-watermark-makes-fetchReverseIndexCandidates-report-a-miss-and-listObjects-still-finds-the-new-grant', async () => {
    const docNs = uniqueName('doc');
    await publishOk([`namespace ${docNs} {`, '  relation viewer: user', '}'].join('\n'));

    await writeOk(tuple(docNs, 'doc_a', 'viewer', 'user', 'alice'));
    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);

    // Sanity: the index genuinely captured doc_a before the new grant lands —
    // otherwise the assertion below would prove nothing.
    const warm = await fetchReverseIndexCandidates(pool, ref('user', 'alice'), 'viewer', docNs, 10);
    expect(warm).toEqual({ hit: true, objectIds: ['doc_a'], truncated: false });

    // The real write the rebuild's own watermark has NOT observed — no
    // second rebuild runs after this.
    const newGrant = await writeOk(tuple(docNs, 'doc_b', 'viewer', 'user', 'alice'));
    expect(newGrant.token).toBeGreaterThan(rebuildResult.watermarkToken);

    const stale = await fetchReverseIndexCandidates(
      pool,
      ref('user', 'alice'),
      'viewer',
      docNs,
      10,
    );
    expect(stale).toEqual({ hit: false });

    // listObjects itself must still report BOTH grants, complete and
    // correct, via its own live fallback.
    const endToEnd = await listObjects(pool, ref('user', 'alice'), 'viewer', docNs, {
      useRelationIndex: true,
    });
    expect([...endToEnd.objects].map((o) => o.id).sort()).toEqual(['doc_a', 'doc_b']);
  });
});

// ---------------------------------------------------------------------------
// The core soundness proof, forced directly (gate 2 makes this
// structurally unreachable via the ordinary write/rebuild API — any real
// write, including the revoke itself, already makes gate 2 refuse the very
// next call, so a genuinely stale accelerated candidate can never actually
// reach a caller through normal operation at all). To prove listObjects's
// own reverification catches a stale candidate anyway — not merely that
// gate 2 usually prevents one from occurring — this fixture manufactures
// the exact hazard directly via raw SQL, the same "construct the hazard
// gate 2 is supposed to make unreachable, and confirm the OTHER layer of
// defense still holds" technique this project already uses for the
// Leopard index's own PK-collision fixture (`relation-index.integration
// .test.ts`) and the isolation suite's own bulk-insert fixtures.
// ---------------------------------------------------------------------------

describe('a stale accelerated candidate (fabricated directly, bypassing gate 2, to prove the OTHER layer of defense) is still correctly excluded from listObjects by the real, unmodified productionCheck re-verification', () => {
  it('a-revoked-grant-manually-left-behind-as-a-stale-relation-membership-index-row-with-a-forced-fresh-watermark-is-still-correctly-excluded-from-listObjects', async () => {
    const docNs = uniqueName('doc');
    await publishOk([`namespace ${docNs} {`, '  relation viewer: user', '}'].join('\n'));

    await writeOk(tuple(docNs, 'doc_a', 'viewer', 'user', 'alice'));
    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);

    // Sanity: a genuine, correct hit before the revoke.
    const before = await fetchReverseIndexCandidates(
      pool,
      ref('user', 'alice'),
      'viewer',
      docNs,
      10,
    );
    expect(before).toEqual({ hit: true, objectIds: ['doc_a'], truncated: false });

    // The real revocation — relation_tuples now correctly has no such row.
    // No second rebuild runs after this: the row this first rebuild already
    // wrote into relation_membership_index for (docNs, doc_a, viewer, user,
    // alice) is genuinely, silently left behind, unTRUNCATEd — real stale
    // content, not a hand-fabricated row.
    const revoke = await deleteTuple(pool, tuple(docNs, 'doc_a', 'viewer', 'user', 'alice'));
    if (!revoke.ok) throw new Error(`fixture revoke failed: ${JSON.stringify(revoke.errors)}`);

    // Manufacture only the OTHER half of the hazard directly: force the
    // state table's own watermark to claim it's fully caught up despite the
    // revoke, so gate 2 passes and the accelerant genuinely reads that
    // already-stale row above — precisely what gate 2 exists to make
    // unreachable through the real write/rebuild API, done here only to
    // isolate and prove the SEPARATE re-verification defense.
    await pool.query(
      `update relation_membership_index_state
       set watermark_token = (select coalesce(max(token), 0) from write_log)
       where id = 1`,
    );

    // Confirm the hazard is genuinely live: the accelerant now reports a
    // hit for the already-revoked doc_a — a real stale candidate, not a
    // hypothetical one.
    const staleHit = await fetchReverseIndexCandidates(
      pool,
      ref('user', 'alice'),
      'viewer',
      docNs,
      10,
    );
    expect(staleHit).toEqual({ hit: true, objectIds: ['doc_a'], truncated: false });

    // The actual soundness assertion: listObjects, given this genuinely
    // stale accelerated candidate, must still correctly exclude doc_a —
    // the real, unmodified productionCheck re-verification catches it.
    const result = await listObjects(pool, ref('user', 'alice'), 'viewer', docNs, {
      useRelationIndex: true,
    });
    expect(result).toEqual({ objects: [], truncated: false });
  });
});
