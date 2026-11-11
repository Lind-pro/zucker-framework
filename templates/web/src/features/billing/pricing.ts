/**
 * Pricing view model for `GET /billing/plans` ({ plans, packs, checkout }). Pure and dependency-free
 * (relative imports only) so node tests can load it directly. The browser never computes prices:
 * amounts are the Server's exact decimal strings and are only formatted for display.
 */

export const PLAN_INTERVALS = ['month', 'year', 'one_time', 'lifetime'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];
/** `'period'` expires at the end of the paid period, a number is days after the grant, null never. */
export type CreditExpiry = 'period' | number | null;

export interface PricingPlanPrice {
  interval: PlanInterval;
  currency: string;
  amount: string;
  termDays: number | null;
  /** Checkout offer for `POST /billing/orders`, or null when no enabled provider sells it. */
  offerId: string | null;
  purchasable: boolean;
  providers: string[];
  credits: number;
  creditExpiry: CreditExpiry;
}
export interface PricingPlan {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  order: number;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  prices: PricingPlanPrice[];
  featured: boolean;
  badge: string | null;
  highlights: string[];
  /** Only ever true in a response to an authenticated request. */
  current: boolean;
}
export interface PricingPackPrice {
  currency: string;
  amount: string;
  offerId: string | null;
  purchasable: boolean;
  providers: string[];
}
export interface PricingPack {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  credits: number;
  expiresInDays: number | null;
  order: number;
  prices: PricingPackPrice[];
}
export interface CheckoutPolicy {
  defaultProvider: string | null;
  allowProviderChoice: boolean;
  /** 'alias': buyers may enter a promo code; the server validates it and freezes the discount. */
  promoCodes: 'none' | 'alias';
}
export interface PricingCatalog {
  plans: PricingPlan[];
  packs: PricingPack[];
  checkout: CheckoutPolicy;
}
export interface EntitlementCatalog {
  features: { key: string; label: string; description?: string; counter?: string }[];
  counters: { key: string; label: string; unit: string; period?: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^\d{1,15}(?:\.\d{1,8})?$/;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter(isString) : []);
const nullableString = (value: unknown) => (isString(value) ? value : null);
function booleanMap(value: unknown): Record<string, boolean> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'boolean')) as Record<string, boolean> : {};
}
function numberMap(value: unknown): Record<string, number> {
  return isRecord(value)
    ? (Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Record<string, number>)
    : {};
}
function money(value: Record<string, unknown>): { currency: string; amount: string } | null {
  return isString(value.currency) && CURRENCY.test(value.currency) && isString(value.amount) && AMOUNT.test(value.amount)
    ? { currency: value.currency, amount: value.amount }
    : null;
}
function sale(value: Record<string, unknown>) {
  // An offer without a provider (or vice versa) cannot be bought, whatever `purchasable` claims.
  const offerId = isString(value.offerId) && value.offerId ? value.offerId : null;
  const providers = strings(value.providers).filter(Boolean);
  const purchasable = value.purchasable === true && !!offerId && providers.length > 0;
  return { offerId: purchasable ? offerId : null, purchasable, providers: purchasable ? providers : [] };
}
function planPrice(value: unknown): PricingPlanPrice | null {
  if (!isRecord(value) || !(PLAN_INTERVALS as readonly unknown[]).includes(value.interval)) return null;
  const amount = money(value);
  if (!amount) return null;
  const expiry = value.creditExpiry;
  return {
    interval: value.interval as PlanInterval,
    ...amount,
    termDays: isCount(value.termDays) ? value.termDays : null,
    ...sale(value),
    credits: isCount(value.credits) ? value.credits : 0,
    creditExpiry: expiry === 'period' || isCount(expiry) ? expiry : null,
  };
}
function plan(value: unknown): PricingPlan | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.slug) || !isString(value.name)) return null;
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    description: nullableString(value.description),
    order: typeof value.order === 'number' ? value.order : 0,
    features: booleanMap(value.features),
    quotas: numberMap(value.quotas),
    prices: (Array.isArray(value.prices) ? value.prices : []).map(planPrice).filter((price) => price !== null),
    featured: value.featured === true,
    badge: isString(value.badge) && value.badge.trim() ? value.badge : null,
    highlights: strings(value.highlights),
    current: value.current === true,
  };
}
function packPrice(value: unknown): PricingPackPrice | null {
  if (!isRecord(value)) return null;
  const amount = money(value);
  return amount ? { ...amount, ...sale(value) } : null;
}
function pack(value: unknown): PricingPack | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.slug) || !isString(value.title) || !isCount(value.credits))
    return null;
  return {
    id: value.id,
    slug: value.slug,
    title: value.title,
    description: nullableString(value.description),
    credits: value.credits,
    expiresInDays: isCount(value.expiresInDays) ? value.expiresInDays : null,
    order: typeof value.order === 'number' ? value.order : 0,
    prices: (Array.isArray(value.prices) ? value.prices : []).map(packPrice).filter((price) => price !== null),
  };
}

/** Validates an API response; malformed plans, packs and prices are dropped rather than shown. */
export function parsePricingCatalog(value: unknown): PricingCatalog {
  if (!isRecord(value) || !Array.isArray(value.plans)) throw new Error('Invalid pricing response');
  const checkout = isRecord(value.checkout) ? value.checkout : {};
  const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
  return {
    plans: value.plans.map(plan).filter((item) => item !== null).sort(byOrder),
    packs: (Array.isArray(value.packs) ? value.packs : []).map(pack).filter((item) => item !== null).sort(byOrder),
    checkout: {
      defaultProvider: isString(checkout.defaultProvider) && checkout.defaultProvider ? checkout.defaultProvider : null,
      allowProviderChoice: checkout.allowProviderChoice !== false,
      promoCodes: checkout.promoCodes === 'alias' ? 'alias' : 'none',
    },
  };
}

export function parseEntitlementCatalog(value: unknown): EntitlementCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.features) || !Array.isArray(value.counters)) return null;
  return {
    features: value.features.filter(isRecord).flatMap((feature) =>
      isString(feature.key) && isString(feature.label)
        ? [{ key: feature.key, label: feature.label, ...(isString(feature.counter) ? { counter: feature.counter } : {}) }]
        : [],
    ),
    counters: value.counters.filter(isRecord).flatMap((counter) =>
      isString(counter.key) && isString(counter.label)
        ? [{ key: counter.key, label: counter.label, unit: isString(counter.unit) ? counter.unit : '' }]
        : [],
    ),
  };
}

/** Every currency with a plan or pack price, alphabetical. */
export function pricingCurrencies(catalog: PricingCatalog): string[] {
  const all = [...catalog.plans.flatMap((item) => item.prices), ...catalog.packs.flatMap((item) => item.prices)];
  return [...new Set(all.map((price) => price.currency))].sort();
}

/** `preferred` when offered, else the most common currency among prices (ties alphabetical), else null. */
export function defaultCurrency(catalog: PricingCatalog, preferred?: string | null): string | null {
  const currencies = pricingCurrencies(catalog);
  if (preferred && currencies.includes(preferred)) return preferred;
  const counts = new Map<string, number>();
  for (const price of [...catalog.plans.flatMap((item) => item.prices), ...catalog.packs.flatMap((item) => item.prices)])
    counts.set(price.currency, (counts.get(price.currency) ?? 0) + 1);
  return [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ?? null;
}

/** Intervals that have at least one plan price in `currency`, in display order. */
export function pricingIntervals(
  catalog: Pick<PricingCatalog, 'plans'>,
  currency: string | null,
): PlanInterval[] {
  const present = new Set(
    catalog.plans.flatMap((item) => item.prices).filter((price) => price.currency === currency).map((price) => price.interval),
  );
  return PLAN_INTERVALS.filter((interval) => present.has(interval));
}

export interface PricingSelection {
  currency?: string | null;
  interval?: string | null;
  /** Plan slugs in display order, or `'all'` (default). Unknown slugs are ignored. */
  plans?: 'all' | readonly string[];
}
export interface PricingView {
  currencies: string[];
  currency: string | null;
  intervals: PlanInterval[];
  interval: PlanInterval | null;
  plans: { plan: PricingPlan; price: PricingPlanPrice }[];
  packs: { pack: PricingPack; price: PricingPackPrice }[];
}

/**
 * Cards for one currency and interval. A plan without a price for that pair is not shown in that
 * tab; a pack without a price in that currency is not shown. Requested values that do not exist
 * fall back to the defaults.
 */
export function buildPricingView(catalog: PricingCatalog, selection: PricingSelection = {}): PricingView {
  const currencies = pricingCurrencies(catalog);
  const currency = defaultCurrency(catalog, selection.currency);
  let plans = catalog.plans;
  if (selection.plans && selection.plans !== 'all') {
    const bySlug = new Map(catalog.plans.map((item) => [item.slug, item]));
    plans = selection.plans.flatMap((slug) => bySlug.get(slug) ?? []);
  }
  // Tabs only for intervals the shown plans actually offer.
  const intervals = pricingIntervals({ plans }, currency);
  const interval = intervals.find((value) => value === selection.interval) ?? intervals[0] ?? null;
  return {
    currencies,
    currency,
    intervals,
    interval,
    plans: plans.flatMap((item) => {
      const price = item.prices.find((value) => value.currency === currency && value.interval === interval);
      return price ? [{ plan: item, price }] : [];
    }),
    packs: catalog.packs.flatMap((item) => {
      const price = item.prices.find((value) => value.currency === currency);
      return price ? [{ pack: item, price }] : [];
    }),
  };
}

/**
 * Providers offered for one price under the checkout policy. With choice off only one provider is
 * offered: the default when it can sell this price, else the first that can.
 */
export function checkoutProviders(
  providers: readonly string[],
  policy: CheckoutPolicy,
): { providers: string[]; selected: string | null; choice: boolean } {
  const selected = policy.defaultProvider && providers.includes(policy.defaultProvider) ? policy.defaultProvider : (providers[0] ?? null);
  if (!policy.allowProviderChoice) return { providers: selected ? [selected] : [], selected, choice: false };
  return { providers: [...providers], selected, choice: providers.length > 1 };
}

/**
 * Display text for a Server decimal string. Uses the currency's symbol with exactly the decimals
 * the Server sent (the string is formatted, never converted through a float), else `USD 19.90`.
 */
export function formatMoney(amount: string, currency: string, locale: string): string {
  const decimals = amount.split('.')[1]?.length ?? 0;
  try {
    const format = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return format.format(amount as unknown as number);
  } catch {
    return `${currency} ${amount}`;
  }
}

/** Quota limit `-1` means unlimited. */
export function planEntitlements(
  plan: Pick<PricingPlan, 'features' | 'quotas'>,
  catalog: EntitlementCatalog | null,
): { key: string; label: string; limit?: number; unit?: string }[] {
  if (!catalog) return [];
  const counters = new Map(catalog.counters.map((counter) => [counter.key, counter]));
  return catalog.features
    .filter((feature) => plan.features[feature.key] === true)
    .map((feature) => {
      const counter = feature.counter ? counters.get(feature.counter) : undefined;
      const limit = feature.counter ? plan.quotas[feature.counter] : undefined;
      return counter && typeof limit === 'number'
        ? { key: feature.key, label: feature.label, limit, unit: counter.unit }
        : { key: feature.key, label: feature.label };
    });
}

export function isPlanInterval(value: unknown): value is PlanInterval {
  return (PLAN_INTERVALS as readonly unknown[]).includes(value);
}
