import { Logger } from '@nestjs/common';
import { CreditPackCatalogError, validateCreditPackWrite, type CreditPackWrite } from '@zucker-framework/payment';
import type { StarterDataSeed } from '../accounts/create-administrator';
import { ApplicationTransaction } from '../database';
import type { BillingCatalogItem } from './catalog';

const logger = new Logger('CreditPackSeeds');

/**
 * Initial credit packs from BILLING_CATALOG_JSON one-time (`payment`) offers: slug = offer id, one
 * price in the offer's currency with its provider references, listed. Subscription offers seed plans
 * instead (subscriptions/plan-seeds.ts).
 */
export function creditPackSeedsFromBillingCatalog(items: readonly BillingCatalogItem[]): CreditPackWrite[] {
  return items.filter(item => item.mode === 'payment').map((item, order) => ({
    slug: item.id, title: item.title, titleI18n: {}, description: null, descriptionI18n: {},
    credits: item.credits, expiresInDays: item.expiresInDays, status: true, order,
    prices: [{ currency: item.currency, amount: item.amount,
      providerRefs: Object.fromEntries(Object.entries(item.providers).filter(([, ref]) => !!ref)) as Record<string, string> }],
  }));
}

export const CREDIT_PACK_SEED_MARKER = 'credit-packs';

/**
 * One-time seed, inside the caller's transaction. The durable marker `starter_data_markers.credit-packs`
 * is written with the first seeded packs, so packs an administrator edited or deleted (even every one
 * of them) are never recreated or changed; a table that already holds packs counts as seeded too. Each seed passes the administrator
 * write validation; an invalid seed (or one whose provider reference is taken) is skipped with a
 * warning so it never aborts administrator creation. Returns the number of packs created.
 */
export async function seedCreditPacks(tx: ApplicationTransaction, seeds: readonly CreditPackWrite[]): Promise<number> {
  if (!seeds.length) return 0;
  // Concurrent setup runs serialize here; the emptiness check below is then authoritative.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':credit-packs:seed', 0))::text AS locked");
  // The marker commits (or rolls back) with the packs; an existing marker means "seeded once already".
  const marked = await tx.query<{ name: string }>(`INSERT INTO starter_data_markers ("name") VALUES ($1) ON CONFLICT DO NOTHING RETURNING "name"`, [CREDIT_PACK_SEED_MARKER]);
  if (!marked.rows.length) return 0;
  if (await tx.model('creditPacks').count({})) return 0;
  let created = 0;
  for (const raw of seeds) {
    let seed: CreditPackWrite;
    try {
      seed = validateCreditPackWrite(raw, { partial: false }) as CreditPackWrite;
    } catch (error) {
      if (!(error instanceof CreditPackCatalogError)) throw error;
      logger.warn(`Skipped credit pack seed ${JSON.stringify(String(raw?.slug ?? '(unnamed)').slice(0, 64))}: ${error.issues.join('; ') || error.message}`);
      continue;
    }
    if (await tx.model('creditPacks').findUnique({ where: { slug: seed.slug } })) continue;
    const { prices, ...pack } = seed;
    const row = await tx.model('creditPacks').create({ data: pack }) as { id: string };
    for (const price of prices) {
      const saved = await tx.model('creditPackPrices').create({ data: { packId: row.id, currency: price.currency, amount: price.amount } }) as { id: string };
      for (const [provider, reference] of Object.entries(price.providerRefs))
        if (!(await tx.model('creditPackPriceRefs').count({ where: { provider, reference } })))
          await tx.model('creditPackPriceRefs').create({ data: { priceId: saved.id, provider, reference } });
    }
    created++;
  }
  return created;
}

/** `seedCreditPacks` as a starter-data contribution for administrator setup (`pnpm account:admin`). */
export function creditPackStarterSeed(seeds: readonly CreditPackWrite[]): StarterDataSeed {
  return { name: 'credit-packs', run: async tx => {
    if (!(tx instanceof ApplicationTransaction)) throw new Error('Application transaction is required');
    await seedCreditPacks(tx, seeds);
  } };
}
