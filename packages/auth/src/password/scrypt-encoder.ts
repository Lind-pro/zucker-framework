import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordEncoder } from './password-encoder.interface';

/** Async scrypt encoder. Wire format: 16-byte hex salt : 64-byte hex derived key.
 * The hex salt text is the KDF salt, preserving existing values in this format. */
export class ScryptEncoder implements PasswordEncoder {
  async encode(raw: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${(await this.derive(raw, salt)).toString('hex')}`;
  }
  async matches(raw: string, encoded: string): Promise<boolean> {
    if (typeof encoded !== 'string') return false;
    const parts = encoded.split(':');
    if (
      parts.length !== 2 ||
      !/^[0-9a-f]{32}$/i.test(parts[0]) ||
      !/^[0-9a-f]{128}$/i.test(parts[1])
    )
      return false;
    const actual = await this.derive(raw, parts[0]);
    const expected = Buffer.from(parts[1], 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  private derive(raw: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(raw, salt, 64, (error, derived) => (error ? reject(error) : resolve(derived)));
    });
  }
}
