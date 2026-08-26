/**
 * `authz tuple write` / `authz tuple delete`'s own exit-code mapping —
 * mirrors `test/unit/cli/check.test.ts`'s established pattern (itself
 * mirroring `expand.test.ts`/`soundness.test.ts`) — full-repo audit finding
 * #13: `tupleWrite`/`tupleDelete` checked `env.DATABASE_URL` and exited 3
 * *before* ever running `validateIdentifiers` on the already-parsed tuple
 * key, so a malformed identifier (e.g. an id containing a space) was masked
 * behind an unrelated "DATABASE_URL is not set" infrastructure message
 * whenever no database happened to be configured — reported at exit 3
 * instead of the exit-2 argument error it actually is.
 *
 *   - a malformed object/subject reference (bad grammar — no colon, empty
 *     id) exits 2, before either command ever touches Postgres
 *   - a well-formed-grammar but invalid-identifier reference (e.g. an id
 *     containing a space) ALSO exits 2, before either command ever touches
 *     Postgres — this is the specific case finding #13 covers; before the
 *     fix, this case fell all the way through to the `DATABASE_URL` check
 *     and exited 3 whenever no database was configured
 *   - an unreachable database exits 3, for a *validly-shaped* tuple key
 *
 * Confirmed directly against `src/cli/commands/tuple.ts` before writing
 * these tests: `buildTupleKey`'s own parsing only checks colon/hash
 * *position* (grammar), never character content — `validateIdentifiers`
 * (now exported from `src/store/tuples.ts` specifically for this) is the
 * check that rejects an id like `'INVALID ID'`, and now runs directly in
 * the CLI before the `DATABASE_URL` check, not only later inside
 * `writeTuple`/`deleteTuple` themselves.
 *
 * Deliberately DB-free (no `PostgreSqlContainer`, no Docker) — see
 * `docs/DECISIONS.md` D-019/D-030: none of the cases here need a *working*
 * Postgres to mean anything, matching `check.test.ts`'s own established
 * scoping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { tupleWrite, tupleDelete } from '../../../src/cli/commands/tuple.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import type { WriteTupleResult } from '../../../src/store/tuples.js';

/** Guaranteed unreachable — same constant `check.test.ts`/`expand.test.ts` already establish. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

describe.each([
  ['tuple write', tupleWrite],
  ['tuple delete', tupleDelete],
])('authz %s — exit codes', (_label, command) => {
  afterEach(async () => {
    await closePool();
    process.exitCode = undefined;
  });

  it('a-malformed-object-reference-with-no-colon-exits-2-before-ever-touching-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await command('not-a-namespace-colon-id-reference', 'viewer', 'user:alice');

    expect(process.exitCode).toBe(2);
  });

  it('an-object-id-containing-a-space-fails-identifier-validation-and-exits-2-not-3-even-with-no-database-url-configured', async () => {
    // The finding's own reproduction: DATABASE_URL deliberately unset
    // entirely. Before the fix, this fell through the grammar-only
    // buildTupleKey check (which accepts 'document:INVALID ID' — colon
    // position is fine), reached the DATABASE_URL check next, and exited 3
    // with a Postgres-connection message instead of reporting the real,
    // immediately-decidable argument error.
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await command('document:INVALID ID', 'viewer', 'user:alice');

    expect(process.exitCode).toBe(2);
  });

  it('a-subject-id-containing-a-space-is-also-caught-before-the-database-url-check', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await command('document:readme', 'viewer', 'user:INVALID ID');

    expect(process.exitCode).toBe(2);
  });

  it('a-validly-shaped-tuple-against-an-unreachable-database-exits-3-not-a-silent-empty-answer', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;

    await command('document:readme', 'viewer', 'user:alice');

    expect(process.exitCode).toBe(3);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
  }, 30_000);
});

/**
 * `authz tuple write --expires-at` (D-144) — the optional validity-window
 * expiry field, threaded from the CLI's own `--expires-at <iso8601>` option
 * (`src/cli/index.ts`) through `tupleWrite`'s new fourth `options` argument.
 *
 * `writeTuple` itself is mocked here (`vi.spyOn` on the `store/tuples.js`
 * module namespace — the same pattern `test/unit/api/server.test.ts`
 * already establishes for this exact function) rather than exercised
 * against a real or even unreachable Postgres: the whole point of these
 * cases is confirming the *parsed* `Date` reaches the `TupleKey` object
 * `writeTuple` is called with, verbatim — not re-proving `writeTuple`'s own
 * behavior, which the existing DB-backed/DB-free tests elsewhere already
 * cover.
 */
describe('authz tuple write --expires-at (D-144)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('a-valid-iso-8601-expires-at-value-is-parsed-into-a-date-and-passed-through-to-writeTuple-verbatim', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockResolvedValue({ ok: true, token: 1, created: true } satisfies WriteTupleResult);

    await tupleWrite('document:readme', 'viewer', 'user:alice', {
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expiresAt: new Date('2027-01-01T00:00:00.000Z') }),
    );
    // A successful, mocked write never touches process.exitCode.
    expect(process.exitCode).toBeUndefined();
  });

  it('a-malformed-expires-at-value-exits-2-before-ever-touching-postgres-and-writeTuple-is-never-called', async () => {
    // DATABASE_URL deliberately unset entirely — mirrors this file's own
    // established discipline above (the malformed-reference/malformed-
    // identifier cases) for proving the argument error is caught before
    // the CLI ever asks whether a database is configured, let alone
    // reachable.
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;
    const spy = vi.spyOn(tuplesModule, 'writeTuple');

    await tupleWrite('document:readme', 'viewer', 'user:alice', {
      expiresAt: 'not-a-real-date',
    });

    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('omitting---expires-at-entirely-still-writes-a-non-expiring-tuple-unchanged-from-before-this-flag-existed', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;
    const spy = vi
      .spyOn(tuplesModule, 'writeTuple')
      .mockResolvedValue({ ok: true, token: 1, created: true } satisfies WriteTupleResult);

    await tupleWrite('document:readme', 'viewer', 'user:alice');

    expect(spy).toHaveBeenCalledTimes(1);
    const [, calledTuple] = spy.mock.calls[0]!;
    expect(calledTuple).not.toHaveProperty('expiresAt');
    expect(process.exitCode).toBeUndefined();
  });
});
