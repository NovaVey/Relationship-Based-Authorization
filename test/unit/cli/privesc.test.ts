/**
 * `authz audit privesc <object> <relation> [--expected subj1,subj2,...]`'s
 * own argument parsing / exit-code logic (`src/cli/commands/privesc.ts`'s
 * `privescCli`) — mirrors this repo's own established pattern for testing a
 * thin CLI wrapper without Docker/Postgres:
 *
 *  - malformed-argument cases (bad `object`, bad `relation`, a malformed
 *    `--expected` entry) exit 2, before ever touching Postgres — proven by
 *    leaving `DATABASE_URL` unset entirely, the same discipline
 *    `check.test.ts`/`expand.test.ts` already establish.
 *  - an unreachable database exits 3 — the real, unmocked `privescCli`
 *    against a guaranteed-closed local port, no container needed.
 *  - the `--expected` UNEXPECTED/MISSING drift comparison and its exit-code
 *    effect (1 iff at least one UNEXPECTED, never for MISSING alone) is
 *    proven with `privescScan` mocked via `vi.spyOn` — the identical
 *    "spy on the orchestration entry point, not a resolver" pattern
 *    `test/unit/cli/soundness.test.ts` already establishes for
 *    `runSoundnessFuzz`. `privescScan`'s own real correctness (does it
 *    actually find every real subject, with real paths, via real
 *    mechanisms) is proven separately, against real Postgres, in
 *    `privesc.integration.test.ts` — this file is only about whether
 *    `privescCli` correctly consumes whatever `privescScan` returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as privescModule from '../../../src/audit/privesc.js';
import type { PrivescFinding } from '../../../src/audit/privesc.js';
import type { ResolutionStep } from '../../../src/resolve/production/resolver.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { privescCli } from '../../../src/cli/commands/privesc.js';

/** Guaranteed unreachable: nothing listens on this port on the loopback interface in any environment this test runs in — same constant every other CLI exit-code test file in this repo already establishes. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

const e = (ns: string, id: string) => ({ ns, id });

function directGrantPath(subjectNs: string, subjectId: string, relation: string): ResolutionStep {
  return {
    kind: 'directGrant',
    object: e('document', 'sensitive'),
    relation,
    subject: e(subjectNs, subjectId),
  };
}

function finding(subjectNs: string, subjectId: string, depth: number): PrivescFinding {
  return {
    subject: e(subjectNs, subjectId),
    allowed: true,
    path: directGrantPath(subjectNs, subjectId, 'viewer'),
    depth,
  };
}

describe('authz audit privesc — argument parsing exits 2 before ever touching Postgres', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('a-malformed-object-reference-with-no-colon-exits-2', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('not-a-namespace-colon-id-reference', 'view', {});

    expect(process.exitCode).toBe(2);
  });

  it('an-object-reference-with-nothing-after-the-colon-exits-2', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('document:', 'view', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-relation-argument-that-is-empty-exits-2', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('document:sensitive', '', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-relation-argument-containing-a-hash-exits-2', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'hack#view', {});

    expect(process.exitCode).toBe(2);
  });

  it('a-malformed---expected-entry-with-no-colon-exits-2', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice,not-valid' });

    expect(process.exitCode).toBe(2);
  });

  it('a---expected-entry-whose-id-half-contains-a-hash-exits-2', async () => {
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice#hack' });

    expect(process.exitCode).toBe(2);
  });

  it('the-malformed---expected-check-runs-before-privescscan-is-ever-called', async () => {
    const spy = vi.spyOn(privescModule, 'privescScan');
    env.DATABASE_URL = undefined;
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'garbage' });

    expect(spy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});

describe('authz audit privesc — infrastructure failure', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('privesc-against-an-unreachable-database-exits-3-not-a-silent-empty-report', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', {});

    expect(process.exitCode).toBe(3);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
  }, 30_000);
});

describe('authz audit privesc — findings printing and exit code 0 with no --expected', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('no---expected-prints-every-finding-and-leaves-the-exit-code-at-its-default', async () => {
    const spy = vi
      .spyOn(privescModule, 'privescScan')
      .mockResolvedValue([finding('user', 'alice', 1), finding('user', 'bob', 2)]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      { ns: 'document', id: 'sensitive' },
      'view',
    );
    expect(process.exitCode).toBeUndefined();

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('user:alice');
    expect(printed).toContain('user:bob');
    expect(printed).toContain('depth 1');
    expect(printed).toContain('depth 2');
    // The real resolution path, rendered the same way `check --path` does.
    expect(printed).toContain('→ document:sensitive#viewer');
    // No --expected supplied — no drift lines at all.
    expect(printed).not.toContain('UNEXPECTED');
    expect(printed).not.toContain('MISSING');
  });

  it('zero-findings-prints-a-plain-zero-count-report-not-an-error', async () => {
    vi.spyOn(privescModule, 'privescScan').mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', {});

    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('0 subject(s)');
  });
});

describe('authz audit privesc — --expected drift detection (UNEXPECTED / MISSING) and exit code', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('an-unexpected-subject-is-flagged-and-sets-exit-code-1', async () => {
    vi.spyOn(privescModule, 'privescScan').mockResolvedValue([
      finding('user', 'alice', 1),
      finding('user', 'mallory', 2),
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice' });

    expect(process.exitCode).toBe(1);
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('UNEXPECTED: user:mallory');
    expect(printed).not.toContain('UNEXPECTED: user:alice');
    expect(printed).not.toContain('MISSING');
  });

  it('a-missing-expected-subject-is-flagged-but-does-not-set-the-exit-code', async () => {
    vi.spyOn(privescModule, 'privescScan').mockResolvedValue([finding('user', 'alice', 1)]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice,user:carol' });

    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('MISSING: user:carol');
    expect(printed).not.toContain('UNEXPECTED');
  });

  it('both-unexpected-and-missing-can-be-reported-in-the-same-run-and-exit-code-is-still-1', async () => {
    vi.spyOn(privescModule, 'privescScan').mockResolvedValue([
      finding('user', 'alice', 1),
      finding('user', 'mallory', 2),
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice,user:carol' });

    expect(process.exitCode).toBe(1);
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('UNEXPECTED: user:mallory');
    expect(printed).toContain('MISSING: user:carol');
  });

  it('an-exact-match-between-found-and-expected-sets-no-drift-lines-and-exit-code-stays-at-default', async () => {
    vi.spyOn(privescModule, 'privescScan').mockResolvedValue([
      finding('user', 'alice', 1),
      finding('user', 'bob', 2),
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice,user:bob' });

    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).not.toContain('UNEXPECTED');
    expect(printed).not.toContain('MISSING');
  });

  it('a-blank-trailing-entry-in---expected-is-tolerated-not-rejected-as-malformed', async () => {
    vi.spyOn(privescModule, 'privescScan').mockResolvedValue([finding('user', 'alice', 1)]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await privescCli('document:sensitive', 'view', { expected: 'user:alice,' });

    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).not.toContain('MISSING');
    expect(printed).not.toContain('UNEXPECTED');
  });
});
