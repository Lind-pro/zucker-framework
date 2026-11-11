import { BillingCatalog as HostBillingCatalog, type BillingCatalogItem, type BillingPackOffers, type BillingPlanOffers } from '@zucker-framework/back-office/billing';
import type { ReferralProvider } from '@zucker-framework/fe-site';
import type { HostedCheckoutAdapter, SubscriptionAdapter } from '@zucker-framework/payment';
import { templateBillingReferrals } from './billing.config';

// The static catalog (`BILLING_CATALOG_JSON`) format and its validation live in the billing host.
export { readBillingCatalog, type BillingCatalogItem, type BillingPackOffers } from '@zucker-framework/back-office/billing';

/** The host catalog with the template's affiliate programs (`BILLING_REFERRAL_PROVIDERS`). */
export class BillingCatalog extends HostBillingCatalog {
  constructor(items: readonly BillingCatalogItem[] | (() => readonly BillingCatalogItem[]), providers: readonly HostedCheckoutAdapter[],
    referrals: readonly ReferralProvider[] = [], subscriptions: readonly SubscriptionAdapter[] = [],
    planOffers: () => BillingPlanOffers | null = () => null, packOffers: BillingPackOffers | null = null) {
    super(items, providers, templateBillingReferrals(referrals), subscriptions, planOffers, packOffers);
  }
}
