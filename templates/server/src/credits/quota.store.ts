import type { DatabaseAdapter } from '@zucker-framework/core';
import { createQuotaReservationStore } from '@zucker-framework/back-office/subscriptions';
import { SUBSCRIPTION_STORAGE } from '../subscriptions/storage';

export type { CapturedQuotaInput, StoredQuotaReservation } from '@zucker-framework/back-office/subscriptions';
export { activeResourceKey } from '@zucker-framework/back-office/subscriptions';

/** Counter reservations (`quota_usage`/`quota_reservations`); all writers take the same subject/counter lock. */
export const createQuotaStore = (database: DatabaseAdapter, transaction?: DatabaseAdapter, expiryId?: string) =>
  createQuotaReservationStore(database, SUBSCRIPTION_STORAGE, { transaction, expiryId });
