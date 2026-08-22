/**
 * `authz check <subject> <relation> <object> [--at-token <n>]`'s own
 * exit-code mapping — `.claude/commands/build-authz-service.md` §7's exit
 * code table applied to `src/cli/commands/check.ts`'s `check`, mirroring
 * `test/unit/cli/expand.test.ts`'s own established pattern (which itself
 * mirrors `test/unit/cli/soundness.test.ts`'s pattern, Phase 5) — full-repo
 * audit finding #20: `check`'s only existing test
 * (`test/unit/cli/check.integration.test.ts`) covered exactly one branch
 * (a real, allowed, real-Postgres check), with no coverage anywhere for a
 * malformed argument, an invalid `--at-token`, or an unreachable database.
 *
 *   - a malformed subject/object reference exits 2, before `check` ever
 *     touches Postgres
 *   - an invalid `--at-token` (non-integer or negative) exits 2, likewise
 *     before touching Postgres
 *   - an unreachable database exits 3
 *
 * Confirmed directly against `src/cli/commands/check.ts` before writing
 * these tests (its own doc comment states the exit-code mapping verbatim;
 * `parseEntityArg`/the `--at-token` guard were read for their exact
 * rejection conditions, not assumed): the malformed-reference check and
 * the `--at-token` check both run, and both return, before `check` ever
 * calls `getPool()` — confirmed here by leaving `DATABASE_URL` unset
 * entirely for those two cases, not just pointed somewhere unreachable, the
 * same discipline `expand.test.ts` already established.
 *
 * Deliberately DB-free (no `PostgreSqlContainer`, no Docker) — see
 * `docs/DECISIONS.md` D-019/D-030: that rule applies to a test that needs a
 * *working* Postgres to mean anything. None of the three cases here does;
 * the "a real check produces a real `checks` row" case needs a real,
 * schema-published Postgres and lives in the real-Postgres sibling file
 * `test/unit/cli/check.integration.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { check } from '../../../src/cli/commands/check.js';

/** Guaranteed unreachable: nothing listens on this port on the loopback interface in any environment this test runs in — same constant `expand.test.ts`/`soundness.test.ts` already establish. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

describe('authz check — exit codes', () => {
  afterEach(async () => {
    await closePool();
    process.exitCode = undefined;
  });

  it('a-malformed-subject-reference-with-no-colon-exits-2-before-check-ever-touches-postgres', async () => {
    // No DATABASE_URL at all — proves the malformed-argument check happens
    // before the CLI even asks whether a database is configured, let alone
    // reachable.
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('not-a-namespace-colon-id-reference', 'view', 'document:readme', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-malformed-object-reference-with-nothing-after-the-colon-is-also-rejected-as-malformed', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', 'view', 'document:', {});

    expect(process.exitCode).toBe(2);
  });

  it('an-invalid-at-token-that-is-not-an-integer-exits-2-before-check-ever-touches-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', 'view', 'document:readme', { atToken: 'not-a-number' });

    expect(process.exitCode).toBe(2);
  });

  it('an-invalid-at-token-that-is-negative-exits-2-before-check-ever-touches-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', 'view', 'document:readme', { atToken: '-1' });

    expect(process.exitCode).toBe(2);
  });

  // Full-repo audit finding #11 (LOW, third audit, 2026-08-17): `Number('')`
  // and `Number('   ')` both coerce to `0`, which passes the numeric checks
  // below unmodified — an empty/whitespace-only `--at-token` was silently
  // treated as the legitimately-supplied token `0` instead of rejected as
  // malformed, unlike `soundness run --queries=""`/`--progress=""` on the
  // same codebase.
  it('an-invalid-at-token-that-is-empty-exits-2-before-check-ever-touches-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', 'view', 'document:readme', { atToken: '' });

    expect(process.exitCode).toBe(2);
  });

  it('an-invalid-at-token-that-is-whitespace-only-exits-2-before-check-ever-touches-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', 'view', 'document:readme', { atToken: '   ' });

    expect(process.exitCode).toBe(2);
  });

  it('check-against-an-unreachable-database-exits-3-not-a-silent-empty-answer', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;

    await check('user:alice', 'view', 'document:readme', {});

    expect(process.exitCode).toBe(3);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
  }, 30_000);

  // Second full-repo audit, finding #4 (MEDIUM, 2026-08-22) — before this
  // fix, `relation` reached `performCheck` with no validation at all, and
  // `subject`/`object` were only checked for colon *position*, never
  // against the real identifier grammar
  // (`IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH`, `src/schema/dsl/
  // types.ts`) — see `src/cli/entity-ref.ts`'s own doc comment for the
  // concrete audit-trail-corruption repro this closes
  // (`document:evil#hack` as an object/relation could make
  // `resolver.ts`'s `parseFrontierKeyString` silently mis-split a
  // reconstructed path). All four cases below must exit 2 before ever
  // touching Postgres, exactly like the pre-existing malformed-reference
  // cases above.
  it('a-relation-argument-containing-a-hash-exits-2-before-check-ever-touches-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    // The exact repro traced live in src/cli/entity-ref.ts's own doc
    // comment: 'hack#view' as the relation, on an otherwise well-formed
    // object reference.
    await check('user:alice', 'hack#view', 'document:evil', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-relation-argument-containing-a-colon-exits-2-before-check-ever-touches-postgres', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', 'view:extra', 'document:readme', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-subject-reference-whose-id-half-contains-a-hash-is-rejected-as-malformed-not-silently-accepted', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    // Before this fix, parseEntityArg only checked colon position — an id
    // half containing '#' (or anything outside IDENTIFIER_PATTERN) passed
    // straight through as a well-formed EntityArg.
    await check('user:alice#hack', 'view', 'document:readme', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-relation-argument-that-is-empty-exits-2-not-treated-as-a-well-formed-empty-identifier', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await check('user:alice', '', 'document:readme', {});

    expect(process.exitCode).toBe(2);
  });
});
