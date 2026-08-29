/**
 * `authz apikey create|revoke|list`'s own argument-validation exit codes —
 * mirrors `test/unit/cli/tuple.test.ts`'s established pattern exactly:
 * every malformed-argument case here exits 2 BEFORE ever touching
 * Postgres (`env.DATABASE_URL` is deliberately left unset for those cases,
 * proving the validation genuinely runs first, the same "finding #13"
 * discipline `tuple.test.ts`'s own top-of-file doc comment documents), and
 * a validly-shaped call with no database configured exits 3. Deliberately
 * DB-free (no `PostgreSqlContainer`, no Docker) — see `docs/DECISIONS.md`
 * D-019/D-030: none of the cases here need a *working* Postgres to mean
 * anything.
 *
 * The success path (a real key actually created/revoked/listed) is not
 * re-derived here — that's `test/unit/store/api-keys.integration.test.ts`'s
 * job against a real, ephemeral Postgres; this file only proves the CLI's
 * own pre-database argument checks.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { apikeyCreate, apikeyRevoke, apikeyList } from '../../../src/cli/commands/apikey.js';

afterEach(async () => {
  await closePool();
  process.exitCode = undefined;
});

describe('authz apikey create — argument validation exits 2 before ever touching Postgres', () => {
  it('an-invalid-role-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'superadmin' });
    expect(process.exitCode).toBe(2);
  });

  it('a-scope-flag-that-parses-to-zero-namespaces-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'admin', scope: ' , ,' });
    expect(process.exitCode).toBe(2);
  });

  it('a-scope-entry-that-is-not-a-valid-identifier-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'admin', scope: 'Not-Valid!' });
    expect(process.exitCode).toBe(2);
  });

  it('a-malformed-expires-at-string-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'admin', expiresAt: 'not-a-real-date' });
    expect(process.exitCode).toBe(2);
  });

  it('an-expires-at-in-the-past-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'admin', expiresAt: '2020-01-01T00:00:00Z' });
    expect(process.exitCode).toBe(2);
  });

  it('an-all-whitespace-name-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'admin', name: '   ' });
    expect(process.exitCode).toBe(2);
  });

  it('a-validly-shaped-create-with-no-database-configured-exits-3-not-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyCreate({ role: 'readonly', scope: 'document,folder', name: 'ci key' });
    expect(process.exitCode).toBe(3);
  });
});

describe('authz apikey revoke — argument validation exits 2 before ever touching Postgres', () => {
  it('a-non-numeric-id-exits-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyRevoke('not-a-number');
    expect(process.exitCode).toBe(2);
  });

  it('a-negative-looking-id-with-a-leading-minus-exits-2-since-a-bare-non-negative-integer-is-required', async () => {
    env.DATABASE_URL = undefined;
    await apikeyRevoke('-5');
    expect(process.exitCode).toBe(2);
  });

  it('a-well-formed-numeric-id-with-no-database-configured-exits-3-not-2', async () => {
    env.DATABASE_URL = undefined;
    await apikeyRevoke('42');
    expect(process.exitCode).toBe(3);
  });

  it('an-id-overflowing-bigint-exits-2-not-3-even-with-no-database-configured', async () => {
    // Full-repo audit finding #12 (2026-08-29): a numeral this large passes
    // the /^\d+$/ shape check but can never fit `id`'s real Postgres bigint
    // column (max 2^63 - 1) — before the fix this fell through to the
    // DATABASE_URL check and exited 3, masking the real argument error.
    env.DATABASE_URL = undefined;
    await apikeyRevoke('99999999999999999999');
    expect(process.exitCode).toBe(2);
  });
});

describe('authz apikey list — no database configured exits 3', () => {
  it('exits-3-when-database-url-is-unset', async () => {
    env.DATABASE_URL = undefined;
    await apikeyList();
    expect(process.exitCode).toBe(3);
  });
});
