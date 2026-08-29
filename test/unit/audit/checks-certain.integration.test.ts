/**
 * `checks.certain` (migration `0009_checks_certain.sql`) — full-repo audit
 * finding #6: `ProductionCheckResult.certain` (`src/resolve/production/
 * resolver.ts`) was already computed correctly internally (D-158 through
 * D-161's own soundness-signal mechanism) but silently discarded at
 * `productionCheck`'s own final return, so a denial's audit trail had no
 * way to distinguish an exhaustively-proven "no" from one a cycle guard or
 * the depth ceiling merely gave up on. This file proves, against real
 * Postgres, through the real, unmodified `performCheck` (`src/audit/
 * checks.ts`) — never a mock of the resolver — that:
 *
 *   - a plain denial with no cycle or depth involvement at all persists
 *     `certain = true`;
 *   - a denial that genuinely hits mechanism 2's SQL depth ceiling inside an
 *     exclusion's `subtract` branch (the exact D-159 bug shape) persists
 *     `certain = false`;
 *   - an allowed check persists `certain = NULL` — the mirror image of
 *     `resolution_path`'s own "non-null iff allowed" contract, already
 *     proven for `resolution_path` itself in `checks.integration.test.ts`.
 *
 * The depth-ceiling fixture's schema/tuple-graph shape and exact depth
 * accounting are adapted directly from `test/unit/resolve/production/
 * mechanism-2-exclusion-depth-ceiling.integration.test.ts` (D-159's own
 * regression file) — same `grant - blocked` exclusion, same 3-hop
 * `group#member` chain, same `maxDepth: 3` boundary already proven there to
 * land exactly one hop short of the real grant — reused here as a known-good
 * "genuinely inconclusive" fixture rather than re-derived from scratch.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { performCheck } from '../../../src/audit/checks.js';
import type { EntityRef } from '../../../src/resolve/production/resolver.js';
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

interface CertainCheckRow {
  allowed: boolean;
  certain: boolean | null;
}

async function fetchLatestRow(
  subject: EntityRef,
  relation: string,
  object: EntityRef,
): Promise<CertainCheckRow> {
  const { rows } = await pool.query<CertainCheckRow>(
    `select allowed, certain from checks
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

describe('checks.certain persists the resolver’s own soundness-signal, never re-derived at the audit layer', () => {
  it('a-plain-denial-with-no-cycle-or-depth-involvement-is-persisted-as-certain-true', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    // No tuple written at all — nobody has ever been granted anything here,
    // so this denial is exhaustively provable with zero cycle/depth
    // machinery involved.
    const subject = ref('user', 'nobody');
    const object = ref(ns, objectId);

    const result = await performCheck(pool, subject, object, 'view');
    expect(result.allowed).toBe(false);
    expect(result.certain).toBe(true);

    const row = await fetchLatestRow(subject, 'view', object);
    expect(row.allowed).toBe(false);
    expect(row.certain).toBe(true);
  });

  it('an-allowed-check-persists-a-null-certain-column-the-mirror-image-of-resolution_paths-own-contract', async () => {
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
    expect(result.certain).toBeUndefined();

    const row = await fetchLatestRow(subject, 'view', object);
    expect(row.allowed).toBe(true);
    expect(row.certain).toBeNull();
  });

  describe('a denial that genuinely hits mechanism 2’s depth ceiling inside an exclusion’s subtract branch (D-159’s own bug shape) is persisted as certain false', () => {
    /**
     * Identical fixture shape to `mechanism-2-exclusion-depth-ceiling
     * .integration.test.ts` — `blocked` is a plain relation (never a
     * permission), so `evalRewrite`'s `computedUserset` case routes it
     * straight into `sqlRelationMembershipWithWitness` (mechanism 2). Alice
     * has a direct `grant` (the exclusion's `base`, true) and is ALSO a
     * real, transitive member of `blocked` via a 3-hop group chain — but
     * only findable if the SQL frontier scan's own remaining budget reaches
     * it.
     */
    function fixtureSource(groupNs: string, docNs: string): string {
      return [
        `namespace ${groupNs} {`,
        `  relation member: user | ${groupNs}#member`,
        '}',
        '',
        `namespace ${docNs} {`,
        '  relation grant: user',
        `  relation blocked: user | ${groupNs}#member`,
        '  permission view = grant - blocked',
        '}',
      ].join('\n');
    }

    it('production-persists-certain-false-at-the-exact-maxDepth-boundary-D-159-confirmed-live', async () => {
      const groupNs = uniqueName('grp');
      const docNs = uniqueName('doc');
      const docId = uniqueName('d');
      await publishOk(fixtureSource(groupNs, docNs));
      await writeOk(tuple(docNs, docId, 'grant', 'user', 'alice'));
      await writeOk(tuple(docNs, docId, 'blocked', groupNs, 'g0', 'member'));
      await writeOk(tuple(groupNs, 'g0', 'member', groupNs, 'g1', 'member'));
      await writeOk(tuple(groupNs, 'g1', 'member', groupNs, 'g2', 'member'));
      await writeOk(tuple(groupNs, 'g2', 'member', 'user', 'alice'));

      const subject = ref('user', 'alice');
      const object = ref(docNs, docId);

      // MAX_DEPTH = 3 is the exact boundary D-159's own regression file
      // proved lands one hop short of alice's real grant on g2 — the SQL
      // frontier scan's own depth ceiling genuinely cuts off a real,
      // unread edge here, so this is a real "cannot prove either way," not
      // a proven "no."
      const result = await performCheck(pool, subject, object, 'view', { maxDepth: 3 });
      expect(result.allowed).toBe(false);
      expect(result.certain).toBe(false);

      const row = await fetchLatestRow(subject, 'view', object);
      expect(row.allowed).toBe(false);
      expect(row.certain).toBe(false);
    });

    it('production-persists-certain-true-once-the-budget-covers-the-real-chain-a-genuine-proof-not-merely-budget-exhaustion', async () => {
      const groupNs = uniqueName('grp');
      const docNs = uniqueName('doc');
      const docId = uniqueName('d');
      await publishOk(fixtureSource(groupNs, docNs));
      await writeOk(tuple(docNs, docId, 'grant', 'user', 'alice'));
      await writeOk(tuple(docNs, docId, 'blocked', groupNs, 'g0', 'member'));
      await writeOk(tuple(groupNs, 'g0', 'member', groupNs, 'g1', 'member'));
      await writeOk(tuple(groupNs, 'g1', 'member', groupNs, 'g2', 'member'));
      await writeOk(tuple(groupNs, 'g2', 'member', 'user', 'alice'));

      const subject = ref('user', 'alice');
      const object = ref(docNs, docId);

      // MAX_DEPTH = 4 (D-159's own regression file confirms this reaches
      // g2, frontier depth 3, and finds alice's real grant there) — a
      // genuine, certain proof that alice IS blocked, so the exclusion
      // denies `view` with an exhaustive disproof of "not excluded," not an
      // uncertain one.
      const result = await performCheck(pool, subject, object, 'view', { maxDepth: 4 });
      expect(result.allowed).toBe(false);
      expect(result.certain).toBe(true);

      const row = await fetchLatestRow(subject, 'view', object);
      expect(row.allowed).toBe(false);
      expect(row.certain).toBe(true);
    });
  });
});
