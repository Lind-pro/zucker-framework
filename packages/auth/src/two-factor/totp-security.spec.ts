import { describe, expect, it } from 'vitest';
import type { VerificationAttemptStore } from '../verification-code';
import { generateTotpCode, generateTotpSecret } from './totp-helpers';
import { TotpValidator } from './totp-validator';

const T0 = Date.parse('2026-11-10T00:00:10Z');

/** Shared lockout store with the same contract as CacheVerificationAttemptStore (counts, locks). */
class MemoryAttemptStore implements VerificationAttemptStore {
  readonly counts = new Map<string, number>();
  readonly locked = new Set<string>();
  constructor(private readonly max: number) {}
  async remainingLock(subject: string) { return this.locked.has(subject) ? 900 : 0; }
  async recordFailure(subject: string) {
    const n = (this.counts.get(subject) ?? 0) + 1;
    if (n < this.max) { this.counts.set(subject, n); return 0; }
    this.counts.delete(subject);
    this.locked.add(subject);
    return 900;
  }
  async clearFailures(subject: string) { this.counts.delete(subject); }
}

describe('TOTP replay and lockout (security)', () => {
  const secret = generateTotpSecret();

  it('a code accepted once is never accepted again, even when raced concurrently', async () => {
    const validator = new TotpValidator({ now: () => T0 });
    const code = generateTotpCode({ secret, time: T0 });
    const results = await Promise.all(Array.from({ length: 8 }, () => validator.verifyOnce('u1', code, secret)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('an older step inside the window cannot be replayed after a newer step was accepted', async () => {
    const validator = new TotpValidator({ now: () => T0 });
    const next = generateTotpCode({ secret, time: T0 + 30_000 });
    const prev = generateTotpCode({ secret, time: T0 - 30_000 });
    expect(await validator.verifyOnce('u1', next, secret)).toBe(true);
    expect(await validator.verifyOnce('u1', prev, secret)).toBe(false);
  });

  it('rejects codes outside the +/-1 step window and malformed input', async () => {
    const validator = new TotpValidator({ now: () => T0 });
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: T0 + 90_000 }), secret)).toBe(false);
    expect(await validator.verifyOnce('u2', generateTotpCode({ secret, time: T0 - 90_000 }), secret)).toBe(false);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 3456', null, undefined, 123456]) {
      expect(await validator.verifyOnce('u3', bad as never, secret)).toBe(false);
    }
    expect(await validator.verifyOnce('', generateTotpCode({ secret, time: T0 }), secret)).toBe(false);
  });

  it('replay and lockout are per user: user B cannot ride on user A state', async () => {
    const validator = new TotpValidator({ now: () => T0, maxAttempts: 2 });
    const code = generateTotpCode({ secret, time: T0 });
    for (let i = 0; i < 2; i++) await validator.verifyOnce('a', '000000', secret);
    expect(await validator.verifyOnce('a', code, secret)).toBe(false); // locked
    expect(await validator.verifyOnce('b', code, secret)).toBe(true); // unaffected
  });

  it('lockout survives after the correct code and releases only after lockMs', async () => {
    let now = T0;
    const validator = new TotpValidator({ now: () => now, maxAttempts: 3, lockMs: 60_000 });
    for (let i = 0; i < 3; i++) await validator.verifyOnce('u1', '000000', secret);
    now += 59_000;
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: now }), secret)).toBe(false);
    now += 2_000;
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: now }), secret)).toBe(true);
  });

  it('a replayed code counts as a failure towards lockout', async () => {
    const validator = new TotpValidator({ now: () => T0, maxAttempts: 3 });
    const code = generateTotpCode({ secret, time: T0 });
    expect(await validator.verifyOnce('u1', code, secret)).toBe(true);
    for (let i = 0; i < 3; i++) expect(await validator.verifyOnce('u1', code, secret)).toBe(false);
    // locked now: a fresh, valid code is refused
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: T0 + 30_000 }), secret)).toBe(false);
  });

  it('a shared attemptStore locks every instance, and verify()/verifyOnce share the key', async () => {
    const store = new MemoryAttemptStore(3);
    const resolver = async () => secret;
    const a = new TotpValidator({ now: () => T0, attemptStore: store, secretResolver: resolver });
    const b = new TotpValidator({ now: () => T0, attemptStore: store, secretResolver: resolver });
    await a.verifyOnce('u1', '000000');
    await a.createTwoFactorValidator('u1', 'op').verify('111111', 1000);
    await a.verifyOnce('u1', '222222');
    expect(store.locked.has('totp:u1')).toBe(true);
    const code = generateTotpCode({ secret, time: T0 });
    expect(await b.verifyOnce('u1', code)).toBe(false);
    expect(await b.createTwoFactorValidator('u1', 'op').verify(code, 1000)).toBe(false);
  });

  it('a successful code clears accumulated failures (no slow-burn lockout)', async () => {
    let now = T0;
    const validator = new TotpValidator({ now: () => now, maxAttempts: 3 });
    for (let round = 0; round < 4; round++) {
      await validator.verifyOnce('u1', '000000', secret);
      await validator.verifyOnce('u1', '000000', secret);
      now += 30_000;
      expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: now }), secret)).toBe(true);
    }
  });

  it('fails closed when the attempt store is unavailable', async () => {
    const broken: VerificationAttemptStore = {
      remainingLock: async () => { throw new Error('unavailable'); },
      recordFailure: async () => { throw new Error('unavailable'); },
      clearFailures: async () => { throw new Error('unavailable'); },
    };
    const validator = new TotpValidator({ now: () => T0, attemptStore: broken });
    await expect(validator.verifyOnce('u1', generateTotpCode({ secret, time: T0 }), secret)).rejects.toThrow();
  });
});

describe('TOTP shared state and shared lockout (3.Z)', () => {
  const secret = generateTotpSecret();

  it('uses an atomic advanceCounter when the state store offers one (cross-instance replay)', async () => {
    const values = new Map<string, unknown>();
    const store = {
      get: async (k: string) => values.get(k),
      set: async (k: string, v: unknown) => { values.set(k, v); },
      advanceCounter: async (k: string, c: number) => {
        const last = values.get(k);
        if (typeof last === 'number' && c <= last) return false;
        values.set(k, c); return true;
      },
    };
    const a = new TotpValidator({ now: () => T0, stateStore: store });
    const b = new TotpValidator({ now: () => T0, stateStore: store });
    const code = generateTotpCode({ secret, time: T0 });
    const results = await Promise.all([a.verifyOnce('u1', code, secret), b.verifyOnce('u1', code, secret)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('concurrent wrong guesses cannot exceed maxAttempts before the lock applies', async () => {
    const validator = new TotpValidator({ now: () => T0, maxAttempts: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => validator.verifyOnce('u1', '000000', secret)));
    expect(results.every(r => r === false)).toBe(true);
    expect(await validator.isLockedOut('u1')).toBe(true);
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: T0 }), secret)).toBe(false);
  });

  it('recordFailedAttempt (e.g. wrong recovery codes) counts toward the TOTP lockout', async () => {
    const validator = new TotpValidator({ now: () => T0, maxAttempts: 3 });
    for (let i = 0; i < 3; i++) await validator.recordFailedAttempt('u1');
    expect(await validator.isLockedOut('u1')).toBe(true);
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: T0 }), secret)).toBe(false);
    expect(await validator.isLockedOut('u2')).toBe(false);
  });
});
