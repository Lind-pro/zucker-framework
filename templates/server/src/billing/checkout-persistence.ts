import { createCheckoutPersistence as createHostCheckoutPersistence, type BillingDatabase, type BillingExtensions } from '@zucker-framework/back-office/billing';
import type { HostedCheckoutPersistence } from '@zucker-framework/payment';
import { TEMPLATE_BILLING_PERSISTENCE } from './billing.config';

export { CHECKOUT_FULFILLED_OUTBOX_KIND } from '@zucker-framework/back-office/billing';

/** Hosted checkout persistence over the template's billing and credit models (see the billing host). */
export function createCheckoutPersistence(database: BillingDatabase, options: {
  extensions?: Pick<BillingExtensions, 'checkoutFulfilled'>; configRevision?: () => string | null;
} = {}): HostedCheckoutPersistence {
  return createHostCheckoutPersistence(database, TEMPLATE_BILLING_PERSISTENCE, options);
}
