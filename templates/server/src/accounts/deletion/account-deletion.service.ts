import { BadRequestException, Inject, Injectable, Logger, Optional, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { OneTimeTicketError, type UserEntity } from '@zucker-framework/auth';
import { PostgresTaskRepository, type DurableTaskAttemptContext } from '@zucker-framework/task';
import { ApplicationDatabase, type ApplicationTransaction } from '../../database';
import { JobsService } from '../../jobs/jobs.service';
import { MAIL_TEMPLATE_KEYS } from '../../mail/mail-templates';
import { ACCOUNT_MAILER, AccountService, DELETED_USERNAME_PREFIX, type AccountMailer } from '../account.service';
import { ACCOUNT_SECURITY_CLOCK, type AccountSecurityClock } from '../security/account-security.clock';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError } from '../security/account-security.errors';
import { stringFields } from '../security/account-request';
import { ACCOUNT_DELETION_CONTRIBUTORS, AccountDeletionPostponedError, type AccountDeletionContributor } from './account-deletion.types';

export const ACCOUNT_DELETION_JOB = 'account.delete';
export const ACCOUNT_DELETION_WAKE_SOURCE = 'account-deletions';
/** A failed deletion job is resubmitted by the wake source after this pause. */
export const FAILED_DELETION_RETRY_MS = 60 * 60_000;
const SCAN_LIMIT = 20;
const DAY_MS = 86_400_000;
const TICKET = /^[A-Za-z0-9_-]{43}$/;

interface DeletionRow { userId: string; status: 'scheduled' | 'cancelled' | 'completed'; executeAfter: Date }
export interface DeletionOutcome { executed: boolean; email: string | null; locale: string | null }

/**
 * Self-service account deletion (decision D16): request → grace period → anonymisation.
 *
 * Scheduling (recent authentication, typed username) ends every session (credentialVersion + 1),
 * revokes API keys and runs contributors' `onScheduled` in one transaction; sign-in is refused with
 * 403 `ACCOUNT_DELETION_PENDING` until it is cancelled (password, or the mailed `cancel-deletion`
 * ticket) or executed. Execution is a durable `account.delete` job per user found by the
 * `account-deletions` wake source: one transaction runs every registered contributor in order, then
 * anonymises `users` (row kept for foreign keys and accounting) and marks the request `completed`.
 * A failing contributor rolls the whole attempt back; the job retries, and a failed job is resubmitted
 * after an hour. API keys stay revoked after a cancellation.
 */
@Injectable()
export class AccountDeletionService implements OnModuleInit {
  private readonly logger = new Logger(AccountDeletionService.name);
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    private readonly accounts: AccountService,
    @Inject(ACCOUNT_DELETION_CONTRIBUTORS) private readonly contributors: readonly AccountDeletionContributor[],
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
    @Inject(ACCOUNT_SECURITY_CLOCK) private readonly clock: AccountSecurityClock,
    @Optional() private readonly jobs?: JobsService) {}

  onModuleInit(): void {
    if (!this.jobs) return;
    this.jobs.registerHandler({ kind: ACCOUNT_DELETION_JOB, version: '1', maxAttempts: 5, handler: {
      execute: async context => { await context.assertActive(); return { userId: this.identity(context) }; },
      complete: async context => {
        const userId = this.identity(context);
        let outcome: DeletionOutcome | null = null;
        const completed = await this.database.transaction(async tx => {
          const done = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING', to: 'COMPLETED',
            leaseToken: context.leaseToken, result: { userId }, now: context.now() });
          if (!done) return false;
          outcome = await this.executeInTransaction(tx, userId);
          return true;
        });
        if (completed && outcome) await this.afterExecution(userId, outcome);
        return completed;
      },
    } });
    this.jobs.registerWakeSource({ name: ACCOUNT_DELETION_WAKE_SOURCE, runOnce: async () => { await this.scheduleDue(); } });
  }

  private identity(context: DurableTaskAttemptContext): string {
    const payload = context.task.payload as { userId?: unknown } | null;
    if (!payload || typeof payload.userId !== 'string' || context.task.resource.type !== 'account-deletion'
      || context.task.resource.id !== payload.userId) throw new Error('Invalid account deletion task identity');
    return payload.userId;
  }

  /**
   * `POST /authorize/deletion {confirm: <username>, reason?, password?}` → `{scheduled: true, executeAfter}`.
   * 409 with `ACCOUNT_HAS_ACTIVE_SUBSCRIPTION`, `ACCOUNT_HAS_OPEN_REFUND` or `ACCOUNT_LAST_SUPERADMIN`.
   */
  async schedule(userId: string, sessionId: string, body: unknown): Promise<{ scheduled: true; executeAfter: string }> {
    const input = stringFields(body, ['confirm', 'reason', 'password']);
    if (input.reason !== undefined && input.reason.length > 500) throw new BadRequestException('Reason is too long');
    const policy = await this.accounts.policy();
    if (!policy.deletionEnabled) throw accountSecurityError(403, E.deletionDisabled, 'Account deletion is turned off');
    const user = await this.accounts.assertRecentAuthentication(userId, sessionId, input.password);
    if (input.confirm !== user.username) throw accountSecurityError(400, E.deletionConfirmMismatch, 'Type your username to confirm');
    const now = this.clock();
    const executeAfter = new Date(now.getTime() + policy.deletionGraceDays * DAY_MS);
    const scheduled = await this.database.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      await this.assertDeletable(tx, userId, now);
      const reason = input.reason?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || null;
      await tx.query(`INSERT INTO account_deletions ("userId", status, "requestedAt", "executeAfter", reason)
        VALUES ($1, 'scheduled', $2, $3, $4)
        ON CONFLICT ("userId") DO UPDATE SET status = 'scheduled', "requestedAt" = $2, "executeAfter" = $3, reason = $4,
          "cancelledAt" = NULL, "completedAt" = NULL`, [userId, now, executeAfter, reason]);
      const bumped = await tx.query<{ credentialVersion: number }>(
        'UPDATE users SET "credentialVersion" = "credentialVersion" + 1 WHERE id = $1 RETURNING "credentialVersion"', [userId]);
      await tx.query(`UPDATE account_sessions SET "revokedAt" = $2, "revokedReason" = 'account-deletion' WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId, now]);
      await tx.query(`UPDATE account_api_keys SET "revokedAt" = $2, "isActive" = false WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId, now]);
      for (const contributor of this.contributors) await contributor.onScheduled?.(tx, userId);
      const ticket = user.email ? await this.accounts.issueTicket({ id: userId, email: user.email, credentialVersion: bumped.rows[0]!.credentialVersion },
        'cancel-deletion', Math.max(policy.deletionGraceDays * 86_400, 3_600), tx) : null;
      return { ticket };
    });
    if (scheduled.ticket && user.email && this.mailer.deletionScheduled) {
      const { email, locale } = user, ticket = scheduled.ticket;
      this.accounts.runInBackground('deletion-scheduled', () => this.mailer.deletionScheduled!(email!, locale ?? 'en', userId, { ticket, executeAfter }));
    }
    return { scheduled: true, executeAfter: executeAfter.toISOString() };
  }

  /** Refusals checked at scheduling and again before execution. */
  private async assertDeletable(tx: ApplicationTransaction, userId: string, now: Date): Promise<void> {
    const subscription = await tx.query(`SELECT 1 FROM billing_subscriptions WHERE "ownerId" = $1 AND status <> 'canceled'
      AND "canceledAt" IS NULL AND "cancelAtPeriodEnd" IS NOT TRUE LIMIT 1`, [userId]);
    if (subscription.rows.length) throw accountSecurityError(409, E.hasActiveSubscription, 'Cancel your subscription before deleting the account');
    const refund = await tx.query(`SELECT 1 FROM billing_refund_requests WHERE "ownerId" = $1
      AND state NOT IN ('succeeded', 'failed', 'canceled') LIMIT 1`, [userId]);
    if (refund.rows.length) throw accountSecurityError(409, E.hasOpenRefund, 'A refund request is still open');
    const superadmin = `FROM user_roles AS link JOIN roles AS role ON role.id = link."roleId"
      WHERE role.name = 'superadmin' AND (link."expiresAt" IS NULL OR link."expiresAt" > $2)`;
    const holds = await tx.query(`SELECT 1 ${superadmin} AND link."userId" = $1 LIMIT 1`, [userId, now]);
    if (!holds.rows.length) return;
    // Serialise concurrent deletions of administrators so two cannot each leave the other as "last".
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':account-deletion:superadmin', 0))::text AS locked");
    const others = await tx.query(`SELECT 1 ${superadmin} AND link."userId" <> $1
      AND EXISTS (SELECT 1 FROM users WHERE users.id = link."userId" AND users.status)
      AND NOT EXISTS (SELECT 1 FROM account_deletions AS pending WHERE pending."userId" = link."userId" AND pending.status = 'scheduled') LIMIT 1`, [userId, now]);
    if (!others.rows.length) throw accountSecurityError(409, E.lastSuperadmin, 'Assign another administrator before deleting this account');
  }

  /**
   * `POST /authorize/deletion/cancel` with `{username, password}` or `{ticket}` (the mailed link) →
   * `{cancelled: true}`. The account can sign in again (two-factor still applies); API keys stay revoked.
   */
  async cancel(body: unknown): Promise<{ cancelled: true }> {
    const input = stringFields(body, ['username', 'password', 'ticket']);
    if (input.ticket !== undefined) {
      if (input.username !== undefined || input.password !== undefined || !TICKET.test(input.ticket)) throw new BadRequestException('Invalid ticket');
      try {
        await this.database.transaction(async tx => {
          const user = await this.accounts.consumeTicket(tx, input.ticket!, 'cancel-deletion');
          await this.restore(tx, user.id);
        });
      } catch (error) {
        if (error instanceof OneTimeTicketError) throw new BadRequestException('Invalid or expired ticket');
        throw error;
      }
      return { cancelled: true };
    }
    if (!input.username || !input.password) throw new BadRequestException('Username and password are required');
    const user: UserEntity | null = await this.accounts.verifyPassword(input.username, input.password);
    if (!user?.status) throw new UnauthorizedException('Invalid credentials');
    await this.database.transaction(tx => this.restore(tx, user.id));
    return { cancelled: true };
  }

  private async restore(tx: ApplicationTransaction, userId: string): Promise<void> {
    const restored = await tx.query(`UPDATE account_deletions SET status = 'cancelled', "cancelledAt" = $2
      WHERE "userId" = $1 AND status = 'scheduled' RETURNING "userId"`, [userId, this.clock()]);
    if (!restored.rows.length) throw accountSecurityError(409, E.deletionNotPending, 'No deletion is scheduled for this account');
    await tx.query(`DELETE FROM account_tickets WHERE "userId" = $1 AND purpose = 'cancel-deletion'`, [userId]);
  }

  /**
   * Executes one due deletion on the caller's transaction (lease-fenced by the job). Returns
   * `executed: false` when the request is no longer scheduled or not yet due. Contributors may throw to
   * postpone; the caller's transaction then rolls back completely.
   */
  async executeInTransaction(tx: ApplicationTransaction, userId: string): Promise<DeletionOutcome> {
    const now = this.clock();
    const rows = await tx.query<DeletionRow>(`SELECT "userId", status, "executeAfter" FROM account_deletions WHERE "userId" = $1 FOR UPDATE`, [userId]);
    const row = rows.rows[0];
    if (!row || row.status !== 'scheduled' || row.executeAfter.getTime() > now.getTime()) return { executed: false, email: null, locale: null };
    const users = await tx.query<{ email: string | null; locale: string | null }>('SELECT email, locale FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const captured = users.rows[0];
    if (!captured) throw new Error('Account to delete was not found');
    try { await this.assertDeletable(tx, userId, now); }
    catch (error) { throw new AccountDeletionPostponedError('account', error instanceof Error ? error.message : 'blocked'); }
    for (const contributor of this.contributors) await contributor.erase(tx, userId);
    await tx.query(`UPDATE users SET username = $2 || id, name = 'Deleted user', email = NULL, "emailVerified" = false, password = NULL,
      "avatarFileId" = NULL, "deviceInfo" = NULL, "lastLoginIp" = NULL, status = false, "credentialVersion" = "credentialVersion" + 1
      WHERE id = $1`, [userId, DELETED_USERNAME_PREFIX]);
    await tx.query(`UPDATE account_deletions SET status = 'completed', "completedAt" = $2, reason = NULL WHERE "userId" = $1`, [userId, now]);
    return { executed: true, email: captured.email, locale: captured.locale };
  }

  /** Runs one deletion now in its own transaction (operators, tests); same path as the job. */
  async executeNow(userId: string): Promise<DeletionOutcome> {
    const outcome = await this.database.transaction(tx => this.executeInTransaction(tx, userId));
    if (outcome.executed) await this.afterExecution(userId, outcome);
    return outcome;
  }

  /** Post-commit, best effort: contributors' external cleanup, then the completion notice (whose log row is removed). */
  private async afterExecution(userId: string, outcome: DeletionOutcome): Promise<void> {
    if (!outcome.executed) return;
    for (const contributor of this.contributors) {
      if (!contributor.afterCommit) continue;
      try { await contributor.afterCommit(userId); }
      catch { this.logger.warn(`Post-deletion cleanup of ${contributor.name} failed; it can be retried by its own recovery`); }
    }
    if (!outcome.email || !this.mailer.deletionCompleted) return;
    try { await this.mailer.deletionCompleted(outcome.email, outcome.locale ?? 'en'); }
    catch { this.logger.warn('Deletion completion mail failed'); }
    finally {
      // The notice must not leave the erased address behind in the delivery history.
      await this.database.transaction(tx => tx.query('DELETE FROM email_logs WHERE recipient = $1 AND template = $2',
        [outcome.email, MAIL_TEMPLATE_KEYS.deletionCompleted])).catch(() => this.logger.warn('Deletion notice log cleanup failed'));
    }
  }

  /** Wake source: submits one `account.delete` job per due request without a live or recently failed job. */
  async scheduleDue(now = this.clock()): Promise<number> {
    if (!this.jobs) return 0;
    const due = await this.database.transaction(tx => tx.query<{ userId: string; jobs: number }>(`
      SELECT request."userId",
        (SELECT count(*)::int FROM async_jobs AS job WHERE job.kind = $1 AND job."resourceType" = 'account-deletion' AND job."resourceId" = request."userId") AS jobs
      FROM account_deletions AS request
      WHERE request.status = 'scheduled' AND request."executeAfter" <= $2
        AND NOT EXISTS (SELECT 1 FROM async_jobs AS job WHERE job.kind = $1 AND job."resourceType" = 'account-deletion'
          AND job."resourceId" = request."userId"
          AND (job.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR (job.status = 'FAILED' AND job."updatedAt" > $3)))
      ORDER BY request."executeAfter", request."userId" LIMIT ${SCAN_LIMIT}`,
      [ACCOUNT_DELETION_JOB, now, new Date(now.getTime() - FAILED_DELETION_RETRY_MS)]));
    for (const row of due.rows) {
      await this.jobs.submit({ kind: ACCOUNT_DELETION_JOB, idempotencyKey: `account-delete:${row.userId}:${row.jobs}`,
        resource: { type: 'account-deletion', id: row.userId }, payload: { userId: row.userId } });
    }
    return due.rows.length;
  }
}
