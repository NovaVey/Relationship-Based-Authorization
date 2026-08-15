/**
 * `authz expand <object> <relation>`'s own exit-code mapping —
 * `.claude/commands/build-authz-service.md` §7's exit code table applied to
 * `src/cli/commands/expand.ts`'s `expandCli`, mirroring `test/unit/cli/
 * soundness.test.ts`'s own established pattern (Phase 5):
 *
 *   - `a-malformed-object-reference-exits-2-before-expand-ever-touches-postgres`
 *   - `expand-against-an-unreachable-database-exits-3-not-a-silent-empty-tree`
 *
 * Deliberately DB-free (no `PostgreSqlContainer`, no Docker) — see
 * `docs/DECISIONS.md` D-019/D-030: that rule applies to a test that needs a
 * *working* Postgres to mean anything. Neither test here does. The
 * malformed-reference case never reaches any DB-related code path at all
 * (confirmed by leaving `DATABASE_URL` unset entirely, not just pointed
 * somewhere unreachable). The unreachable-database case runs the real,
 * unmocked `expandCli` against a real `pg.Pool` pointed at a connection
 * string guaranteed unreachable (a closed local port) — no container
 * needed, since the whole point is that nothing is listening there.
 *
 * The "an undeclared relation/permission resolves an explicit `undeclared`
 * node at exit 0, never a throw" case needs a real, schema-published
 * Postgres to exercise — see the real-Postgres sibling file `test/unit/cli/
 * expand.integration.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { expandCli } from '../../../src/cli/commands/expand.js';

/** Guaranteed unreachable: nothing listens on this port on the loopback interface in any environment this test runs in. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

describe('authz expand — exit codes', () => {
  afterEach(async () => {
    await closePool();
    process.exitCode = undefined;
  });

  it('a-malformed-object-reference-exits-2-before-expand-ever-touches-postgres', async () => {
    // No DATABASE_URL at all — proves the malformed-argument check happens
    // before the CLI even asks whether a database is configured, let alone
    // whether one is reachable.
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await expandCli('not-a-namespace-colon-id-reference', 'view');

    expect(process.exitCode).toBe(2);
  });

  it('an-object-reference-with-nothing-after-the-colon-is-also-rejected-as-malformed', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await expandCli('document:', 'view');

    expect(process.exitCode).toBe(2);
  });

  it('expand-against-an-unreachable-database-exits-3-not-a-silent-empty-tree', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;

    await expandCli('document:readme', 'view');

    expect(process.exitCode).toBe(3);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
  }, 30_000);
});
