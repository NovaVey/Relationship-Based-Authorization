/**
 * `src/api/db-api-keys.ts` — the real, mintable, DB-backed API-key
 * credential tier's own lifecycle functions. DB-free: every function that
 * needs `pool.query` at all is exercised here against a plain
 * `{ query: vi.fn() }` fake (the identical fixture shape `test/unit/api/
 * server.test.ts`'s own top-of-file doc comment already establishes for
 * "prove the wiring, not a real database" tests), never a real Postgres
 * connection — that proof is `test/unit/store/api-keys.integration.test.ts`'s
 * job instead (real Postgres, the full create/scope/expire/revoke story).
 *
 * Written from `db-api-keys.ts`'s own exported types and doc comments,
 * matching this project's own established discipline of testing a
 * function's documented contract, not whatever its implementation happens
 * to do today.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  generateRawApiKey,
  hashApiKey,
  createApiKey,
  revokeApiKey,
  listApiKeys,
  validateDbApiKey,
} from '../../../src/api/db-api-keys.js';
import type { QueryExecutor } from '../../../src/store/query-executor.js';

// ---------------------------------------------------------------------------
// generateRawApiKey — a real random secret, never predictable.
// ---------------------------------------------------------------------------

describe('generateRawApiKey — a real, high-entropy, URL-safe secret', () => {
  it('two-consecutive-calls-produce-different-keys', () => {
    const a = generateRawApiKey();
    const b = generateRawApiKey();
    expect(a).not.toBe(b);
  });

  it('a-generated-key-is-base64url-shaped-no-plus-slash-or-padding-characters', () => {
    const key = generateRawApiKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).not.toContain('+');
    expect(key).not.toContain('/');
    expect(key).not.toContain('=');
  });

  it('a-generated-key-decodes-back-to-32-real-bytes-256-bits-of-entropy', () => {
    const key = generateRawApiKey();
    const decoded = Buffer.from(key, 'base64url');
    expect(decoded).toHaveLength(32);
  });

  it('a-thousand-consecutive-keys-are-all-distinct-no-collisions-from-a-weak-or-predictable-source', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateRawApiKey()));
    expect(keys.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// hashApiKey — a deterministic SHA-256 hex digest.
// ---------------------------------------------------------------------------

describe('hashApiKey — a deterministic SHA-256 hex digest, never the raw key itself', () => {
  it('the-same-raw-key-hashes-to-the-same-digest-every-time', () => {
    const raw = 'a-fixed-raw-key-value-for-this-test';
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });

  it('two-different-raw-keys-hash-to-two-different-digests', () => {
    expect(hashApiKey('raw-key-one')).not.toBe(hashApiKey('raw-key-two'));
  });

  it('the-digest-is-64-lowercase-hex-characters-a-real-sha-256-hex-shape', () => {
    const digest = hashApiKey('some-raw-key');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the-digest-never-equals-or-contains-the-raw-key-itself', () => {
    const raw = 'never-store-this-verbatim-anywhere';
    const digest = hashApiKey(raw);
    expect(digest).not.toBe(raw);
    expect(digest).not.toContain(raw);
  });

  it('matches-a-hand-computed-sha-256-hex-digest-for-a-known-input-not-just-internally-self-consistent', () => {
    // sha256("hello") — a well-known, independently-verifiable test vector,
    // computed by a source other than this file's own function under test.
    expect(hashApiKey('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

// ---------------------------------------------------------------------------
// createApiKey — validation (DB-free, throws before ever touching `pool`)
// and the success path (mocked `pool.query`).
// ---------------------------------------------------------------------------

function fakePool(rows: unknown[]): QueryExecutor & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('createApiKey — input validation runs before pool.query is ever called', () => {
  it('an-empty-scopes-array-is-rejected-never-silently-widened-to-unscoped', async () => {
    const pool = fakePool([]);
    await expect(
      createApiKey(pool, { name: 'test key', role: 'admin', scopes: [] }),
    ).rejects.toThrow(/at least one namespace/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a-scope-entry-that-is-not-a-valid-identifier-is-rejected', async () => {
    const pool = fakePool([]);
    await expect(
      createApiKey(pool, { name: 'test key', role: 'admin', scopes: ['Not-Valid!'] }),
    ).rejects.toThrow(/invalid scope namespace/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('an-expiresAt-at-or-before-now-is-rejected', async () => {
    const pool = fakePool([]);
    await expect(
      createApiKey(pool, {
        name: 'test key',
        role: 'admin',
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/must be in the future/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('an-empty-or-all-whitespace-name-is-rejected', async () => {
    const pool = fakePool([]);
    await expect(createApiKey(pool, { name: '   ', role: 'admin' })).rejects.toThrow(
      /name must not be empty/,
    );
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('createApiKey — success path returns {id, rawKey}, and the raw key is inserted only in hashed form', () => {
  it('returns-the-inserted-id-and-a-fresh-raw-key-never-the-hash', async () => {
    const pool = fakePool([{ id: '42' }]);
    const result = await createApiKey(pool, { name: 'ci key', role: 'readonly' });
    expect(result.id).toBe('42');
    expect(typeof result.rawKey).toBe('string');
    expect(result.rawKey.length).toBeGreaterThan(0);
  });

  it('the-value-bound-into-the-insert-is-the-hash-of-the-returned-raw-key-never-the-raw-key-itself', async () => {
    const pool = fakePool([{ id: '1' }]);
    const result = await createApiKey(pool, { name: 'ci key', role: 'admin' });
    const [, params] = pool.query.mock.calls[0] as [string, unknown[]];
    const insertedKeyHash = params[1];
    expect(insertedKeyHash).toBe(hashApiKey(result.rawKey));
    expect(insertedKeyHash).not.toBe(result.rawKey);
  });

  it('an-unscoped-key-passing-no-scopes-field-inserts-null-not-undefined-or-an-empty-array', async () => {
    const pool = fakePool([{ id: '1' }]);
    await createApiKey(pool, { name: 'unscoped key', role: 'admin' });
    const [, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBeNull();
  });

  it('a-scoped-key-inserts-the-real-namespace-array', async () => {
    const pool = fakePool([{ id: '1' }]);
    await createApiKey(pool, { name: 'scoped key', role: 'admin', scopes: ['document', 'folder'] });
    const [, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toEqual(['document', 'folder']);
  });
});

// ---------------------------------------------------------------------------
// revokeApiKey
// ---------------------------------------------------------------------------

describe('revokeApiKey', () => {
  it('a-non-numeric-id-is-rejected-before-pool-query-is-ever-called', async () => {
    const pool = fakePool([]);
    await expect(revokeApiKey(pool, 'not-a-number')).rejects.toThrow(
      /must be a non-negative integer/,
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a-real-updated-row-rowCount-1-reports-true', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    await expect(revokeApiKey(pool, '5')).resolves.toBe(true);
  });

  it('no-row-matched-rowCount-0-either-a-nonexistent-id-or-already-revoked-reports-false', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await expect(revokeApiKey(pool, '5')).resolves.toBe(false);
  });

  it('the-query-only-ever-touches-rows-where-revoked_at-is-null-never-re-stamping-an-already-revoked-key', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await revokeApiKey(pool, '5');
    const [text] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/revoked_at is null/);
  });
});

// ---------------------------------------------------------------------------
// listApiKeys — never a hash or raw key, by construction of the select list.
// ---------------------------------------------------------------------------

describe('listApiKeys', () => {
  it('the-select-list-never-names-key_hash-so-a-hash-can-never-leak-through-this-function', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await listApiKeys(pool);
    const [text] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(text).not.toMatch(/key_hash/);
  });

  it('maps-every-row-field-to-its-camelcase-listing-shape-verbatim', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-06-01T00:00:00Z');
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: '7',
            name: 'my key',
            role: 'admin',
            scopes: ['document'],
            created_at: createdAt,
            expires_at: expiresAt,
            revoked_at: null,
          },
        ],
        rowCount: 1,
      }),
    };
    const result = await listApiKeys(pool);
    expect(result).toEqual([
      {
        id: '7',
        name: 'my key',
        role: 'admin',
        scopes: ['document'],
        createdAt,
        expiresAt,
        revokedAt: null,
      },
    ]);
  });

  it('an-empty-table-returns-an-empty-array-never-throws', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await expect(listApiKeys(pool)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateDbApiKey
// ---------------------------------------------------------------------------

describe('validateDbApiKey', () => {
  it('no-matching-row-returns-null', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await expect(validateDbApiKey(pool, 'some-raw-key')).resolves.toBeNull();
  });

  it('a-matching-row-returns-id-role-and-scopes', async () => {
    const pool: QueryExecutor & { query: ReturnType<typeof vi.fn> } = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: '9', role: 'readonly', scopes: null }],
        rowCount: 1,
      }),
    };
    await expect(validateDbApiKey(pool, 'some-raw-key')).resolves.toEqual({
      id: '9',
      role: 'readonly',
      scopes: null,
    });
  });

  it('looks-up-by-the-hash-of-the-supplied-raw-key-never-the-raw-key-itself', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool: QueryExecutor & { query: typeof query } = { query };
    const raw = 'a-raw-key-to-look-up';
    await validateDbApiKey(pool, raw);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(hashApiKey(raw));
    expect(params[0]).not.toBe(raw);
  });

  it('the-query-carries-all-three-validity-conditions-key_hash-revoked_at-and-expires_at-in-one-where-clause', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool: QueryExecutor & { query: typeof query } = { query };
    await validateDbApiKey(pool, 'raw');
    const [text] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/key_hash\s*=\s*\$1/);
    expect(text).toMatch(/revoked_at is null/);
    expect(text).toMatch(/expires_at is null or expires_at > now\(\)/);
  });
});
