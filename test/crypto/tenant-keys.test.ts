import { describe, expect, it } from 'vitest';

import {
  DecryptionError,
  InvalidKeyError,
  InvalidTenantIdError,
  SecurityKitError,
} from '../../src/errors.js';
import { EnvKeyProvider, StaticKeyProvider, TenantEncryptor } from '../../src/crypto/index.js';
import type { EncryptedPayload, KeyProvider } from '../../src/crypto/index.js';

const MASTER_SECRET = 'a-sufficiently-long-master-secret-for-testing';

describe('EnvKeyProvider', () => {
  // Regression (HIGH): this used to be a plain TypeError, breaking this
  // package's "every error extends SecurityKitError" guarantee.
  it('throws InvalidKeyError when the master secret is shorter than 16 bytes', () => {
    expect(() => new EnvKeyProvider('short')).toThrow(InvalidKeyError);
  });

  it('InvalidKeyError from a too-short master secret extends SecurityKitError and carries actualLength', () => {
    try {
      new EnvKeyProvider('short');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityKitError);
      const error = err as InvalidKeyError;
      expect(error.code).toBe('INVALID_KEY');
      expect(error.actualLength).toBe(5); // 'short'.length
    }
  });

  it('accepts a master secret of exactly 16 bytes', () => {
    expect(() => new EnvKeyProvider('0123456789abcdef')).not.toThrow();
  });

  it('accepts a Buffer master secret', () => {
    expect(() => new EnvKeyProvider(Buffer.from(MASTER_SECRET, 'utf8'))).not.toThrow();
  });

  it('throws InvalidKeyError for a too-short Buffer master secret', () => {
    expect(() => new EnvKeyProvider(Buffer.from('tiny'))).toThrow(InvalidKeyError);
  });

  it('derives a 32-byte key for a tenant', () => {
    const provider = new EnvKeyProvider(MASTER_SECRET);
    const key = provider.getDataKey('tenant-a');
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('derives the same key for the same tenant id (deterministic)', () => {
    const provider = new EnvKeyProvider(MASTER_SECRET);
    const key1 = provider.getDataKey('tenant-a');
    const key2 = provider.getDataKey('tenant-a');
    expect(key1.equals(key2)).toBe(true);
  });

  it('derives different keys for different tenants', () => {
    const provider = new EnvKeyProvider(MASTER_SECRET);
    const keyA = provider.getDataKey('tenant-a');
    const keyB = provider.getDataKey('tenant-b');
    expect(keyA.equals(keyB)).toBe(false);
  });
});

describe('StaticKeyProvider', () => {
  it('returns the configured key for a known tenant', () => {
    const key = Buffer.alloc(32, 7);
    const provider = new StaticKeyProvider({ 'tenant-a': key });
    expect(provider.getDataKey('tenant-a')).toBe(key);
  });

  // Regression (LOW): this used to throw a plain `Error`, breaking this
  // package's "every error extends SecurityKitError" guarantee — reachable
  // in real production use, not just tests/fixtures, since this class's
  // own docs endorse it for small fixed deployments too.
  it('throws InvalidKeyError with a clear message for an unconfigured tenant', () => {
    const provider = new StaticKeyProvider({});
    expect(() => provider.getDataKey('tenant-missing')).toThrow(InvalidKeyError);
    expect(() => provider.getDataKey('tenant-missing')).toThrow(/tenant-missing/);
  });

  it('the thrown error is a SecurityKitError, not a DecryptionError (it is a configuration error)', () => {
    const provider = new StaticKeyProvider({});
    try {
      provider.getDataKey('tenant-missing');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityKitError);
      expect(err).not.toBeInstanceOf(DecryptionError);
      const error = err as InvalidKeyError;
      expect(error.code).toBe('INVALID_KEY');
      expect(error.actualLength).toBe(0);
    }
  });
});

describe('TenantEncryptor', () => {
  it('round-trips a string plaintext through encrypt/decrypt', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'hello, world');
    const decrypted = await encryptor.decrypt('tenant-a', payload);
    expect(decrypted.toString('utf8')).toBe('hello, world');
  });

  it('round-trips a Buffer plaintext through encrypt/decrypt', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const original = Buffer.from([0, 1, 2, 3, 255, 254, 253]);
    const payload = await encryptor.encrypt('tenant-a', original);
    const decrypted = await encryptor.decrypt('tenant-a', payload);
    expect(decrypted.equals(original)).toBe(true);
  });

  it('produces an EncryptedPayload with base64 fields and no keyId', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'data');
    expect(typeof payload.ciphertext).toBe('string');
    expect(typeof payload.iv).toBe('string');
    expect(typeof payload.authTag).toBe('string');
    expect(payload.keyId).toBeUndefined();
    // IV must decode to 12 bytes, authTag to 16 bytes.
    expect(Buffer.from(payload.iv, 'base64').length).toBe(12);
    expect(Buffer.from(payload.authTag, 'base64').length).toBe(16);
  });

  it('produces different ciphertext for the same plaintext across different tenants', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payloadA = await encryptor.encrypt('tenant-a', 'identical plaintext');
    const payloadB = await encryptor.encrypt('tenant-b', 'identical plaintext');
    expect(payloadA.ciphertext).not.toBe(payloadB.ciphertext);
  });

  it('produces different ciphertext across repeated encryptions of the same plaintext (random IV)', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload1 = await encryptor.encrypt('tenant-a', 'same plaintext');
    const payload2 = await encryptor.encrypt('tenant-a', 'same plaintext');
    expect(payload1.ciphertext).not.toBe(payload2.ciphertext);
    expect(payload1.iv).not.toBe(payload2.iv);
  });

  it('throws DecryptionError when decrypting tenant A payload with tenant B key (StaticKeyProvider)', async () => {
    const keyA = Buffer.alloc(32, 1);
    const keyB = Buffer.alloc(32, 2);
    const encryptor = new TenantEncryptor({
      keyProvider: new StaticKeyProvider({ 'tenant-a': keyA, 'tenant-b': keyB }),
    });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    await expect(encryptor.decrypt('tenant-b', payload)).rejects.toThrow(DecryptionError);
  });

  it('the DecryptionError from a cross-tenant decrypt carries the original cause', async () => {
    const keyA = Buffer.alloc(32, 1);
    const keyB = Buffer.alloc(32, 2);
    const encryptor = new TenantEncryptor({
      keyProvider: new StaticKeyProvider({ 'tenant-a': keyA, 'tenant-b': keyB }),
    });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    try {
      await encryptor.decrypt('tenant-b', payload);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      const error = err as DecryptionError;
      expect(error.code).toBe('DECRYPTION_FAILED');
      expect(error.cause).toBeDefined();
    }
  });

  it('throws DecryptionError when the ciphertext is tampered with', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    const tampered: EncryptedPayload = { ...payload, ciphertext: flipLastByte(payload.ciphertext) };
    await expect(encryptor.decrypt('tenant-a', tampered)).rejects.toThrow(DecryptionError);
  });

  it('throws DecryptionError when the authTag is tampered with', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    const tampered: EncryptedPayload = { ...payload, authTag: flipLastByte(payload.authTag) };
    await expect(encryptor.decrypt('tenant-a', tampered)).rejects.toThrow(DecryptionError);
  });

  it('round-trips successfully when matching AAD is supplied to both encrypt and decrypt', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const aad = Buffer.from('record-123', 'utf8');
    const payload = await encryptor.encrypt('tenant-a', 'aad-protected data', aad);
    const decrypted = await encryptor.decrypt('tenant-a', payload, aad);
    expect(decrypted.toString('utf8')).toBe('aad-protected data');
  });

  it('throws DecryptionError when AAD is provided on encrypt but omitted on decrypt', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const aad = Buffer.from('record-123', 'utf8');
    const payload = await encryptor.encrypt('tenant-a', 'aad-protected data', aad);
    await expect(encryptor.decrypt('tenant-a', payload)).rejects.toThrow(DecryptionError);
  });

  it('throws DecryptionError when AAD mismatches between encrypt and decrypt', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt(
      'tenant-a',
      'aad-protected data',
      Buffer.from('record-123'),
    );
    await expect(encryptor.decrypt('tenant-a', payload, Buffer.from('record-456'))).rejects.toThrow(
      DecryptionError,
    );
  });

  // Regression (HIGH): this used to be a plain TypeError, breaking this
  // package's "every error extends SecurityKitError" guarantee — and this
  // path is reachable through the documented KeyProvider extension point
  // (a real KMS integration returning a malformed key), not just a
  // hypothetical misuse.
  it('throws InvalidKeyError when the KeyProvider returns a key that is too short', async () => {
    const badProvider = { getDataKey: () => Buffer.alloc(16) };
    const encryptor = new TenantEncryptor({ keyProvider: badProvider });
    await expect(encryptor.encrypt('tenant-a', 'data')).rejects.toThrow(InvalidKeyError);
  });

  it('throws InvalidKeyError when the KeyProvider returns a key that is too long', async () => {
    const badProvider = { getDataKey: () => Buffer.alloc(64) };
    const encryptor = new TenantEncryptor({ keyProvider: badProvider });
    await expect(encryptor.encrypt('tenant-a', 'data')).rejects.toThrow(InvalidKeyError);
  });

  it('InvalidKeyError from a wrong-length KeyProvider key extends SecurityKitError and carries actualLength', async () => {
    const badProvider = { getDataKey: () => Buffer.alloc(10) };
    const encryptor = new TenantEncryptor({ keyProvider: badProvider });
    try {
      await encryptor.encrypt('tenant-a', 'data');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityKitError);
      const error = err as InvalidKeyError;
      expect(error.code).toBe('INVALID_KEY');
      expect(error.actualLength).toBe(10);
    }
  });

  it('throws InvalidKeyError on decrypt when the KeyProvider returns a wrong-length key', async () => {
    const goodProvider = new EnvKeyProvider(MASTER_SECRET);
    const encryptor = new TenantEncryptor({ keyProvider: goodProvider });
    const payload = await encryptor.encrypt('tenant-a', 'data');

    const badProvider = { getDataKey: () => Buffer.alloc(10) };
    const badEncryptor = new TenantEncryptor({ keyProvider: badProvider });
    await expect(badEncryptor.decrypt('tenant-a', payload)).rejects.toThrow(InvalidKeyError);
  });

  // Regression (HIGH): decrypt() never validated the decoded authTag's
  // length before calling decipher.setAuthTag() — node:crypto itself
  // accepts any NIST SP 800-38D-legal GCM tag length (4-16 bytes), so a
  // caller-supplied EncryptedPayload with a truncated tag was authenticated
  // at far weaker odds than the 128 bits this module documents (a 4-byte
  // tag is ~1-in-4-billion, not ~1-in-2^128). EncryptedPayload is explicitly
  // documented as "trivially JSON-serializable... safe to store as
  // JSON/columns", i.e. designed to cross a storage/serialization boundary
  // an attacker could influence.
  it('throws DecryptionError when authTag is truncated to a shorter GCM-legal length (4 bytes)', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    const truncated: EncryptedPayload = {
      ...payload,
      authTag: Buffer.from(payload.authTag, 'base64').subarray(0, 4).toString('base64'),
    };
    await expect(encryptor.decrypt('tenant-a', truncated)).rejects.toThrow(DecryptionError);
  });

  it('throws DecryptionError when authTag is empty', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    const empty: EncryptedPayload = { ...payload, authTag: '' };
    await expect(encryptor.decrypt('tenant-a', empty)).rejects.toThrow(DecryptionError);
  });

  it('throws DecryptionError when authTag is longer than 16 bytes', async () => {
    const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
    const payload = await encryptor.encrypt('tenant-a', 'secret data');
    const extended: EncryptedPayload = {
      ...payload,
      authTag: Buffer.concat([Buffer.from(payload.authTag, 'base64'), Buffer.alloc(4)]).toString(
        'base64',
      ),
    };
    await expect(encryptor.decrypt('tenant-a', extended)).rejects.toThrow(DecryptionError);
  });

  it('supports an async KeyProvider (getDataKey returning a Promise<Buffer>)', async () => {
    const key = Buffer.alloc(32, 9);
    const asyncProvider = {
      getDataKey: async (_tenantId: string) => key,
    };
    const encryptor = new TenantEncryptor({ keyProvider: asyncProvider });
    const payload = await encryptor.encrypt('tenant-a', 'async provider works');
    const decrypted = await encryptor.decrypt('tenant-a', payload);
    expect(decrypted.toString('utf8')).toBe('async provider works');
  });

  // Regression (LOW): neither encrypt() nor decrypt() validated tenantId at
  // all — an empty string silently derived (EnvKeyProvider) or looked up
  // (StaticKeyProvider, if coincidentally configured for '') a real,
  // working key for "the tenant with no id", which could mask a real
  // upstream bug (a missing field, a bad default) that produces '' instead
  // of failing loudly.
  describe('empty tenantId', () => {
    it('encrypt() throws InvalidTenantIdError for an empty tenantId', async () => {
      const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
      await expect(encryptor.encrypt('', 'data')).rejects.toThrow(InvalidTenantIdError);
    });

    it('decrypt() throws InvalidTenantIdError for an empty tenantId', async () => {
      const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
      const payload = await encryptor.encrypt('tenant-a', 'data');
      await expect(encryptor.decrypt('', payload)).rejects.toThrow(InvalidTenantIdError);
    });

    it('the thrown error is a SecurityKitError with a stable code', async () => {
      const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
      try {
        await encryptor.encrypt('', 'data');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SecurityKitError);
        expect((err as InvalidTenantIdError).code).toBe('INVALID_TENANT_ID');
      }
    });
  });

  // Regression (LOW): assertKeyLength only checked `.length`, not
  // `Buffer.isBuffer` — a misbehaving KeyProvider returning a non-Buffer
  // value with a `.length` of exactly 32 (a string, a plain array) would
  // pass this check and reach node:crypto's own, far less clear error
  // instead of this module's InvalidKeyError.
  it('throws InvalidKeyError when the KeyProvider returns a non-Buffer value, even with the right .length', async () => {
    const fakeKey = 'x'.repeat(32); // a string, not a Buffer — .length is 32
    const badProvider: KeyProvider = { getDataKey: () => fakeKey as unknown as Buffer };
    const encryptor = new TenantEncryptor({ keyProvider: badProvider });
    await expect(encryptor.encrypt('tenant-a', 'data')).rejects.toThrow(InvalidKeyError);
  });

  // Regression (LOW): decrypt() validated authTag's decoded length but not
  // iv's — node:crypto's own GCM tag verification already fails safe for a
  // wrong-length iv (confirmed live before this change: it's caught by the
  // same DecryptionError-wrapping try/catch either way), so this is about a
  // clear, deterministic failure reason rather than closing an actual gap.
  describe('malformed iv', () => {
    it('throws DecryptionError when iv is truncated', async () => {
      const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
      const payload = await encryptor.encrypt('tenant-a', 'secret data');
      const truncated: EncryptedPayload = {
        ...payload,
        iv: Buffer.from(payload.iv, 'base64').subarray(0, 4).toString('base64'),
      };
      await expect(encryptor.decrypt('tenant-a', truncated)).rejects.toThrow(DecryptionError);
    });

    it('throws DecryptionError when iv is empty', async () => {
      const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
      const payload = await encryptor.encrypt('tenant-a', 'secret data');
      const empty: EncryptedPayload = { ...payload, iv: '' };
      await expect(encryptor.decrypt('tenant-a', empty)).rejects.toThrow(DecryptionError);
    });

    it('throws DecryptionError when iv is longer than 12 bytes', async () => {
      const encryptor = new TenantEncryptor({ keyProvider: new EnvKeyProvider(MASTER_SECRET) });
      const payload = await encryptor.encrypt('tenant-a', 'secret data');
      const extended: EncryptedPayload = {
        ...payload,
        iv: Buffer.concat([Buffer.from(payload.iv, 'base64'), Buffer.alloc(4)]).toString('base64'),
      };
      await expect(encryptor.decrypt('tenant-a', extended)).rejects.toThrow(DecryptionError);
    });
  });

  // encrypt()'s error-wrapping behavior (EncryptionError) needs a genuine
  // node:crypto failure to exercise for real — see
  // test/crypto/tenant-keys.encryption-error.test.ts, which mocks
  // node:crypto specifically for that (isolated in its own file so the
  // mock doesn't affect every other real-crypto test in this one).
});

/** Flips the low bit of the last byte of a base64 string, re-encoding the result. */
function flipLastByte(base64: string): string {
  const buffer = Buffer.from(base64, 'base64');
  buffer[buffer.length - 1] = (buffer[buffer.length - 1] ?? 0) ^ 0x01;
  return buffer.toString('base64');
}
