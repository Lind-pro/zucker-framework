import { createHash } from 'node:crypto';
import { PostgresCreditOperationCoordinator, QuotaCapacity, QuotaCapacityExceededError, QuotaReservationError } from '@zucker-framework/credit';
import type { QuotaCapacityKey, QuotaCapacityStore, QuotaReservationInput, QuotaReservationRecord, QuotaReservationStore, QuotaReservationState } from '@zucker-framework/credit';
import type { ApplicationDatabase, ApplicationTransaction } from '../database';

export interface StoredQuotaReservation extends QuotaReservationRecord {
  period: string; limit: number; policyVersion: string; resourceType: string; resourceId: string;
  createdAt: Date; updatedAt: Date; finishedAt: Date | null; reason: string | null;
}
export interface CapturedQuotaInput extends QuotaReservationInput {
  id: string; period: string; limit: number; policyVersion: string; resourceType: string; resourceId: string;
}
const coordinator = new PostgresCreditOperationCoordinator(), capacity = new QuotaCapacity();

/**
 * Storage key of a RESERVED/CONFIRMED reservation: sha256 of the length-prefixed UTF-8 parts. The
 * migration backfill computes the same value in SQL; keep both in sync.
 */
export function activeResourceKey(identity: { subjectId: string; counter: string; resourceType: string; resourceId: string }): string {
  const parts = [identity.subjectId, identity.counter, identity.resourceType, identity.resourceId];
  return createHash('sha256').update(parts.map(part => `${Buffer.byteLength(part)}:${part}`).join(''), 'utf8').digest('hex');
}
function uniqueViolation(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof value?.code === 'string' ? value.code : value?.cause?.code;
  return code === 'P2002' || code === '23505' || (error instanceof Error && /Unique constraint/i.test(error.message));
}
function lock(tx: ApplicationTransaction, identity: { subjectId: string; counter: string }) {
  return coordinator.lockAccount(tx, `quota:${createHash('sha256').update(JSON.stringify([identity.subjectId, identity.counter])).digest('hex')}`);
}
function where(key: QuotaCapacityKey) { return { subjectId: key.subjectId, counter: key.counter, period: key.period }; }
function capacityStore(tx: ApplicationTransaction): QuotaCapacityStore {
  return {
    lock: key => lock(tx, key),
    ensureUsage: async (key, limit) => {
      await tx.query(`INSERT INTO quota_usage ("subjectId","counter","period","limit") VALUES ($1,$2,$3,$4)
        ON CONFLICT ("subjectId","counter","period") DO UPDATE SET "limit"=$4,"updatedAt"=$5`,
      [key.subjectId, key.counter, key.period, limit, new Date()]);
      return await tx.model('quotaUsage').findUnique({ where: { subjectId_counter_period: where(key) } }) as { used: number; limit: number };
    },
    readUsage: async key => await tx.model('quotaUsage').findUnique({ where: { subjectId_counter_period: where(key) } }) as { used: number; limit: number },
    reservations: async key => await tx.model('quotaReservation').findMany({ where: { ...where(key), status: 'RESERVED' },
      select: { amount: true, expiresAt: true, period: true } }) as Array<{ amount: number; expiresAt: Date; period: string }>,
    incrementIfCapacity: async (key, amount, maximumUsedBefore) => (await tx.model('quotaUsage').updateMany({
      where: { ...where(key), used: { lte: maximumUsedBefore } }, data: { used: { increment: amount }, updatedAt: new Date() } })).count === 1,
  };
}

/** Counter usage is separate from the credit wallet; all writers take the same subject/counter lock. */
export function createQuotaStore(database: ApplicationDatabase, transaction?: ApplicationTransaction, expiryId?: string):
QuotaReservationStore<ApplicationTransaction, StoredQuotaReservation, CapturedQuotaInput> {
  return {
    transaction: work => transaction ? work(transaction) : database.transaction(work), lock,
    find: async (tx, id) => await tx.model('quotaReservation').findUnique({ where: { id } }) as StoredQuotaReservation | null,
    assertCapacity: async (tx, input) => {
      const snapshot = await capacity.check(capacityStore(tx), { ...input, now: new Date() });
      if (!snapshot.allowed) throw new QuotaCapacityExceededError(snapshot, input.amount);
    },
    insert: async (tx, input) => {
      try {
        return await tx.model('quotaReservation').create({ data: { ...input, status: 'RESERVED',
          activeResourceKey: activeResourceKey(input) } }) as StoredQuotaReservation;
      } catch (error) {
        // Another live reservation holds this resource on this counter (all writers of the key hold
        // the subject/counter lock, so this means a row written outside the reservation path).
        if (uniqueViolation(error)) throw new QuotaReservationError('conflict');
        throw error;
      }
    },
    transition: async (tx, id, from, to, options) => (await tx.model('quotaReservation').updateMany({
      where: { id, status: from, ...(options.expiresAfter ? { expiresAt: { gt: options.expiresAfter } } : {}) },
      // RELEASED/EXPIRED free the resource key so a later attempt can charge it again.
      data: { status: to, updatedAt: options.at, finishedAt: options.at, reason: options.reason ?? null,
        ...(to === 'RELEASED' || to === 'EXPIRED' ? { activeResourceKey: null } : {}) },
    })).count === 1,
    charge: async (tx, reservation) => {
      // An active reservation already owns capacity. Converting it to usage keeps used+reserved
      // unchanged and must not invalidate an accepted operation after a later policy change.
      const changed = await tx.model('quotaUsage').updateMany({
        where: { ...where(reservation), used: { lte: 2147483647 - reservation.amount } },
        data: { used: { increment: reservation.amount }, updatedAt: new Date() },
      });
      if (changed.count !== 1) throw new Error('Captured quota usage is unavailable');
    },
    expire: async (tx, before) => (await tx.model('quotaReservation').updateMany({
      where: { ...(expiryId ? { id: expiryId } : {}), status: 'RESERVED', expiresAt: { lt: before } },
      data: { status: 'EXPIRED' satisfies QuotaReservationState, finishedAt: before, updatedAt: before, reason: 'reservation-expired',
        activeResourceKey: null },
    })).count,
  };
}
