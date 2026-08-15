// Mirrors docs/encryption.md's KMS KeyProvider sample — the basic-usage and
// AAD samples are executable and live in doc-examples/run/encryption.mjs
// instead. Keep both in sync — see doc-examples/README.md for the
// convention this file is part of.
import { TenantEncryptor } from '@novavey/multi-tenant-security-kit/crypto';
import type { KeyProvider } from '@novavey/multi-tenant-security-kit/crypto';

declare const kmsClient: { decrypt(wrapped: Buffer): Promise<Buffer> };
declare const tenantKeyStore: { getWrappedKey(tenantId: string): Promise<Buffer> };

class KmsKeyProvider implements KeyProvider {
  async getDataKey(tenantId: string): Promise<Buffer> {
    return kmsClient.decrypt(await tenantKeyStore.getWrappedKey(tenantId));
  }
}

const encryptor = new TenantEncryptor({ keyProvider: new KmsKeyProvider() });
void encryptor;
