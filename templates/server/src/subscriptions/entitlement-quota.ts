import type { DatabaseAdapter } from '@zucker-framework/core';
import { createQuotaReservationStore, createResourceChargeLookup } from '@zucker-framework/back-office/subscriptions';
import { SUBSCRIPTION_STORAGE } from './storage';

/** Plan counters: the quota reservation store with the explicit unlimited plan quota (`-1`) accepted. */
export const createPlanQuotaStore = (database: DatabaseAdapter, transaction?: DatabaseAdapter) =>
  createQuotaReservationStore(database, SUBSCRIPTION_STORAGE, { transaction, allowUnlimited: true });
/** Prior-charge lookup of metered resources (one live charge per subject, counter and resource). */
export const resourceChargeLookup = createResourceChargeLookup(SUBSCRIPTION_STORAGE);
