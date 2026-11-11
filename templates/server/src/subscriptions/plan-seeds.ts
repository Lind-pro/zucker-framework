import { Logger } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { SubscriptionPlanWrite } from '@zucker-framework/payment';
import { planSeedsFromOffers, seedPlans as seed } from '@zucker-framework/back-office/subscriptions';
import type { BillingCatalogItem } from '../billing/catalog';
import { APP_ENTITLEMENT_CATALOG } from './entitlement-catalog';
import { SUBSCRIPTION_STORAGE } from './storage';

const logger = new Logger('PlanSeeds');

/**
 * Initial plans from BILLING_CATALOG_JSON subscription offers (slug = offer id). Afterwards the database
 * is the only source of plan prices, and a seeded plan claims its static offer (BillingCatalog).
 */
export const planSeedsFromBillingCatalog = (items: readonly BillingCatalogItem[]): SubscriptionPlanWrite[] => planSeedsFromOffers(items);

/** Creates missing plans inside the administrator setup transaction; invalid seeds are logged and skipped. */
export const seedPlans = (tx: DatabaseAdapter, seeds: readonly SubscriptionPlanWrite[]): Promise<number> =>
  seed(tx, seeds, { catalog: APP_ENTITLEMENT_CATALOG, storage: SUBSCRIPTION_STORAGE,
    onSkip: (slug, issues) => logger.warn(`Skipped plan seed ${JSON.stringify(slug)}: ${issues.join('; ')}`) });
