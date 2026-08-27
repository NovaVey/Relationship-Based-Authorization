/**
 * `src/audit/anchor.ts` — deliberately DB-free (`readChainTip`/`recordAnchor`
 * take a plain `QueryExecutor`, so a fake `{ query }` object stands in for a
 * real Postgres pool exactly as this codebase's other DB-free tests already
 * do for the identical narrow interface, see `query-executor.ts`). Proves,
 * without a container:
 *
 *   - `recordAnchor` writes the exact tip `readChainTip` reports, and does
 *     so via genuine append — a second call never disturbs the first
 *     entry's own bytes on disk, the real property this whole feature's
 *     "genuinely append-only" requirement depends on;
 *   - `readAnchorFile` round-trips what `recordAnchor` wrote, tolerates a
 *     trailing blank line, and fails loud (never silently drops an entry)
 *     on a malformed or incomplete line;
 *   - `readChainTip`/`recordAnchor` correctly treat "zero chained rows" as
 *     "nothing to anchor," matching `fetchChainTipHash`'s own established
 *     `checks.ts` convention for the identical "no chained rows yet" case.
 *
 * The real-Postgres half — reading a genuine `checks` table's tip, and the
 * actual fail-check this feature exists to pass (a live consistent forward
 * chain rewrite, caught by `--anchor-file` and invisible to a plain `authz
 * audit verify`) — is `test/unit/cli/audit-anchor.integration.test.ts`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ANCHOR_FILE_PATH,
  readAnchorFile,
  readChainTip,
  recordAnchor,
  type AnchorEntry,
} from '../../../src/audit/anchor.js';
import type { QueryExecutor } from '../../../src/store/query-executor.js';

/** A fake `QueryExecutor` whose `query` always returns `rows` — enough for `readChainTip`, which issues exactly one query and reads exactly one row back. */
function fakeExecutor(rows: unknown[]): QueryExecutor {
  return {
    query: async () => ({ rows: rows as never[], rowCount: rows.length }),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'authz-anchor-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DEFAULT_ANCHOR_FILE_PATH', () => {
  it('is-an-absolute-path-under-the-current-working-directory', () => {
    expect(path.isAbsolute(DEFAULT_ANCHOR_FILE_PATH)).toBe(true);
    expect(DEFAULT_ANCHOR_FILE_PATH).toBe(path.resolve(process.cwd(), 'audit-anchor.ndjson'));
  });
});

describe('readChainTip', () => {
  it('returns-undefined-when-no-chained-row-exists', async () => {
    const tip = await readChainTip(fakeExecutor([]));
    expect(tip).toBeUndefined();
  });

  it('returns-the-single-row-the-query-reports', async () => {
    const tip = await readChainTip(
      fakeExecutor([{ chain_seq: '42', row_hash: 'a'.repeat(64), row_count: '17' }]),
    );
    expect(tip).toEqual({ chainSeq: '42', rowHash: 'a'.repeat(64), rowCount: 17 });
  });
});

describe('recordAnchor', () => {
  it('returns-undefined-and-writes-nothing-when-there-is-no-chain-tip-yet', async () => {
    const filePath = path.join(dir, 'anchor.ndjson');
    const entry = await recordAnchor(fakeExecutor([]), filePath);
    expect(entry).toBeUndefined();
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });

  it('appends-exactly-one-line-matching-the-real-chain-tip', async () => {
    const filePath = path.join(dir, 'nested', 'anchor.ndjson');
    const executor = fakeExecutor([{ chain_seq: '7', row_hash: 'b'.repeat(64), row_count: '7' }]);

    const entry = await recordAnchor(executor, filePath);
    expect(entry).toBeDefined();
    expect(entry?.chainSeq).toBe('7');
    expect(entry?.rowHash).toBe('b'.repeat(64));
    expect(entry?.rowCount).toBe(7);
    expect(() => new Date(entry?.recordedAt ?? 'not-a-date').toISOString()).not.toThrow();

    const content = await readFile(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(entry);
  });

  it('genuinely-appends-a-second-entry-without-disturbing-the-first-entrys-own-bytes', async () => {
    const filePath = path.join(dir, 'anchor.ndjson');

    await recordAnchor(
      fakeExecutor([{ chain_seq: '1', row_hash: 'c'.repeat(64), row_count: '1' }]),
      filePath,
    );
    const afterFirst = await readFile(filePath, 'utf8');

    await recordAnchor(
      fakeExecutor([{ chain_seq: '2', row_hash: 'd'.repeat(64), row_count: '2' }]),
      filePath,
    );
    const afterSecond = await readFile(filePath, 'utf8');

    // The first write's own bytes must appear byte-for-byte as a prefix of
    // the file after the second write — genuine append, never a rewrite or
    // a truncate-then-recompute of the whole file.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);

    const entries = await readAnchorFile(filePath);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.chainSeq).toBe('1');
    expect(entries[1]?.chainSeq).toBe('2');
  });
});

describe('readAnchorFile', () => {
  it('throws-a-clear-error-when-the-file-does-not-exist', async () => {
    await expect(readAnchorFile(path.join(dir, 'nope.ndjson'))).rejects.toThrow(
      /anchor file not found/,
    );
  });

  it('round-trips-what-recordAnchor-wrote-and-tolerates-a-trailing-blank-line', async () => {
    const filePath = path.join(dir, 'anchor.ndjson');
    const one: AnchorEntry = {
      chainSeq: '1',
      rowHash: 'e'.repeat(64),
      recordedAt: '2026-01-01T00:00:00.000Z',
      rowCount: 1,
    };
    const two: AnchorEntry = {
      chainSeq: '5',
      rowHash: 'f'.repeat(64),
      recordedAt: '2026-01-02T00:00:00.000Z',
      rowCount: 5,
    };
    // Trailing newline after the last entry, exactly what recordAnchor's
    // own `${JSON.stringify(entry)}\n` produces — this is the one blank-line
    // shape this function must tolerate, not reject.
    const raw = `${JSON.stringify(one)}\n${JSON.stringify(two)}\n`;
    await writeFile(filePath, raw, 'utf8');

    const entries = await readAnchorFile(filePath);
    expect(entries).toEqual([one, two]);
  });

  it('throws-on-a-malformed-json-line-rather-than-silently-skipping-it', async () => {
    const filePath = path.join(dir, 'anchor.ndjson');
    await writeFile(filePath, 'not json at all\n', 'utf8');
    await expect(readAnchorFile(filePath)).rejects.toThrow(/not valid JSON/);
  });

  it('throws-on-a-line-missing-a-required-field-rather-than-silently-accepting-it', async () => {
    const filePath = path.join(dir, 'anchor.ndjson');
    await writeFile(filePath, `${JSON.stringify({ chainSeq: '1', rowHash: 'x' })}\n`, 'utf8');
    await expect(readAnchorFile(filePath)).rejects.toThrow(/not a valid anchor entry/);
  });

  it('returns-an-empty-array-for-a-file-containing-only-blank-lines', async () => {
    const filePath = path.join(dir, 'anchor.ndjson');
    await writeFile(filePath, '\n\n', 'utf8');
    const entries = await readAnchorFile(filePath);
    expect(entries).toEqual([]);
  });
});
