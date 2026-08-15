/**
 * `authz expand <object> <relation>` (`src/cli/commands/expand.ts`,
 * `expandCli`) against a real Postgres — the one case from
 * `.claude/commands/build-authz-service.md`'s Phase 6 delegation that needs
 * real, schema-published data to exercise: an undeclared relation or
 * permission name must resolve to an explicit `undeclared` node in the
 * printed tree at exit 0, never a throw.
 *
 * This was NOT assumed from `src/audit/expand.ts`'s own already-covered
 * behavior (`test/unit/audit/expand.integration.test.ts` already proves
 * `expand()` itself returns `{ kind: 'undeclared', ... }` rather than
 * throwing) — what's actually new and untested here is the CLI *wrapper*:
 * does `expandCli` render that node and leave `process.exitCode` unset
 * (success), or does something in its own try/catch/exit-code plumbing
 * accidentally treat it as an error? Read directly from
 * `src/cli/commands/expand.ts` before writing this test: its `catch` block
 * only fires on a thrown error from `expand()` itself, and `expand()`
 * returning an `undeclared` node is not a thrown error — so the expected
 * behavior below is confirmed against the actual code path, not assumed.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { expandCli } from '../../../src/cli/commands/expand.js';

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
  vi.restoreAllMocks();
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(verifyPool, source);
  if (!result.ok) throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
}

describe('authz expand — an undeclared relation/permission resolves an explicit node, never a throw', () => {
  it('an-undeclared-relation-or-permission-resolves-an-explicit-undeclared-node-in-the-printed-tree-at-exit-0', async () => {
    const ns = uniqueName('doc');
    await publishOk([`namespace ${ns} {`, '  relation viewer: user', '}'].join('\n'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    await expandCli(`${ns}:obj0`, 'not_a_real_relation_or_permission');

    // Success — no error path taken, no exit code set (Node treats an
    // unset process.exitCode as an implicit 0, matching soundness.test.ts's
    // own established "sound run leaves exit code at its default" pattern).
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('undeclared');
    expect(printed).toContain('not_a_real_relation_or_permission');
  });
});
