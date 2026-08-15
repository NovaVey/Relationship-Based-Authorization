// Mirrors docs/encryption.md's executable code samples (basic usage + AAD).
// The KMS KeyProvider sample is typecheck-only pseudocode — see
// doc-examples/typecheck/encryption.ts. Keep both in sync — see
// doc-examples/README.md for the convention this file is part of.
import assert from 'node:assert/strict';
import { EnvKeyProvider, TenantEncryptor } from '@novavey/multi-tenant-security-kit/crypto';

// "Basic usage"
const keyProvider = new EnvKeyProvider('a-dev-only-master-secret-thats-long-enough');
const encryptor = new TenantEncryptor({ keyProvider });

const payload = await encryptor.encrypt('acme', 'sensitive data');
assert.equal(typeof payload.ciphertext, 'string');
assert.equal(typeof payload.iv, 'string');
assert.equal(typeof payload.authTag, 'string');

const plaintext = await encryptor.decrypt('acme', payload);
assert.equal(Buffer.isBuffer(plaintext), true);
assert.equal(plaintext.toString('utf8'), 'sensitive data');

// "Associated data (AAD)"
const invoice = { id: 'inv_123' };
const invoiceBody = 'invoice body text';
const aad = Buffer.from(invoice.id, 'utf8');
const aadPayload = await encryptor.encrypt('acme', invoiceBody, aad);

const decrypted = await encryptor.decrypt('acme', aadPayload, aad);
assert.equal(decrypted.toString('utf8'), invoiceBody);

// "decrypting requires the exact same aad; anything else throws DecryptionError"
await assert.rejects(() => encryptor.decrypt('acme', aadPayload, Buffer.from('wrong-aad')), /./);

console.log('OK encryption.md: basic usage + AAD examples');
