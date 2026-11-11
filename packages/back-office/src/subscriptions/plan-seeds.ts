import type { DatabaseAdapter } from '@zucker-framework/core';
import { validatePlanGrant, type EntitlementCatalog } from '@zucker-framework/credit';
import { PlanCatalogError, validatePlanWrite, type PlanPrice, type SubscriptionPlanWrite } from '@zucker-framework/payment';
import { creditExpiryColumns } from './plan-catalog.store';
import type { SubscriptionsStorage } from './storage';

/** A static subscription offer (the shape of a billing catalog entry) a plan can be seeded from. */
export interface PlanSeedOffer {
  id: string;
  mode: 'payment' | 'subscription';
  title: string;
  currency: string;
  amount: string;
  providers: Readonly<Record<string, string | null | undefined>>;
  credits?: number;
  expiresInDays?: number | null;
}

/**
 * Initial plans from static subscription offers (slug = offer id): one monthly price in the offer's
 * currency with its provider references and credits; listed, with no features or quotas.
 * Administrators then edit grants and prices; seeding never updates an existing slug.
 */
export function planSeedsFromOffers(items: readonly PlanSeedOffer[]): SubscriptionPlanWrite[] {
  return items.filter(item => item.mode === 'subscription').map((item, order) => {
    const providerRefs = Object.fromEntries(Object.entries(item.providers)
      .filter(([provider, ref]) => !!ref && (provider !== 'stripe' || /^price_[A-Za-z0-9]{1,250}$/.test(ref)))) as Record<string, string>;
    const price: PlanPrice = { interval: 'month', currency: item.currency, amount: item.amount, termDays: null, providerRefs,
      credits: item.credits ?? 0, creditExpiry: item.expiresInDays ?? null };
    return { slug: item.id, name: item.title, description: null, status: true, order, features: {}, quotas: {}, prices: [price] };
  });
}

export interface SeedPlansOptions {
  /** Grants are validated against this catalog. */
  catalog: EntitlementCatalog;
  storage: SubscriptionsStorage;
  /** Called for every skipped (invalid) seed. Default: `console.warn`. */
  onSkip?: (slug: string, issues: readonly string[]) => void;
}

/**
 * Creates missing plans (and their prices) inside the caller's transaction; a taken provider
 * reference is dropped. Every seed passes the same validation and normalization as an administrator
 * plan write; an invalid seed is skipped (reported through `onSkip`) and never aborts the caller.
 * Returns the number of plans created. Run it from an explicit setup command, not at every boot.
 */
export async function seedPlans(tx: DatabaseAdapter, seeds: readonly SubscriptionPlanWrite[], options: SeedPlansOptions): Promise<number> {
  const models = options.storage.of(tx);
  const skip = options.onSkip ?? ((slug, issues) => console.warn(`[back-office/subscriptions] skipped plan seed ${JSON.stringify(slug)}: ${issues.join('; ')}`));
  let created = 0;
  for (const raw of seeds) {
    let seed: SubscriptionPlanWrite;
    try {
      seed = validatePlanWrite(raw, { validateGrant: grant => validatePlanGrant(options.catalog, grant), partial: false }) as SubscriptionPlanWrite;
    } catch (error) {
      if (!(error instanceof PlanCatalogError)) throw error;
      skip(typeof raw?.slug === 'string' ? raw.slug.slice(0, 64) : '(unnamed)', error.issues.length ? error.issues : [error.message]);
      continue;
    }
    if (await models.plans.count({ where: { slug: seed.slug } })) continue;
    const { prices, ...plan } = seed;
    const row = await models.plans.create({ data: { ...plan, ...options.storage.planRowExtras?.(seed, 'create') } }) as { id: string };
    for (const price of prices) {
      const saved = await models.planPrices.create({ data: { planId: row.id, interval: price.interval,
        currency: price.currency, amount: price.amount, termDays: price.termDays, ...creditExpiryColumns(price) } }) as { id: string };
      for (const [provider, reference] of Object.entries(price.providerRefs))
        if (!(await models.planPriceRefs.count({ where: { provider, reference } })))
          await models.planPriceRefs.create({ data: { priceId: saved.id, provider, reference } });
    }
    created++;
  }
  return created;
}
