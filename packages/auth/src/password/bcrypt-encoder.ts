import { randomBytes, timingSafeEqual, pbkdf2 as cryptoPbkdf2 } from 'node:crypto';
import type { PasswordEncoder } from './password-encoder.interface';

/**
 * Bcrypt-compatible password encoder using Node.js built-in crypto.
 *
 * Uses PBKDF2 with SHA-512 as a secure alternative that requires no
 * external dependencies (bcryptjs). The output format includes the salt
 * and iteration count for self-contained verification.
 */
export class BcryptEncoder implements PasswordEncoder {
  private readonly iterations: number;
  private readonly keyLength: number;
  private readonly saltLength: number;

  constructor(options?: {
    iterations?: number;
    keyLength?: number;
    saltLength?: number;
  }) {
    this.iterations = options?.iterations ?? 100000;
    this.keyLength = options?.keyLength ?? 64;
    this.saltLength = options?.saltLength ?? 32;
  }

  async encode(raw: string): Promise<string> {
    const salt = randomBytes(this.saltLength);
    const hash = await this.pbkdf2(raw, salt);
    // Format: iterations:salt:hash (all base64)
    return `${this.iterations}:${salt.toString('base64')}:${hash.toString('base64')}`;
  }

  async matches(raw: string, encoded: string): Promise<boolean> {
    try {
      const parts = encoded.split(':');
      if (parts.length !== 3) return false;

      const iterations = parseInt(parts[0], 10);
      if (isNaN(iterations) || iterations <= 0) return false;

      const salt = Buffer.from(parts[1], 'base64');
      const storedHash = Buffer.from(parts[2], 'base64');

      const hash = await this.pbkdf2(raw, salt, iterations);

      if (hash.length !== storedHash.length) return false;
      return timingSafeEqual(hash, storedHash);
    } catch {
      return false;
    }
  }

  private pbkdf2(
    password: string,
    salt: Buffer,
    iterations?: number,
  ): Promise<Buffer> {
    const iters = iterations ?? this.iterations;
    return new Promise((resolve, reject) => {
      cryptoPbkdf2(password, salt, iters, this.keyLength, 'sha512', (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }
}
