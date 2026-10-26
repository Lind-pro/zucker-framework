import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { DurableTaskLeaseLostError, PostgresTaskRepository } from '@zucker-framework/task';
import type { DurableTaskAttemptContext, TaskErrorSummary } from '@zucker-framework/task';
import { ApplicationDatabase } from '../database';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import { BillingModule } from './billing.module';
import { BillingService } from './billing.service';
import { BillingRefundRuntime } from './refunds/refunds.runtime';
import { SUBSCRIPTION_RECONCILE_EVENT, type BillingSubscription, type SubscriptionExecutionFence } from './subscription-persistence';

export const SUBSCRIPTION_RECONCILE_JOB = 'billing.subscription.reconcile';
const active = ['QUEUED', 'PROCESSING', 'RETRYING', 'WAITING_PROVIDER'];

/** No private timer: the single durable Jobs host owns scanning and attempts. */
@Injectable()
export class BillingRuntime implements OnModuleInit {
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    private readonly jobs: JobsService, private readonly billing: BillingService) {}

  onModuleInit(): void {
    this.jobs.registerHandler({ kind: SUBSCRIPTION_RECONCILE_JOB, version: '1', maxAttempts: 3, handler: {
      execute: async context => {
        const { subscriptionId, ownerId } = this.identity(context);
        await context.assertActive();
        const result = await this.billing.subscriptions.refresh(subscriptionId, ownerId, this.fence(context));
        await context.assertActive();
        return { subscriptionId, status: result.status, initialFulfilledAt: result.initialFulfilledAt };
      },
      complete: async (context, result) => this.database.transaction(async tx => {
        const { subscriptionId } = this.identity(context);
        const completed = await new PostgresTaskRepository(tx).transition({ id: context.task.id,
          from: 'PROCESSING', to: 'COMPLETED', leaseToken: context.leaseToken, result, now: context.now() });
        if (!completed) return false;
        await tx.model('billingOutbox').updateMany({ where: { kind: SUBSCRIPTION_RECONCILE_EVENT,
          aggregateId: subscriptionId, status: { in: ['pending', 'scheduled'] } },
          data: { status: 'delivered', deliveredAt: context.now() } });
        return true;
      }),
      fail: (context, error) => this.fail(context, error),
    } });
    this.jobs.registerWakeSource({ name: 'billing-subscriptions', runOnce: () => this.scheduleDue() });
  }

  private identity(context: DurableTaskAttemptContext) {
    const payload = context.task.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid subscription task payload');
    const { subscriptionId, ownerId } = payload as Record<string, unknown>;
    if (typeof subscriptionId !== 'string' || typeof ownerId !== 'string' || !subscriptionId || !ownerId
      || context.task.userId !== ownerId || context.task.resource.type !== 'billing-subscription'
      || context.task.resource.id !== subscriptionId) throw new Error('Invalid subscription task identity');
    return { subscriptionId, ownerId };
  }

  private fence(context: DurableTaskAttemptContext): SubscriptionExecutionFence {
    return async tx => {
      const result = await tx.query<{ id: string }>(`SELECT id FROM async_jobs
        WHERE id=$1 AND "leaseToken"=$2 AND status='PROCESSING' AND "leaseExpiresAt" > clock_timestamp()
        FOR UPDATE`, [context.task.id, context.leaseToken]);
      if (result.rows.length !== 1 || context.signal.aborted) throw new DurableTaskLeaseLostError(context.task.id, 'subscription fulfillment');
    };
  }

  private fail(context: DurableTaskAttemptContext, error: TaskErrorSummary) {
    return this.database.transaction(async tx => {
      const { subscriptionId, ownerId } = this.identity(context);
      const failed = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING',
        to: 'FAILED', leaseToken: context.leaseToken, error, now: context.now() });
      if (!failed) return false;
      // A later successful manual reconciliation clears the task pointer; this older failure cannot undo it.
      await tx.model('billingSubscriptions').updateMany({ where: { id: subscriptionId, ownerId,
        lastReconcileTaskId: context.task.id }, data: { reconcileStatus: 'attention',
        reconcileErrorCode: error.code, updatedAt: context.now(), revision: { increment: 1 } } });
      return true;
    });
  }

  async scheduleDue(): Promise<void> {
    const now = new Date();
    const due = await this.database.model('billingSubscriptions').findMany({
      where: { reconcileStatus: { not: 'attention' }, nextReconcileAt: { lte: now } },
      orderBy: [{ nextReconcileAt: 'asc' }, { id: 'asc' }], take: 25,
    }) as BillingSubscription[];
    for (const candidate of due) {
      const submitted = await this.database.transaction(async tx => {
        await this.coordinator.lockAccount(tx, candidate.ownerId);
        const row = await tx.model('billingSubscriptions').findUnique({ where: { id: candidate.id } }) as BillingSubscription | null;
        if (!row || row.ownerId !== candidate.ownerId || row.reconcileStatus === 'attention' || row.nextReconcileAt > now) return null;
        const running = await tx.model('asyncJob').count({ where: { kind: SUBSCRIPTION_RECONCILE_JOB,
          resourceType: 'billing-subscription', resourceId: row.id, status: { in: active } } });
        if (running) return null;
        const result = await this.jobs.submitInTransaction(tx, { kind: SUBSCRIPTION_RECONCILE_JOB,
          idempotencyKey: `${row.id}:${row.nextReconcileAt.toISOString()}`, ownerId: row.ownerId,
          orderId: row.initialOrderId, resource: { type: 'billing-subscription', id: row.id },
          payload: { subscriptionId: row.id, ownerId: row.ownerId } });
        if (result.task.status === 'FAILED' || result.task.status === 'CANCELLED') {
          await tx.model('billingSubscriptions').updateMany({ where: { id: row.id, revision: row.revision },
            data: { reconcileStatus: 'attention', reconcileErrorCode: 'RECONCILIATION_STOPPED',
              lastReconcileTaskId: result.task.id, revision: { increment: 1 } } });
          return null;
        }
        // If an old completed task has the same schedule, keep it quiet until a successful refresh sets a new one.
        if (result.task.status === 'COMPLETED') return null;
        const claimed = await tx.model('billingSubscriptions').updateMany({ where: { id: row.id, revision: row.revision },
          data: { lastReconcileTaskId: result.task.id, reconcileStatus: 'pending', revision: { increment: 1 } } });
        if (claimed.count !== 1) throw new Error('Subscription schedule changed before task submission');
        await tx.model('billingOutbox').updateMany({ where: { kind: SUBSCRIPTION_RECONCILE_EVENT,
          aggregateId: row.id, status: 'pending' }, data: { status: 'scheduled' } });
        return result;
      });
      if (submitted) this.jobs.wake(submitted.task.id);
    }
  }
}

@Module({ imports: [BillingModule, JobsModule], providers: [BillingRuntime, BillingRefundRuntime] })
export class BillingRuntimeModule {}
