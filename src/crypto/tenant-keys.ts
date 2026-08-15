import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import {
  DecryptionError,
  EncryptionError,
  InvalidKeyError,
  InvalidTenantIdError,
} from '../errors.js';
import type { EncryptedPayload, KeyProvider } from './types.js';

/** AES-256-GCM: 32-byte key, 12-byte IV, 16-byte auth tag. */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * {@link KeyProvider} that derives an independent 256-bit key per tenant
 * from a single master secret, using HKDF (RFC 5869, SHA-256) with the
 * tenant id as the HKDF "info" parameter.
 *
 * The point of this indirection: you manage exactly ONE secret (e.g.
 * fetched once from a secrets manager at startup) while every tenant still
 * gets a cryptographically independent 256-bit key. Because HKDF is a
 * one-way derivation, compromising or misusing one tenant's derived key
 * reveals nothing about another tenant's key, and reveals nothing about the
 * master secret itself — there is no way to run the derivation backwards.
 *
 * This is the pragmatic default for getting started, not the ceiling. For
 * production deployments wanting real per-tenant key rotation (issuing a
 * brand-new, unrelated key for a single tenant without touching anyone
 * else's) and a centralized audit trail of every key access, implement
 * {@link KeyProvider} against a real KMS (AWS KMS, GCP KMS, HashiCorp
 * Vault) instead.
 */
export class EnvKeyProvider implements KeyProvider {
  private readonly masterSecret: Buffer;

  /**
   * @param masterSecret The single secret all tenant keys are derived from.
   * Strings are interpreted as UTF-8. Must be at least 16 bytes — anything
   * shorter is almost certainly a placeholder or typo, not a real secret
   * pulled from a secrets manager, so it's rejected up front rather than
   * silently producing weak-in-practice derived keys.
   *
   * **This is a length floor, not an entropy floor** — for a module that
   * derives AES-256 keys, "at least 16 bytes" only rules out the shortest,
   * most obvious placeholders (`'x'`, `'changeme'`); it says nothing about
   * how random those 16+ bytes actually are, and can't: 16 zero bytes, or
   * `'aaaaaaaaaaaaaaaa'`, both pass this check and are exactly as easy to
   * guess as they look. This check exists to catch an accidental typo/stub
   * value, not to certify a secret as cryptographically strong — generate
   * the real value with a CSPRNG (e.g. `openssl rand -base64 32`, or
   * `node:crypto`'s `randomBytes(32)`) and pull it from a real secrets
   * manager, the same way you would any other production secret.
   * @throws {InvalidKeyError} if the resulting buffer is shorter than 16 bytes.
   */
  constructor(masterSecret: string | Buffer) {
    const buffer = Buffer.isBuffer(masterSecret) ? masterSecret : Buffer.from(masterSecret, 'utf8');
    if (buffer.length < 16) {
      throw new InvalidKeyError(
        `EnvKeyProvider master secret is too short (${buffer.length} bytes; need at least 16). ` +
          'This looks like a placeholder, not a real master secret.',
        buffer.length,
      );
    }
    this.masterSecret = buffer;
  }

  /**
   * Derives this tenant's 32-byte data key via HKDF-SHA256, using an empty
   * salt and the tenant id as "info" — the standard HKDF way to bind a
   * single input key material to many independent, context-specific
   * outputs.
   */
  getDataKey(tenantId: string): Buffer {
    const derived = hkdfSync(
      'sha256',
      this.masterSecret,
      Buffer.alloc(0),
      Buffer.from(tenantId, 'utf8'),
      KEY_LENGTH_BYTES,
    );
    return Buffer.from(derived);
  }
}

/**
 * {@link KeyProvider} backed by a direct `tenantId -> key` map supplied at
 * construction time.
 *
 * Primarily useful for tests and fixtures (deterministic, no derivation
 * involved) or small fixed deployments that already manage per-tenant keys
 * out of band and just need to plug them into {@link TenantEncryptor}.
 */
export class StaticKeyProvider implements KeyProvider {
  private readonly keys: Record<string, Buffer>;

  constructor(keys: Record<string, Buffer>) {
    this.keys = keys;
  }

  /**
   * @throws {InvalidKeyError} if no key is configured for `tenantId`. This
   * class's own docs endorse it for real, small fixed deployments (not just
   * tests/fixtures), so a missing-key misconfiguration here is a genuinely
   * reachable production failure — it needs the same "every error extends
   * `SecurityKitError`" guarantee as every other key problem this module
   * can hit, not a bare `Error` a caller's `catch (err) { if (err
   * instanceof SecurityKitError) ... }` handling would silently miss.
   * `actualLength` is `0` here specifically because there's no key at all
   * to report a wrong length for, not because a zero-length key was found.
   */
  getDataKey(tenantId: string): Buffer {
    const key = this.keys[tenantId];
    if (!key) {
      throw new InvalidKeyError(`No encryption key configured for tenant "${tenantId}".`, 0);
    }
    return key;
  }
}

/** Configuration for a {@link TenantEncryptor}. */
export interface TenantEncryptorOptions {
  /** Supplies the 32-byte AES-256-GCM key for each tenant. */
  keyProvider: KeyProvider;
}

/**
 * Encrypts and decrypts data with AES-256-GCM, scoping every operation to a
 * tenant via a pluggable {@link KeyProvider}.
 *
 * This class owns only the "how do I use a key with AES-256-GCM" concern —
 * key sourcing is entirely delegated to the `KeyProvider`, so swapping
 * {@link EnvKeyProvider} for a KMS-backed provider (or a
 * {@link StaticKeyProvider} in tests) requires no change here. GCM was
 * chosen because it's authenticated: `decrypt` cannot succeed against a
 * tampered ciphertext, a wrong key, or mismatched associated data — the
 * underlying `decipher.final()` call throws, which this class turns into a
 * single, consistent {@link DecryptionError}.
 */
export class TenantEncryptor {
  private readonly keyProvider: KeyProvider;

  constructor(options: TenantEncryptorOptions) {
    this.keyProvider = options.keyProvider;
  }

  /**
   * Encrypts `plaintext` under the given tenant's data key.
   *
   * @param tenantId Identifies which tenant's key to encrypt under.
   * @param plaintext The data to encrypt. Strings are encoded as UTF-8.
   * @param aad Optional additional authenticated data (e.g. a record id or
   * tenant id) that is authenticated but not encrypted — decrypting the
   * resulting payload will fail unless the exact same `aad` is supplied,
   * which lets callers cryptographically bind a ciphertext to a specific
   * context and detect if it's ever moved/replayed elsewhere.
   * @throws {InvalidTenantIdError} if `tenantId` is an empty string — this
   * module deliberately does not treat that as "the tenant with no id",
   * since a caller-side bug that silently produces `''` instead of a real
   * id (a missed field, a bad default) would otherwise derive/use a real,
   * working key instead of failing loudly.
   * @throws {InvalidKeyError} if the key returned by the `KeyProvider` is
   * not exactly 32 bytes.
   * @throws {EncryptionError} if the underlying `node:crypto` cipher
   * operation itself fails — essentially unreachable under normal use
   * (unlike `decrypt`, encryption has no authentication step to fail), but
   * wrapped for the same reason every other failure in this module is: so
   * a genuine failure here is still a typed `SecurityKitError`, not a raw,
   * inconsistent exception.
   */
  async encrypt(
    tenantId: string,
    plaintext: string | Buffer,
    aad?: Buffer,
  ): Promise<EncryptedPayload> {
    assertNonEmptyTenantId(tenantId);
    const key = await this.keyProvider.getDataKey(tenantId);
    assertKeyLength(key);

    try {
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      if (aad !== undefined) {
        cipher.setAAD(aad);
      }

      const plaintextBuffer = Buffer.isBuffer(plaintext)
        ? plaintext
        : Buffer.from(plaintext, 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
      };
    } catch (cause) {
      throw new EncryptionError(undefined, { cause });
    }
  }

  /**
   * Decrypts a payload previously produced by {@link encrypt}.
   *
   * @param tenantId Identifies which tenant's key to decrypt with — this
   * must be the same tenant the payload was encrypted for; using any other
   * tenant's key is indistinguishable, from GCM's point of view, from a
   * tampered ciphertext and fails the same way.
   * @param payload The `{ ciphertext, iv, authTag }` produced by `encrypt`.
   * @param aad Must exactly match the `aad` (or lack thereof) passed to the
   * original `encrypt` call.
   * @throws {InvalidTenantIdError} if `tenantId` is an empty string — see
   * `encrypt`'s own doc comment for why this is checked explicitly rather
   * than left to derive/use a real key for it.
   * @throws {InvalidKeyError} if the key returned by the `KeyProvider` is
   * not exactly 32 bytes.
   * @throws {DecryptionError} if decryption fails for any reason — wrong
   * key, tampered ciphertext/authTag, a malformed-length `authTag`/`iv`, or
   * mismatched `aad`. GCM's built-in tag verification (inside
   * `decipher.final()`) is what actually detects a tampered tag; this
   * method never implements its own tag comparison, since a hand-rolled
   * comparison is an easy place to introduce a timing side channel or
   * subtle bug. The `authTag` and `iv` *lengths* are checked explicitly,
   * though: `node:crypto` itself accepts any NIST SP 800-38D-legal GCM tag
   * length (as short as 4 bytes), so without that check a caller-supplied
   * `EncryptedPayload` with a truncated tag would be authenticated at far
   * weaker odds than the 128 bits this module documents and callers expect.
   * A wrong-length `iv` already fails safe on its own (GCM's tag
   * verification catches it, the same as any other tampering — confirmed
   * live before this change), so this check is for a clear, deterministic
   * failure reason rather than closing a real gap.
   */
  async decrypt(tenantId: string, payload: EncryptedPayload, aad?: Buffer): Promise<Buffer> {
    assertNonEmptyTenantId(tenantId);
    const key = await this.keyProvider.getDataKey(tenantId);
    assertKeyLength(key);

    try {
      const iv = Buffer.from(payload.iv, 'base64');
      if (iv.length !== IV_LENGTH_BYTES) {
        throw new TypeError(`iv must be exactly ${IV_LENGTH_BYTES} bytes; got ${iv.length}.`);
      }
      const authTag = Buffer.from(payload.authTag, 'base64');
      if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
        throw new TypeError(
          `authTag must be exactly ${AUTH_TAG_LENGTH_BYTES} bytes; got ${authTag.length}.`,
        );
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      if (aad !== undefined) {
        decipher.setAAD(aad);
      }
      const ciphertext = Buffer.from(payload.ciphertext, 'base64');
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (cause) {
      throw new DecryptionError(undefined, { cause });
    }
  }
}

/**
 * Guards both `encrypt` and `decrypt` against a misconfigured
 * `KeyProvider` returning a key of the wrong size — AES-256-GCM requires
 * exactly 32 bytes, and `createCipheriv`/`createDecipheriv` would otherwise
 * fail with a much less obvious error message deep inside `node:crypto`.
 *
 * Also guards against a `KeyProvider` returning something that merely
 * *looks* like a `Buffer` at the type level but isn't one at runtime — the
 * `Buffer` return type on {@link KeyProvider.getDataKey} is a compile-time
 * constraint only, and a real implementation (a hand-rolled KMS adapter, a
 * base64-decode that forgot the `Buffer.from(...)` step) could hand back a
 * plain array or string with a `.length` that happens to equal 32.
 * `createCipheriv`/`createDecipheriv` would still reject that, but with a
 * confusing low-level error instead of this module's own clear one.
 */
function assertKeyLength(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH_BYTES) {
    throw new InvalidKeyError(
      `KeyProvider returned a key of length ${key.length}; expected ${KEY_LENGTH_BYTES} bytes.`,
      key.length,
    );
  }
}

/**
 * Guards `encrypt`/`decrypt` against a `''` (or otherwise non-string)
 * `tenantId` — see either method's own doc comment for why an empty tenant
 * id is rejected explicitly rather than allowed to silently derive/use a
 * real key for "the tenant with no id".
 */
function assertNonEmptyTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new InvalidTenantIdError(tenantId);
  }
}
