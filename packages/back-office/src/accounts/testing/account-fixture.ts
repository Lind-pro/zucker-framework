/**
 * TEST-ONLY harness for the account host specs: an in-memory adapter that records the models it was asked
 * for, a recording mailer, a controllable clock and an attempt store with the lockout semantics of
 * `CacheVerificationAttemptStore`. Not exported from the package.
 */
import { JwtService } from '@nestjs/jwt';
import { ScryptEncoder, type PasswordEncoder, type UserEntity, type VerificationAttemptStore } from '@zucker-framework/auth';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { AccountGuard } from '../account.guard';
import { AccountService } from '../account.service';
import { AccountSessionCookie } from '../account-session-cookie';
import { resolveAccountsOptions, type BackOfficeAccountsOptions } from '../accounts.options';
import type { AccountMailer, AccountMailDelivery, AccountMailPurpose, AccountPolicy, AccountPolicySource } from '../accounts.ports';
import { DEFAULT_ACCOUNT_POLICY } from '../accounts.ports';
import { AccountTwoFactorService } from '../two-factor/two-factor.service';

export const JWT_SECRET = 'synthetic-jwt-secret-for-account-specs-0123456789';
export const TWO_FACTOR_KEY = 'synthetic-two-factor-key-0123456789abcdef-xyz';
export const PASSWORD = 'Str0ng!Passw0rd#1';

export interface SentMail { email: string; purpose: string; secret: string; locale: string; userId?: string; delivery?: AccountMailDelivery; kind: 'send' | 'code' }

export class RecordingMailer implements AccountMailer {
  readonly sent: SentMail[] = [];
  configured = true;
  assertConfigured(): void { if (!this.configured) throw new Error('mail not configured'); }
  async send(email: string, purpose: AccountMailPurpose, secret: string, locale: string, userId?: string, delivery?: AccountMailDelivery) {
    this.sent.push({ email, purpose, secret, locale, userId, delivery, kind: 'send' });
  }
  last(purpose?: string): SentMail | undefined { return [...this.sent].reverse().find(mail => !purpose || mail.purpose === purpose); }
}
/** Same as the recording mailer, with the dedicated six-digit code method of the F5 mailer shape. */
export class CodeMailer extends RecordingMailer {
  async code(email: string, purpose: AccountMailPurpose | 'login', code: string, locale: string, userId?: string) {
    this.sent.push({ email, purpose, secret: code, locale, userId, kind: 'code' });
  }
}

/** Lockout after `maxAttempts` failures for `lockSeconds`, evaluated against the test clock. */
export class MemoryAttemptStore implements VerificationAttemptStore {
  private readonly failures = new Map<string, number>();
  private readonly locks = new Map<string, number>();
  constructor(private readonly now: () => Date, private readonly options = { maxAttempts: 3, lockSeconds: 600 }) {}
  async remainingLock(subject: string) {
    const until = this.locks.get(subject);
    return until && until > this.now().getTime() ? Math.ceil((until - this.now().getTime()) / 1000) : 0;
  }
  async recordFailure(subject: string) {
    const count = (this.failures.get(subject) ?? 0) + 1;
    if (count < this.options.maxAttempts) { this.failures.set(subject, count); return 0; }
    this.failures.delete(subject);
    this.locks.set(subject, this.now().getTime() + this.options.lockSeconds * 1000);
    return this.options.lockSeconds;
  }
  async clearFailures(subject: string) { this.failures.delete(subject); }
}

/** In-memory adapter that records every `model(name)` request, nested transactions included. */
export class SpyAdapter extends InMemoryAdapter {
  readonly touched = new Set<string>();
  /** Test clock for column defaults such as `createdAt` (set by `createFixture`). */
  now: () => Date = () => new Date();
  /** Model names that hold users: rows get the column defaults a real schema provides. */
  constructor(private readonly userModels: readonly string[] = ['users']) { super(); }
  // Rows are plain records in specs: `any` keeps assertions on them readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override model(name: string): ModelOperations<any> {
    this.touched.add(name);
    const ops = super.model(name);
    const defaults = (data: Record<string, unknown>) => ({
      createdAt: this.now(),
      ...(this.userModels.includes(name) ? { credentialVersion: 0, emailVerified: false } : {}),
      ...('code' in data ? { used: false } : {}),
      ...('tokenHash' in data ? { consumedAt: null } : {}),
      ...('secretCiphertext' in data ? { lastUsedStep: null } : {}),
      ...data,
    });
    const increments = (data: Record<string, unknown>) => Object.values(data).some(value => !!value && typeof value === 'object' && 'increment' in value);
    return new Proxy(ops, { get: (target, key) => {
      if (key === 'create') return (args: { data: Record<string, unknown> }) => target.create({ ...args, data: defaults(args.data) });
      // The in-memory adapter stores `{ increment }` literally; Prisma and PostgreSQL apply it per row.
      if (key === 'update' || key === 'updateMany') return async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!increments(args.data)) return (target as never as Record<string, (a: unknown) => unknown>)[key]!(args);
        const rows = await target.findMany({ where: args.where }) as Array<Record<string, unknown> & { id: string }>;
        for (const row of rows) {
          const data = Object.fromEntries(Object.entries(args.data).map(([field, value]) =>
            [field, value && typeof value === 'object' && 'increment' in value ? Number(row[field] ?? 0) + Number((value as { increment: number }).increment) : value]));
          await target.updateMany({ where: { id: row.id }, data });
        }
        return key === 'update' ? target.findUnique({ where: args.where }) : { count: rows.length };
      };
      return Reflect.get(target, key).bind(target);
    } });
  }
}

export class MutablePolicy implements AccountPolicySource {
  value: AccountPolicy = { ...DEFAULT_ACCOUNT_POLICY };
  async policy() { return this.value; }
}

export interface Fixture {
  db: SpyAdapter;
  clock: { now: Date; advance(seconds: number): void };
  jwt: JwtService;
  mailer: RecordingMailer;
  policy: MutablePolicy;
  attempts: MemoryAttemptStore;
  accounts: AccountService;
  guard: AccountGuard;
  cookie: AccountSessionCookie;
  twoFactor: AccountTwoFactorService | undefined;
  options: ReturnType<typeof resolveAccountsOptions>;
  /** A verified, enabled account with `PASSWORD`. */
  createUser(username: string, extra?: Partial<UserEntity>): Promise<UserEntity>;
}

export interface FixtureInput extends Omit<BackOfficeAccountsOptions, 'policy' | 'mailer'> {
  mailer?: RecordingMailer;
  db?: SpyAdapter;
  /** Encoder used for the stored passwords (default scrypt, like ccopyright). */
  encoder?: PasswordEncoder;
  policy?: Partial<AccountPolicy>;
}

export function createFixture(input: FixtureInput = {}): Fixture {
  const { mailer = new RecordingMailer(), db = new SpyAdapter(), encoder = new ScryptEncoder(), policy: policyPatch, ...rest } = input;
  const clock = { now: new Date('2026-06-01T12:00:00Z'), advance(seconds: number) { this.now = new Date(this.now.getTime() + seconds * 1000); } };
  const now = () => clock.now;
  db.now = now;
  const attempts = new MemoryAttemptStore(now);
  const options = resolveAccountsOptions({
    passwordEncoder: encoder,
    // The in-memory adapter has no SQL: the advisory-lock statement of code mode is accepted and ignored.
    sql: () => ({ query: async () => ({ rows: [] }) }),
    locales: { supported: ['en', 'zh'] },
    ...rest,
    verification: { attempts, ...rest.verification },
  });
  const jwt = new JwtService({ secret: JWT_SECRET });
  const policy = new MutablePolicy();
  policy.value = { ...DEFAULT_ACCOUNT_POLICY, requireEmailVerification: false, ...policyPatch };
  const twoFactor = options.features.twoFactor
    ? new AccountTwoFactorService(db, now, { encryptionKey: TWO_FACTOR_KEY, distinctFrom: [JWT_SECRET] }, options)
    : undefined;
  const verifiers = options.tokens.additionalAccessVerifiers.map(entry => (typeof entry === 'function' ? new (entry as new () => never)() : entry));
  const accounts = new AccountService(db, jwt, mailer, options, policy, undefined, twoFactor, now, undefined, undefined, undefined);
  const guard = new AccountGuard(
    { getAllAndOverride: () => undefined } as never, jwt, accounts,
    { resolve: async () => undefined } as never, undefined, verifiers as never);
  return {
    db, clock, jwt, mailer, policy, attempts, accounts, guard, twoFactor, options, cookie: new AccountSessionCookie(options),
    createUser: async (username, extra = {}) => accounts.users().addUser({ username, password: PASSWORD, email: `${username}@example.invalid`,
      name: username, typeId: 'member', status: true, emailVerified: true, locale: 'en', ...extra }),
  };
}

export type { DatabaseAdapter };
