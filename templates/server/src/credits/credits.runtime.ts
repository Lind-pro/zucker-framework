import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresTaskRepository } from '@zucker-framework/task';
import type { DurableTaskAttemptContext } from '@zucker-framework/task';
import { ApplicationDatabase } from '../database';
import { createCreditLedger } from '../billing/ledger';
import { JobsService } from '../jobs/jobs.service';

export const CREDIT_EXPIRY_JOB = 'credits.expire';
interface DueLot { id: string; userId: string; expiresAt: Date }

/** Maintenance uses the one Jobs host; reads never repair another account's balance. */
@Injectable()
export class CreditsRuntime implements OnModuleInit {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly jobs: JobsService) {}
  onModuleInit(): void {
    const ledger = createCreditLedger(this.database);
    this.jobs.registerHandler({ kind: CREDIT_EXPIRY_JOB, version: '1', maxAttempts: 3, handler: {
      execute: async context => { await context.assertActive(); return this.identity(context); },
      complete: (context, result) => this.database.transaction(async tx => {
        const { ownerId, lotId } = this.identity(context);
        const completed = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING', to: 'COMPLETED',
          leaseToken: context.leaseToken, result, now: context.now() });
        if (!completed) return false;
        await ledger.expireInTransaction(tx, { accountId: ownerId, lotIds: [lotId],
          transactionData: { type: 'EXPIRE', description: 'Expired credits', metadata: { taskId: context.task.id, resourceType: 'credit-lot', resourceId: lotId } } }, context.now());
        return true;
      }),
    } });
    this.jobs.registerWakeSource({ name: 'credit-expiry', runOnce: () => this.scheduleDue() });
  }
  private identity(context: DurableTaskAttemptContext) {
    const payload = context.task.payload as { ownerId?: unknown; lotId?: unknown } | null;
    if (!payload || typeof payload.ownerId !== 'string' || typeof payload.lotId !== 'string'
      || payload.ownerId !== context.task.userId || context.task.resource.type !== 'credit-lot' || context.task.resource.id !== payload.lotId)
      throw new Error('Invalid credit maintenance identity');
    return { ownerId: payload.ownerId, lotId: payload.lotId };
  }
  async scheduleDue(): Promise<void> {
    const due = await this.database.transaction(tx => tx.query<DueLot>(`
      SELECT lot.id,lot."userId",lot."expiresAt" FROM credit_lots AS lot
      WHERE NOT lot."isExpired" AND lot."remainingAmount">0 AND lot."expiresAt"<=$1
        AND NOT EXISTS (SELECT 1 FROM async_jobs AS job WHERE job.kind=$2 AND job."resourceType"='credit-lot' AND job."resourceId"=lot.id)
      ORDER BY lot."expiresAt",lot.id LIMIT 50`, [new Date(), CREDIT_EXPIRY_JOB]));
    for (const lot of due.rows) {
      await this.jobs.submit({ kind: CREDIT_EXPIRY_JOB, idempotencyKey: `${lot.id}:${lot.expiresAt.toISOString()}`, ownerId: lot.userId,
        resource: { type: 'credit-lot', id: lot.id }, payload: { ownerId: lot.userId, lotId: lot.id } });
    }
  }
}
