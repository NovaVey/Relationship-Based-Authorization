/**
 * Shared types for the per-tenant encryption module. Kept separate from the
 * implementation so alternative {@link KeyProvider} backends (e.g. a
 * KMS-backed provider) can depend on just this file without pulling in
 * `node:crypto` usage details from `tenant-keys.ts`.
 */

/**
 * Pluggable source of per-tenant data encryption keys.
 *
 * `TenantEncryptor` (see `tenant-keys.ts`) only knows how to call
 * `getDataKey` and use the result with AES-256-GCM — it has no opinion on
 * where keys come from. That indirection is what lets a deployment start
 * with the bundled {@link EnvKeyProvider} (single master secret, HKDF
 * derivation) and later swap in a provider backed by a real KMS (AWS KMS,
 * GCP KMS, HashiCorp Vault) without touching any encrypt/decrypt call site.
 */
export interface KeyProvider {
  /** Returns the 32-byte (256-bit) data key for a tenant. */
  getDataKey(tenantId: string): Buffer | Promise<Buffer>;
}

/**
 * The result of encrypting a single plaintext with {@link TenantEncryptor}.
 *
 * All binary fields are base64-encoded so this shape is trivially
 * JSON-serializable (for storing alongside a database row, in an object
 * store, etc.) without callers needing to know the underlying encoding.
 */
export interface EncryptedPayload {
  /** The encrypted data, base64-encoded. */
  ciphertext: string;
  /** The 12-byte GCM initialization vector used for this encryption, base64-encoded. */
  iv: string;
  /** The 16-byte GCM authentication tag produced by encryption, base64-encoded. */
  authTag: string;
  /**
   * Optional identifier for which key/version produced this payload, to
   * support future key rotation. This module does not implement rotation
   * itself — it just leaves the field available for callers and
   * `KeyProvider` implementations that want to stamp payloads with a key
   * version so a future decrypt path can pick the right key.
   */
  keyId?: string;
}
