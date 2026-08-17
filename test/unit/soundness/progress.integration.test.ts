/**
 * Real-Postgres proof that `runSoundnessFuzz`'s `onProgress` option
 * (`SoundnessRunOptions.onProgress`, D-090 — `docs/DECISIONS.md`) actually
 * gets invoked by `checkAllQueries`, with the right `completed`/`total`
 * values, once per real concurrency-sized batch — not just that the CLI
 * layer threads a function through unmodified (`test/unit/cli/
 * soundness.test.ts`'s own `--progress` describe block already covers
 * that, DB-free). The cadence *decision* logic (when to actually print,
 * given an `every` interval) is separately unit-tested in full, with no
 * Postgres at all, in `test/unit/report/progress.test.ts` — this file's
 * only job is confirming the real runner calls back at all, and with
 * values that make sense (monotonically increasing, capped at the real
 * total, present for every batch).
 *
 * Real Postgres via `PostgreSqlContainer`, migrations applied via this
 * project's own `runMigrations` — matching every other
 * `*.integration.test.ts` in this repo. Query count kept small (a handful,
 * not the 5,000 default): this file proves the callback wiring, not
 * soundness itself, which `differential-soundness.fuzz.integration
 * .test.ts` already owns.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { runSoundnessFuzz } from '../../../src/soundness/runner.js';
import { runMigrations } from '../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('runSoundnessFuzz onProgress', () => {
  it('a-real-run-calls-onprogress-once-per-batch-with-monotonically-increasing-completed-counts-ending-at-the-real-total', async () => {
    const calls: Array<{ completed: number; total: number }> = [];

    const result = await runSoundnessFuzz(pool, {
      queryCount: 7,
      dryRun: true,
      onProgress: (completed, total) => {
        calls.push({ completed, total });
      },
    });

    expect(result.queryCount).toBe(7);
    expect(calls.length).toBeGreaterThan(0);

    // Every call reports the same total — the real query count this run
    // actually generated, not some other number.
    for (const call of calls) {
      expect(call.total).toBe(7);
    }

    // Strictly increasing — each batch reports more completed than the
    // last, never the same count twice and never a regression.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.completed).toBeGreaterThan(calls[i - 1]!.completed);
    }

    // The final call is always the real total — a caller building a
    // "done" signal off this (like `createProgressReporter` does) can
    // rely on it without a separate completion callback.
    expect(calls[calls.length - 1]!.completed).toBe(7);
  }, 30_000);

  it('omitting onProgress changes nothing about a real run — no crash, same shape of result', async () => {
    const result = await runSoundnessFuzz(pool, { queryCount: 3, dryRun: true });
    expect(result.queryCount).toBe(3);
  }, 30_000);
});
