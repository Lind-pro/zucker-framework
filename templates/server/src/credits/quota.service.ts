import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { QuotaCapacityExceededError, QuotaReservationService } from '@zucker-framework/credit';
import type { TaskRecord } from '@zucker-framework/task';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { QUOTA_OPTIONS, quotaPeriod, type QuotaOptions } from './quota.config';
import { createQuotaStore, type StoredQuotaReservation } from './quota.store';
import type { CreditPageOptions } from './credits.service';

@Injectable()
export class QuotaService {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, @Inject(QUOTA_OPTIONS) private readonly options: QuotaOptions) {}
  async reserveRecord(tx: ApplicationTransaction, task: TaskRecord): Promise<void> {
    if (this.options.recordLimit === undefined) return;
    if (!task.userId || task.kind !== 'record') throw new Error('Record quota requires an owned record task');
    const now = new Date(), period = quotaPeriod(now, this.options.period);
    try { await new QuotaReservationService(createQuotaStore(this.database, tx)).reserve({ id: task.id, subjectId: task.userId,
      counter: 'record', amount: 1, period: period.period, limit: this.options.recordLimit, policyVersion: `record:${this.options.period}:1`,
      resourceType: 'job', resourceId: task.id, expiresAt: new Date(Math.min(period.endsAt.getTime(), now.getTime() + this.options.reservationTtlMs)) });
    } catch (error) { if (error instanceof QuotaCapacityExceededError) throw new ConflictException('Record quota is exhausted'); throw error; }
  }
  private async reservation(tx: ApplicationTransaction, task: TaskRecord) {
    const row = await tx.model('quotaReservation').findUnique({ where: { id: task.id } }) as StoredQuotaReservation | null;
    if (row && (row.subjectId !== task.userId || row.resourceType !== 'job' || row.resourceId !== task.id || row.counter !== 'record'))
      throw new Error('Quota reservation does not match its task');
    return row;
  }
  async confirmRecord(tx: ApplicationTransaction, task: TaskRecord): Promise<void> {
    if (await this.reservation(tx, task)) await new QuotaReservationService(createQuotaStore(this.database, tx)).confirm(task.id);
  }
  async releaseRecord(tx: ApplicationTransaction, task: TaskRecord, reason: string): Promise<void> {
    if (await this.reservation(tx, task)) await new QuotaReservationService(createQuotaStore(this.database, tx)).release(task.id, reason);
  }
  async reconcile(tx: ApplicationTransaction, reservationId: string, ownerId: string): Promise<void> {
    const row = await tx.model('quotaReservation').findUnique({ where: { id: reservationId } }) as StoredQuotaReservation | null;
    if (!row || row.subjectId !== ownerId || row.status !== 'RESERVED') return;
    const task = await tx.model('asyncJob').findUnique({ where: { id: row.resourceId }, select: { status: true, userId: true } }) as { status: string; userId: string } | null;
    if (!task || task.userId !== row.subjectId) throw new Error('Quota reservation task is unavailable');
    const service = new QuotaReservationService(createQuotaStore(this.database, tx, row.id));
    if (task.status === 'FAILED' || task.status === 'CANCELLED') await service.release(row.id, 'task-terminal');
    else await service.expire();
  }
  async recordSnapshot(ownerId: string) {
    if (this.options.recordLimit === undefined) return { configured: false as const };
    const now = new Date(), period = quotaPeriod(now, this.options.period);
    const result = await this.database.transaction(tx => tx.query<{ used: number; reserved: number }>(`
      SELECT COALESCE((SELECT used FROM quota_usage WHERE "subjectId"=$1 AND counter='record' AND period=$2),0) AS used,
        COALESCE((SELECT SUM(amount)::integer FROM quota_reservations WHERE "subjectId"=$1 AND counter='record'
          AND period=$2 AND status='RESERVED' AND "expiresAt">$3),0) AS reserved`, [ownerId, period.period, now]));
    const { used, reserved } = result.rows[0];
    return { configured: true as const, counter: 'record', period: period.period, resetsAt: period.endsAt,
      limit: this.options.recordLimit, used, reserved, remaining: Math.max(0, this.options.recordLimit - used - reserved) };
  }
  async list(ownerId: string, options: CreditPageOptions) {
    return this.database.transaction(async tx => {
      const where = { subjectId: ownerId };
      const data = await tx.model('quotaReservation').findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (options.page - 1) * options.pageSize, take: options.pageSize });
      const total = await tx.model('quotaReservation').count({ where }); return { data, total, ...options };
    });
  }
  async get(ownerId: string, id: string) {
    const rows = await this.database.model('quotaReservation').findMany({ where: { id, subjectId: ownerId }, take: 1 });
    if (!rows[0]) throw new NotFoundException(); return rows[0];
  }
}
