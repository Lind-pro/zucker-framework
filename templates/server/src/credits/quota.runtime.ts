import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { PostgresTaskRepository } from '@zucker-framework/task';
import type { DurableTaskAttemptContext } from '@zucker-framework/task';
import { ApplicationDatabase } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { QuotaService } from './quota.service';

export const QUOTA_RECONCILE_JOB = 'quota.reconcile';
@Injectable()
export class QuotaRuntime implements OnModuleInit {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly jobs: JobsService, private readonly quota: QuotaService) {}
  onModuleInit(): void {
    this.jobs.registerTransactionHooks({ name: 'record-quota', kind: 'record',
      submitted: (tx, task) => this.quota.reserveRecord(tx, task), completed: (tx, task) => this.quota.confirmRecord(tx, task),
      cancelled: (tx, task) => this.quota.releaseRecord(tx, task, 'task-cancelled'), failed: (tx, task) => this.quota.releaseRecord(tx, task, 'task-failed') });
    this.jobs.registerHandler({ kind: QUOTA_RECONCILE_JOB, version: '1', maxAttempts: 3, handler: {
      execute: async context => { await context.assertActive(); return this.identity(context); },
      complete: (context, result) => this.database.transaction(async tx => {
        const { ownerId, reservationId } = this.identity(context);
        const completed = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING', to: 'COMPLETED', leaseToken: context.leaseToken, result, now: context.now() });
        if (!completed) return false;
        await this.quota.reconcile(tx, reservationId, ownerId); return true;
      }),
    } });
    this.jobs.registerWakeSource({ name: 'quota-reservations', runOnce: () => this.scheduleDue() });
  }
  private identity(context: DurableTaskAttemptContext) {
    const payload = context.task.payload as { ownerId?: unknown; reservationId?: unknown } | null;
    if (!payload || typeof payload.ownerId !== 'string' || typeof payload.reservationId !== 'string'
      || payload.ownerId !== context.task.userId || context.task.resource.type !== 'quota-reservation' || context.task.resource.id !== payload.reservationId)
      throw new Error('Invalid quota maintenance identity');
    return { ownerId: payload.ownerId, reservationId: payload.reservationId };
  }
  async scheduleDue(): Promise<void> {
    const due = await this.database.transaction(tx => tx.query<{ id: string; subjectId: string }>(`
      SELECT reservation.id, reservation."subjectId" FROM quota_reservations AS reservation
      JOIN async_jobs AS task ON task.id=reservation."resourceId" AND task."userId"=reservation."subjectId"
      WHERE reservation.status='RESERVED' AND (reservation."expiresAt"<$1 OR task.status IN ('FAILED','CANCELLED'))
        AND NOT EXISTS (SELECT 1 FROM async_jobs AS maintenance WHERE maintenance.kind=$2
          AND maintenance."resourceType"='quota-reservation' AND maintenance."resourceId"=reservation.id)
      ORDER BY reservation."expiresAt",reservation.id LIMIT 50`, [new Date(), QUOTA_RECONCILE_JOB]));
    for (const row of due.rows) await this.jobs.submit({ kind: QUOTA_RECONCILE_JOB, idempotencyKey: row.id, ownerId: row.subjectId,
      resource: { type: 'quota-reservation', id: row.id }, payload: { reservationId: row.id, ownerId: row.subjectId } });
  }
}
