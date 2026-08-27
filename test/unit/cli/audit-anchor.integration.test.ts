/**
 * `authz audit anchor` / `authz audit verify --anchor-file` (D-148's own
 * disclosed residual risk, closed — `src/audit/anchor.ts`,
 * `src/cli/commands/audit.ts`) against a real Postgres — the actual
 * fail-check this feature exists to pass, not a mocked stand-in for one.
 *
 * **The two-part live proof this file exists to run, as two distinct,
 * separately-observed facts:**
 *
 *   (a) A plain `authz audit verify` (no `--anchor-file`) genuinely CANNOT
 *       detect a full, consistent forward rewrite of the chain — this is
 *       proven live here, not merely assumed from `docs/DECISIONS.md`'s own
 *       account of the gap.
 *   (b) `authz audit verify --anchor-file <path>`, given an anchor recorded
 *       BEFORE the rewrite, correctly detects and reports it.
 *
 * **How the attack is simulated.** A raw SQL read-then-write sequence that
 * does exactly what a privileged database user with direct SQL access
 * could do: flip one already-committed row's `allowed` column (the
 * tampered row), then recompute `row_hash`/`prev_hash` forward from that
 * row through the real current chain tip using this codebase's own
 * `computeCheckRowHash` — i.e. genuinely reproducing the exact hash-chain
 * algorithm `insertCheckRow` uses, not a fake or simplified stand-in for
 * it. This is the realistic shape D-148's own "Revisit if" names: "a
 * privileged DB user... rewriting the whole chain forward consistently
 * from a tampered row."
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { performCheck, computeCheckRowHash, GENESIS_PREV_HASH } from '../../../src/audit/checks.js';
import type { HashableCheckRow } from '../../../src/audit/checks.js';
import { readAnchorFile } from '../../../src/audit/anchor.js';
import { auditVerify, auditAnchor } from '../../../src/cli/commands/audit.js';
import type { EntityRef } from '../../../src/resolve/production/resolver.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let verifyPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  verifyPool = new Pool({ connectionString: container.getConnectionUri() });
  verifyPool.on('error', (err) => {
    // See audit.integration.test.ts's own identical listener for why this
    // is expected, not swallowed silently.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(verifyPool, MIGRATIONS_DIR);
  env.DATABASE_URL = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await verifyPool.end();
  await container.stop();
});

afterEach(async () => {
  await closePool();
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

let anchorDir: string;
let anchorFilePath: string;
beforeEach(async () => {
  anchorDir = await mkdtemp(path.join(tmpdir(), 'authz-anchor-integration-'));
  anchorFilePath = path.join(anchorDir, 'audit-anchor.ndjson');
});
afterEach(async () => {
  await rm(anchorDir, { recursive: true, force: true });
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
): TupleKey {
  return { objectNs, objectId, relation, subjectNs, subjectId };
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(verifyPool, t);
  if (!result.ok)
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(verifyPool, source);
  if (!result.ok) throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
}

interface RawCheckRow {
  id: string;
  chain_seq: string;
  subject_ns: string;
  subject_id: string;
  relation: string;
  object_ns: string;
  object_id: string;
  allowed: boolean;
  consistency_token: string | null;
  resolution_path: unknown;
  depth: number;
  duration_ms: number | null;
  checked_at: Date;
}

function toHashable(row: RawCheckRow): HashableCheckRow {
  return {
    subjectNs: row.subject_ns,
    subjectId: row.subject_id,
    relation: row.relation,
    objectNs: row.object_ns,
    objectId: row.object_id,
    allowed: row.allowed,
    consistencyToken: row.consistency_token,
    resolutionPath: row.resolution_path,
    depth: row.depth,
    durationMs: row.duration_ms,
    checkedAt: row.checked_at,
  };
}

interface ChainRowIdentity {
  id: string;
  chain_seq: string;
}

/** Finds the real chain_seq/id of the checks row this test's own fixture produced for `(subject, object)` — the row this test's own live attack targets. */
async function findOwnRow(subject: EntityRef, object: EntityRef): Promise<ChainRowIdentity> {
  const { rows } = await verifyPool.query<ChainRowIdentity>(
    `select id, chain_seq::text as chain_seq from checks
     where subject_ns = $1 and subject_id = $2 and object_ns = $3 and object_id = $4`,
    [subject.ns, subject.id, object.ns, object.id],
  );
  const row = rows[0];
  if (!row) throw new Error('expected a checks row for this fixture, found none');
  return row;
}

/**
 * The live attack this file exists to run: flips `targetChainSeq`'s own
 * `allowed` column, then recomputes `row_hash`/`prev_hash` forward through
 * the real current chain tip using this codebase's own real
 * `computeCheckRowHash` — genuinely reproducing what a privileged database
 * user with direct SQL access could do, not a simplified stand-in for it.
 * Every row from `targetChainSeq` through the tip gets a real `UPDATE`
 * (target row: `allowed` flipped; every row after it: content unchanged,
 * only `prev_hash`/`row_hash` recomputed to stay internally consistent).
 */
async function simulateFullForwardRewriteFrom(targetChainSeq: string): Promise<void> {
  const { rows: predRows } = await verifyPool.query<{ row_hash: string }>(
    `select row_hash from checks
     where row_hash is not null and chain_seq < $1
     order by chain_seq desc limit 1`,
    [targetChainSeq],
  );
  let prevHash = predRows[0]?.row_hash ?? GENESIS_PREV_HASH;

  // `chain_seq` selected WITHOUT a `::text` cast, deliberately — casting it
  // under the identical alias would make `order by chain_seq asc` resolve
  // against that TEXT alias instead of the real `bigint` column, sorting
  // lexicographically ('10' before '2') rather than numerically once this
  // shared, cross-test `checks` table's real chain_seq reaches double
  // digits — the exact bug this project's own `readChainTip` (`anchor.ts`)
  // had, caught live via this file's own LOCALVERIFY run, fixed there and
  // avoided here the same way. `pg` already returns a `bigint` column as a
  // JS `string` (D-018), so `RawCheckRow.chain_seq: string` needs no cast.
  const { rows } = await verifyPool.query<RawCheckRow>(
    `select id, chain_seq, subject_ns, subject_id, relation, object_ns,
            object_id, allowed, consistency_token, resolution_path, depth, duration_ms, checked_at
     from checks
     where row_hash is not null and chain_seq >= $1
     order by chain_seq asc`,
    [targetChainSeq],
  );
  if (rows.length === 0) throw new Error('expected at least the target row, found none');

  let isTarget = true;
  for (const row of rows) {
    const mutated: RawCheckRow = isTarget ? { ...row, allowed: !row.allowed } : row;
    isTarget = false;

    const newRowHash = computeCheckRowHash(toHashable(mutated), prevHash);
    await verifyPool.query(
      `update checks set allowed = $1, prev_hash = $2, row_hash = $3 where id = $4`,
      [mutated.allowed, prevHash, newRowHash, row.id],
    );
    prevHash = newRowHash;
  }
}

describe('authz audit anchor — records a real anchor entry against real Postgres', () => {
  it('appends-an-entry-matching-the-real-current-chain-tip', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'alice'));
    await performCheck(verifyPool, ref('user', 'alice'), ref(ns, objectId), 'view');

    // No `::text` cast on `chain_seq` here either — see
    // `simulateFullForwardRewriteFrom`'s own comment below for why aliasing
    // it under the same name would break this `order by ... desc limit 1`.
    const { rows: tipRows } = await verifyPool.query<{ chain_seq: string; row_hash: string }>(
      `select chain_seq, row_hash from checks
       where row_hash is not null order by chain_seq desc limit 1`,
    );
    const realTip = tipRows[0];
    if (!realTip) throw new Error('expected a real chain tip after performCheck');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await auditAnchor({ file: anchorFilePath });
    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain(`chain_seq=${realTip.chain_seq}`);
    expect(printed).toContain(`row_hash=${realTip.row_hash}`);

    const entries = await readAnchorFile(anchorFilePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ chainSeq: realTip.chain_seq, rowHash: realTip.row_hash });
  });
});

describe('authz audit anchor / verify --anchor-file — the actual D-148 fail-check', () => {
  it('a-full-consistent-forward-rewrite-is-invisible-to-plain-verify-and-caught-by-anchor-verify', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );

    // Three real, chained checks — the first (dana) is the row this test's
    // own attack later tampers with; the anchor is recorded once all three
    // are already committed, so the attack rewrites strictly *within* the
    // anchored range.
    const fixtures: { subjectId: string; objectId: string }[] = [];
    for (const subjectId of ['dana', 'erin', 'frank']) {
      const objectId = uniqueName('obj');
      await writeOk(tuple(ns, objectId, 'viewer', 'user', subjectId));
      const result = await performCheck(
        verifyPool,
        ref('user', subjectId),
        ref(ns, objectId),
        'view',
      );
      expect(result.allowed).toBe(true);
      fixtures.push({ subjectId, objectId });
    }

    // Record the anchor NOW — before any tampering — exactly the "anchor
    // recorded, then attack happens later" ordering this feature exists to
    // defend against.
    await auditAnchor({ file: anchorFilePath });
    expect(process.exitCode).toBeUndefined();

    const first = fixtures[0];
    const second = fixtures[1];
    const third = fixtures[2];
    if (!first || !second || !third) throw new Error('fixture setup error: expected 3 rows');
    const targetRow = await findOwnRow(ref('user', first.subjectId), ref(ns, first.objectId));

    // THE ATTACK: a raw SQL read-then-write sequence flipping `dana`'s own
    // `allowed` column and recomputing every row_hash/prev_hash forward
    // through the real current tip — exactly the "privileged DB user
    // rewrites the whole chain forward consistently from a tampered row"
    // shape D-148's own "Revisit if" names.
    await simulateFullForwardRewriteFrom(targetRow.chain_seq);

    // --- FACT (a): a plain `authz audit verify`, no --anchor-file, is
    // genuinely blind to this — proven live, not assumed from the design
    // doc's own account of the gap. ---
    {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await auditVerify();

      expect(process.exitCode).toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('rows verified, chain intact.');
      expect(printed).not.toContain('TAMPERING DETECTED');
    }

    process.exitCode = undefined;
    vi.restoreAllMocks();

    // --- FACT (b): `authz audit verify --anchor-file <path>`, given the
    // anchor recorded before the attack, correctly detects and reports it
    // — a distinct, clearly-worded "ANCHOR MISMATCH", never conflated with
    // the plain "TAMPERING DETECTED" single-row-tamper message. ---
    {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await auditVerify({ anchorFile: anchorFilePath });

      expect(process.exitCode).toBe(1);
      const printedError = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printedError).toContain('ANCHOR MISMATCH');
      expect(printedError).not.toContain('TAMPERING DETECTED');
      expect(printedError).toContain('rewritten forward, consistently');

      // The plain internal-walk report still printed first, and still
      // reported the chain intact — the anchor check runs strictly *in
      // addition to* it, never replacing or hiding it.
      const printedLog = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printedLog).toContain('rows verified, chain intact.');
    }
  });
});
