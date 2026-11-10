import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { isIP } from 'node:net';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { PostgresTaskRepository, type DurableTaskAttemptContext } from '@zucker-framework/task';
import { createCreditLedger } from '../billing/ledger';
import { ApplicationDatabase, ApplicationTransaction } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { PolicyService } from '../policy/policy.service';
import { MAX_WELCOME_CREDITS, readAccountPolicy, type AccountPolicyValues } from './account.policy';

export const WELCOME_CREDITS_JOB = 'credits.welcome';
export const WELCOME_CREDIT_SOURCE = 'welcome';
/** The one idempotency identity of a user's welcome grant (credit receipt, lot sourceId and retry job). */
export const welcomeCreditKey = (userId: string) => `welcome:${userId}`;

/** `password`, or `oauth:<provider>`. */
export type SignupMethod = 'password' | `oauth:${string}`;
export interface SignupContext { method: SignupMethod; ip?: unknown; utmSource?: unknown }
/** Welcome grant frozen at sign-up, so a later policy change cannot alter (or conflict with) a pending retry. */
export interface WelcomeCreditSnapshot { amount: number; validDays: number }
export type WelcomeGrantOutcome = 'granted' | 'already-granted' | 'account-unavailable' | 'expired';
/**
 * What `recordSignup` already made durable inside the sign-up transaction: `settled` (granted, or
 * nothing to grant), `queued` (the grant failed in its savepoint and a retry task was committed with the
 * user) or `inline` (no job host or no application transaction: `afterSignup` grants after commit).
 */
export type SignupWelcome = WelcomeCreditSnapshot & { readonly state: 'settled' | 'queued' | 'inline'; readonly taskId?: string };

/** First-touch `utm_source`: keeps only [A-Za-z0-9_.-], at most 64 characters; anything else becomes null. */
export function sanitizeUtmSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.slice(0, 512).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return cleaned || null;
}
/** A parsed IPv4/IPv6 literal (as Express derived it under TRUST_PROXY), else null. IPv4-mapped IPv6 is unwrapped. */
export function sanitizeSignupIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ip = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(ip) && ip.length <= 45 ? ip : null;
}
function validSnapshot(value: unknown): value is WelcomeCreditSnapshot {
  const snapshot = value as Partial<WelcomeCreditSnapshot> | null;
  return !!snapshot && Number.isSafeInteger(snapshot.amount) && snapshot.amount! >= 1 && snapshot.amount! <= MAX_WELCOME_CREDITS
    && Number.isSafeInteger(snapshot.validDays) && snapshot.validDays! >= 0 && snapshot.validDays! <= 3650;
}

/**
 * Sign-up side effects owned by the account policy: acquisition row, initial role and welcome credits.
 * `recordSignup` runs inside the user-creation transaction (and grants there, or commits a retry task);
 * `afterSignup` runs after it commits and never fails the sign-up. Welcome credits are granted through the canonical ledger with the credit
 * operation receipt `welcome:<userId>` (unique row + per-account lock), so password and OAuth sign-up,
 * the inline attempt, its retry job and any concurrent duplicate grant at most once.
 */
@Injectable()
export class AccountOnboarding implements OnModuleInit {
  private readonly logger = new Logger(AccountOnboarding.name);
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Optional() private readonly policies?: PolicyService,
    @Optional() private readonly jobs?: JobsService) {}

  onModuleInit(): void {
    this.jobs?.registerHandler({ kind: WELCOME_CREDITS_JOB, version: '1', maxAttempts: 5, handler: {
      execute: async context => { await context.assertActive(); return this.jobIdentity(context); },
      complete: (context, result) => this.database.transaction(async tx => {
        const { ownerId, snapshot } = this.jobIdentity(context);
        const completed = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING', to: 'COMPLETED',
          leaseToken: context.leaseToken, result, now: context.now() });
        if (!completed) return false;
        await this.grantInTransaction(tx, ownerId, snapshot, context.now());
        return true;
      }),
    } });
  }
  private jobIdentity(context: DurableTaskAttemptContext) {
    const payload = context.task.payload as { ownerId?: unknown; snapshot?: unknown } | null;
    if (!payload || typeof payload.ownerId !== 'string' || payload.ownerId !== context.task.userId || !validSnapshot(payload.snapshot)
      || context.task.resource.type !== 'account' || context.task.resource.id !== payload.ownerId) throw new Error('Invalid welcome credit task identity');
    return { ownerId: payload.ownerId, snapshot: payload.snapshot };
  }

  policy(): Promise<AccountPolicyValues> { return readAccountPolicy(this.policies); }

  /**
   * Inside the user-creation transaction: stores the sanitised acquisition row and assigns the
   * policy's initial role (only an existing, enabled role that is not `superadmin`; anything else is
   * logged and skipped so a stale policy value never blocks sign-up). Returns the welcome outcome (see `SignupWelcome`).
   */
  async recordSignup(tx: DatabaseAdapter, userId: string, context: SignupContext, policy: AccountPolicyValues): Promise<SignupWelcome | null> {
    await tx.model('userAcquisition').create({ data: { userId, signupMethod: context.method.slice(0, 32),
      signupIp: sanitizeSignupIp(context.ip), signupUtmSource: sanitizeUtmSource(context.utmSource) } });
    const roleId = policy.initialRoleId.trim();
    if (roleId) {
      const role = await tx.model('roles').findUnique({ where: { id: roleId }, select: { id: true, name: true, status: true } }) as
        { id: string; name: string; status: boolean | null } | null;
      if (role && role.status !== false && role.name !== 'superadmin') await tx.model('userRoles').create({ data: { userId, roleId: role.id } });
      else this.logger.warn('Account policy initialRoleId does not name an assignable role; no initial role was granted');
    }
    if (!policy.welcomeCreditsEnabled || policy.welcomeCreditsAmount < 1) return null;
    const snapshot: WelcomeCreditSnapshot = { amount: policy.welcomeCreditsAmount, validDays: policy.welcomeCreditsValidDays };
    if (!(tx instanceof ApplicationTransaction) || !this.jobs) return { ...snapshot, state: 'inline' };
    // Durability: the grant (or its retry task) commits atomically with the user row, so a crash after
    // commit can never lose a promised grant. The grant runs in a savepoint; when it fails, only the
    // savepoint is rolled back and the retry task (same frozen snapshot, same `welcome:<id>` identity)
    // is committed instead. The ledger receipt keeps every later attempt from granting twice.
    await tx.query('SAVEPOINT welcome_credits');
    try {
      await this.grantInTransaction(tx, userId, snapshot, new Date());
      await tx.query('RELEASE SAVEPOINT welcome_credits');
      return { ...snapshot, state: 'settled' };
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT welcome_credits');
      this.logger.warn(`Welcome credit grant failed (${error instanceof Error ? error.name : 'Error'}); scheduling a retry`);
    }
    const submitted = await this.jobs.submitInTransaction(tx, this.retryCommand(userId, snapshot));
    return { ...snapshot, state: 'queued', taskId: submitted.task.id };
  }

  private retryCommand(userId: string, snapshot: WelcomeCreditSnapshot) {
    return { kind: WELCOME_CREDITS_JOB, idempotencyKey: welcomeCreditKey(userId), ownerId: userId,
      resource: { type: 'account', id: userId }, payload: { ownerId: userId, snapshot: { amount: snapshot.amount, validDays: snapshot.validDays } } };
  }

  /**
   * After commit. Wakes a retry task committed by `recordSignup`; for the `inline` fallback grants now and,
   * on failure, hands the frozen snapshot to the retry job. Never throws.
   */
  async afterSignup(userId: string, welcome: WelcomeCreditSnapshot | SignupWelcome | null): Promise<void> {
    if (!welcome) return;
    const state = 'state' in welcome ? welcome.state : 'inline';
    if (state === 'settled') return;
    if (state === 'queued') { if ('taskId' in welcome && welcome.taskId) this.jobs?.wake(welcome.taskId); return; }
    const snapshot: WelcomeCreditSnapshot = { amount: welcome.amount, validDays: welcome.validDays };
    try { await this.grantWelcomeCredits(userId, snapshot); return; }
    catch (error) { this.logger.warn(`Welcome credit grant failed (${error instanceof Error ? error.name : 'Error'}); scheduling a retry`); }
    if (!this.jobs) { this.logger.error('Welcome credit retry is unavailable without the jobs host'); return; }
    try {
      const submitted = await this.jobs.submit(this.retryCommand(userId, snapshot));
      this.jobs.wake(submitted.task.id);
    } catch (error) {
      this.logger.error(`Welcome credit retry could not be scheduled (${error instanceof Error ? error.name : 'Error'})`);
    }
  }

  /** Idempotent: the first call grants, every later or concurrent call returns `already-granted`. */
  grantWelcomeCredits(userId: string, welcome: WelcomeCreditSnapshot, now = new Date()): Promise<WelcomeGrantOutcome> {
    return this.database.transaction(tx => this.grantInTransaction(tx, userId, welcome, now));
  }

  private async grantInTransaction(tx: ApplicationTransaction, userId: string, welcome: WelcomeCreditSnapshot, now: Date): Promise<WelcomeGrantOutcome> {
    if (!validSnapshot(welcome)) throw new TypeError('Invalid welcome credit snapshot');
    // Account lock first, as every other ledger writer does.
    await new PostgresCreditOperationCoordinator().lockAccount(tx, userId);
    const user = (await tx.query<{ createTime: Date | null; status: boolean }>('SELECT "createTime", status FROM users WHERE id = $1', [userId])).rows[0];
    if (!user?.status) return 'account-unavailable';
    // Expiry counts from account creation, so a retry grants the same lot an immediate grant would have.
    const expiresAt = welcome.validDays ? new Date((user.createTime ?? now).getTime() + welcome.validDays * 86_400_000) : undefined;
    if (expiresAt && expiresAt <= now) return 'expired';
    const key = welcomeCreditKey(userId), description = 'Welcome credits';
    const granted = await createCreditLedger(this.database).grant(tx, {
      accountId: userId, amount: welcome.amount, source: WELCOME_CREDIT_SOURCE, sourceId: key, expiresAt, description,
      operation: { idempotencyKey: key, accountId: userId, operationType: 'WELCOME_CREDIT_GRANT', amount: welcome.amount,
        resourceType: 'account', resourceId: userId },
      transactionData: { type: 'GRANT', description, expireAt: expiresAt ?? null,
        metadata: { source: WELCOME_CREDIT_SOURCE, sourceId: key, validDays: welcome.validDays } },
    });
    return granted ? 'granted' : 'already-granted';
  }
}
