import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { PostgresTaskRepository, type DurableTaskAttemptContext } from '@zucker-framework/task';
import { ACCOUNT_SECURITY_ERRORS as E, AccountDeletionService as HostDeletionService, accountSecurityError, type AccountDeletionOutcome, type AccountSql } from '@zucker-framework/back-office/accounts';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { JobsService } from '../../jobs/jobs.service';

export const ACCOUNT_DELETION_JOB = 'account.delete';
export const ACCOUNT_DELETION_WAKE_SOURCE = 'account-deletions';
/** A failed deletion job is resubmitted by the wake source after this pause. */
export const FAILED_DELETION_RETRY_MS = 60 * 60_000;
const SCAN_LIMIT = 20;

/** Product refusals (billing tables of this template), checked at scheduling and before execution. */
export async function assertNoOpenBilling(_tx: DatabaseAdapter, sql: AccountSql, userId: string): Promise<void> {
  const subscription = await sql.query(`SELECT 1 FROM billing_subscriptions WHERE "ownerId" = $1 AND status <> 'canceled'
    AND "canceledAt" IS NULL AND "cancelAtPeriodEnd" IS NOT TRUE LIMIT 1`, [userId]);
  if (subscription.rows.length) throw accountSecurityError(409, E.hasActiveSubscription, 'Cancel your subscription before deleting the account');
  const refund = await sql.query(`SELECT 1 FROM billing_refund_requests WHERE "ownerId" = $1 AND state NOT IN ('succeeded', 'failed', 'canceled') LIMIT 1`, [userId]);
  if (refund.rows.length) throw accountSecurityError(409, E.hasOpenRefund, 'A refund request is still open');
}

/**
 * Account deletion executed by the template's durable Jobs host: one `account.delete` job per due request
 * (found by the `account-deletions` wake source), lease-fenced in the transaction that runs the erase.
 */
@Injectable()
export class AccountDeletionService extends HostDeletionService implements OnModuleInit {
  @Optional() @Inject(JobsService) private readonly jobs?: JobsService;

  override onModuleInit(): void {
    const jobs = this.jobs;
    if (!jobs) return;
    jobs.registerHandler({ kind: ACCOUNT_DELETION_JOB, version: '1', maxAttempts: 5, handler: {
      execute: async context => { await context.assertActive(); return { userId: this.identity(context) }; },
      complete: async context => {
        const userId = this.identity(context);
        let outcome: AccountDeletionOutcome | null = null;
        const completed = await this.database.$transaction(async tx => {
          const done = await new PostgresTaskRepository(tx as never).transition({ id: context.task.id, from: 'PROCESSING', to: 'COMPLETED',
            leaseToken: context.leaseToken, result: { userId }, now: context.now() });
          if (!done) return false;
          outcome = await this.executeInTransaction(tx, userId);
          return true;
        });
        if (completed && outcome) await this.afterExecution(userId, outcome);
        return completed;
      },
    } });
    jobs.registerWakeSource({ name: ACCOUNT_DELETION_WAKE_SOURCE, runOnce: async () => { await this.scheduleDue(); } });
  }

  private identity(context: DurableTaskAttemptContext): string {
    const payload = context.task.payload as { userId?: unknown } | null;
    if (!payload || typeof payload.userId !== 'string' || context.task.resource.type !== 'account-deletion'
      || context.task.resource.id !== payload.userId) throw new Error('Invalid account deletion task identity');
    return payload.userId;
  }

  /** Wake source: submits one `account.delete` job per due request without a live or recently failed job. */
  async scheduleDue(now = this.clock()): Promise<number> {
    if (!this.jobs) return 0;
    const due = await this.database.$transaction(tx => (tx as unknown as AccountSql).query<{ userId: string; jobs: number }>(`
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
