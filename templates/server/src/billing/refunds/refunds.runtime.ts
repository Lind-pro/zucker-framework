import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { DurableTaskLeaseLostError, PostgresTaskRepository } from '@zucker-framework/task';
import type { DurableTaskAttemptContext, TaskErrorSummary } from '@zucker-framework/task';
import { ApplicationDatabase } from '../../database';
import { JobsService } from '../../jobs/jobs.service';
import { BillingService } from '../billing.service';
import type { SubscriptionExecutionFence } from '../subscription-persistence';

export const REFUND_RECONCILE_JOB = 'billing.refund.reconcile';
const activeTasks = ['QUEUED', 'PROCESSING', 'RETRYING', 'WAITING_PROVIDER'];
const pendingCash = ['submitting', 'pending', 'requires_action', 'unknown'];
const intervalMs = 15 * 60_000;
interface ScheduledRefund {
  id: string; ownerId: string; state: string; creditState: string; revision: number;
  reconcileStatus: string; lastReconcileTaskId: string | null;
  checkedAt: Date | null; updatedAt: Date;
}

/** Read-only provider reconciliation runs on the application's one JobsHost. */
@Injectable()
export class BillingRefundRuntime implements OnModuleInit {
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    private readonly jobs: JobsService, private readonly billing: BillingService) {}
  onModuleInit(): void {
    this.jobs.registerHandler({ kind: REFUND_RECONCILE_JOB, version: '1', maxAttempts: 3, handler: {
      execute: async context => {
        const { refundId, ownerId } = this.identity(context);
        const record = await this.database.model('billingRefundRequests').findUnique({ where: { id: refundId }, select: { ownerId: true } }) as { ownerId: string } | null;
        if (!record || record.ownerId !== ownerId) throw new Error('Refund task owner does not match its request');
        await context.assertActive();
        const result = await this.billing.refunds.reconcile(refundId, this.fence(context));
        await context.assertActive();
        return { refundId, cashState: result.cashState, creditState: result.creditState };
      },
      complete: (context, result) => this.database.transaction(async tx => Boolean(await new PostgresTaskRepository(tx).transition({
        id: context.task.id, from: 'PROCESSING', to: 'COMPLETED', leaseToken: context.leaseToken, result, now: context.now(),
      }))),
      fail: (context, error) => this.fail(context, error),
    } });
    this.jobs.registerWakeSource({ name: 'billing-refunds', runOnce: () => this.scheduleDue() });
  }
  private identity(context: DurableTaskAttemptContext) {
    const payload = context.task.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid refund task payload');
    const { refundId, ownerId } = payload as Record<string, unknown>;
    if (typeof refundId !== 'string' || typeof ownerId !== 'string' || !refundId || !ownerId
      || context.task.userId !== ownerId || context.task.resource.type !== 'billing-refund'
      || context.task.resource.id !== refundId) throw new Error('Invalid refund task identity');
    return { refundId, ownerId };
  }
  private fence(context: DurableTaskAttemptContext): SubscriptionExecutionFence {
    return async tx => {
      const result = await tx.query<{ id: string }>(`SELECT id FROM async_jobs WHERE id=$1 AND "leaseToken"=$2
        AND status='PROCESSING' AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`, [context.task.id, context.leaseToken]);
      if (result.rows.length !== 1 || context.signal.aborted) throw new DurableTaskLeaseLostError(context.task.id, 'refund reconciliation');
    };
  }
  private fail(context: DurableTaskAttemptContext, error: TaskErrorSummary) {
    return this.database.transaction(async tx => {
      const { refundId, ownerId } = this.identity(context);
      const failed = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING',
        to: 'FAILED', leaseToken: context.leaseToken, error, now: context.now() });
      if (!failed) return false;
      await this.coordinator.lockAccount(tx, ownerId);
      // A newer manual success clears this pointer, so an older failed task cannot undo it.
      await tx.model('billingRefundRequests').updateMany({ where: { id: refundId, ownerId, lastReconcileTaskId: context.task.id },
        data: { reconcileStatus: 'attention', reconcileErrorCode: error.code, revision: { increment: 1 } } });
      return true;
    });
  }
  async scheduleDue(): Promise<void> {
    const now = new Date();
    for (const candidate of await this.billing.refunds.due()) {
      const submitted = await this.database.transaction(async tx => {
        await this.coordinator.lockAccount(tx, candidate.ownerId);
        const result = await tx.query<ScheduledRefund>('SELECT * FROM billing_refund_requests WHERE id=$1 FOR UPDATE', [candidate.id]);
        const row = result.rows[0];
        if (!row || row.ownerId !== candidate.ownerId || !pendingCash.includes(row.state) || row.creditState === 'attention'
          || row.reconcileStatus === 'attention' || (row.checkedAt ?? row.updatedAt).getTime() > now.getTime() - intervalMs) return null;
        const running = await tx.model('asyncJob').count({ where: { kind: REFUND_RECONCILE_JOB, resourceType: 'billing-refund',
          resourceId: row.id, status: { in: activeTasks } } });
        if (running) return null;
        if (row.lastReconcileTaskId) {
          const previous = await tx.model('asyncJob').findUnique({ where: { id: row.lastReconcileTaskId }, select: { status: true } }) as { status: string } | null;
          if (!previous || ['FAILED', 'CANCELLED'].includes(previous.status)) {
            await tx.model('billingRefundRequests').updateMany({ where: { id: row.id, revision: row.revision },
              data: { reconcileStatus: 'attention', reconcileErrorCode: 'RECONCILIATION_STOPPED', revision: { increment: 1 } } });
            return null;
          }
        }
        const task = await this.jobs.submitInTransaction(tx, { kind: REFUND_RECONCILE_JOB,
          idempotencyKey: `${row.id}:${row.revision}`, ownerId: row.ownerId,
          resource: { type: 'billing-refund', id: row.id }, payload: { refundId: row.id, ownerId: row.ownerId } });
        if (['FAILED', 'CANCELLED'].includes(task.task.status)) {
          await tx.model('billingRefundRequests').updateMany({ where: { id: row.id, revision: row.revision },
            data: { reconcileStatus: 'attention', reconcileErrorCode: 'RECONCILIATION_STOPPED', lastReconcileTaskId: task.task.id, revision: { increment: 1 } } });
          return null;
        }
        if (task.task.status === 'COMPLETED') return null;
        const claimed = await tx.model('billingRefundRequests').updateMany({ where: { id: row.id, revision: row.revision },
          data: { reconcileStatus: 'pending', lastReconcileTaskId: task.task.id, revision: { increment: 1 } } });
        if (claimed.count !== 1) throw new Error('Refund schedule changed before task submission');
        return task;
      });
      if (submitted) this.jobs.wake(submitted.task.id);
    }
  }
}
