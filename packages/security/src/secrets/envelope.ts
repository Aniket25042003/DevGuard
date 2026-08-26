/**
 * C093 — Envelope encryption for the minimum unavoidable persisted material.
 *
 * - AES-256-GCM with versioned master keys (fake-KMS interface for tests;
 *   real KMS/secret-manager adapters land with deployment wiring, C100).
 * - Associated data binds ciphertext to {scopeType, scopeId, purpose,
 *   version} so records cannot be replayed across tenants/purposes.
 * - Plaintext and raw key material are forbidden in outputs; only
 *   {ciphertextB64, ivB64, authTagB64, keyVersion, aadDigest} leave here.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export interface MasterKeyProvider {
  /** Returns the raw 32-byte key for a version. Test doubles may synthesize. */
  getKey(version: string): Promise<Buffer>;
}

export function staticKeyProvider(keys: Readonly<Record<string, string>>): MasterKeyProvider {
  return {
    async getKey(version) {
      const secret = keys[version];
      if (secret === undefined) throw new Error(`unknown_key_version:${version}`);
      return createHash('sha256').update(`devguard.master.v1:${version}:${secret}`).digest();
    },
  };
}

export interface AssociatedData {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly purpose: string;
  readonly refVersion: string;
}

export interface EncryptedSecretRecord {
  readonly ciphertextB64: string;
  readonly ivB64: string;
  readonly authTagB64: string;
  readonly keyVersion: string;
  /** SHA-256 over the canonical associated data — evidence without secrets. */
  readonly aadDigest: string;
}

function canonicalAad(data: AssociatedData): Buffer {
  // Length-prefixed encoding prevents delimiter injection between fields.
  // NOTE: changing this encoding invalidates all persisted EncryptedSecretRecords.
  // Safe to change before MVP because no records exist; add format discriminator
  // when persistence begins.
  const fields = [data.scopeType, data.scopeId, data.purpose, data.refVersion];
  const parts = fields.map((field) => {
    const bytes = Buffer.from(field, 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.byteLength);
    return Buffer.concat([prefix, bytes]);
  });
  return Buffer.concat(parts);
}

export function aadDigest(data: AssociatedData): string {
  return createHash('sha256').update(canonicalAad(data)).digest('hex');
}

export class EnvelopeEncryptor {
  constructor(
    private readonly keys: MasterKeyProvider,
    private readonly activeKeyVersion: string,
  ) {}

  async encrypt(plaintext: string, associatedData: AssociatedData): Promise<EncryptedSecretRecord> {
    const key = await this.keys.getKey(this.activeKeyVersion);
    if (key.length !== 32) throw new Error('master_key_must_be_32_bytes');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(canonicalAad(associatedData));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    return {
      ciphertextB64: ciphertext.toString('base64'),
      ivB64: iv.toString('base64'),
      authTagB64: cipher.getAuthTag().toString('base64'),
      keyVersion: this.activeKeyVersion,
      aadDigest: aadDigest(associatedData),
    };
  }

  async decrypt(record: EncryptedSecretRecord, associatedData: AssociatedData): Promise<string> {
    // Associated-data mismatch must fail BEFORE any plaintext is produced.
    if (!timingSafeEqual(Buffer.from(aadDigest(associatedData)), Buffer.from(record.aadDigest))) {
      throw new Error('aad_mismatch');
    }
    const key = await this.keys.getKey(record.keyVersion);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.ivB64, 'base64'));
    decipher.setAAD(canonicalAad(associatedData));
    decipher.setAuthTag(Buffer.from(record.authTagB64, 'base64'));
    try {
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertextB64, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (error) {
      // AEAD failure: surface unavailable, never partial plaintext.
      throw new Error('decryption_failed', { cause: error });
    }
  }
}
