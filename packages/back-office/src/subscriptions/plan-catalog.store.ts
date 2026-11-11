import type { DatabaseAdapter } from '@zucker-framework/core';
import { PLAN_PRICE_INTERVALS } from '@zucker-framework/fe-types/back-office';
import {
  PlanCatalogError, fromMinorUnits, toMinorUnits,
  type PlanCatalogStore, type PlanPrice, type SubscriptionPlanRecord, type SubscriptionPlanWrite,
} from '@zucker-framework/payment';
import { isForeignKeyViolation, isUniqueViolation, type SubscriptionsModels, type SubscriptionsStorage } from './storage';

/** A price row as stored (amount is an exact decimal string). */
export interface StoredPlanPrice {
  id: string; planId?: string; interval: PlanPrice['interval']; currency: string; amount: string; termDays: number | null;
  credits?: number; creditExpiryPeriod?: boolean; creditExpiryDays?: number | null;
  refs?: Array<{ provider: string; reference: string }>;
}
type PresentationField = 'featured' | 'badge' | 'highlights' | 'nameI18n' | 'descriptionI18n' | 'badgeI18n' | 'highlightsI18n';
/** A plan row as stored, with its prices (and their provider references) attached. */
export interface StoredPlan extends Omit<SubscriptionPlanRecord, 'features' | 'quotas' | 'prices' | PresentationField> {
  features: unknown; quotas: unknown; prices?: StoredPlanPrice[];
  featured?: boolean; badge?: string | null; highlights?: unknown; nameI18n?: unknown; descriptionI18n?: unknown;
  badgeI18n?: unknown; highlightsI18n?: unknown;
}

function record(value: unknown): Record<string, never> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, never> : {};
}
/** Stored exact decimals are presented with the currency's minor-unit precision ("9.9" → "9.90"). */
function money(value: unknown, currency: string): string {
  const text = String(value);
  try { return fromMinorUnits(toMinorUnits(text, currency), currency); } catch { return text; }
}
const intervalOrder = (interval: string) => PLAN_PRICE_INTERVALS.indexOf(interval as PlanPrice['interval']);
/** Plan price credit expiry ↔ its two typed columns. */
export function creditExpiryColumns(price: Pick<PlanPrice, 'credits' | 'creditExpiry'>) {
  const expiry = price.credits ? price.creditExpiry ?? null : null;
  return { credits: price.credits ?? 0, creditExpiryPeriod: expiry === 'period', creditExpiryDays: typeof expiry === 'number' ? expiry : null };
}
export function presentPrice(price: StoredPlanPrice): PlanPrice {
  return { interval: price.interval, currency: price.currency, amount: money(price.amount, price.currency), termDays: price.termDays ?? null,
    providerRefs: Object.fromEntries((price.refs ?? []).map(ref => [ref.provider, ref.reference]).sort(([a], [b]) => a.localeCompare(b))),
    credits: price.credits ?? 0,
    creditExpiry: price.creditExpiryPeriod ? 'period' : price.creditExpiryDays ?? null };
}
function texts(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value) as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
/** Only the plan fields of the port; other stored columns (legacy prices, provider ids) never leak. */
export function presentPlan(row: StoredPlan): SubscriptionPlanRecord {
  return {
    id: row.id, slug: row.slug, name: row.name, description: row.description ?? null, status: row.status, order: row.order,
    revision: row.revision ?? 0, createdAt: row.createdAt, updatedAt: row.updatedAt,
    features: record(row.features), quotas: record(row.quotas),
    featured: row.featured === true, badge: row.badge ?? null, highlights: list(row.highlights), nameI18n: texts(row.nameI18n),
    descriptionI18n: texts(row.descriptionI18n), badgeI18n: texts(row.badgeI18n),
    highlightsI18n: Object.fromEntries(Object.entries(record(row.highlightsI18n) as Record<string, unknown>).map(([locale, items]) => [locale, list(items)])),
    prices: [...(row.prices ?? [])].sort((a, b) => intervalOrder(a.interval) - intervalOrder(b.interval) || a.currency.localeCompare(b.currency))
      .map(presentPrice),
  } as SubscriptionPlanRecord;
}

/** Attaches prices and their provider references to plan rows (explicit reads: no relation includes). */
export async function attachPrices(models: SubscriptionsModels, plans: StoredPlan[]): Promise<StoredPlan[]> {
  if (!plans.length) return plans;
  const prices = await models.planPrices.findMany({ where: { planId: { in: plans.map(plan => plan.id) } } }) as unknown as StoredPlanPrice[];
  const refs = prices.length
    ? await models.planPriceRefs.findMany({ where: { priceId: { in: prices.map(price => price.id) } } }) as unknown as Array<{ priceId: string; provider: string; reference: string }>
    : [];
  return plans.map(plan => ({ ...plan, prices: prices.filter(price => price.planId === plan.id)
    .map(price => ({ ...price, refs: refs.filter(ref => ref.priceId === price.id) })) }));
}
/** One plan with its prices, or null. */
export async function loadPlan(models: SubscriptionsModels, where: { id: string } | { slug: string }): Promise<StoredPlan | null> {
  const row = await models.plans.findUnique({ where }) as unknown as StoredPlan | null;
  return row ? (await attachPrices(models, [row]))[0] : null;
}
/** Plans by id with their prices, keyed by id. */
export async function loadPlans(models: SubscriptionsModels, ids: readonly string[]): Promise<Map<string, StoredPlan>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await models.plans.findMany({ where: { id: { in: unique } } }) as unknown as StoredPlan[];
  return new Map((await attachPrices(models, rows)).map(plan => [plan.id, plan]));
}

/** Unique/FK violations map to the port's domain reasons; other storage errors propagate. */
function storageError(error: unknown): never {
  if (error instanceof PlanCatalogError) throw error;
  if (isUniqueViolation(error))
    throw new PlanCatalogError('conflict', 'Plan slug or a provider price reference is already in use',
      ['slug or provider price reference already in use']);
  if (isForeignKeyViolation(error))
    throw new PlanCatalogError('referenced', 'Plan is referenced by a subscription or a recorded payment');
  throw error;
}

/** Replaces a plan's price list, keeping the row id of each (interval, currency) that stays. */
async function replacePrices(models: SubscriptionsModels, planId: string, prices: readonly PlanPrice[]): Promise<void> {
  const current = await models.planPrices.findMany({ where: { planId } }) as unknown as StoredPlanPrice[];
  // Drop every reference first so a reference can move between prices of this plan.
  if (current.length) await models.planPriceRefs.deleteMany({ where: { priceId: { in: current.map(row => row.id) } } });
  const keep = new Set(prices.map(price => `${price.interval}\u0000${price.currency}`));
  const removed = current.filter(row => !keep.has(`${row.interval}\u0000${row.currency}`)).map(row => row.id);
  if (removed.length) await models.planPrices.deleteMany({ where: { id: { in: removed } } });
  for (const price of prices) {
    const existing = current.find(row => row.interval === price.interval && row.currency === price.currency);
    const fields = { amount: price.amount, termDays: price.termDays, ...creditExpiryColumns(price) };
    const saved = existing
      ? await models.planPrices.update({ where: { id: existing.id }, data: { ...fields, updatedAt: new Date() } }) as unknown as StoredPlanPrice
      : await models.planPrices.create({ data: { planId, interval: price.interval, currency: price.currency, ...fields } }) as unknown as StoredPlanPrice;
    for (const [provider, reference] of Object.entries(price.providerRefs))
      await models.planPriceRefs.create({ data: { priceId: saved.id, provider, reference } });
  }
}

/**
 * Plans + prices + provider references binding of the payment `PlanCatalogStore` port over a
 * `DatabaseAdapter`. Revisions are compare-and-set updates (no SQL); deletion refuses plans that a
 * subscription, the payment ledger (foreign key) or the billing link still references.
 */
export function createPlanCatalogStore(database: DatabaseAdapter, storage: SubscriptionsStorage): PlanCatalogStore {
  const read = async (db: DatabaseAdapter, where: { id: string } | { slug: string }) => {
    const row = await loadPlan(storage.of(db), where);
    return row ? presentPlan(row) : null;
  };
  return {
    async list(options) {
      const models = storage.of(database);
      const rows = await models.plans.findMany({ where: options?.listedOnly ? { status: true } : {},
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }) as unknown as StoredPlan[];
      return (await attachPrices(models, rows)).map(presentPlan);
    },
    findById: id => read(database, { id }),
    findBySlug: slug => read(database, { slug }),
    async create(data: SubscriptionPlanWrite) {
      try {
        return await database.$transaction(async tx => {
          const models = storage.of(tx);
          const { prices, ...plan } = data;
          const created = await models.plans.create({ data: { ...plan, ...storage.planRowExtras?.(data, 'create') } }) as { id: string };
          await replacePrices(models, created.id, prices);
          return await read(tx, { id: created.id }) as SubscriptionPlanRecord;
        });
      } catch (error) { storageError(error); }
    },
    async update(id, data, options) {
      try {
        return await database.$transaction(async tx => {
          const models = storage.of(tx);
          const { prices, ...plan } = data;
          // Compare-and-set on the revision; the row lock taken by the update serializes later writers
          // of this plan until commit, and they then re-check the revision they expect.
          const changed = await models.plans.updateMany({
            where: options.expectedRevision !== undefined ? { id, revision: options.expectedRevision } : { id },
            data: { ...plan, ...storage.planRowExtras?.(data, 'update'), revision: { increment: 1 }, updatedAt: new Date() },
          });
          if (changed.count !== 1) {
            if (!(await models.plans.count({ where: { id } }))) return null;
            throw new PlanCatalogError('conflict', 'The plan was changed by someone else; reload it and apply your edit again',
              ['stale plan revision']);
          }
          if (prices) await replacePrices(models, id, prices);
          return read(tx, { id });
        });
      } catch (error) { storageError(error); }
    },
    async delete(id) {
      try {
        return await database.$transaction(async tx => {
          const models = storage.of(tx);
          // Waits for assignments/write-backs holding the shared plan lock; new ones wait for this commit.
          await storage.locks.plan(tx, id, 'exclusive');
          // Row-lock the plan for the rest of the transaction (no-op write) before the reference checks.
          if ((await models.plans.updateMany({ where: { id }, data: { updatedAt: new Date() } })).count !== 1) return false;
          if (await models.subscriptions.count({ where: { planId: id } }))
            throw new PlanCatalogError('referenced', 'Plan is referenced by a subscription');
          if (await models.subscriptionPayments.count({ where: { planId: id } }))
            throw new PlanCatalogError('referenced', 'Plan is referenced by a recorded payment');
          // An unsettled checkout or a live provider subscription for this plan still needs it for write-back.
          if (await storage.billingLink?.planReferenced(tx, id))
            throw new PlanCatalogError('referenced', 'Plan is referenced by an open order or a provider subscription');
          const prices = await models.planPrices.findMany({ where: { planId: id }, select: { id: true } }) as unknown as Array<{ id: string }>;
          if (prices.length) {
            await models.planPriceRefs.deleteMany({ where: { priceId: { in: prices.map(price => price.id) } } });
            await models.planPrices.deleteMany({ where: { planId: id } });
          }
          await models.plans.delete({ where: { id } });
          return true;
        });
      } catch (error) { storageError(error); }
    },
  };
}
