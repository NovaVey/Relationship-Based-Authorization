/**
 * `authz soundness run --format markdown|json|text` on an infrastructure
 * failure (exit code 3) — closing full-repo-audit HIGH finding #8 (2026-08-16,
 * see `docs/DECISIONS.md` D-068): before this fix, `soundnessRun`'s `catch`
 * block (`src/cli/commands/soundness.ts`) printed the real error to stderr
 * only, leaving stdout completely empty. `.github/workflows/soundness.yml`
 * captures `--format markdown`'s stdout verbatim into `soundness-report.md`,
 * which `scripts/post-soundness-comment.mjs` posts — or PATCHes the
 * existing *tracked* comment to, unconditionally — as the literal PR-comment
 * body, so a 0-byte report silently blanked the PR's last known-good
 * soundness comment with no report and no visible sign of failure to a human
 * reading the PR (the CI job itself still went red via `exitCode 3` — that
 * part was never broken; the *comment* going silently blank was).
 *
 * A sibling of `test/unit/cli/soundness.test.ts` (which already covers the
 * exit-code table itself, including the DB-unreachable -> exit-3 case) and
 * `test/unit/cli/soundness-format.test.ts` (format dispatch for a completed
 * run). This file is specifically about format dispatch on the *failure*
 * path — a case neither of those two files exercises.
 *
 * Two call sites in `src/cli/commands/soundness.ts` reach exit code 3, and
 * both are covered here:
 *
 *   1. `runSoundnessFuzz` throwing from inside the `try` block (the
 *      originally-reported bug) — most tests below mock `runSoundnessFuzz`
 *      via `vi.spyOn` to reject with a controlled, known error message, so
 *      the rendered stdout can be asserted against exactly (matching
 *      `soundness-format.test.ts`'s own established mocking rationale: this
 *      file is testing the CLI's own rendering/dispatch wiring, not
 *      `runSoundnessFuzz`'s own ability to fail). One test
 *      (`a-real-unreachable-database-still-prints-a-non-empty-markdown-
 *      report...`) deliberately runs the real, unmocked path against a
 *      guaranteed-unreachable database instead — matching
 *      `test/unit/cli/soundness.test.ts`'s own precedent for the exit-3
 *      case — so the fix is proven against a genuine infrastructure failure
 *      at least once, not only against a mock standing in for one.
 *   2. The `DATABASE_URL`-not-set early return, which never calls
 *      `runSoundnessFuzz` at all — a second, independent gap this fix also
 *      closes (see D-068's own "why this was widened beyond the literal
 *      finding" note), verified separately below.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as runnerModule from '../../../src/soundness/runner.js';
import { env } from '../../../src/config/env.js';
import { soundnessRun } from '../../../src/cli/commands/soundness.js';
import { closePool } from '../../../src/store/client.js';
import {
  SOUNDNESS_REPORT_MARKER,
  renderSoundnessInfrastructureFailureMarkdown,
} from '../../../src/report/markdown.js';
import { renderSoundnessInfrastructureFailureJsonString } from '../../../src/report/json.js';

/** Guaranteed unreachable: nothing listens on this port on the loopback interface in any environment this test runs in — same constant `test/unit/cli/soundness.test.ts` already establishes. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

const MOCK_ERROR_MESSAGE = 'connect ECONNREFUSED 127.0.0.1:1 (mock infrastructure failure)';

describe('authz soundness run — infrastructure failure (exit 3) always prints something to stdout for markdown/json', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('a-runsoundnessfuzz-throw-with-format-markdown-prints-exactly-the-rendered-infrastructure-failure-report-starting-with-the-marker', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(new Error(MOCK_ERROR_MESSAGE));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'markdown' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).toBe(renderSoundnessInfrastructureFailureMarkdown(MOCK_ERROR_MESSAGE));
    expect(printed.startsWith(SOUNDNESS_REPORT_MARKER)).toBe(true);
    expect(printed).toContain(MOCK_ERROR_MESSAGE);
    expect(process.exitCode).toBe(3);
  });

  it('a-runsoundnessfuzz-throw-with-format-json-prints-exactly-the-rendered-infrastructure-failure-json-with-a-self-describing-status', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(new Error(MOCK_ERROR_MESSAGE));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).toBe(renderSoundnessInfrastructureFailureJsonString(MOCK_ERROR_MESSAGE));

    const parsed: unknown = JSON.parse(printed);
    expect(parsed).toEqual({ status: 'infrastructure_failure', message: MOCK_ERROR_MESSAGE });
    // Never the shape of a real `SoundnessJsonReport` — no `verdict` field
    // to misread as a genuine (and falsely clean) result.
    expect(parsed).not.toHaveProperty('verdict');
    expect(process.exitCode).toBe(3);
  });

  it('a-runsoundnessfuzz-throw-with-format-text-is-unchanged-stderr-only-no-stdout-still-exits-3', async () => {
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockRejectedValue(new Error(MOCK_ERROR_MESSAGE));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(`Postgres: ${MOCK_ERROR_MESSAGE}`);
    expect(process.exitCode).toBe(3);
  });

  it('a-real-unreachable-database-still-prints-a-non-empty-markdown-report-starting-with-the-marker-not-a-mock-standing-in-for-one', async () => {
    // Deliberately real and unmocked — see this file's own top-of-file doc
    // comment. This is the exact reproduction the original audit finding
    // used (an unreachable DATABASE_URL against the real built CLI).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;

    await soundnessRun({ queries: '1', format: 'markdown' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.startsWith(SOUNDNESS_REPORT_MARKER)).toBe(true);
    expect(printed).toContain('INFRASTRUCTURE_FAILURE');
    expect(process.exitCode).toBe(3);
  }, 30_000);

  it('database_url-not-set-with-format-markdown-also-prints-a-non-empty-report-without-ever-calling-runsoundnessfuzz', async () => {
    const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await soundnessRun({ format: 'markdown' });

    expect(spy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed.startsWith(SOUNDNESS_REPORT_MARKER)).toBe(true);
    expect(printed).toContain('DATABASE_URL is not set');
    expect(process.exitCode).toBe(3);
  });

  it('database_url-not-set-with-format-text-is-unchanged-stderr-only-no-stdout', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await soundnessRun({});

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Postgres: DATABASE_URL is not set — see .env.example.');
    expect(process.exitCode).toBe(3);
  });
});
