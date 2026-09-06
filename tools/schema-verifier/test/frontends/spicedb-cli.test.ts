/**
 * `../../src/frontends/spicedb/cli.ts` ("translate-spicedb") end to end —
 * mirrors `openfga-cli.test.ts` exactly, one ecosystem over.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const CLI_ENTRY = fileURLToPath(new URL('../../src/frontends/spicedb/cli.ts', import.meta.url));
const UPSTREAM_DIR = fileURLToPath(new URL('../../thirdparty/upstream/', import.meta.url));

interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: string[]): Promise<CliRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI_ENTRY, ...args]);
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('translate-spicedb', () => {
  it('prints translated .authz text with a disclosed-notes header to stdout', async () => {
    const result = await runCli([UPSTREAM_DIR + 'spicedb-entitlements.zed']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Translated from SpiceDB schema');
    expect(result.stdout).toContain('namespace entitlement {');
    expect(result.stdout).toContain('permission subscribed_member = org->member');
  }, 20_000);

  it('--out writes the translation to a file instead of stdout', async () => {
    const outPath = join(tmpdir(), `translate-spicedb-cli-test-${process.pid}.authz`);
    try {
      const result = await runCli([UPSTREAM_DIR + 'spicedb-entitlements.zed', '--out', outPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      const written = readFileSync(outPath, 'utf8');
      expect(written).toContain('namespace entitlement {');
    } finally {
      unlinkSync(outPath);
    }
  }, 20_000);

  it('a nonexistent schema file → exit 1, no crash', async () => {
    const result = await runCli([UPSTREAM_DIR + 'this-file-does-not-exist.zed']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('could not read schema file');
  }, 20_000);

  it('--help exits 0', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('translate-spicedb');
  }, 20_000);
});
