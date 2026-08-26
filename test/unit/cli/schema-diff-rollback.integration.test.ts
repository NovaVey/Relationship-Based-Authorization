/**
 * `authz schema diff <file>` / `authz schema rollback <namespace>
 * <version>` (`src/cli/commands/schema.ts`'s `diffSchemaFile`/
 * `rollbackSchema`) against a real Postgres — the end-to-end case neither
 * `test/unit/schema/diff.test.ts` (DB-free, `diffNamespace` in isolation)
 * nor a hand-built `NamespaceConfig` can exercise: a REAL narrowing
 * publish genuinely revoking a REAL grant, `schema diff` warning about it
 * BEFORE that publish happens, and `schema rollback` genuinely restoring
 * the original grant afterward by republishing the original version's own
 * stored source.
 *
 * The story this test proves, start to finish:
 *   1. Publish v1: `view = viewer | editor`. Write a tuple granting Erin
 *      `editor`. Confirm `performCheck` returns `allowed: true` for her —
 *      this is the real grant the rest of the test is about.
 *   2. Run `authz schema diff` against a v2 candidate that drops the
 *      `editor` branch (`view = viewer`) — WITHOUT publishing v2 yet.
 *      Confirm the printed warning names `view` and classifies it
 *      `possibly-narrowing`, and `process.exitCode` is `1`.
 *   3. Actually publish v2. Confirm Erin's identical `performCheck` call
 *      now returns `allowed: false` — the narrowing `schema diff` warned
 *      about really did revoke her access, proving the warning wasn't a
 *      false alarm about nothing.
 *   4. Run `authz schema rollback <namespace> 1`. Confirm Erin's identical
 *      `performCheck` call is `allowed: true` again — rollback genuinely
 *      restored the original grant, not just re-printed v1's source.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { performCheck } from '../../../src/audit/checks.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { diffSchemaFile, rollbackSchema } from '../../../src/cli/commands/schema.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let verifyPool: Pool;
let tmpDir: string;

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
  tmpDir = mkdtempSync(join(tmpdir(), 'authz-schema-diff-rollback-'));
}, 120_000);

afterAll(async () => {
  await verifyPool.end();
  await container.stop();
  rmSync(tmpDir, { recursive: true, force: true });
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

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(verifyPool, t);
  if (!result.ok)
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
}

function writeSchemaFile(name: string, source: string): string {
  const file = join(tmpDir, name);
  writeFileSync(file, source);
  return file;
}

function widenedSource(ns: string): string {
  return [
    `namespace ${ns} {`,
    '  relation viewer: user',
    '  relation editor: user',
    '  permission view = viewer | editor',
    '}',
  ].join('\n');
}

function narrowedSource(ns: string): string {
  // The `editor` branch is gone — a genuine, real union-branch removal:
  // anyone who only ever held `editor` (never `viewer`) loses `view`.
  return [
    `namespace ${ns} {`,
    '  relation viewer: user',
    '  relation editor: user',
    '  permission view = viewer',
    '}',
  ].join('\n');
}

describe('authz schema diff warns about a real narrowing publish before it happens, and authz schema rollback genuinely restores the grant it removed', () => {
  it('diff-warns-narrowing-publish-actually-revokes-rollback-actually-restores', async () => {
    const ns = uniqueName('doc');
    const objectId = uniqueName('obj');

    // --- Step 1: publish v1, grant Erin `editor`, confirm she can `view`. ---
    const v1 = await publishSchema(verifyPool, widenedSource(ns));
    if (!v1.ok) throw new Error(`v1 fixture schema failed to publish: ${v1.errors.join('; ')}`);
    expect(v1.published).toEqual([{ namespace: ns, version: 1 }]);

    await writeOk({
      objectNs: ns,
      objectId,
      relation: 'editor',
      subjectNs: 'user',
      subjectId: 'erin',
    });

    const beforeNarrowing = await performCheck(
      verifyPool,
      { ns: 'user', id: 'erin' },
      { ns, id: objectId },
      'view',
    );
    expect(beforeNarrowing.allowed).toBe(true);

    // --- Step 2: `authz schema diff` against the narrowed v2 candidate — ---
    // --- BEFORE it's ever published. ---
    const v2File = writeSchemaFile(`${ns}-v2.authz`, narrowedSource(ns));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    await diffSchemaFile(v2File);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const diffOutput = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(diffOutput).toContain(`${ns}:`);
    expect(diffOutput).toContain('permission view: changed (possibly-narrowing)');
    expect(diffOutput).toContain('WARNING: 1 possibly-narrowing change(s)');
    expect(diffOutput).toContain("- permission 'view':");
    logSpy.mockRestore();
    errorSpy.mockRestore();

    // Nothing was actually published by `diff` — v1 (still `viewer | editor`)
    // remains the latest published version, and Erin's grant is untouched.
    const stillBeforePublish = await performCheck(
      verifyPool,
      { ns: 'user', id: 'erin' },
      { ns, id: objectId },
      'view',
    );
    expect(stillBeforePublish.allowed).toBe(true);

    // --- Step 3: actually publish v2 — the narrowing `diff` warned about. ---
    const v2 = await publishSchema(verifyPool, narrowedSource(ns));
    if (!v2.ok) throw new Error(`v2 fixture schema failed to publish: ${v2.errors.join('; ')}`);
    expect(v2.published).toEqual([{ namespace: ns, version: 2 }]);

    const afterNarrowing = await performCheck(
      verifyPool,
      { ns: 'user', id: 'erin' },
      { ns, id: objectId },
      'view',
    );
    // The real proof the warning wasn't crying wolf: Erin's grant, which
    // came ONLY from `editor` (never `viewer`), is genuinely gone now.
    expect(afterNarrowing.allowed).toBe(false);

    // --- Step 4: `authz schema rollback` back to v1 — restores the grant. ---
    process.exitCode = undefined;
    const rollbackLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const rollbackErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await rollbackSchema(ns, '1');

    expect(rollbackErrorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const rollbackOutput = rollbackLogSpy.mock.calls.map((call) => String(call[0])).join('\n');
    // Rollback republishes v1's exact stored source as a NEW version (3),
    // never resurrecting/mutating version 1 itself — see
    // `getNamespaceConfigVersion`'s own doc comment.
    expect(rollbackOutput).toBe(`published ${ns} v3`);
    rollbackLogSpy.mockRestore();
    rollbackErrorSpy.mockRestore();

    const afterRollback = await performCheck(
      verifyPool,
      { ns: 'user', id: 'erin' },
      { ns, id: objectId },
      'view',
    );
    expect(afterRollback.allowed).toBe(true);
  });

  /**
   * `authz schema diff` against a candidate that ONLY widens (a pure union
   * addition — the exact negative case this task's own instructions single
   * out as mattering as much as the positive one: "a false-positive warning
   * on every publish would make the tool useless"). Publishes a real v1,
   * then diffs a real v2 that adds a brand-new `owner` branch on top of the
   * unchanged `viewer` one, and confirms NO warning fires and the exit code
   * stays `0` — proving this isn't a tool that cries wolf on every publish.
   */
  it('diff-does-not-warn-on-a-pure-widening-candidate-a-union-gaining-a-branch', async () => {
    const ns = uniqueName('doc');
    const v1Source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '  relation owner: user',
      '  permission view = viewer',
      '}',
    ].join('\n');
    const v2Source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      '  relation owner: user',
      '  permission view = viewer | owner',
      '}',
    ].join('\n');

    const v1 = await publishSchema(verifyPool, v1Source);
    if (!v1.ok) throw new Error(`v1 fixture schema failed to publish: ${v1.errors.join('; ')}`);

    const v2File = writeSchemaFile(`${ns}-widen-v2.authz`, v2Source);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    await diffSchemaFile(v2File);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('permission view: changed (widen)');
    expect(output).not.toContain('WARNING');
  });
});
