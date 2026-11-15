import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/** Derive purpose-specific keys from the master key so one secret serves every use. */
export function deriveKey(masterKey: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, new Uint8Array(0), `kamen/${purpose}/v1`, 32));
}

/**
 * AES-256-GCM with the keyset id as associated data, so an encrypted key cannot be moved to
 * another keyset row. Format: "v1:" + base64(iv(12) || tag(16) || ciphertext).
 */
export class KeyVault {
  readonly #key: Buffer;

  constructor(masterKey: Uint8Array, purpose = 'keyset-enc') {
    this.#key = deriveKey(masterKey, purpose);
  }

  encrypt(plaintextHex: string, keysetId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(keysetId, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintextHex, 'utf8'), cipher.final()]);
    return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(sealed: string, keysetId: string): string {
    if (!sealed.startsWith('v1:')) throw new Error('unknown key encryption version');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(keysetId, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Random lower-case base32 id. 12 chars = 60 bits. */
export function randomId(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += B32[b & 31];
  return out;
}

/** 256-bit bearer token, base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
