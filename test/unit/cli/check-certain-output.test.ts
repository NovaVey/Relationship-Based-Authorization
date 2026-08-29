/**
 * `authz check --path`'s new certain/inconclusive denial messaging —
 * full-repo audit finding #6 (`src/cli/commands/check.ts`, `src/resolve/
 * production/resolver.ts`'s `ProductionCheckResult.certain`). Before this
 * fix, every denied `--path` invocation printed the identical static line
 * regardless of whether the denial was exhaustively proven or merely a
 * cycle-guard/depth-ceiling cutoff that never finished proving anything —
 * see `resolver.ts`'s own `ProductionCheckResult.certain` doc comment and
 * `docs/DECISIONS.md` D-158 through D-161 for the full soundness-signal
 * mechanism this surfaces.
 *
 * Deliberately DB-free, mirroring `test/unit/audit/checks.test.ts`'s own
 * established pattern for testing orchestration/wiring in isolation:
 * `performCheck` (`src/audit/checks.js`) is mocked via `vi.spyOn` on its own
 * module namespace, so this file proves `check.ts`'s own branching on
 * `result.certain` is correct without needing a real depth-exhausted or
 * cyclic tuple graph to genuinely produce an inconclusive denial — that real
 * end-to-end proof lives in `test/unit/audit/checks-certain.integration
 * .test.ts` (real Postgres, a real mechanism-2 depth-ceiling fixture).
 * `env.DATABASE_URL` is set to an arbitrary, never-dialed string purely to
 * pass `check`'s own early `if (!env.DATABASE_URL)` guard — `getPool()`
 * never eagerly connects, and `performCheck` is fully mocked, so nothing
 * here ever touches a real socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { check } from '../../../src/cli/commands/check.js';
import * as checksModule from '../../../src/audit/checks.js';
import type { PerformCheckResult } from '../../../src/audit/checks.js';

const FAKE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/never-actually-dialed';

const CERTAIN_DENIAL: PerformCheckResult = {
  allowed: false,
  certain: true,
  depth: 1,
  touchedExpiringTuple: false,
};

const INCONCLUSIVE_DENIAL: PerformCheckResult = {
  allowed: false,
  certain: false,
  depth: 25,
  touchedExpiringTuple: false,
};

/** Defensive fallback case — `result.certain` absent entirely (should never happen for a real denial today, since the resolver always sets it, but `certain` is typed optional and this file's own CLI branch must still fail toward the honest, less-confident message rather than assume proven). */
const DENIAL_WITH_NO_CERTAIN_FIELD_AT_ALL: PerformCheckResult = {
  allowed: false,
  depth: 3,
  touchedExpiringTuple: false,
};

describe('authz check --path — certain vs inconclusive denial messaging', () => {
  afterEach(async () => {
    await closePool();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('a-certain-denial-prints-DENIED-certain-under---path', async () => {
    env.DATABASE_URL = FAKE_DATABASE_URL;
    vi.spyOn(checksModule, 'performCheck').mockResolvedValue(CERTAIN_DENIAL);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let lines: string[];
    try {
      await check('user:alice', 'view', 'document:readme', { path: true });
      lines = logSpy.mock.calls.map((call) => call[0] as string);
    } finally {
      logSpy.mockRestore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(lines[0]).toBe('user:alice view document:readme: DENIED');
    expect(lines[1]).toBe('  DENIED (certain) — no resolution path; nothing granted this');
  });

  it('an-inconclusive-denial-prints-the-depth-cycle-limit-message-under---path-not-the-certain-one', async () => {
    env.DATABASE_URL = FAKE_DATABASE_URL;
    vi.spyOn(checksModule, 'performCheck').mockResolvedValue(INCONCLUSIVE_DENIAL);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let lines: string[];
    try {
      await check('user:alice', 'view', 'document:readme', { path: true });
      lines = logSpy.mock.calls.map((call) => call[0] as string);
    } finally {
      logSpy.mockRestore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(lines[0]).toBe('user:alice view document:readme: DENIED');
    expect(lines[1]).toBe(
      '  DENIED (inconclusive — hit depth/cycle limit, consider a larger --max-depth)',
    );
    // Never the certain-branch's own line — the two messages are mutually
    // exclusive, not merely differently worded.
    expect(lines[1]).not.toContain('(certain)');
  });

  it('a-denial-with-no-certain-field-at-all-falls-back-to-the-inconclusive-message-the-safe-honest-direction-on-ambiguity', async () => {
    env.DATABASE_URL = FAKE_DATABASE_URL;
    vi.spyOn(checksModule, 'performCheck').mockResolvedValue(DENIAL_WITH_NO_CERTAIN_FIELD_AT_ALL);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let lines: string[];
    try {
      await check('user:alice', 'view', 'document:readme', { path: true });
      lines = logSpy.mock.calls.map((call) => call[0] as string);
    } finally {
      logSpy.mockRestore();
    }

    expect(lines[1]).toBe(
      '  DENIED (inconclusive — hit depth/cycle limit, consider a larger --max-depth)',
    );
  });

  it('an-allowed-result-is-completely-unaffected-by-the-certain-field-existing-at-all', async () => {
    env.DATABASE_URL = FAKE_DATABASE_URL;
    vi.spyOn(checksModule, 'performCheck').mockResolvedValue({
      allowed: true,
      path: {
        kind: 'directGrant',
        object: { ns: 'document', id: 'readme' },
        relation: 'viewer',
        subject: { ns: 'user', id: 'alice' },
      },
      depth: 1,
      touchedExpiringTuple: false,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let lines: string[];
    try {
      await check('user:alice', 'viewer', 'document:readme', { path: true });
      lines = logSpy.mock.calls.map((call) => call[0] as string);
    } finally {
      logSpy.mockRestore();
    }

    expect(lines[0]).toBe('user:alice viewer document:readme: ALLOWED');
    expect(lines.slice(1)).toEqual(['user:alice', '  → document:readme#viewer']);
  });
});
