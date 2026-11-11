import { BadRequestException, Inject, Injectable, Logger, Optional, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { OneTimeTicketError, type UserEntity } from '@zucker-framework/auth';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError, stringFields, systemAccountSecurityClock, type AccountSecurityClock } from '../account-security';
import { AccountService, DELETED_USERNAME_PREFIX } from '../account.service';
import { requireSql, table, type ResolvedAccountsOptions } from '../accounts.options';
import type { AccountDeletionOutcome, AccountDeletionRunner, AccountDeletionScheduler, AccountMailer } from '../accounts.ports';
import { ACCOUNTS_CLOCK, ACCOUNTS_DELETION_CONTRIBUTORS, ACCOUNTS_DELETION_SCHEDULER, ACCOUNTS_MAILER, ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { AccountDeletionPostponedError, type AccountDeletionContributor } from './account-deletion.types';

const DAY_MS = 86_400_000;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
interface DeletionRow { userId: string; status: 'scheduled' | 'cancelled' | 'completed'; executeAfter: Date }

/**
 * Self-service account deletion: request → grace period → anonymisation.
 *
 * Scheduling (recent authentication, typed username) ends every session (credentialVersion + 1),
 * revokes API keys and runs contributors' `onScheduled` in one transaction; sign-in is refused with
 * 403 `ACCOUNT_DELETION_PENDING` until it is cancelled (password, or the mailed `cancel-deletion`
 * ticket) or executed. Execution (`executeInTransaction`, driven by an `AccountDeletionScheduler` or
 * `executeNow`) runs every registered contributor in order in one transaction, then anonymises `users`
 * (row kept for foreign keys and accounting) and marks the request `completed`. A failing contributor
 * rolls the whole attempt back. API keys stay revoked after a cancellation.
 */
@Injectable()
export class AccountDeletionService implements OnModuleInit, AccountDeletionRunner {
  protected readonly logger = new Logger(AccountDeletionService.name);
  protected readonly options: ResolvedAccountsOptions;
  constructor(@Inject(DATABASE_ADAPTER) protected readonly database: DatabaseAdapter,
    protected readonly accounts: AccountService,
    @Inject(ACCOUNTS_DELETION_CONTRIBUTORS) protected readonly contributors: readonly AccountDeletionContributor<DatabaseAdapter>[],
    @Inject(ACCOUNTS_MAILER) protected readonly mailer: AccountMailer,
    @Optional() @Inject(ACCOUNTS_CLOCK) protected readonly clock: AccountSecurityClock = systemAccountSecurityClock,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions,
    @Optional() @Inject(ACCOUNTS_DELETION_SCHEDULER) private readonly scheduler?: AccountDeletionScheduler) {
    this.options = options ?? accounts.options;
  }

  onModuleInit(): void { this.scheduler?.start(this); }

  private get feature() { return this.options.features.deletion ?? { mount: true }; }

  /**
   * `POST /authorize/deletion {confirm: <username>, reason?, password?}` → `{scheduled: true, executeAfter}`.
   * 409 with `ACCOUNT_LAST_SUPERADMIN` or a product refusal (`assertDeletable`).
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
    const scheduled = await this.database.$transaction(async tx => {
      const sql = requireSql(this.options, tx, 'Account deletion');
      await sql.query(`SELECT id FROM ${table(this.options, 'users')} WHERE id = $1 FOR UPDATE`, [userId]);
      await this.assertDeletable(tx, userId, now);
      const reason = input.reason?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || null;
      await sql.query(`INSERT INTO ${table(this.options, 'accountDeletions')} ("userId", status, "requestedAt", "executeAfter", reason)
        VALUES ($1, 'scheduled', $2, $3, $4)
        ON CONFLICT ("userId") DO UPDATE SET status = 'scheduled', "requestedAt" = $2, "executeAfter" = $3, reason = $4,
          "cancelledAt" = NULL, "completedAt" = NULL`, [userId, now, executeAfter, reason]);
      const bumped = await sql.query<{ credentialVersion: number }>(
        `UPDATE ${table(this.options, 'users')} SET "credentialVersion" = "credentialVersion" + 1 WHERE id = $1 RETURNING "credentialVersion"`, [userId]);
      await sql.query(`UPDATE ${table(this.options, 'accountSessions')} SET "revokedAt" = $2, "revokedReason" = 'account-deletion' WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId, now]);
      if (this.options.features.apiKeys) {
        await sql.query(`UPDATE ${table(this.options, 'accountApiKeys')} SET "revokedAt" = $2, "isActive" = false WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId, now]);
      }
      for (const contributor of this.contributors) await contributor.onScheduled?.(tx, userId);
      const ticket = user.email ? await this.accounts.issueTicket({ id: userId, email: user.email, credentialVersion: bumped.rows[0]!.credentialVersion },
        'cancel-deletion', Math.max(policy.deletionGraceDays * 86_400, 3_600), tx) : null;
      return { ticket };
    });
    if (scheduled.ticket && user.email && this.mailer.deletionScheduled) {
      const { email, locale } = user, ticket = scheduled.ticket;
      this.accounts.runInBackground('deletion-scheduled', () => this.mailer.deletionScheduled!(email!, locale ?? this.options.locales.default, userId, { ticket, executeAfter }));
    }
    return { scheduled: true, executeAfter: executeAfter.toISOString() };
  }

  /** Refusals checked at scheduling and again before execution: product checks, then the last active superadmin. */
  private async assertDeletable(tx: DatabaseAdapter, userId: string, now: Date): Promise<void> {
    const sql = requireSql(this.options, tx, 'Account deletion');
    await this.feature.assertDeletable?.(tx, sql, userId, now);
    const users = table(this.options, 'users'), links = table(this.options, 'userRoles'), roles = table(this.options, 'roles');
    const superadmin = `FROM ${links} AS link JOIN ${roles} AS role ON role.id = link."roleId"
      WHERE role.name = 'superadmin' AND (link."expiresAt" IS NULL OR link."expiresAt" > $2)`;
    const holds = await sql.query(`SELECT 1 ${superadmin} AND link."userId" = $1 LIMIT 1`, [userId, now]);
    if (!holds.rows.length) return;
    // Serialise concurrent deletions of administrators so two cannot each leave the other as "last".
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':account-deletion:superadmin', 0))::text AS locked");
    const others = await sql.query(`SELECT 1 ${superadmin} AND link."userId" <> $1
      AND EXISTS (SELECT 1 FROM ${users} AS account WHERE account.id = link."userId" AND account.status)
      AND NOT EXISTS (SELECT 1 FROM ${table(this.options, 'accountDeletions')} AS pending WHERE pending."userId" = link."userId" AND pending.status = 'scheduled') LIMIT 1`, [userId, now]);
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
        await this.database.$transaction(async tx => {
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
    await this.database.$transaction(tx => this.restore(tx, user.id));
    return { cancelled: true };
  }

  private async restore(tx: DatabaseAdapter, userId: string): Promise<void> {
    const sql = requireSql(this.options, tx, 'Account deletion');
    const restored = await sql.query(`UPDATE ${table(this.options, 'accountDeletions')} SET status = 'cancelled', "cancelledAt" = $2
      WHERE "userId" = $1 AND status = 'scheduled' RETURNING "userId"`, [userId, this.clock()]);
    if (!restored.rows.length) throw accountSecurityError(409, E.deletionNotPending, 'No deletion is scheduled for this account');
    await sql.query(`DELETE FROM ${table(this.options, 'accountTickets')} WHERE "userId" = $1 AND purpose = 'cancel-deletion'`, [userId]);
  }

  /**
   * Executes one due deletion on the caller's transaction (lease-fenced by the scheduler). Returns
   * `executed: false` when the request is no longer scheduled or not yet due. Contributors may throw to
   * postpone; the caller's transaction then rolls back completely.
   */
  async executeInTransaction(tx: DatabaseAdapter, userId: string): Promise<AccountDeletionOutcome> {
    const sql = requireSql(this.options, tx, 'Account deletion');
    const now = this.clock();
    const rows = await sql.query<DeletionRow>(`SELECT "userId", status, "executeAfter" FROM ${table(this.options, 'accountDeletions')} WHERE "userId" = $1 FOR UPDATE`, [userId]);
    const row = rows.rows[0];
    if (!row || row.status !== 'scheduled' || row.executeAfter.getTime() > now.getTime()) return { executed: false, email: null, locale: null };
    const users = await sql.query<{ email: string | null; locale: string | null }>(`SELECT email, locale FROM ${table(this.options, 'users')} WHERE id = $1 FOR UPDATE`, [userId]);
    const captured = users.rows[0];
    if (!captured) throw new Error('Account to delete was not found');
    try { await this.assertDeletable(tx, userId, now); }
    catch (error) { throw new AccountDeletionPostponedError('account', error instanceof Error ? error.message : 'blocked'); }
    for (const contributor of this.contributors) await contributor.erase(tx, userId);
    await sql.query(`UPDATE ${table(this.options, 'users')} SET username = $2 || id, name = 'Deleted user', email = NULL, "emailVerified" = false, password = NULL,
      status = false, "credentialVersion" = "credentialVersion" + 1 WHERE id = $1`, [userId, DELETED_USERNAME_PREFIX]);
    const clear = this.feature.clearUserFields;
    if (clear && Object.keys(clear).length) await tx.model(this.options.models.users).update({ where: { id: userId }, data: { ...clear } });
    await sql.query(`UPDATE ${table(this.options, 'accountDeletions')} SET status = 'completed', "completedAt" = $2, reason = NULL WHERE "userId" = $1`, [userId, now]);
    return { executed: true, email: captured.email, locale: captured.locale };
  }

  /** Runs one deletion now in its own transaction (operators, tests); same path as a scheduler. */
  async executeNow(userId: string): Promise<AccountDeletionOutcome> {
    const outcome = await this.database.$transaction(tx => this.executeInTransaction(tx, userId));
    if (outcome.executed) await this.afterExecution(userId, outcome);
    return outcome;
  }

  /** Post-commit, best effort: contributors' external cleanup, then the completion notice. */
  async afterExecution(userId: string, outcome: AccountDeletionOutcome): Promise<void> {
    if (!outcome.executed) return;
    for (const contributor of this.contributors) {
      if (!contributor.afterCommit) continue;
      try { await contributor.afterCommit(userId); }
      catch { this.logger.warn(`Post-deletion cleanup of ${contributor.name} failed; it can be retried by its own recovery`); }
    }
    if (!outcome.email || !this.mailer.deletionCompleted) return;
    try { await this.mailer.deletionCompleted(outcome.email, outcome.locale ?? this.options.locales.default); }
    catch { this.logger.warn('Deletion completion mail failed'); }
  }
}
