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
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { check } from '../../../src/cli/commands/check.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

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

  /**
   * `--path` — full-repo audit finding #8: the README's own headline
   * example states `authz check user:dana edit document:eng_handbook`
   * "returns this exact path," but before this flag existed, plain `check`
   * only ever printed `ALLOWED`/`DENIED`. Builds the identical shape as the
   * README's own worked example (nested group membership → a
   * tuple-to-userset `parent` hop → the document) against a real,
   * uniquely-named namespace, and asserts the printed `--path` output
   * matches, hop-for-hop, so this stays proven against a live check, not
   * just the DB-free hand-built trees in `test/unit/cli/check-path.test.ts`.
   */
  it('a-real-cli-check-invocation-with---path-prints-the-real-resolution-path', async () => {
    const ns = uniqueName('doc');
    await publishOk(
      [
        `namespace ${ns} {`,
        '  relation editor: user',
        '  relation parent: folder',
        '  permission edit = editor | parent->editor',
        '}',
        `namespace folder {`,
        '  relation editor: user',
        '  relation member: user',
        '}',
      ].join('\n'),
    );
    const folderId = uniqueName('folder');
    const docId = uniqueName('doc');
    await writeOk(tuple('folder', folderId, 'editor', 'user', 'dana'));
    await writeOk({
      objectNs: ns,
      objectId: docId,
      relation: 'parent',
      subjectNs: 'folder',
      subjectId: folderId,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    try {
      await check('user:dana', 'edit', `${ns}:${docId}`, { path: true });
      // Read `.mock.calls` before `mockRestore()` — `mockRestore()` does
      // everything `mockReset()` does (which clears recorded calls) and
      // then restores the original implementation; reading after restoring
      // silently sees an empty array, not an error, which is exactly what
      // caught this during LOCALVERIFY (every assertion below failed with
      // "expected undefined" — zero calls recorded — even though a
      // standalone reproduction of the identical call outside vitest
      // printed the correct three lines every time).
      lines = logSpy.mock.calls.map((call) => call[0] as string);
    } finally {
      logSpy.mockRestore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(lines[0]).toBe(`user:dana edit ${ns}:${docId}: ALLOWED`);
    expect(lines.slice(1)).toEqual([
      'user:dana',
      `  → folder:${folderId}#editor`,
      `  → ${ns}:${docId}#edit`,
    ]);
  });
});
