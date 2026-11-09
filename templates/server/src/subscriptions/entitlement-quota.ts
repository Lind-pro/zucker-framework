import { UNLIMITED_QUOTA, type QuotaReservationStore, type ResourceChargeLookup } from '@zucker-framework/credit';
import type { ApplicationDatabase, ApplicationTransaction } from '../database';
import { activeResourceKey, createQuotaStore, type CapturedQuotaInput, type StoredQuotaReservation } from '../credits/quota.store';

/**
 * Plan counters reuse the template's quota reservation store (same lock, capacity and charge
 * rules). An explicit unlimited plan quota (`-1`) skips the capacity check but still records usage.
 */
export function createPlanQuotaStore(database: ApplicationDatabase, transaction?: ApplicationTransaction):
QuotaReservationStore<ApplicationTransaction, StoredQuotaReservation, CapturedQuotaInput> {
  const base = createQuotaStore(database, transaction);
  return {
    ...base,
    async assertCapacity(tx, input) {
      if (input.limit !== UNLIMITED_QUOTA) return base.assertCapacity(tx, input);
      await tx.query(`INSERT INTO quota_usage ("subjectId","counter","period","limit") VALUES ($1,$2,$3,-1)
        ON CONFLICT ("subjectId","counter","period") DO UPDATE SET "limit"=-1,"updatedAt"=$4`,
      [input.subjectId, input.counter, input.period, new Date()]);
    },
  };
}

/**
 * Prior-charge lookup by the reservation's storage key (one RESERVED/CONFIRMED row per subject,
 * counter and resource). Runs on the reservation transaction after the subject/counter lock.
 */
export const resourceChargeLookup: ResourceChargeLookup<ApplicationTransaction> = {
  async findActiveCharge(tx, query) {
    const result = await tx.query<{ status: 'CONFIRMED' | 'RESERVED' }>(`SELECT status FROM quota_reservations
      WHERE "activeResourceKey"=$1 AND id<>$2 AND (status='CONFIRMED' OR (status='RESERVED' AND "expiresAt">$3))`,
    [activeResourceKey(query), query.exceptReservationId ?? '', query.now]);
    return result.rows[0]?.status ?? null;
  },
  async expireStale(tx, query) {
    const result = await tx.query<{ id: string }>(`UPDATE quota_reservations SET status='EXPIRED', "activeResourceKey"=NULL,
        "finishedAt"=$2, "updatedAt"=$2, reason='reservation-expired'
      WHERE "activeResourceKey"=$1 AND status='RESERVED' AND "expiresAt"<=$2 RETURNING id`, [activeResourceKey(query), query.now]);
    return result.rows.length;
  },
};
