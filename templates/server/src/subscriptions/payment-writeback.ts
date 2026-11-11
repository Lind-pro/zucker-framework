import type { DatabaseAdapter } from '@zucker-framework/core';
import { createPlanFulfillmentHooks, type PlanFulfillmentHooks } from '@zucker-framework/back-office/subscriptions';
import { SUBSCRIPTION_STORAGE } from './storage';

export { PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, PLAN_TERM_CHANGED_OUTBOX_KIND } from '@zucker-framework/back-office/subscriptions';

/** Plan entitlement write-back for BillingService (events go to `billing_outbox`). */
export const planFulfillmentHooks = (database: DatabaseAdapter): PlanFulfillmentHooks => createPlanFulfillmentHooks(database, SUBSCRIPTION_STORAGE);
