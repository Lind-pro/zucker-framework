import { Logger } from '@nestjs/common';
import { validatePlanGrant } from '@zucker-framework/credit';
import { PlanCatalogError, validatePlanWrite, type PlanPrice, type SubscriptionPlanWrite } from '@zucker-framework/payment';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { BillingCatalogItem } from '../billing/catalog';
import { APP_ENTITLEMENT_CATALOG } from './entitlement-catalog';
import { creditExpiryColumns } from './plan-catalog.store';

const logger = new Logger('PlanSeeds');

/**
 * Initial plans from BILLING_CATALOG_JSON subscription offers (slug = offer id): one monthly price in
 * the offer's currency with the offer's provider references and credits. Plans are seeded listed with no features
 * or quotas; administrators then edit grants and prices in the back office. Afterwards the database is
 * the only source of plan prices: seeding never updates an existing slug, and a seeded plan claims
 * its static offer so checkout sells the plan (BillingCatalog), never the static entry.
 */
export function planSeedsFromBillingCatalog(items: readonly BillingCatalogItem[]): SubscriptionPlanWrite[] {
  return items.filter(item => item.mode === 'subscription').map((item, order) => {
    const providerRefs = Object.fromEntries(Object.entries(item.providers)
      .filter(([provider, ref]) => !!ref && (provider !== 'stripe' || /^price_[A-Za-z0-9]{1,250}$/.test(ref)))) as Record<string, string>;
    // The offer's credits become the plan price's per-cycle credits (days-based expiry kept as is).
    const price: PlanPrice = { interval: 'month', currency: item.currency, amount: item.amount, termDays: null, providerRefs,
      credits: item.credits, creditExpiry: item.expiresInDays };
    return { slug: item.id, name: item.title, description: null, status: true, order, features: {}, quotas: {}, prices: [price] };
  });
}

/**
 * Creates missing plans (and their prices) inside the caller's transaction; a taken provider
 * reference is dropped. Every seed passes the same validation and normalization as an administrator
 * plan write (slug format, name length, exact currency amounts, grants against the entitlement
 * catalog); an invalid seed is skipped with a warning so it never aborts administrator creation.
 */
export async function seedPlans(tx: DatabaseAdapter, seeds: readonly SubscriptionPlanWrite[]): Promise<number> {
  let created = 0;
  for (const raw of seeds) {
    let seed: SubscriptionPlanWrite;
    try {
      seed = validatePlanWrite(raw, { validateGrant: grant => validatePlanGrant(APP_ENTITLEMENT_CATALOG, grant), partial: false }) as SubscriptionPlanWrite;
    } catch (error) {
      if (!(error instanceof PlanCatalogError)) throw error;
      const slug = typeof raw?.slug === 'string' ? raw.slug.slice(0, 64) : '(unnamed)';
      logger.warn(`Skipped plan seed ${JSON.stringify(slug)}: ${error.issues.join('; ') || error.message}`);
      continue;
    }
    if (await tx.model('subscriptionPlans').findUnique({ where: { slug: seed.slug } })) continue;
    const { prices, ...plan } = seed;
    const row = await tx.model('subscriptionPlans').create({ data: plan }) as { id: string };
    for (const price of prices) {
      const saved = await tx.model('subscriptionPlanPrices').create({ data: { planId: row.id, interval: price.interval,
        currency: price.currency, amount: price.amount, termDays: price.termDays, ...creditExpiryColumns(price) } }) as { id: string };
      for (const [provider, reference] of Object.entries(price.providerRefs))
        if (!(await tx.model('subscriptionPlanPriceRefs').count({ where: { provider, reference } })))
          await tx.model('subscriptionPlanPriceRefs').create({ data: { priceId: saved.id, provider, reference } });
    }
    created++;
  }
  return created;
}
