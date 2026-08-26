/**
 * `authz audit verify` (`src/cli/commands/audit.ts`, `auditVerify`) against
 * a real Postgres — the actual fail-check this feature exists to pass, not
 * a mocked stand-in for one: write several real checks through
 * `performCheck` (`src/audit/checks.ts`), confirm `auditVerify` reports the
 * hash chain intact, then perform a raw SQL `UPDATE` against one already-
 * committed row's `allowed` column — simulating exactly the kind of
 * tampering this feature exists to detect — and confirm `auditVerify` now
 * reports that EXACT row as the first broken link, not merely "something
 * is wrong somewhere."
 *
 * **Why counts are asserted as deltas, never hardcoded totals.** This
 * describe block's own checks are the only rows this test controls, but
 * this project's `checks` table has no per-test isolation of its own (by
 * design — the hash chain is one single, global sequence, exactly like
 * `write_log`, see `src/audit/checks.ts`'s own top-of-file "Concurrency"
 * section) and this file follows this repo's own D-019/D-030 convention of
 * a fresh, ephemeral container per `*.integration.test.ts` file — so in
 * ordinary CI this table starts genuinely empty, but nothing about this
 * file's own correctness should *depend* on that. Every count assertion
 * below compares a fresh `count(*) where row_hash is not null` taken
 * immediately before and after this test's own writes, rather than
 * asserting a literal "N/N" string — correct whether this container's
 * `checks` table started at 0 rows or already had unrelated history.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { performCheck } from '../../../src/audit/checks.js';
import { auditVerify } from '../../../src/cli/commands/audit.js';
import type { EntityRef } from '../../../src/resolve/production/resolver.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let verifyPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  verifyPool = new Pool({ connectionString: container.getConnectionUri() });
  verifyPool.on('error', (err) => {
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

/** The current chain's own size — see this file's own top-of-file doc comment for why every count assertion is a delta against this, never a hardcoded total. */
async function countChainedRows(): Promise<number> {
  const { rows } = await verifyPool.query<{ count: string }>(
    `select count(*)::text as count from checks where row_hash is not null`,
  );
  return Number(rows[0]?.count ?? '0');
}

interface ChainRowIdentity {
  id: string;
  chain_seq: string;
}

/** Finds the real chain_seq/id of the checks row this test's own fixture produced for `(subject, object)` — used to build a raw, targeted `UPDATE` that tampers with exactly one row. */
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

describe('authz audit verify — writes several real checks, confirms the chain intact', () => {
  it('reports-every-newly-chained-row-verified-with-no-tampering-detected', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );

    const before = await countChainedRows();

    // Several real checks — a mix of allowed and denied, over several
    // distinct objects/subjects, exactly the "writes several real checks"
    // this feature's own live fail-check calls for.
    const subjects = ['alice', 'bob', 'carol'];
    for (const subjectId of subjects) {
      const objectId = uniqueName('obj');
      await writeOk(tuple(ns, objectId, 'viewer', 'user', subjectId));
      const result = await performCheck(
        verifyPool,
        ref('user', subjectId),
        ref(ns, objectId),
        'view',
      );
      expect(result.allowed).toBe(true);
    }
    // One denied check too — the hash chain covers denials identically to
    // allows (see checks.ts's own canonical-serialization section).
    const deniedObjectId = uniqueName('obj');
    const deniedResult = await performCheck(
      verifyPool,
      ref('user', 'mallory'),
      ref(ns, deniedObjectId),
      'view',
    );
    expect(deniedResult.allowed).toBe(false);

    const after = await countChainedRows();
    expect(after).toBe(before + subjects.length + 1);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await auditVerify();

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain(`authz audit verify: ${after}/${after} rows verified, chain intact.`);
  });
});

describe('authz audit verify — a raw UPDATE against a committed row is detected as the first broken link (live fail-check)', () => {
  it('names-the-exact-tampered-row-not-just-that-something-somewhere-is-wrong', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );

    // Three real checks, chained one after another — the middle one is the
    // one this test tampers with, so a correct implementation must walk
    // past the first (genuinely untouched) row before reporting the
    // tampered one, never just report "row 1 is fine" and stop early, and
    // never report the row AFTER the tampered one instead.
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

    // First: confirm the chain really is intact before any tampering —
    // this test's own control, proving the later failure is caused by the
    // UPDATE below and not some pre-existing, unrelated break.
    {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await auditVerify();
      expect(process.exitCode).toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const middle = fixtures[1];
    if (!middle) throw new Error('fixture setup error: expected a middle row');
    const targetSubject = ref('user', middle.subjectId);
    const targetObject = ref(ns, middle.objectId);
    const targetRow = await findOwnRow(targetSubject, targetObject);

    // The live fail-check itself: a raw SQL UPDATE against an already-
    // committed row's `allowed` column, simulating exactly the tampering
    // this feature exists to detect — no CLI, no ORM, a bare UPDATE
    // exactly as a privileged database user with direct SQL access could
    // run it for real.
    await verifyPool.query(`update checks set allowed = not allowed where id = $1`, [targetRow.id]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await auditVerify();

    // Tampering must be reported as a real, blocking finding — exit code
    // 1, never a silent success and never conflated with an infrastructure
    // failure (exit code 3).
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    const printedError = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printedError).toContain('TAMPERING DETECTED');
    // Names the EXACT row — its chain_seq, its id, and enough of its real
    // recorded columns (subject/object) that an operator can see precisely
    // what was altered, per this command's own top-of-file doc comment.
    expect(printedError).toContain(targetRow.chain_seq);
    expect(printedError).toContain(targetRow.id);
    expect(printedError).toContain(`user:${middle.subjectId}`);
    expect(printedError).toContain(`${ns}:${middle.objectId}`);

    // Never names either of the two neighboring, genuinely untampered rows
    // as if they were the break — the report is about the middle row
    // specifically, not "somewhere in this general area."
    const first = fixtures[0];
    const last = fixtures[2];
    if (!first || !last) throw new Error('fixture setup error: expected first/last rows');
    expect(printedError).not.toContain(`user:${first.subjectId}`);
    expect(printedError).not.toContain(`user:${last.subjectId}`);

    // Revert the tampering and confirm a fresh run goes back to reporting
    // the chain intact — proves this command reflects the database's real,
    // current state on every run, not a cached verdict from the earlier
    // failure.
    await verifyPool.query(`update checks set allowed = not allowed where id = $1`, [targetRow.id]);
    logSpy.mockClear();
    errorSpy.mockClear();
    process.exitCode = undefined;

    await auditVerify();

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    const printedAfterRevert = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printedAfterRevert).toContain('chain intact');
  });
});
