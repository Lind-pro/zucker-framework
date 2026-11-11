import type { TwoFactorValidator, TwoFactorValidatorProvider } from './two-factor.interface';
import type { VerificationAttemptStore } from '../verification-code';
import { generateTotpSecret, hotpCode } from './totp-helpers';

/**
 * Shared key/value store for two-factor state (an `ICache` from @zucker-framework/cache fits;
 * `ttlMs` is milliseconds). With it, the replay guard (last accepted time step) and successful
 * validations are visible to every instance.
 *
 * Replay guard atomicity: inside one process the validator serialises checks per user, so a
 * code is accepted at most once there. Across replicas, implement `advanceCounter` as an atomic
 * compare-and-set (Redis Lua/WATCH, SQL `UPDATE … WHERE last < $step`); without it the guard
 * falls back to read-then-write and two replicas receiving the same code at the same instant
 * may both accept it.
 */
export interface TwoFactorStateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /**
   * Atomically stores `counter` under `key` only when no value is stored or the stored number is
   * lower, and returns whether it did. Optional; see the interface comment.
   */
  advanceCounter?(key: string, counter: number, ttlMs: number): Promise<boolean>;
}

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
  /** Tail of the per-user check queue: lockout read, verification and counter write run one at a time per user. */
  private readonly userQueues = new Map<string, Promise<unknown>>();
  private readonly maxAttempts: number;
  private readonly lockMs: number;
  private readonly attemptStore?: VerificationAttemptStore;
  private readonly stateStore?: TwoFactorStateStore;
  private secretResolver: (userId: string) => Promise<string | null>;
  private readonly now: () => number;

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
    /**
     * Shared store for validations and the replay guard (multi-instance deployments). Without
     * it both are per-process: a code can be replayed on another replica within its window and
     * a validation on one replica is unknown to the others.
     */
    stateStore?: TwoFactorStateStore;
    /** Clock (ms) for TOTP steps, lockout and validation expiry. Default `Date.now` (tests inject one). */
    now?: () => number;
  }) {
    this.period = options?.period ?? 30;
    this.digits = options?.digits ?? 6;
    this.window = options?.window ?? 1;
    this.secretResolver = options?.secretResolver ?? (() => Promise.resolve(null));
    this.maxAttempts = options?.maxAttempts ?? 5;
    this.lockMs = options?.lockMs ?? 15 * 60 * 1000;
    this.attemptStore = options?.attemptStore;
    this.stateStore = options?.stateStore;
    this.now = options?.now ?? (() => Date.now());
  }

  getProvider(): string {
    return 'totp';
  }

  createTwoFactorValidator(userId: string, operation: string, sessionId?: string): TwoFactorValidator {
    const cacheKey = this.buildCacheKey(userId, operation, sessionId);
    return {
      getProvider: () => this.getProvider(),
      verify: async (code: string, timeout: number) => {
        if (!(await this.verifyOnce(userId, code))) return false;
        await this.setValidatedUntil(cacheKey, this.now() + timeout, timeout);
        return true;
      },
      expired: async () => (await this.getValidatedUntil(cacheKey)) <= this.now(),
    };
  }

  /**
   * Check one code for `userId` with the replay guard and lockout, without recording an
   * operation validation. Used for enrolment confirmation and login step-up.
   *
   * `secret` overrides the resolver, e.g. for a pending (not yet active) enrolment; the replay
   * guard and lockout still key on `userId`. Returns false when locked, when no secret is
   * known, for a malformed or wrong code, and for a code at or before the last accepted step.
   */
  async verifyOnce(userId: string, code: string, secret?: string): Promise<boolean> {
    if (typeof userId !== 'string' || userId.length === 0) return false;
    // Serialised per user: concurrent copies of one code cannot all pass the replay guard, and
    // concurrent wrong guesses cannot all pass the lockout check before their failures count.
    return this.exclusive(userId, async () => {
      if (await this.isLocked(userId)) return false;
      const resolved = secret ?? (await this.secretResolver(userId));
      if (!resolved) return false;
      const counter = typeof code === 'string' ? this.matchCounter(code.trim(), resolved) : null;
      if (counter === null || !(await this.advanceLastCounter(userId, counter))) {
        await this.recordFailure(userId);
        return false;
      }
      await this.clearFailures(userId);
      return true;
    });
  }

  /**
   * Lockout state shared with `verifyOnce` (key `totp:<userId>`), for other second factors such as
   * recovery codes: callers check `isLockedOut` first and report each wrong attempt with
   * `recordFailedAttempt`, so guesses of every factor count toward the same lockout.
   */
  async isLockedOut(userId: string): Promise<boolean> {
    if (typeof userId !== 'string' || userId.length === 0) return true;
    return this.exclusive(userId, () => this.isLocked(userId));
  }

  async recordFailedAttempt(userId: string): Promise<void> {
    if (typeof userId !== 'string' || userId.length === 0) return;
    await this.exclusive(userId, () => this.recordFailure(userId));
  }

  /**
   * Runs `work` after every earlier queued check of `userId` settled (success or failure). The queue
   * entry is removed when it is the tail, so idle users hold no memory.
   */
  private exclusive<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.userQueues.get(userId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(() => undefined, () => undefined);
    this.userQueues.set(userId, tail);
    void tail.then(() => { if (this.userQueues.get(userId) === tail) this.userQueues.delete(userId); });
    return run;
  }

  setSecretResolver(resolver: (userId: string) => Promise<string | null>): void {
    this.secretResolver = resolver;
  }

  /**
   * Generate a random base32-encoded secret.
   */
  generateSecret(): string {
    return generateTotpSecret();
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
    if (!/^\d+$/.test(token) || token.length !== this.digits) return null;
    const counter = Math.floor(this.now() / 1000 / this.period);

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
    return !!entry && entry.lockedUntil > this.now();
  }

  private async recordFailure(userId: string): Promise<void> {
    if (this.attemptStore) {
      await this.attemptStore.recordFailure(`totp:${userId}`);
      return;
    }
    const now = this.now();
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

  /** Accepts `counter` once: true only when it is newer than the last accepted step (compare-and-set). */
  private async advanceLastCounter(userId: string, counter: number): Promise<boolean> {
    if (this.stateStore) {
      const key = `totp:counter:${userId}`;
      // Only steps inside the acceptance window can be replayed; keep the guard that long.
      const ttlMs = (this.window * 2 + 2) * this.period * 1000;
      if (typeof this.stateStore.advanceCounter === 'function') return this.stateStore.advanceCounter(key, counter, ttlMs);
      const stored = await this.stateStore.get(key);
      if (typeof stored === 'number' && counter <= stored) return false;
      await this.stateStore.set(key, counter, ttlMs);
      return true;
    }
    const last = this.lastCounter.get(userId) ?? -1;
    if (counter <= last) return false;
    this.lastCounter.set(userId, counter);
    return true;
  }

  private async setValidatedUntil(cacheKey: string, expiresAt: number, timeout: number): Promise<void> {
    if (this.stateStore) {
      if (timeout > 0) await this.stateStore.set(`totp:validated:${cacheKey}`, expiresAt, timeout);
      return;
    }
    this.pruneValidations();
    this.validatedUntil.set(cacheKey, expiresAt);
  }

  private async getValidatedUntil(cacheKey: string): Promise<number> {
    if (this.stateStore) {
      const value = await this.stateStore.get(`totp:validated:${cacheKey}`);
      return typeof value === 'number' ? value : 0;
    }
    return this.validatedUntil.get(cacheKey) ?? 0;
  }

  private pruneValidations(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.validatedUntil) {
      if (expiresAt <= now) this.validatedUntil.delete(key);
    }
  }

  private generateToken(secret: string, counter: number): string {
    return hotpCode(secret, counter, this.digits);
  }

  private buildCacheKey(userId: string, operation: string, sessionId?: string): string {
    return JSON.stringify([userId, operation, sessionId ?? null]);
  }
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
