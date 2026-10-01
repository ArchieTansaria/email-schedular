import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

export class SecretCipher {
  readonly #key: Buffer;

  constructor(encryptionKey: string) {
    if (encryptionKey.length < 32)
      throw new Error('APP_ENCRYPTION_KEY must contain at least 32 characters');
    this.#key = createHash('sha256').update(encryptionKey, 'utf8').digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split('.');
    if (version !== VERSION || !encodedIv || !encodedTag || !encodedCiphertext || extra) {
      throw new Error('Encrypted secret has an unsupported format');
    }
    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
