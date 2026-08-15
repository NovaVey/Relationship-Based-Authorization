import type * as NodeCrypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

// Regression (LOW): encrypt() had no error wrapping at all, unlike
// decrypt() — a failure inside the underlying node:crypto cipher
// operations would have propagated as a raw, unwrapped error, breaking
// this module's "every failure is a typed SecurityKitError" consistency.
// This is essentially unreachable through realistic inputs (unlike
// decrypt(), encrypt() has no authentication step to fail), so this test
// forces it directly by mocking node:crypto's createCipheriv — isolated in
// its own file so the mock doesn't affect every other real-crypto test in
// test/crypto/tenant-keys.test.ts.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    createCipheriv: vi.fn(() => {
      throw new Error('simulated node:crypto failure');
    }),
  };
});

describe('TenantEncryptor.encrypt error wrapping', () => {
  it('wraps a low-level cipher failure in EncryptionError', async () => {
    const { EnvKeyProvider, TenantEncryptor } = await import('../../src/crypto/index.js');
    const { EncryptionError } = await import('../../src/errors.js');

    const encryptor = new TenantEncryptor({
      keyProvider: new EnvKeyProvider('a-sufficiently-long-master-secret-for-testing'),
    });
    await expect(encryptor.encrypt('tenant-a', 'data')).rejects.toThrow(EncryptionError);
  });

  it('the wrapped EncryptionError is a SecurityKitError and carries the original cause', async () => {
    const { EnvKeyProvider, TenantEncryptor } = await import('../../src/crypto/index.js');
    const { EncryptionError, SecurityKitError } = await import('../../src/errors.js');

    const encryptor = new TenantEncryptor({
      keyProvider: new EnvKeyProvider('a-sufficiently-long-master-secret-for-testing'),
    });
    try {
      await encryptor.encrypt('tenant-a', 'data');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityKitError);
      expect(err).toBeInstanceOf(EncryptionError);
      const error = err as InstanceType<typeof EncryptionError>;
      expect(error.code).toBe('ENCRYPTION_FAILED');
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toBe('simulated node:crypto failure');
    }
  });
});
