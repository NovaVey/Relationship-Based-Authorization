/**
 * `authz check <subject> <relation> <object>` (`src/cli/commands/check.ts`,
 * `check`) against a real Postgres — proves the CLI wiring itself routes a
 * real check through `performCheck` (`src/audit/checks.ts`, Phase 6), not
 * just that `performCheck` works correctly in isolation (already proven in
 * `test/unit/audit/checks.integration.test.ts`). This runs the actual CLI
 * command function end to end and confirms a `checks` row exists
 * afterward, read back with a connection independent of the one the CLI
 * command itself opened and closed.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { check } from '../../../src/cli/commands/check.js';

const MIGRATIONS_DIR = new URL('../../../src/store/migrations', import.meta.url).pathname;

let container: StartedPostgreSqlContainer;
let verifyPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  verifyPool = new Pool({ connectionString: container.getConnectionUri() });
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
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
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

describe('authz check really persists a checks row, end to end through the CLI', () => {
  it('a-real-cli-check-invocation-produces-a-matching-checks-row-via-performcheck-not-just-a-printed-answer', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    await writeOk(tuple(ns, objectId, 'viewer', 'user', 'grace'));

    process.exitCode = undefined;
    // The real CLI command function — not performCheck called directly —
    // proving src/cli/commands/check.ts's own wiring, not performCheck in
    // isolation.
    await check('user:grace', 'view', `${ns}:${objectId}`, {});

    expect(process.exitCode).toBeUndefined();

    const { rows } = await verifyPool.query(
      `select allowed, resolution_path, depth from checks
       where subject_ns = 'user' and subject_id = 'grace' and relation = 'view'
         and object_ns = $1 and object_id = $2
       order by checked_at desc
       limit 1`,
      [ns, objectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed).toBe(true);
    expect(rows[0]?.resolution_path).not.toBeNull();
    expect(Number.isInteger(rows[0]?.depth)).toBe(true);
  });

  /**
   * The denied half — full-repo audit finding #20: the CLI's only prior
   * test covered exclusively the allowed path. §9 Phase 6's own exit
   * criterion states "every check, allowed or denied, is logged" — a
   * `checks` row for a denial that never got written (or got written with
   * `allowed: true` by mistake) would be exactly the kind of gap that
   * criterion exists to rule out, and nothing previously exercised it
   * through the real CLI command function.
   */
  it('a-real-cli-check-invocation-with-no-matching-tuple-prints-denied-exits-0-and-still-writes-a-checks-row-with-allowed-false', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [`namespace ${ns} {`, '  relation viewer: user', '', '  permission view = viewer', '}'].join(
        '\n',
      ),
    );
    const objectId = uniqueName('obj');
    // Deliberately never written to — no tuple names 'heidi' anywhere on
    // this object, so the check must resolve denied.

    process.exitCode = undefined;
    await check('user:heidi', 'view', `${ns}:${objectId}`, {});

    // Denial is information, not an error — §7's own exit-code table (see
    // check.ts's own doc comment): 0, not 1, not 3.
    expect(process.exitCode).toBeUndefined();

    const { rows } = await verifyPool.query(
      `select allowed, resolution_path, depth from checks
       where subject_ns = 'user' and subject_id = 'heidi' and relation = 'view'
         and object_ns = $1 and object_id = $2
       order by checked_at desc
       limit 1`,
      [ns, objectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed).toBe(false);
    // `performCheck`'s own contract: `resolution_path` populated iff
    // `allowed` is true — a denial must never carry a stale or fabricated
    // path.
    expect(rows[0]?.resolution_path).toBeNull();
    expect(Number.isInteger(rows[0]?.depth)).toBe(true);
  });
});
