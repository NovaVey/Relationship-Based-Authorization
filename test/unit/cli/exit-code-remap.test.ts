/**
 * `src/cli/index.ts` — `program.exitOverride()` + the `try`/`catch` around
 * `parseAsync` remapping Commander's own usage-error exit code (full-repo
 * audit finding #16, MEDIUM, 2026-08-16 — see that file's own doc comment
 * and `docs/DECISIONS.md`). Before this fix, Commander called
 * `process.exit(1)` directly from deep inside `parseAsync` on any usage
 * error (an unknown flag, a missing argument, an unknown subcommand) — the
 * exact same exit code `authz soundness run`'s own table reserves for a
 * real, blocking security finding (verdict `unsound` — at least one
 * `false_grant`, §7). A plain CLI typo (`authz --bogus-flag`) and a genuine
 * unauthorized-permission finding were indistinguishable to any script or
 * CI step that branches on exit code alone.
 *
 * This is the one file in this repo that spawns the CLI as a real
 * subprocess — there is no existing precedent for it elsewhere in `test/`
 * (checked: no `execFile`/`spawn` usage anywhere else), because every other
 * CLI-command test in this repo calls the command's own exported function
 * directly (`src/cli/commands/*.ts`) with mocked dependencies, which is
 * both faster and doesn't need Docker/Postgres. That approach doesn't work
 * here: the remap under test lives in `index.ts`'s own top-level
 * `program.parseAsync(...)`/`catch` wiring, which only runs when Commander
 * itself is actually invoked end-to-end — there is no exported function to
 * call directly that exercises `exitOverride()` and the `catch` block
 * around it. A handful of real `npx tsx src/cli/index.ts <args>` spawns is
 * the only way to prove this remap without either duplicating Commander's
 * own internals in a fake, or asserting against `index.ts`'s source text
 * instead of its actual observed behavior — kept deliberately small (two
 * spawns) and fast (each resolves in well under a second locally — see this
 * phase's own test-author report), and neither path here touches
 * `DATABASE_URL`/Postgres at all (`--help` and an unknown flag both fail
 * inside Commander's own argument parsing, before any command's `.action()`
 * handler — the one that might need a database — ever runs).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const CLI_ENTRY = fileURLToPath(new URL('../../../src/cli/index.ts', import.meta.url));

/** Runs `npx tsx src/cli/index.ts <args>` and resolves with its exit code, never throwing on a non-zero exit — a CLI usage error is the expected, asserted-on outcome here, not a test-harness failure. */
async function runCli(
  args: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI_ENTRY, ...args]);
    return { exitCode: 0, stderr, stdout };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; stdout?: string };
    return { exitCode: e.code ?? -1, stderr: e.stderr ?? '', stdout: e.stdout ?? '' };
  }
}

describe("finding #16: an unknown CLI flag exits with code 2, never Commander's own raw exit code 1", () => {
  it('an-unknown-flag-exits-with-code-2-not-commanders-own-raw-exit-code-1-which-would-collide-with-a-real-false-grant-verdict', async () => {
    const result = await runCli(['--this-flag-does-not-exist']);
    expect(result.exitCode).toBe(2);
  }, 20_000);

  it('an-unknown-subcommand-exits-with-code-2-not-commanders-own-raw-exit-code-1', async () => {
    const result = await runCli(['this-subcommand-does-not-exist']);
    expect(result.exitCode).toBe(2);
  }, 20_000);
});

describe('finding #16 regression guard: --help/--version are non-error display, left at exit code 0, never remapped', () => {
  it('help-still-exits-zero-the-remap-only-touches-commanders-own-usage-error-exit-code-not-its-help-exit-code', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: authz');
  }, 20_000);
});
