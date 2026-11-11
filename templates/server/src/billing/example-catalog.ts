import type { CreditPackWrite, SubscriptionPlanWrite } from '@zucker-framework/payment';
import type { BillingCatalogItem } from './catalog';
import { creditPackSeedsFromBillingCatalog } from './credit-pack-seeds';
import { planSeedsFromBillingCatalog } from '../subscriptions/plan-seeds';

/**
 * Example plans and credit pack seeded by `pnpm setup:admin` when BILLING_CATALOG_JSON has no offers,
 * so a new site shows a complete pricing page from day one. They carry no provider references and are
 * therefore shown as "not purchasable" until an administrator adds a provider price reference in the
 * back office (Plans / Credit packs). Edit or delete them freely: seeding runs once and never
 * recreates them.
 */
export const EXAMPLE_PLAN_SEEDS: readonly SubscriptionPlanWrite[] = Object.freeze([
  { slug: 'starter', name: 'Starter', description: 'Example plan: edit or delete it in the back office.', status: true, order: 0, features: {}, quotas: {},
    prices: [{ interval: 'month', currency: 'USD', amount: '9.00', termDays: null, providerRefs: {}, credits: 500, creditExpiry: 'period' }] },
  { slug: 'pro', name: 'Pro', description: 'Example plan: edit or delete it in the back office.', status: true, order: 1, features: {}, quotas: {},
    prices: [{ interval: 'month', currency: 'USD', amount: '29.00', termDays: null, providerRefs: {}, credits: 2000, creditExpiry: 'period' }] },
]);
export const EXAMPLE_CREDIT_PACK_SEEDS: readonly CreditPackWrite[] = Object.freeze([
  { slug: 'credits-1000', title: '1,000 credits', titleI18n: {}, description: 'Example credit pack: edit or delete it in the back office.', descriptionI18n: {},
    credits: 1000, expiresInDays: 365, status: true, order: 0, prices: [{ currency: 'USD', amount: '10.00', providerRefs: {} }] },
]);

/** Plan and credit-pack seeds for administrator setup: the configured catalog, else the examples above. */
export function starterBillingSeeds(catalog: readonly BillingCatalogItem[]): { plans: SubscriptionPlanWrite[]; packs: CreditPackWrite[] } {
  if (catalog.length) return { plans: planSeedsFromBillingCatalog(catalog), packs: creditPackSeedsFromBillingCatalog(catalog) };
  return { plans: [...EXAMPLE_PLAN_SEEDS], packs: [...EXAMPLE_CREDIT_PACK_SEEDS] };
}
