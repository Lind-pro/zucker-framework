import {
  CreditPackCatalogError, fromMinorUnits, toMinorUnits,
  type CreditPackPrice, type CreditPackRecord, type CreditPackStore, type CreditPackWrite,
} from '@zucker-framework/payment';
import { billingTransaction, DEFAULT_BILLING_STORAGE, type BillingDatabase, type BillingStorage, type BillingTransaction } from './billing.database';

interface StoredPackPrice {
  id: string; currency: string; amount: string;
  refs?: Array<{ provider: string; reference: string }>;
}
interface StoredPack extends Omit<CreditPackRecord, 'prices' | 'titleI18n' | 'descriptionI18n'> {
  titleI18n: unknown; descriptionI18n: unknown; prices?: StoredPackPrice[];
}
/** Prisma include that loads a pack with its prices and provider references. */
export const CREDIT_PACK_INCLUDE = { prices: { include: { refs: true } } } as const;

function texts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function money(value: string, currency: string): string {
  try { return fromMinorUnits(toMinorUnits(value, currency), currency); } catch { return value; }
}
function presentPrice(price: StoredPackPrice): CreditPackPrice {
  return { currency: price.currency, amount: money(price.amount, price.currency),
    providerRefs: Object.fromEntries((price.refs ?? []).map(ref => [ref.provider, ref.reference]).sort(([a], [b]) => a.localeCompare(b))) };
}
export function presentCreditPack(row: StoredPack): CreditPackRecord {
  const { prices, titleI18n, descriptionI18n, ...pack } = row;
  return { ...pack, titleI18n: texts(titleI18n), descriptionI18n: texts(descriptionI18n),
    prices: [...(prices ?? [])].sort((a, b) => a.currency.localeCompare(b.currency)).map(presentPrice) };
}

function code(error: unknown): string | undefined {
  const value = (error as { code?: unknown; cause?: { code?: unknown } } | null);
  return typeof value?.code === 'string' ? value.code : typeof value?.cause?.code === 'string' ? value.cause.code : undefined;
}
function storageError(error: unknown): never {
  if (error instanceof CreditPackCatalogError) throw error;
  const kind = code(error);
  const message = error instanceof Error ? error.message : '';
  if (kind === 'P2002' || kind === '23505' || /Unique constraint/i.test(message))
    throw new CreditPackCatalogError('conflict', 'Credit pack slug or a provider price reference is already in use',
      ['slug or provider price reference already in use']);
  throw error;
}

/** Replaces a pack's price list, keeping the row id of each currency that stays. */
async function replacePrices(storage: BillingStorage, tx: BillingTransaction, packId: string, prices: readonly CreditPackPrice[]): Promise<void> {
  const rows = storage.model(tx, 'creditPackPrices'), refs = storage.model(tx, 'creditPackPriceRefs');
  const current = await rows.findMany({ where: { packId } }) as StoredPackPrice[];
  // Drop every reference first so a reference can move between prices of this pack.
  if (current.length) await refs.deleteMany({ where: { priceId: { in: current.map(row => row.id) } } });
  const keep = new Set(prices.map(price => price.currency));
  const removed = current.filter(row => !keep.has(row.currency)).map(row => row.id);
  if (removed.length) await rows.deleteMany({ where: { id: { in: removed } } });
  for (const price of prices) {
    const existing = current.find(row => row.currency === price.currency);
    const saved = existing
      ? await rows.update({ where: { id: existing.id }, data: { amount: price.amount, updatedAt: new Date() } }) as StoredPackPrice
      : await rows.create({ data: { packId, currency: price.currency, amount: price.amount } }) as StoredPackPrice;
    for (const [provider, reference] of Object.entries(price.providerRefs))
      await refs.create({ data: { priceId: saved.id, provider, reference } });
  }
}

/**
 * Credit packs + prices + provider references binding of the payment CreditPackStore port (models
 * `creditPacks`, `creditPackPrices`, `creditPackPriceRefs` with Prisma relations `prices` and `refs`).
 */
export function createCreditPackStore(database: BillingDatabase, storage: BillingStorage = DEFAULT_BILLING_STORAGE): CreditPackStore {
  const t = storage.t;
  const read = async (tx: BillingDatabase | BillingTransaction, where: Record<string, unknown>) => {
    const row = await storage.model(tx, 'creditPacks').findUnique({ where, include: CREDIT_PACK_INCLUDE }) as StoredPack | null;
    return row ? presentCreditPack(row) : null;
  };
  return {
    async list(options) {
      const rows = await storage.model(database, 'creditPacks').findMany({ where: options?.listedOnly ? { status: true } : {},
        include: CREDIT_PACK_INCLUDE, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }) as StoredPack[];
      return rows.map(presentCreditPack);
    },
    findById: id => read(database, { id }),
    findBySlug: slug => read(database, { slug }),
    async create(data: CreditPackWrite) {
      try {
        return await billingTransaction(database, async tx => {
          const { prices, ...pack } = data;
          const created = await storage.model(tx, 'creditPacks').create({ data: pack }) as { id: string };
          await replacePrices(storage, tx, created.id, prices);
          return await read(tx, { id: created.id }) as CreditPackRecord;
        });
      } catch (error) { storageError(error); }
    },
    async update(id, data, options) {
      try {
        return await billingTransaction(database, async tx => {
          // Serializes writers of this pack and makes the revision check atomic with the write.
          const locked = await tx.query<{ revision: number }>(`SELECT revision FROM ${t.creditPacks} WHERE id=$1 FOR UPDATE`, [id]);
          if (!locked.rows.length) return null;
          if (options.expectedRevision !== undefined && options.expectedRevision !== locked.rows[0].revision)
            throw new CreditPackCatalogError('conflict', 'The credit pack was changed by someone else; reload it and apply your edit again',
              ['stale credit pack revision']);
          const { prices, ...pack } = data;
          await storage.model(tx, 'creditPacks').update({ where: { id }, data: { ...pack, revision: { increment: 1 }, updatedAt: new Date() } });
          if (prices) await replacePrices(storage, tx, id, prices);
          return read(tx, { id });
        });
      } catch (error) { storageError(error); }
    },
    async delete(id) {
      try {
        return await billingTransaction(database, async tx => {
          const locked = await tx.query<{ id: string }>(`SELECT id FROM ${t.creditPacks} WHERE id=$1 FOR UPDATE`, [id]);
          if (!locked.rows.length) return false;
          // Orders freeze their own snapshot, so fulfillment never needs the pack row. A pack with an
          // open order is still refused so the back office keeps the record it was sold from.
          const open = await tx.query<{ referenced: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${t.orders}
              WHERE offer->'fulfillmentData'->'pack'->>'packId'=$1 AND state <> 'unpaid' AND "fulfilledAt" IS NULL) AS referenced`, [id]);
          if (open.rows[0]?.referenced) throw new CreditPackCatalogError('referenced', 'Credit pack is referenced by an open order');
          await storage.model(tx, 'creditPacks').delete({ where: { id } });
          return true;
        });
      } catch (error) { storageError(error); }
    },
  };
}

/** True when at least one credit pack exists (listed or not): the database then replaces static payment offers. */
export async function creditPacksConfigured(database: BillingDatabase, storage: BillingStorage = DEFAULT_BILLING_STORAGE): Promise<boolean> {
  return (await storage.model(database, 'creditPacks').count({})) > 0;
}
