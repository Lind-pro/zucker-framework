import { PLAN_PRICE_INTERVALS } from '@zucker-framework/fe-types/back-office';
import {
  PlanCatalogError, fromMinorUnits, toMinorUnits,
  type PlanCatalogStore, type PlanPrice, type SubscriptionPlanRecord, type SubscriptionPlanWrite,
} from '@zucker-framework/payment';
import type { ApplicationDatabase, ApplicationTransaction } from '../database';

interface StoredPrice {
  id: string; interval: PlanPrice['interval']; currency: string; amount: string; termDays: number | null;
  refs?: Array<{ provider: string; reference: string }>;
}
export interface StoredPlan extends Omit<SubscriptionPlanRecord, 'features' | 'quotas' | 'prices'> {
  features: unknown; quotas: unknown; prices?: StoredPrice[];
}
/** Prisma include that loads a plan with its prices and provider references. */
export const PLAN_INCLUDE = { prices: { include: { refs: true } } } as const;

function record(value: unknown): Record<string, never> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, never> : {};
}
/** Stored exact decimals are presented with the currency's minor-unit precision ("9.9" → "9.90"). */
function money(value: string, currency: string): string {
  try { return fromMinorUnits(toMinorUnits(value, currency), currency); } catch { return value; }
}
const intervalOrder = (interval: string) => PLAN_PRICE_INTERVALS.indexOf(interval as PlanPrice['interval']);
export function presentPrice(price: StoredPrice): PlanPrice {
  return { interval: price.interval, currency: price.currency, amount: money(price.amount, price.currency), termDays: price.termDays ?? null,
    providerRefs: Object.fromEntries((price.refs ?? []).map(ref => [ref.provider, ref.reference]).sort(([a], [b]) => a.localeCompare(b))) };
}
export function presentPlan(row: StoredPlan): SubscriptionPlanRecord {
  const { prices, features, quotas, ...plan } = row;
  return { ...plan, features: record(features), quotas: record(quotas),
    prices: [...(prices ?? [])].sort((a, b) => intervalOrder(a.interval) - intervalOrder(b.interval) || a.currency.localeCompare(b.currency))
      .map(presentPrice) };
}
function code(error: unknown): string | undefined {
  const value = (error as { code?: unknown; cause?: { code?: unknown } } | null);
  return typeof value?.code === 'string' ? value.code : typeof value?.cause?.code === 'string' ? value.cause.code : undefined;
}
/** Unique/FK violations map to the port's domain reasons; other storage errors propagate. */
function storageError(error: unknown): never {
  if (error instanceof PlanCatalogError) throw error;
  const kind = code(error);
  const message = error instanceof Error ? error.message : '';
  if (kind === 'P2002' || kind === '23505' || /Unique constraint/i.test(message))
    throw new PlanCatalogError('conflict', 'Plan slug or a provider price reference is already in use',
      ['slug or provider price reference already in use']);
  if (kind === 'P2003' || kind === '23503' || /Foreign key constraint/i.test(message))
    throw new PlanCatalogError('referenced', 'Plan is referenced by a subscription or a recorded payment');
  throw error;
}

/** Replaces a plan's price list, keeping the row id of each (interval, currency) that stays. */
async function replacePrices(tx: ApplicationTransaction, planId: string, prices: readonly PlanPrice[]): Promise<void> {
  const rows = tx.model('subscriptionPlanPrices'), refs = tx.model('subscriptionPlanPriceRefs');
  const current = await rows.findMany({ where: { planId } }) as StoredPrice[];
  // Drop every reference first so a reference can move between prices of this plan.
  if (current.length) await refs.deleteMany({ where: { priceId: { in: current.map(row => row.id) } } });
  const keep = new Set(prices.map(price => `${price.interval}\u0000${price.currency}`));
  const removed = current.filter(row => !keep.has(`${row.interval}\u0000${row.currency}`)).map(row => row.id);
  if (removed.length) await rows.deleteMany({ where: { id: { in: removed } } });
  for (const price of prices) {
    const existing = current.find(row => row.interval === price.interval && row.currency === price.currency);
    const fields = { amount: price.amount, termDays: price.termDays };
    const saved = existing
      ? await rows.update({ where: { id: existing.id }, data: { ...fields, updatedAt: new Date() } }) as StoredPrice
      : await rows.create({ data: { planId, interval: price.interval, currency: price.currency, ...fields } }) as StoredPrice;
    for (const [provider, reference] of Object.entries(price.providerRefs))
      await refs.create({ data: { priceId: saved.id, provider, reference } });
  }
}

/** `subscription_plans` + prices + provider references binding of the payment PlanCatalogStore port. */
export function createPlanCatalogStore(database: ApplicationDatabase): PlanCatalogStore {
  const read = async (tx: ApplicationDatabase | ApplicationTransaction, where: Record<string, unknown>) => {
    const row = await tx.model('subscriptionPlans').findUnique({ where, include: PLAN_INCLUDE }) as StoredPlan | null;
    return row ? presentPlan(row) : null;
  };
  return {
    async list(options) {
      const rows = await database.model('subscriptionPlans').findMany({ where: options?.listedOnly ? { status: true } : {},
        include: PLAN_INCLUDE, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }) as StoredPlan[];
      return rows.map(presentPlan);
    },
    findById: id => read(database, { id }),
    findBySlug: slug => read(database, { slug }),
    async create(data: SubscriptionPlanWrite) {
      try {
        return await database.transaction(async tx => {
          const { prices, ...plan } = data;
          const created = await tx.model('subscriptionPlans').create({ data: plan }) as { id: string };
          await replacePrices(tx, created.id, prices);
          return await read(tx, { id: created.id }) as SubscriptionPlanRecord;
        });
      } catch (error) { storageError(error); }
    },
    async update(id, data, options) {
      try {
        return await database.transaction(async tx => {
          // Serializes writers of this plan and makes the revision check atomic with the write.
          const locked = await tx.query<{ revision: number }>('SELECT revision FROM subscription_plans WHERE id=$1 FOR UPDATE', [id]);
          if (!locked.rows.length) return null;
          if (options.expectedRevision !== undefined && options.expectedRevision !== locked.rows[0].revision)
            throw new PlanCatalogError('conflict', 'The plan was changed by someone else; reload it and apply your edit again',
              ['stale plan revision']);
          const { prices, ...plan } = data;
          await tx.model('subscriptionPlans').update({ where: { id }, data: { ...plan, revision: { increment: 1 }, updatedAt: new Date() } });
          if (prices) await replacePrices(tx, id, prices);
          return read(tx, { id });
        });
      } catch (error) { storageError(error); }
    },
    async delete(id) {
      try {
        return await database.transaction(async tx => {
          // Lock the plan row so a concurrent assignment cannot reference it between check and delete.
          const locked = await tx.query<{ id: string }>('SELECT id FROM subscription_plans WHERE id=$1 FOR UPDATE', [id]);
          if (!locked.rows.length) return false;
          if (await tx.model('userSubscriptions').count({ where: { planId: id } }))
            throw new PlanCatalogError('referenced', 'Plan is referenced by a subscription');
          // An unsettled checkout or a live provider subscription for this plan still needs it for write-back.
          const billing = await tx.query<{ referenced: boolean }>(`SELECT
              EXISTS (SELECT 1 FROM billing_orders WHERE offer->'fulfillmentData'->'plan'->>'planId'=$1
                AND state <> 'unpaid' AND "fulfilledAt" IS NULL)
              OR EXISTS (SELECT 1 FROM billing_subscriptions WHERE offer->'fulfillmentData'->'plan'->>'planId'=$1
                AND status <> 'canceled') AS referenced`, [id]);
          if (billing.rows[0]?.referenced) throw new PlanCatalogError('referenced', 'Plan is referenced by an open order or a provider subscription');
          await tx.model('subscriptionPlans').delete({ where: { id } });
          return true;
        });
      } catch (error) { storageError(error); }
    },
  };
}
