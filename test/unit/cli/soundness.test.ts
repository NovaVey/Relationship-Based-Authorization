/**
 * `authz soundness run`'s own exit-code mapping — build spec §7's exit
 * code table (`0` sound, `1` unsound, `2` insufficient_coverage/malformed
 * args, `3` infrastructure failure) as `src/cli/commands/soundness.ts`
 * itself documents it, and §10's "CI" test-plan bullets:
 *
 *   - `a-false-grant-exits-one-and-an-infrastructure-failure-exits-three`
 *   - `an-unreachable-database-fails-the-check-rather-than-passing-it`
 *
 * Deliberately DB-free (no `PostgreSqlContainer`, no Docker) — see
 * `docs/DECISIONS.md` D-019/D-030's "testcontainers only, never a
 * hardcoded local connection string" rule: it applies to a test that needs
 * a *working* Postgres to mean anything. Neither test here does:
 *
 * - The `false_grant` -> exit 1 half of the first test stands in a canned
 *   `SoundnessRunResult` (verdict `unsound`) for `runSoundnessFuzz` via
 *   `vi.spyOn` on the whole exported function, rather than running a real
 *   fuzz pass. This is a deliberate choice, not a shortcut taken to dodge
 *   Postgres: the fuzz harness's own ability to *detect* a false_grant is
 *   already proven, twice, elsewhere — the synthetic-broken-engine test in
 *   `test/isolation/differential-soundness.fuzz.test.ts` (no Postgres) and
 *   the real 5,000-query run in `differential-soundness.fuzz
 *   .integration.test.ts` (real Postgres). There is also no way to trigger
 *   a *real* false_grant through this CLI without either an actual
 *   unsoundness bug in the shipped resolver (not something to assume into
 *   existence) or mutating shipped resolver source at test-run time, which
 *   this task's own hard constraints forbid. What's specifically under
 *   test here — and untested anywhere else — is much narrower: does the
 *   CLI correctly map an `unsound` verdict onto exit code 1? Spying on
 *   `runSoundnessFuzz` (the orchestration entry point, not a resolver, and
 *   not the reference resolver being checked against the production one)
 *   isolates exactly that question. `runSoundnessFuzz` is otherwise
 *   completely un-mocked everywhere else in this repo's suite.
 * - The infrastructure-failure -> exit 3 half of the first test, and the
 *   second test, run the real, unmocked `soundnessRun` against a real
 *   `pg.Pool` pointed at a connection string that is guaranteed
 *   unreachable (a closed local port) — no container needed, and no
 *   dependency on any one environment's local Postgres either, since the
 *   whole point is that nothing is listening there.
 *
 * `env.DATABASE_URL` (`src/config/env.ts`) is a plain, mutable object (not
 * frozen, not re-loaded per test) — set directly in each test rather than
 * via `process.env` + a module reset, matching how `src/store/client.ts`'s
 * `getPool()` actually reads it (at call time, not at its own import
 * time). `closePool()` after each scenario resets `client.ts`'s pool
 * singleton so the next scenario's `env.DATABASE_URL` change actually
 * takes effect on the next `getPool()` call — `soundnessRun` itself calls
 * `closePool()` in its own `finally`, so this is only a defensive
 * belt-and-suspenders `afterEach`, not load-bearing on its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as runnerModule from '../../../src/soundness/runner.js';
import { env } from '../../../src/config/env.js';
import { soundnessRun } from '../../../src/cli/commands/soundness.js';
import { closePool } from '../../../src/store/client.js';
import { SoundnessFixtureError, type SoundnessRunResult } from '../../../src/soundness/runner.js';

/** Guaranteed unreachable: nothing listens on this port on the loopback interface in any environment this test runs in. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

function cannedUnsoundResult(): SoundnessRunResult {
  return {
    id: 'test-run-id',
    graphSeed: 'test-seed',
    namespaceCount: 3,
    tupleCount: 10,
    queryCount: 5,
    falseGrantCount: 1,
    falseDenyCount: 0,
    criticalNamespaceFalseGrants: 1,
    verdict: 'unsound',
    divergences: [
      {
        query: {
          subject: { ns: 'user', id: 'mallory' },
          object: { ns: 'critical_ns', id: 'o0' },
          relationOrPermission: 'view',
        },
        expected: false,
        actual: true,
        kind: 'false_grant',
        critical: true,
      },
    ],
  };
}

describe('authz soundness run — exit codes', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('a-false-grant-exits-one-and-an-infrastructure-failure-exits-three', async () => {
    // Part 1: a false_grant (verdict `unsound`) exits 1.
    const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue(cannedUnsoundResult());
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    spy.mockRestore();
    await closePool();
    process.exitCode = undefined;

    // Part 2: an infrastructure failure (unreachable DB) exits 3 — the
    // real, unmocked `runSoundnessFuzz`, so this half is not standing in
    // for anything; it genuinely fails to connect.
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;

    await soundnessRun({ queries: '1' });

    expect(process.exitCode).toBe(3);
  }, 30_000);

  it('an-unreachable-database-fails-the-check-rather-than-passing-it', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;

    await soundnessRun({ queries: '1' });

    // Fails closed: never 0 (sound) and never left unset (which Node
    // treats as an implicit 0 too) — an unreachable database is an
    // infrastructure failure, not a silent pass.
    expect(process.exitCode).toBe(3);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
  }, 30_000);

  it('a sound run leaves the exit code at its default (0) — the exit-code table is not vacuously true just because every branch above happens to set something', async () => {
    const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue({
      id: 'test-run-id-2',
      graphSeed: 'test-seed-2',
      namespaceCount: 3,
      tupleCount: 10,
      queryCount: 5,
      falseGrantCount: 0,
      falseDenyCount: 0,
      criticalNamespaceFalseGrants: 0,
      verdict: 'sound',
      divergences: [],
    });
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  }, 30_000);
});

/**
 * Full-repo audit finding #12 (MEDIUM, 2026-08-16), CLI-level half — the
 * other half lives in `test/unit/soundness/runner-fixture-error.test.ts`
 * (does `runSoundnessFuzz` itself throw `SoundnessFixtureError` from each of
 * its three generator-bug sites) and `test/unit/report/markdown.test.ts` /
 * `test/unit/report/json.test.ts` (do the `FIXTURE_FAILURE`/
 * `fixture_failure` renderers themselves look right). This describe block
 * is only about `soundnessRun`'s own `catch` block branching correctly on
 * `err instanceof SoundnessFixtureError` — mirroring
 * `test/unit/cli/soundness.test.ts`'s own established `vi.spyOn(runnerModule,
 * 'runSoundnessFuzz').mockRejectedValue(...)` pattern from the
 * `a-false-grant-exits-one-and-an-infrastructure-failure-exits-three` test
 * above, and `test/unit/cli/soundness-format.test.ts`'s own
 * `vi.spyOn(console, 'log'/'error')` pattern for capturing what actually
 * printed.
 */
describe('authz soundness run — SoundnessFixtureError vs. every other rejection (finding #12)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('a-soundnessfixtureerror-rejection-sets-exit-code-2-not-3', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(
      new SoundnessFixtureError(
        'soundness run (seed=fixture-seed): generated schema failed to compile — this is a ' +
          'generator bug, not a resolver finding: line 1: bad',
      ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(process.exitCode).toBe(2);
  });

  it('a-soundnessfixtureerror-with-format-markdown-prints-fixture-failure-framing-on-stdout-never-infrastructure-failure', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(
      new SoundnessFixtureError('the generated fixture was invalid'),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'markdown' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed).toContain('FIXTURE_FAILURE');
    expect(printed).not.toContain('INFRASTRUCTURE_FAILURE');
    expect(process.exitCode).toBe(2);
  });

  it('a-soundnessfixtureerror-with-format-json-prints-fixture-failure-status-on-stdout-never-infrastructure-failure', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(
      new SoundnessFixtureError('the generated fixture was invalid'),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(JSON.parse(printed).status).toBe('fixture_failure');
    expect(printed).not.toContain('infrastructure_failure');
    expect(process.exitCode).toBe(2);
  });

  it('a-soundnessfixtureerror-rejection-never-prints-the-postgres-colon-prefix-on-stderr', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(
      new SoundnessFixtureError('broken fixture, seed=xyz'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(errorSpy).toHaveBeenCalled();
    const allStderr = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allStderr).not.toContain('Postgres: ');
    expect(process.exitCode).toBe(2);
  });

  it('a-plain-error-rejection-that-is-not-a-soundnessfixtureerror-keeps-the-pre-existing-exit-3-postgres-prefixed-behavior-unchanged', async () => {
    // Regression check: this is exactly the behavior every rejection had
    // before `SoundnessFixtureError` existed — proving the new `instanceof`
    // branch in `soundnessRun`'s `catch` block didn't change what happens
    // for anything that ISN'T a fixture error.
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(
      new Error('connection terminated unexpectedly'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(process.exitCode).toBe(3);
    expect(errorSpy).toHaveBeenCalled();
    const allStderr = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allStderr).toContain('Postgres: connection terminated unexpectedly');
  });

  it('a-plain-error-rejections-format-markdown-output-still-prints-infrastructure-failure-framing-not-fixture-failure', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(
      new Error('connection terminated'),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'markdown' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed).toContain('INFRASTRUCTURE_FAILURE');
    expect(printed).not.toContain('FIXTURE_FAILURE');
    expect(process.exitCode).toBe(3);
  });
});

/**
 * `--progress <n>` (D-090, `docs/DECISIONS.md`) — mirrors this file's own
 * established `--queries` validation test shape (malformed input -> exit
 * code 2) and the `vi.spyOn(runnerModule, 'runSoundnessFuzz')` pattern used
 * throughout this file for asserting what `soundnessRun` actually passed
 * through, without a real fuzz run or real Postgres. The cadence logic
 * itself (`createProgressReporter`) is unit-tested directly and in full in
 * `test/unit/report/progress.test.ts` — what's specifically under test here
 * is narrower: does `soundnessRun` validate `--progress` the same way it
 * already validates `--queries`, and does a valid value actually reach
 * `runSoundnessFuzz` as a real `onProgress` function (not just some truthy
 * value)?
 */
describe('authz soundness run — --progress', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it.each(['0', '-5', 'abc', '3.5'])(
    "invalid --progress '%s' exits 2 without ever calling runSoundnessFuzz",
    async (badValue) => {
      const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = undefined;

      await soundnessRun({ progress: badValue });

      expect(spy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(errorSpy).toHaveBeenCalled();
    },
  );

  it('a-valid---progress-is-threaded-through-to-runsoundnessfuzz-as-a-real-onprogress-function', async () => {
    const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue({
      id: 'test-run-id-3',
      graphSeed: 'test-seed-3',
      namespaceCount: 1,
      tupleCount: 1,
      queryCount: 1,
      falseGrantCount: 0,
      falseDenyCount: 0,
      criticalNamespaceFalseGrants: 0,
      verdict: 'sound',
      divergences: [],
    });
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ progress: '500' });

    expect(spy).toHaveBeenCalledTimes(1);
    const passedOptions = spy.mock.calls[0]?.[1];
    expect(typeof passedOptions?.onProgress).toBe('function');
  });

  it('omitting --progress passes no onProgress at all — the default path is unchanged', async () => {
    const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue({
      id: 'test-run-id-4',
      graphSeed: 'test-seed-4',
      namespaceCount: 1,
      tupleCount: 1,
      queryCount: 1,
      falseGrantCount: 0,
      falseDenyCount: 0,
      criticalNamespaceFalseGrants: 0,
      verdict: 'sound',
      divergences: [],
    });
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(spy).toHaveBeenCalledTimes(1);
    const passedOptions = spy.mock.calls[0]?.[1];
    expect(passedOptions?.onProgress).toBeUndefined();
  });
});
