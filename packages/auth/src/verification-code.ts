import { randomInt } from 'node:crypto';
import type { ModelOperations } from '@zucker-framework/core';
import type { IdentityTransactions } from './identity-transactions';

export class VerificationCodeError extends Error {
  constructor(readonly reason: 'invalid' | 'locked' | 'unavailable', readonly waitSeconds = 0) {
    super(`Verification code ${reason}`);
    this.name = 'VerificationCodeError';
  }
}

export interface VerificationAttemptStore {
  remainingLock(subject: string): Promise<number>;
  recordFailure(subject: string): Promise<number>;
  clearFailures(subject: string): Promise<void>;
}

/** Security operations cannot use a cache's silent fallback values. Every command fails closed. */
export class CacheVerificationAttemptStore implements VerificationAttemptStore {
  constructor(private readonly cache: {
    isAvailable(): boolean;
    ttl(key: string): Promise<number>;
    incr(key: string, ttlSeconds: number): Promise<number>;
    set(key: string, value: boolean, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
  }, private readonly options: {
    attemptPrefix: string;
    lockPrefix: string;
    maxAttempts: number;
    lockSeconds: number;
  }) {}

  private async required<T>(work: () => Promise<T>): Promise<T> {
    if (!this.cache.isAvailable()) throw new VerificationCodeError('unavailable');
    try {
      const result = await work();
      if (!this.cache.isAvailable()) throw new VerificationCodeError('unavailable');
      return result;
    } catch {
      throw new VerificationCodeError('unavailable');
    }
  }
  async remainingLock(subject: string): Promise<number> {
    const ttl = await this.required(() => this.cache.ttl(`${this.options.lockPrefix}${subject}`));
    return ttl === -1 ? this.options.lockSeconds : Math.max(0, ttl);
  }
  async recordFailure(subject: string): Promise<number> {
    const count = await this.required(() => this.cache.incr(
      `${this.options.attemptPrefix}${subject}`, this.options.lockSeconds,
    ));
    if (count < 1) throw new VerificationCodeError('unavailable');
    if (count < this.options.maxAttempts) return 0;
    await this.required(() => this.cache.set(
      `${this.options.lockPrefix}${subject}`, true, this.options.lockSeconds,
    ));
    await this.clearFailures(subject);
    return this.options.lockSeconds;
  }
  async clearFailures(subject: string): Promise<void> {
    await this.required(() => this.cache.delete(`${this.options.attemptPrefix}${subject}`));
  }
}

export interface VerificationCodeRecord {
  id: string;
  code: string;
  used: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export interface VerificationCodeStore<Tx> {
  transactions: IdentityTransactions<Tx>;
  latest(tx: Tx, subject: string, purpose: string): Promise<VerificationCodeRecord | null>;
  replace(tx: Tx, subject: string, purpose: string, code: string, expiresAt: Date): Promise<void>;
  claim(tx: Tx, subject: string, purpose: string, code: string, now: Date): Promise<boolean>;
}

/** Existing schemas retain their column names; all writes stay on the supplied transaction. */
export class DatabaseVerificationCodeStore<Tx> implements VerificationCodeStore<Tx> {
  readonly transactions: IdentityTransactions<Tx>;
  constructor(private readonly options: {
    transactions: IdentityTransactions<Tx>;
    model: (tx: Tx) => ModelOperations<VerificationCodeRecord>;
    subjectField: string;
    purposeField: string;
  }) { this.transactions = options.transactions; }
  private scope(subject: string, purpose: string) {
    return { [this.options.subjectField]: subject, [this.options.purposeField]: purpose };
  }
  async latest(tx: Tx, subject: string, purpose: string) {
    const rows = await this.options.model(tx).findMany({
      where: this.scope(subject, purpose), orderBy: { createdAt: 'desc' }, take: 1,
    });
    return rows[0] ?? null;
  }
  async replace(tx: Tx, subject: string, purpose: string, code: string, expiresAt: Date) {
    const model = this.options.model(tx);
    const scope = this.scope(subject, purpose);
    await model.updateMany({ where: { ...scope, used: false }, data: { used: true } });
    await model.create({ data: { ...scope, code, expiresAt } });
  }
  async claim(tx: Tx, subject: string, purpose: string, code: string, now: Date) {
    const model = this.options.model(tx);
    const where = { ...this.scope(subject, purpose), code, used: false, expiresAt: { gte: now } };
    const rows = await model.findMany({ where: this.scope(subject, purpose), orderBy: { createdAt: 'desc' }, take: 1 });
    if (!rows[0] || rows[0].code !== code || rows[0].used || rows[0].expiresAt < now) return false;
    const claimed = await model.updateMany({
      where: { ...where, id: rows[0].id }, data: { used: true },
    });
    return claimed.count === 1;
  }
}

export class VerificationCodeService<Tx> {
  constructor(private readonly store: VerificationCodeStore<Tx>,
    private readonly attempts: VerificationAttemptStore,
    private readonly options: { expirySeconds: number; resendSeconds: number; now?: () => Date },
  ) {}

  issue(subject: string, purpose: string): Promise<
    { issued: true; code: string } | { issued: false; waitSeconds: number }
  > {
    return this.store.transactions.run(subject, async (tx) => {
      const now = this.options.now?.() ?? new Date();
      const latest = await this.store.latest(tx, subject, purpose);
      const remaining = latest
        ? this.options.resendSeconds - (now.getTime() - latest.createdAt.getTime()) / 1000 : 0;
      if (remaining > 0) return { issued: false as const, waitSeconds: Math.ceil(remaining) };
      const code = randomInt(100000, 1000000).toString();
      await this.store.replace(tx, subject, purpose, code,
        new Date(now.getTime() + this.options.expirySeconds * 1000));
      return { issued: true as const, code };
    });
  }

  /** The consumed flag and local account mutation commit/rollback together. Never pass external effects. */
  consume<T>(subject: string, purpose: string, code: string, apply: (tx: Tx) => Promise<T>): Promise<T> {
    return this.store.transactions.run(subject, async (tx) => {
      const locked = await this.attempts.remainingLock(subject);
      if (locked > 0) throw new VerificationCodeError('locked', locked);
      const now = this.options.now?.() ?? new Date();
      if (!await this.store.claim(tx, subject, purpose, code, now)) {
        const wait = await this.attempts.recordFailure(subject);
        throw new VerificationCodeError(wait ? 'locked' : 'invalid', wait);
      }
      await this.attempts.clearFailures(subject);
      return apply(tx);
    });
  }
}
