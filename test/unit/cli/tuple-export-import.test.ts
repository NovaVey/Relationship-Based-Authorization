/**
 * `authz tuple export` / `authz tuple import` (`src/cli/commands/tuple.ts`,
 * new feature) — mirrors `test/unit/cli/tuple.test.ts`'s own established
 * pattern: `getPool()`'s real `Pool` object is left alone (never actually
 * connects unless a query runs against it), and `listAllTuples`/`writeTuple`
 * are mocked directly via `vi.spyOn` on `src/store/tuples.js`'s own module
 * namespace — the same "prove the wiring, not the already-tested domain
 * function" scope every other CLI command test file in this directory
 * already keeps. `env.DATABASE_URL` set to a real-shaped but unreachable
 * address for every case that must get past the "is a database configured
 * at all" check without a real Postgres.
 *
 * This file's own job: `tupleExport`'s pagination loop (multiple pages,
 * an empty final page, the `--namespace` filter threaded through to
 * `listAllTuples`'s own filter) and its NDJSON output shape; `tupleImport`'s
 * per-line independence (one malformed/rejected line never blocks any
 * other), its `--progress` validation, and the one property specific to
 * this command among every batch operation in this codebase: a THROWN
 * error (a genuine infrastructure failure, not a per-item validation
 * rejection) aborts the whole import immediately rather than being
 * counted as one more failed line.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';
import { tupleExport, tupleImport, EXPORT_PAGE_SIZE } from '../../../src/cli/commands/tuple.js';
import * as tuplesModule from '../../../src/store/tuples.js';
import type { TupleRow, WriteTupleResult } from '../../../src/store/tuples.js';

/** Guaranteed unreachable — same constant `test/unit/cli/tuple.test.ts` already establishes. */
const UNREACHABLE_DATABASE_URL = 'postgres://user:pass@127.0.0.1:1/definitely_nonexistent_db';

const ORIGINAL_MAX_CONCURRENCY = env.MAX_CONCURRENCY;

function row(overrides: Partial<TupleRow> = {}): TupleRow {
  return {
    id: 1,
    objectNs: 'document',
    objectId: 'readme',
    relation: 'viewer',
    subjectNs: 'user',
    subjectId: 'alice',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(async () => {
  await closePool();
  process.exitCode = undefined;
  env.MAX_CONCURRENCY = ORIGINAL_MAX_CONCURRENCY;
  vi.restoreAllMocks();
});

describe('authz tuple export', () => {
  it('DATABASE_URL unset exits 3 and never calls listAllTuples', async () => {
    env.DATABASE_URL = undefined;
    const spy = vi.spyOn(tuplesModule, 'listAllTuples');

    await tupleExport();

    expect(process.exitCode).toBe(3);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a page shorter than EXPORT_PAGE_SIZE is the last page — no further call needed, writing one NDJSON line per row', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const spy = vi
      .spyOn(tuplesModule, 'listAllTuples')
      .mockResolvedValueOnce([row({ id: 1, objectId: 'a' }), row({ id: 2, objectId: 'b' })]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await tupleExport();

    expect(process.exitCode).toBeUndefined();
    // A page shorter than the limit it was asked for can only mean there's
    // nothing left to page through — no wasted round trip for a now-empty
    // final page.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    const lines = writeSpy.mock.calls.map((call) => call[0] as string);
    expect(JSON.parse(lines[0]!.trim())).toMatchObject({ objectId: 'a', relation: 'viewer' });
    expect(JSON.parse(lines[1]!.trim())).toMatchObject({ objectId: 'b', relation: 'viewer' });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('exported 2 tuples'));
  });

  it('a full page (exactly EXPORT_PAGE_SIZE rows) always fetches a next page, advancing afterId from the last row seen', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const fullPage = Array.from({ length: EXPORT_PAGE_SIZE }, (_, i) => row({ id: i + 1 }));
    const spy = vi
      .spyOn(tuplesModule, 'listAllTuples')
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([]);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await tupleExport();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ afterId: 0 });
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ afterId: EXPORT_PAGE_SIZE });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`exported ${EXPORT_PAGE_SIZE} tuples`),
    );
  });

  it('threads --namespace through to listAllTuples’s own filter', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const spy = vi.spyOn(tuplesModule, 'listAllTuples').mockResolvedValueOnce([]);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await tupleExport({ namespace: 'org' });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ objectNs: 'org' }),
    );
  });

  it('omitting --namespace never passes an objectNs filter at all', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const spy = vi.spyOn(tuplesModule, 'listAllTuples').mockResolvedValueOnce([]);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await tupleExport();

    expect(spy.mock.calls[0]?.[1]).not.toHaveProperty('objectNs');
  });
});

describe('authz tuple import — argument validation', () => {
  it('an invalid --progress value exits 2 before ever touching Postgres', async () => {
    env.DATABASE_URL = undefined;
    const spy = vi.spyOn(tuplesModule, 'writeTuple');

    await tupleImport(undefined, { progress: 'not-a-number' });

    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('DATABASE_URL unset exits 3', async () => {
    env.DATABASE_URL = undefined;
    const spy = vi.spyOn(tuplesModule, 'writeTuple');

    // A real, existing empty-ish file — argument validation must reject
    // on DATABASE_URL before ever reading it.
    await tupleImport(undefined, {});

    expect(process.exitCode).toBe(3);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('authz tuple import — reading a real file', () => {
  let dir: string;

  function writeTempFile(contents: string): string {
    dir = mkdtempSync(join(tmpdir(), 'authz-tuple-import-test-'));
    const file = join(dir, 'tuples.ndjson');
    writeFileSync(file, contents);
    return file;
  }

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('writes every line, reporting written/already-existed/failed counts', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    vi.spyOn(tuplesModule, 'writeTuple').mockImplementation(async (_pool, tuple) => {
      if (tuple.objectId === 'existing') return { ok: true, token: 1, created: false };
      return { ok: true, token: 1, created: true } satisfies WriteTupleResult;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const file = writeTempFile(
      [
        JSON.stringify({
          objectNs: 'document',
          objectId: 'new1',
          relation: 'viewer',
          subjectNs: 'user',
          subjectId: 'alice',
        }),
        JSON.stringify({
          objectNs: 'document',
          objectId: 'existing',
          relation: 'viewer',
          subjectNs: 'user',
          subjectId: 'bob',
        }),
      ].join('\n'),
    );

    await tupleImport(file, {});

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 written, 1 already existed, 0 failed, out of 2 lines'),
    );
  });

  it('a malformed JSON line is reported and counted as failed, but does not block any other line', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue({
      ok: true,
      token: 1,
      created: true,
    } satisfies WriteTupleResult);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const file = writeTempFile(
      [
        'not even json',
        JSON.stringify({
          objectNs: 'document',
          objectId: 'ok',
          relation: 'viewer',
          subjectNs: 'user',
          subjectId: 'alice',
        }),
      ].join('\n'),
    );

    await tupleImport(file, {});

    expect(process.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('line 1: not valid JSON'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 written, 0 already existed, 1 failed, out of 2 lines'),
    );
  });

  it('a line missing a required field is reported and counted as failed, not thrown', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    const spy = vi.spyOn(tuplesModule, 'writeTuple');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const file = writeTempFile(JSON.stringify({ objectNs: 'document', objectId: 'x' }));

    await tupleImport(file, {});

    expect(process.exitCode).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('line 1:'));
  });

  it('a per-line writeTuple rejection ({ok: false}) is reported and counted as failed, exit 2', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    vi.spyOn(tuplesModule, 'writeTuple').mockResolvedValue({
      ok: false,
      errors: [{ code: 'undeclared_relation', message: "relation 'viewer' is not declared" }],
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const file = writeTempFile(
      JSON.stringify({
        objectNs: 'document',
        objectId: 'x',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      }),
    );

    await tupleImport(file, {});

    expect(process.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("relation 'viewer' is not declared"),
    );
  });

  it('a THROWN error from writeTuple aborts the whole import immediately, exit 3 — never counted as a failed line', async () => {
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    env.MAX_CONCURRENCY = 1; // deterministic: one line attempted at a time
    vi.spyOn(tuplesModule, 'writeTuple').mockRejectedValue(
      new Error('connection terminated unexpectedly'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const file = writeTempFile(
      JSON.stringify({
        objectNs: 'document',
        objectId: 'x',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      }),
    );

    await tupleImport(file, {});

    expect(process.exitCode).toBe(3);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Postgres:'));
    // Never reaches the normal "N written, N already existed..." summary —
    // that's console.log, distinct from the abort message on console.error.
    expect(logSpy).not.toHaveBeenCalled();
  });
});
