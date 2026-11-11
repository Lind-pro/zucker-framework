import {
  BillingSubscriptionsService as HostBillingSubscriptionsService, type AccountAdapterSource, type BillingDatabase, type BillingExtensions,
  type BillingRefundsService,
} from '@zucker-framework/back-office/billing';
import type { SubscriptionAdapter } from '@zucker-framework/payment';
import { TEMPLATE_BILLING_PERSISTENCE } from './billing.config';

/** The host's subscription service over the template's billing and credit models. */
export class BillingSubscriptionsService extends HostBillingSubscriptionsService {
  constructor(database: BillingDatabase, adapters: readonly SubscriptionAdapter[] | AccountAdapterSource<SubscriptionAdapter>, webUrl: string,
    refunds?: Pick<BillingRefundsService, 'prepareCycle'>, extensions?: BillingExtensions) {
    super(database, adapters, webUrl, refunds, extensions, { persistence: TEMPLATE_BILLING_PERSISTENCE });
  }
}
