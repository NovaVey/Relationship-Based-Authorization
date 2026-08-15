export type { EncryptedPayload, KeyProvider } from './types.js';
export { EnvKeyProvider, StaticKeyProvider, TenantEncryptor } from './tenant-keys.js';
export type { TenantEncryptorOptions } from './tenant-keys.js';

// Re-exported so consumers importing only this subpath can catch/narrow on
// the error types this module's own functions throw, without also
// importing from the package root.
export {
  SecurityKitError,
  DecryptionError,
  EncryptionError,
  InvalidKeyError,
  InvalidTenantIdError,
} from '../errors.js';
