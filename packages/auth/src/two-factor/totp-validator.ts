import { createHmac, randomBytes } from 'node:crypto';
import type { TwoFactorValidator, TwoFactorValidatorProvider } from './two-factor.interface';
import type { VerificationAttemptStore } from '../verification-code';

/**
 * TOTP (Time-based One-Time Password) validator.
 * Compatible with Google Authenticator (RFC 6238).
 *
 * Implements HMAC-based OTP without external dependencies.
 */
export class TotpValidator implements TwoFactorValidatorProvider {
  private readonly period: number;
  private readonly digits: number;
  private readonly window: number;
  private readonly validatedUntil = new Map<string, number>();
  /** Last accepted time-step per user: a code (or an older one) cannot be replayed. */
  private readonly lastCounter = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number; resetAt: number }>();
  private readonly maxAttempts: number;
  private readonly lockMs: number;
  private readonly attemptStore?: VerificationAttemptStore;
  private secretResolver: (userId: string) => Promise<string | null>;

  constructor(options?: {
    period?: number;
    digits?: number;
    window?: number;
    secretResolver?: (userId: string) => Promise<string | null>;
    /** Failed codes allowed before the user is locked out. Default 5. */
    maxAttempts?: number;
    /** Lockout duration (ms) for the in-process attempt counter. Default 15 minutes. */
    lockMs?: number;
    /** Shared attempt store (e.g. CacheVerificationAttemptStore) for multi-instance deployments. */
    attemptStore?: VerificationAttemptStore;
  }) {
    this.period = options?.period ?? 30;
    this.digits = options?.digits ?? 6;
    this.window = options?.window ?? 1;
    this.secretResolver = options?.secretResolver ?? (() => Promise.resolve(null));
    this.maxAttempts = options?.maxAttempts ?? 5;
    this.lockMs = options?.lockMs ?? 15 * 60 * 1000;
    this.attemptStore = options?.attemptStore;
  }

  getProvider(): string {
    return 'totp';
  }

  createTwoFactorValidator(userId: string, operation: string, sessionId?: string): TwoFactorValidator {
    const cacheKey = this.buildCacheKey(userId, operation, sessionId);
    return {
      getProvider: () => this.getProvider(),
      verify: async (code: string, timeout: number) => {
        if (await this.isLocked(userId)) return false;
        const secret = await this.secretResolver(userId);
        if (!secret) return false;
        const counter = this.matchCounter(code, secret);
        if (counter === null || counter <= (this.lastCounter.get(userId) ?? -1)) {
          await this.recordFailure(userId);
          return false;
        }
        this.lastCounter.set(userId, counter);
        await this.clearFailures(userId);
        this.pruneValidations();
        this.validatedUntil.set(cacheKey, Date.now() + timeout);
        return true;
      },
      expired: () => {
        const expiresAt = this.validatedUntil.get(cacheKey) ?? 0;
        return expiresAt <= Date.now();
      },
    };
  }

  setSecretResolver(resolver: (userId: string) => Promise<string | null>): void {
    this.secretResolver = resolver;
  }

  /**
   * Generate a random base32-encoded secret.
   */
  generateSecret(): string {
    const buffer = randomBytes(20);
    return base32Encode(buffer);
  }

  /**
   * Generate a QR code URL (otpauth:// URI) for authenticator apps.
   */
  generateQRCodeUrl(secret: string, issuer: string, account: string): string {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedAccount = encodeURIComponent(account);
    return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${this.digits}&period=${this.period}`;
  }

  /**
   * Verify a TOTP token against a secret.
   * Accepts tokens within the configured time window.
   */
  private matchCounter(token: string, secret: string): number | null {
    const counter = Math.floor(Date.now() / 1000 / this.period);

    for (let i = -this.window; i <= this.window; i++) {
      const expected = this.generateToken(secret, counter + i);
      if (timingSafeEqual(token, expected)) {
        return counter + i;
      }
    }
    return null;
  }

  private async isLocked(userId: string): Promise<boolean> {
    if (this.attemptStore) return (await this.attemptStore.remainingLock(`totp:${userId}`)) > 0;
    const entry = this.failures.get(userId);
    return !!entry && entry.lockedUntil > Date.now();
  }

  private async recordFailure(userId: string): Promise<void> {
    if (this.attemptStore) {
      await this.attemptStore.recordFailure(`totp:${userId}`);
      return;
    }
    const now = Date.now();
    const entry = this.failures.get(userId);
    const current = entry && entry.resetAt > now ? entry : { count: 0, lockedUntil: 0, resetAt: now + this.lockMs };
    current.count += 1;
    if (current.count >= this.maxAttempts) {
      current.lockedUntil = now + this.lockMs;
      current.count = 0;
      current.resetAt = current.lockedUntil;
    }
    this.failures.set(userId, current);
  }

  private async clearFailures(userId: string): Promise<void> {
    if (this.attemptStore) await this.attemptStore.clearFailures(`totp:${userId}`);
    else this.failures.delete(userId);
  }

  private pruneValidations(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.validatedUntil) {
      if (expiresAt <= now) this.validatedUntil.delete(key);
    }
  }

  private generateToken(secret: string, counter: number): string {
    const secretBuffer = base32Decode(secret);

    // Convert counter to 8-byte big-endian buffer
    const counterBuffer = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) {
      counterBuffer[i] = counter & 0xff;
      counter = Math.floor(counter / 256);
    }

    const hmac = createHmac('sha1', secretBuffer);
    hmac.update(counterBuffer);
    const hash = hmac.digest();

    // Dynamic truncation (RFC 4226)
    const offset = hash[hash.length - 1] & 0x0f;
    const code =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    const otp = code % Math.pow(10, this.digits);
    return otp.toString().padStart(this.digits, '0');
  }

  private buildCacheKey(userId: string, operation: string, sessionId?: string): string {
    return JSON.stringify([userId, operation, sessionId ?? null]);
  }
}

// ---- Base32 encode/decode ----

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += BASE32_CHARS[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
