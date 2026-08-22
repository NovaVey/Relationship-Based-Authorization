/**
 * Unit tests for the pure, DB-free half of the migration runner —
 * `runMigrations` itself needs a real Postgres connection and is covered
 * separately: Phase 0's CHECKPOINT verified it manually against a real
 * database, and `test/unit/store/migrate.integration.test.ts` now covers it
 * with real-Postgres integration tests (idempotent rerun, concurrent-call
 * race).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverMigrations } from '../../src/store/migrate.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'authz-migrations-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('discoverMigrations', () => {
  it('a missing directory is treated as zero migrations, not an error', () => {
    expect(discoverMigrations('/this/path/does/not/exist')).toEqual([]);
  });

  it('an empty directory reports zero migrations', () => {
    withTempDir((dir) => {
      expect(discoverMigrations(dir)).toEqual([]);
    });
  });

  it('finds .sql files and derives id from the filename minus the extension', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '0001_init.sql'), '-- noop');
      const [migration] = discoverMigrations(dir);
      expect(migration).toMatchObject({ id: '0001_init', filename: '0001_init.sql' });
    });
  });

  it('ignores non-.sql files in the same directory', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '0001_init.sql'), '-- noop');
      writeFileSync(join(dir, 'README.md'), '# not a migration');
      writeFileSync(join(dir, '.gitkeep'), '');
      expect(discoverMigrations(dir).map((m) => m.filename)).toEqual(['0001_init.sql']);
    });
  });

  it('sorts lexicographically by filename, matching the NNNN_description.sql apply order', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '0002_second.sql'), '-- noop');
      writeFileSync(join(dir, '0010_tenth.sql'), '-- noop');
      writeFileSync(join(dir, '0001_first.sql'), '-- noop');
      expect(discoverMigrations(dir).map((m) => m.id)).toEqual([
        '0001_first',
        '0002_second',
        '0010_tenth',
      ]);
    });
  });
});
