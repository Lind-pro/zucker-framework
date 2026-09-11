import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export interface SecretCipherOptions {
  /** Explicit host key material. A getter supports lazy configuration and host-owned rotation. */
  masterKey: string | (() => string);
  /** Read-only compatibility for historical CBC values; absent by default. New writes always use GCM. */
  legacyCbc?: { salt: string };
}
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function isSecureCiphertext(value: string): boolean {
  if (typeof value !== 'string' || !value) return false;
  const parts = value.split('.');
  return parts.length === 5 && parts[0] === 'v2';
}
export function isLegacyCiphertext(value: string): boolean {
  if (typeof value !== 'string' || !value || isSecureCiphertext(value)) return false;
  const [iv, ciphertext, ...rest] = value.split(':');
  return (
    rest.length === 0 &&
    !!iv &&
    !!ciphertext &&
    /^[0-9a-f]+$/i.test(iv) &&
    /^[0-9a-f]+$/i.test(ciphertext)
  );
}

/** AES-256-GCM with per-value random salt/IV and scrypt key derivation. No environment or product defaults. */
export class SecretCipher {
  constructor(private readonly options: SecretCipherOptions) {}
  private masterKey(): string {
    const key =
      typeof this.options.masterKey === 'function'
        ? this.options.masterKey()
        : this.options.masterKey;
    if (typeof key !== 'string' || !key) throw new Error('Secret encryption key is required');
    return key;
  }
  encrypt(plaintext: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = scryptSync(this.masterKey(), salt, KEY_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v2',
      salt.toString('base64'),
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }
  decrypt(value: string): string {
    if (isSecureCiphertext(value)) return this.decryptSecure(value);
    if (isLegacyCiphertext(value) && this.options.legacyCbc)
      return this.decryptLegacy(value, this.options.legacyCbc.salt);
    throw new Error('[Security] 加密字段格式无效或未启用旧格式读取');
  }
  private decryptSecure(value: string): string {
    const [, saltText, ivText, tagText, ciphertextText] = value.split('.');
    const salt = Buffer.from(saltText, 'base64');
    const iv = Buffer.from(ivText, 'base64');
    const tag = Buffer.from(tagText, 'base64');
    const ciphertext = Buffer.from(ciphertextText, 'base64');
    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH)
      throw new Error('密文参数长度无效');
    const key = scryptSync(this.masterKey(), salt, KEY_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  private decryptLegacy(value: string, salt: string): string {
    const [ivHex, ciphertextHex] = value.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    if (
      ivHex.length !== 32 ||
      !ciphertext.length ||
      ciphertext.length % 16 !== 0 ||
      ciphertextHex.length % 2 !== 0
    )
      throw new Error('旧格式密文参数无效');
    const key = scryptSync(this.masterKey(), salt, KEY_LENGTH);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
