import {
  bindCheckoutSubscription as bindHostCheckoutSubscription, createSubscriptionCyclePersistence as createHostCyclePersistence,
  type BillingDatabase, type BillingExecutionFence, type BillingExtensions, type BillingTransaction,
} from '@zucker-framework/back-office/billing';
import type { HostedCheckoutOrder, SubscriptionCyclePersistence } from '@zucker-framework/payment';
import { TEMPLATE_BILLING_PERSISTENCE } from './billing.config';

export {
  SUBSCRIPTION_RECONCILE_EVENT, type BillingSubscription, type SubscriptionExecutionFence,
} from '@zucker-framework/back-office/billing';

/** Called by hosted checkout on its existing transaction; a handoff is not a credit grant. */
export function bindCheckoutSubscription(tx: BillingTransaction, order: Readonly<HostedCheckoutOrder>): Promise<void> {
  return bindHostCheckoutSubscription(tx, order, TEMPLATE_BILLING_PERSISTENCE);
}
/** Subscription cycle persistence over the template's billing and credit models. */
export function createSubscriptionCyclePersistence(database: BillingDatabase, fence?: BillingExecutionFence,
  extensions?: Pick<BillingExtensions, 'cycleFulfilled'>): SubscriptionCyclePersistence {
  return createHostCyclePersistence(database, TEMPLATE_BILLING_PERSISTENCE, fence, extensions);
}
