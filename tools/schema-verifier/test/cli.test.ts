/**
 * `verify-schema` end to end (build spec §9) — real `npx tsx
 * src/cli/index.ts <args>` subprocesses, mirroring this repo's own root
 * `test/unit/cli/exit-code-remap.test.ts` (the one place elsewhere in
 * this repo that spawns a CLI as a real subprocess, and why: the thing
 * under test here — `--json`'s exact stdout shape, Commander's own usage-
 * error wiring, `index.ts`'s top-level `try`/`catch` — only runs when the
 * process is actually invoked, not when `runVerify` is called directly.
 * `test/cli-exit-codes.test.ts` already covers the exit-code *mapping*
 * logic in isolation; this file proves the whole pipeline — real fixture
 * files on disk, a real spawned process, a real observed exit code —
 * against every fixture the known-answer corpus (`test/known-
 * answers.test.ts`) has already committed to as correct, so the two
 * files can't silently drift apart on what a given fixture pair
 * "should" produce.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const CLI_ENTRY = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const SCHEMA_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `npx tsx src/cli/index.ts <args>` and resolves with its exit code — never throws on a non-zero exit, since every exit code this CLI defines is an asserted-on outcome here, not a test-harness failure. */
async function runCli(args: string[]): Promise<CliRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI_ENTRY, ...args]);
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('verify-schema — exit codes against the known-answer corpus, through a real subprocess', () => {
  it('monotone HOLDS (exact) → exit 0', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'tenancy.authz',
      '--invariants',
      INVARIANT_DIR + 'no-public-path-to-private-document.invariant',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('HOLDS');
    expect(result.stdout).toContain('exit code: 0');
  }, 20_000);

  it('monotone VIOLATED, self-validation confirmed → exit 1, counterexample tuples printed', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'tenancy.authz',
      '--invariants',
      INVARIANT_DIR + 'tenant-isolation.invariant',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('VIOLATED');
    expect(result.stdout).toContain('counterexample tuples:');
    expect(result.stdout).toContain('self-validation: confirmed');
  }, 20_000);

  it('non-monotone VIOLATED (bounded search, already confirmed at search time) → exit 1', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'non-monotone.authz',
      '--invariants',
      INVARIANT_DIR + 'intersection-approve.invariant',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('VIOLATED');
  }, 20_000);

  it('non-monotone HOLDS, now decided exactly by the new SMT tier (not bounded) → exit 0, reported bare, no "up to k"', async () => {
    // Before the SMT tier (docs/DECISIONS.md) existed, this fixture fell
    // through to bounded search and reported `HOLDS up to k = 1`, exit 2
    // — a bound, not a proof. The SMT tier now decides this exclusion
    // exactly (`document.publish = editor - blocked`, non-recursive), so
    // `checkAndValidate` never reaches bounded search for it at all.
    const result = await runCli([
      SCHEMA_DIR + 'non-monotone.authz',
      '--invariants',
      INVARIANT_DIR + 'exclusion-blocked-cannot-publish.invariant',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('HOLDS (fragment: non-monotone, proof: exact)');
    expect(result.stdout).not.toContain('up to k');
  }, 20_000);

  it('a real static/runtime self-validation mismatch (depth-exceeds-limit) → exit 3, reported loudly, not as a confirmed VIOLATED', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'depth-exceeds-limit.authz',
      '--invariants',
      INVARIANT_DIR + 'deep-chain-view.invariant',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('MISMATCH');
    expect(result.stdout).not.toContain('exit code: 1');
  }, 20_000);

  it('a schema file that does not exist → exit 3, no crash, no stack trace on stdout', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'this-file-does-not-exist.authz',
      '--invariants',
      INVARIANT_DIR + 'tenant-isolation.invariant',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('could not read schema file');
  }, 20_000);

  it('a schema that fails to compile → exit 3', async () => {
    const result = await runCli([
      INVARIANT_DIR + 'tenant-isolation.invariant', // a real file, just the wrong kind
      '--invariants',
      INVARIANT_DIR + 'tenant-isolation.invariant',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('failed to compile');
  }, 20_000);

  it('a missing required --invariants option → Commander usage error, exit 3 (never 1, never a real verdict code)', async () => {
    const result = await runCli([SCHEMA_DIR + 'tenancy.authz']);
    expect(result.exitCode).toBe(3);
  }, 20_000);

  it('an unknown flag → Commander usage error, exit 3', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'tenancy.authz',
      '--invariants',
      INVARIANT_DIR + 'tenant-isolation.invariant',
      '--this-flag-does-not-exist',
    ]);
    expect(result.exitCode).toBe(3);
  }, 20_000);

  it('--help exits 0, not remapped', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('verify-schema');
  }, 20_000);

  it('an invariants file that parses but declares zero invariants → exit 3, not silently treated as a clean pass', async () => {
    // Confirmed directly (not assumed from the parser's own informal
    // grammar comment, which reads `file := invariant+`): an empty or
    // whitespace-only invariants file genuinely parses to `{ ok: true,
    // invariants: [] }`, not a parse error. `runVerify` guards this case
    // itself — this proves the guard actually fires end to end.
    const result = await runCli([
      SCHEMA_DIR + 'tenancy.authz',
      '--invariants',
      INVARIANT_DIR + 'empty.invariant',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('declares no invariants');
  }, 20_000);

  it('a --invariants file naming more than one invariant checks every one, combined exit code is the worst among them', async () => {
    // `combineExitCodes` has its own pure-function coverage in
    // `test/cli-exit-codes.test.ts` against fabricated exit codes — this
    // proves the real combination end to end: one genuinely HOLDS (exit
    // 0), one genuinely VIOLATED (exit 1), on the same real schema, from
    // one real `--invariants` file naming both.
    const result = await runCli([
      SCHEMA_DIR + 'tenancy.authz',
      '--invariants',
      INVARIANT_DIR + 'multi-holds-and-violated.invariant',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('no_public_path_to_private_document: HOLDS');
    expect(result.stdout).toContain('tenant_isolation: VIOLATED');
  }, 20_000);
});

describe('verify-schema --json — machine-readable output', () => {
  it('produces a single parseable JSON object with the same verdict/exit code as the human output', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'tenancy.authz',
      '--invariants',
      INVARIANT_DIR + 'tenant-isolation.invariant',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      schema: string;
      exitCode: number;
      invariants: ReadonlyArray<{
        name: string;
        verdict: string;
        exitCode: number;
        witness?: readonly string[];
      }>;
    };
    expect(parsed.exitCode).toBe(1);
    expect(parsed.invariants).toHaveLength(1);
    expect(parsed.invariants[0]!.verdict).toBe('VIOLATED');
    expect(parsed.invariants[0]!.exitCode).toBe(1);
    expect(parsed.invariants[0]!.witness).toBeDefined();
    expect(parsed.invariants[0]!.witness!.length).toBeGreaterThan(0);
  }, 20_000);
});

describe('verify-schema --bound', () => {
  it('a non-integer --bound is a usage error, exit 3, before any check runs', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'non-monotone.authz',
      '--invariants',
      INVARIANT_DIR + 'exclusion-blocked-cannot-publish.invariant',
      '--bound',
      'not-a-number',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('invalid --bound');
  }, 20_000);

  it('--bound 2 still finds the same real violation as the default (intersection-approve needs no bound above 1 to find its witness)', async () => {
    const result = await runCli([
      SCHEMA_DIR + 'non-monotone.authz',
      '--invariants',
      INVARIANT_DIR + 'intersection-approve.invariant',
      '--bound',
      '2',
    ]);
    expect(result.exitCode).toBe(1);
  }, 20_000);
});
