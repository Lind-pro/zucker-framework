import {
  MAX_CREDIT_EXPIRY_DAYS,
  MAX_PLAN_HIGHLIGHTS,
  MAX_PLAN_HIGHLIGHT_LENGTH,
  MAX_PLAN_PRICE_CREDITS,
  PLAN_PRICE_INTERVALS,
  RECURRING_PLAN_PRICE_INTERVALS,
  brandPortError,
  type LocalizedText,
  type PlanCreditExpiry,
  type PlanPrice,
  type PlanPriceInterval,
  type PortErrorReason,
  type SubscriptionPlan,
} from '@zucker-framework/fe-types/back-office';
import { currencyExponent, fromMinorUnits, toMinorUnits } from '../contract/money';

/**
 * Database-backed subscription plan catalog. Plans are the single source of what is sold and at
 * what price: every price row is (interval, currency, exact decimal amount, provider references).
 * Plan contents and prices are consumer data; the feature/counter catalog that `features`/`quotas`
 * must satisfy is injected.
 */
export type SubscriptionPlanRecord = SubscriptionPlan<Date>;
export type { PlanPrice, PlanPriceInterval, PlanCreditExpiry, LocalizedText };
export type SubscriptionPlanWrite = Omit<SubscriptionPlanRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;

export type PlanCatalogErrorReason = Extract<PortErrorReason, 'invalid' | 'not_found' | 'conflict' | 'referenced'>;
export class PlanCatalogError extends Error {
  constructor(
    readonly reason: PlanCatalogErrorReason,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'PlanCatalogError';
    brandPortError(this);
  }
}

export interface PlanUpdateOptions {
  /** When set, the store must reject with `PlanCatalogError('conflict')` unless the stored revision equals it. */
  expectedRevision?: number;
}

/**
 * Persistence port.
 * - `create`/`update` enforce slug uniqueness and provider-reference uniqueness (one provider
 *   reference sells exactly one price) in storage and throw `PlanCatalogError('conflict')`.
 * - `update` is atomic: it checks `expectedRevision`, increments `revision`, and replaces the whole
 *   price list when `data.prices` is present.
 * - `delete` atomically refuses plans that a user subscription references (`'referenced'`).
 */
export interface PlanCatalogStore {
  list(options?: { listedOnly?: boolean }): Promise<SubscriptionPlanRecord[]>;
  findById(id: string): Promise<SubscriptionPlanRecord | null>;
  findBySlug(slug: string): Promise<SubscriptionPlanRecord | null>;
  create(data: SubscriptionPlanWrite): Promise<SubscriptionPlanRecord>;
  update(id: string, data: Partial<SubscriptionPlanWrite>, options: PlanUpdateOptions): Promise<SubscriptionPlanRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface PlanCatalogServiceOptions {
  /** Validates and normalizes `{features, quotas}`; pass the consumer catalog's `validatePlanGrant`. */
  validateGrant: (grant: { features: unknown; quotas: unknown }) => {
    features: Record<string, boolean>;
    quotas: Record<string, number>;
  };
  /**
   * Accepted provider-reference formats by provider id. Defaults to {@link DEFAULT_PROVIDER_REF_FORMATS}
   * (Stripe Price IDs); a provider without an entry accepts any printable reference.
   */
  providerRefFormats?: Readonly<Record<string, RegExp>>;
}

/** Stripe Price IDs; other providers' references are opaque. */
export const DEFAULT_PROVIDER_REF_FORMATS: Readonly<Record<string, RegExp>> = Object.freeze({
  stripe: /^price_[A-Za-z0-9]{1,250}$/,
});
export const MAX_PLAN_PRICES = 24;
export const MAX_ONE_TIME_TERM_DAYS = 36_500;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const CURRENCY = /^[A-Z]{3}$/;
const FIELDS = new Set<keyof SubscriptionPlanWrite>([
  'slug', 'name', 'description', 'status', 'order', 'features', 'quotas', 'prices',
  'featured', 'badge', 'highlights', 'nameI18n', 'descriptionI18n', 'badgeI18n', 'highlightsI18n',
]);
const PRICE_FIELDS = ['interval', 'currency', 'amount', 'termDays', 'providerRefs', 'credits', 'creditExpiry'];
/** BCP 47-like locale keys of localized fields (`en`, `zh`, `zh-Hans`, `pt-BR`). */
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
export const MAX_LOCALIZED_ENTRIES = 32;
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function printable(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Credits granted by one price: an integer from 0; absent means 0. */
export function validateCredits(value: unknown, at: string, issues: string[], minimum = 0): number {
  if (value === undefined && minimum === 0) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_PLAN_PRICE_CREDITS) {
    issues.push(`${at} must be an integer from ${minimum} to ${MAX_PLAN_PRICE_CREDITS}`);
    return 0;
  }
  return value;
}

/** Days until granted credits expire (1 … 36500) or null; absent means null. */
export function validateExpiryDays(value: unknown, at: string, issues: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_CREDIT_EXPIRY_DAYS) {
    issues.push(`${at} must be null or an integer from 1 to ${MAX_CREDIT_EXPIRY_DAYS}`);
    return null;
  }
  return value;
}

/**
 * Locale → text map. Keys are locale tags, values non-empty printable text up to `max` characters
 * (line breaks allowed when `multiline`). `null`/absent is an empty map.
 */
export function validateLocalizedText(value: unknown, at: string, issues: string[], max: number, multiline = false): LocalizedText {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    issues.push(`${at} must be an object of locale to text`);
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_LOCALIZED_ENTRIES) issues.push(`${at} has more than ${MAX_LOCALIZED_ENTRIES} locales`);
  const result: LocalizedText = {};
  for (const [locale, text] of entries.slice(0, MAX_LOCALIZED_ENTRIES)) {
    const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if (!LOCALE.test(locale)) issues.push(`${at} has an invalid locale key`);
    else if (typeof text !== 'string' || !text.trim() || text.length > max || control.test(text))
      issues.push(`${at}.${locale} must be 1-${max} characters`);
    else result[locale] = text.trim();
  }
  return result;
}

function validateHighlights(value: unknown, at: string, issues: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PLAN_HIGHLIGHTS) {
    issues.push(`${at} must be a list of at most ${MAX_PLAN_HIGHLIGHTS} entries`);
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (!printable(item, MAX_PLAN_HIGHLIGHT_LENGTH)) issues.push(`${at}[${index}] must be 1-${MAX_PLAN_HIGHLIGHT_LENGTH} characters`);
    else result.push(item.trim());
  });
  return result;
}

function validateLocalizedHighlights(value: unknown, at: string, issues: string[]): Record<string, string[]> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    issues.push(`${at} must be an object of locale to a list`);
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_LOCALIZED_ENTRIES) issues.push(`${at} has more than ${MAX_LOCALIZED_ENTRIES} locales`);
  const result: Record<string, string[]> = {};
  for (const [locale, list] of entries.slice(0, MAX_LOCALIZED_ENTRIES)) {
    if (!LOCALE.test(locale)) issues.push(`${at} has an invalid locale key`);
    else result[locale] = validateHighlights(list, `${at}.${locale}`, issues);
  }
  return result;
}

/**
 * Validates one provider-reference map (`provider → reference`; empty/null entries are dropped).
 * `refs` collects `provider\u0000reference` across a whole price list so a reference sells one price.
 */
export function validateProviderRefs(
  raw: unknown,
  at: string,
  issues: string[],
  refs: Set<string>,
  formats: Readonly<Record<string, RegExp>>,
): Record<string, string> {
  const providerRefs: Record<string, string> = {};
  const rawRefs = raw ?? {};
  if (!isRecord(rawRefs)) {
    issues.push(`${at}.providerRefs must be an object`);
    return providerRefs;
  }
  for (const [provider, ref] of Object.entries(rawRefs)) {
    if (ref === null || ref === '') continue;
    if (!PROVIDER.test(provider)) issues.push(`${at}.providerRefs has an invalid provider id`);
    else if (!printable(ref, 255) || (Object.hasOwn(formats, provider) && !formats[provider].test(ref)))
      issues.push(`${at}.providerRefs.${provider} is not a valid ${provider} reference`);
    else if (refs.has(`${provider}\u0000${ref}`)) issues.push(`${at}.providerRefs.${provider} is used by another price`);
    else {
      refs.add(`${provider}\u0000${ref}`);
      providerRefs[provider] = ref;
    }
  }
  return providerRefs;
}

/** Exact decimal string for the currency, or null. Numbers are rejected so a float never becomes a price. */
export function normalizePlanAmount(value: unknown, currency: string): string | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  try {
    // Reject precision the currency cannot represent instead of rounding a price.
    return fromMinorUnits(toMinorUnits(value, currency), currency);
  } catch {
    return null;
  }
}

/** Validates one complete price list (it always replaces the stored list). */
export function validatePlanPrices(
  value: unknown,
  options: Pick<PlanCatalogServiceOptions, 'providerRefFormats'> = {},
): { prices: PlanPrice[]; issues: string[] } {
  const issues: string[] = [];
  if (!Array.isArray(value)) return { prices: [], issues: ['prices must be an array'] };
  if (value.length > MAX_PLAN_PRICES) return { prices: [], issues: [`at most ${MAX_PLAN_PRICES} prices`] };
  const formats = options.providerRefFormats ?? DEFAULT_PROVIDER_REF_FORMATS;
  const prices: PlanPrice[] = [];
  const seen = new Set<string>();
  const refs = new Set<string>();
  value.forEach((raw, index) => {
    const at = `prices[${index}]`;
    if (!isRecord(raw)) return void issues.push(`${at} must be an object`);
    const unknown = Object.keys(raw).filter((key) => !PRICE_FIELDS.includes(key));
    if (unknown.length) issues.push(`${at} has unsupported field ${unknown[0]}`);
    const interval = raw.interval as PlanPriceInterval;
    if (!PLAN_PRICE_INTERVALS.includes(interval)) issues.push(`${at}.interval must be one of ${PLAN_PRICE_INTERVALS.join(', ')}`);
    const currency = typeof raw.currency === 'string' && CURRENCY.test(raw.currency) ? raw.currency : null;
    if (!currency) issues.push(`${at}.currency must be a three-letter uppercase code`);
    const amount = currency ? normalizePlanAmount(raw.amount, currency) : null;
    if (currency && amount === null) issues.push(`${at}.amount must be a non-negative decimal string for ${currency}`);
    let termDays: number | null = null;
    if (interval === 'one_time') {
      if (typeof raw.termDays !== 'number' || !Number.isSafeInteger(raw.termDays) || raw.termDays < 1 || raw.termDays > MAX_ONE_TIME_TERM_DAYS)
        issues.push(`${at}.termDays must be an integer from 1 to ${MAX_ONE_TIME_TERM_DAYS}`);
      else termDays = raw.termDays;
    } else if (raw.termDays !== undefined && raw.termDays !== null) issues.push(`${at}.termDays applies only to one_time prices`);
    const providerRefs = validateProviderRefs(raw.providerRefs, at, issues, refs, formats);
    const credits = validateCredits(raw.credits, `${at}.credits`, issues);
    let creditExpiry: PlanCreditExpiry = null;
    if (raw.creditExpiry === 'period') {
      // A lifetime term has no end: "expire with the period" would silently mean "never".
      if (interval === 'lifetime') issues.push(`${at}.creditExpiry 'period' does not apply to lifetime prices`);
      else creditExpiry = 'period';
    } else if (raw.creditExpiry !== undefined && raw.creditExpiry !== null) {
      if (typeof raw.creditExpiry !== 'number') issues.push(`${at}.creditExpiry must be 'period', a number of days or null`);
      else creditExpiry = validateExpiryDays(raw.creditExpiry, `${at}.creditExpiry`, issues);
    }
    const key = `${interval}\u0000${currency}`;
    if (currency && PLAN_PRICE_INTERVALS.includes(interval)) {
      if (seen.has(key)) issues.push(`${at} duplicates the ${interval} ${currency} price`);
      seen.add(key);
    }
    if (amount !== null && currency && PLAN_PRICE_INTERVALS.includes(interval))
      // Without credits there is nothing to expire; store the canonical null.
      prices.push({ interval, currency, amount, termDays, providerRefs, credits, creditExpiry: credits ? creditExpiry : null });
  });
  return { prices, issues };
}

/**
 * Validates an administrator plan write. `partial` validates only the supplied fields (PUT of an
 * existing plan); otherwise slug and name are required. Unknown fields fail. `prices` always
 * replaces the whole list.
 */
export function validatePlanWrite(
  input: unknown,
  options: PlanCatalogServiceOptions & { partial: boolean },
): Partial<SubscriptionPlanWrite> {
  if (!isRecord(input)) throw new PlanCatalogError('invalid', 'Plan data must be an object', ['plan data must be an object']);
  const issues: string[] = [];
  const data: Partial<SubscriptionPlanWrite> = {};
  for (const key of Object.keys(input))
    if (!FIELDS.has(key as keyof SubscriptionPlanWrite)) issues.push(`unsupported field ${key}`);
  const has = (key: string) => input[key] !== undefined;
  if (!options.partial) for (const key of ['slug', 'name']) if (!has(key)) issues.push(`${key} is required`);
  if (has('slug')) {
    if (typeof input.slug !== 'string' || !SLUG.test(input.slug)) issues.push('slug must be lowercase letters, digits, _ or -');
    else data.slug = input.slug;
  }
  if (has('name')) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) issues.push('name must be 1-100 characters');
    else data.name = input.name.trim();
  }
  if (has('description') || input.description === null) {
    if (input.description !== null && (typeof input.description !== 'string' || input.description.length > 2000))
      issues.push('description must be at most 2000 characters');
    else data.description = (input.description as string | null) || null;
  }
  if (has('status')) {
    if (typeof input.status !== 'boolean') issues.push('status must be a boolean');
    else data.status = input.status;
  }
  if (has('order')) {
    if (typeof input.order !== 'number' || !Number.isSafeInteger(input.order) || Math.abs(input.order) > 1_000_000)
      issues.push('order must be an integer');
    else data.order = input.order;
  }
  if (has('featured')) {
    if (typeof input.featured !== 'boolean') issues.push('featured must be a boolean');
    else data.featured = input.featured;
  }
  if (has('badge') || input.badge === null) {
    if (input.badge !== null && !printable(input.badge, 40)) issues.push('badge must be 1-40 characters or null');
    else data.badge = input.badge === null ? null : (input.badge as string).trim();
  }
  if (has('highlights') || input.highlights === null) data.highlights = validateHighlights(input.highlights, 'highlights', issues);
  if (has('nameI18n') || input.nameI18n === null) data.nameI18n = validateLocalizedText(input.nameI18n, 'nameI18n', issues, 100);
  if (has('descriptionI18n') || input.descriptionI18n === null)
    data.descriptionI18n = validateLocalizedText(input.descriptionI18n, 'descriptionI18n', issues, 2000, true);
  if (has('badgeI18n') || input.badgeI18n === null) data.badgeI18n = validateLocalizedText(input.badgeI18n, 'badgeI18n', issues, 40);
  if (has('highlightsI18n') || input.highlightsI18n === null)
    data.highlightsI18n = validateLocalizedHighlights(input.highlightsI18n, 'highlightsI18n', issues);
  if (has('prices') || !options.partial) {
    const result = validatePlanPrices(input.prices ?? [], options);
    issues.push(...result.issues);
    if (!result.issues.length) data.prices = result.prices;
  }
  if (has('features') || has('quotas') || !options.partial) {
    try {
      const grant = options.validateGrant({ features: input.features ?? {}, quotas: input.quotas ?? {} });
      if (has('features') || !options.partial) data.features = grant.features;
      if (has('quotas') || !options.partial) data.quotas = grant.quotas;
    } catch (error) {
      const nested = (error as { issues?: unknown }).issues;
      if (Array.isArray(nested)) issues.push(...nested.map(String));
      else issues.push(error instanceof Error ? error.message : 'invalid features or quotas');
    }
  }
  if (issues.length) throw new PlanCatalogError('invalid', `Invalid plan: ${issues.join('; ')}`, issues);
  if (!options.partial) {
    data.description ??= null;
    data.status ??= false;
    data.order ??= 0;
    data.prices ??= [];
    data.featured ??= false;
    data.badge ??= null;
    data.highlights ??= [];
    data.nameI18n ??= {};
    data.descriptionI18n ??= {};
    data.badgeI18n ??= {};
    data.highlightsI18n ??= {};
  }
  return data;
}

// ─── Plan offers (checkout) ──────────────────────────────────────────────────

/** Checkout offer id of one plan price; never collides with static offer ids (they cannot contain ':'). */
export function planOfferId(planId: string, interval: PlanPriceInterval, currency: string): string {
  return `plan:${planId}:${interval}:${currency}`;
}
export function parsePlanOfferId(offerId: string): { planId: string; interval: PlanPriceInterval; currency: string } | null {
  const match = /^plan:([A-Za-z0-9_-]{1,64}):([a-z_]{1,16}):([A-Z]{3})$/.exec(offerId);
  if (!match || !PLAN_PRICE_INTERVALS.includes(match[2] as PlanPriceInterval)) return null;
  return { planId: match[1], interval: match[2] as PlanPriceInterval, currency: match[3] };
}
/** Recurring intervals are sold as provider subscriptions; one-time and lifetime as single payments. */
export function planCheckoutMode(interval: PlanPriceInterval): 'subscription' | 'payment' {
  return RECURRING_PLAN_PRICE_INTERVALS.includes(interval) ? 'subscription' : 'payment';
}

/**
 * The plan and price an order was created for, frozen on the order. Fulfillment and plan
 * write-back use this snapshot (never today's catalog, a slug or a provider reference lookup).
 */
export interface PlanPriceSnapshot {
  [key: string]: string | number | null;
  planId: string;
  slug: string;
  revision: number;
  interval: PlanPriceInterval;
  currency: string;
  amount: string;
  termDays: number | null;
  providerId: string;
  providerRef: string;
  /** Credits each paid period grants (0 for snapshots frozen before plans granted credits). */
  credits: number;
  creditExpiry: PlanCreditExpiry;
}

/**
 * Canonical amount for the currency, or a two-decimal amount stored for a three-decimal currency
 * (KWD, BHD, JOD, OMR, TND) before 1.0.19 used ISO exponents. The stored string is kept as is.
 */
function isStoredSnapshotAmount(amount: string, currency: string): boolean {
  if (normalizePlanAmount(amount, currency) === amount) return true;
  return currencyExponent(currency) === 3 && /^\d+\.\d{2}$/.test(amount) && normalizePlanAmount(amount, currency) !== null;
}

/** Strict parser for a stored snapshot; returns null for anything that is not one. */
export function readPlanPriceSnapshot(value: unknown): PlanPriceSnapshot | null {
  if (!isRecord(value)) return null;
  const { planId, slug, revision, interval, currency, amount, termDays, providerId, providerRef } = value;
  // Absent on orders created before plans granted credits: those orders grant none.
  const credits = value.credits ?? 0, creditExpiry = value.creditExpiry ?? null;
  if (typeof planId !== 'string' || !planId || typeof slug !== 'string' || typeof revision !== 'number'
    || !PLAN_PRICE_INTERVALS.includes(interval as PlanPriceInterval) || typeof currency !== 'string' || !CURRENCY.test(currency)
    || typeof amount !== 'string' || !isStoredSnapshotAmount(amount, currency)
    || (interval === 'one_time' ? typeof termDays !== 'number' || !Number.isSafeInteger(termDays) || termDays < 1 : termDays !== null)
    || typeof providerId !== 'string' || typeof providerRef !== 'string' || !providerRef
    || typeof credits !== 'number' || !Number.isSafeInteger(credits) || credits < 0 || credits > MAX_PLAN_PRICE_CREDITS
    || !(creditExpiry === null || (creditExpiry === 'period' && interval !== 'lifetime')
      || (typeof creditExpiry === 'number' && Number.isSafeInteger(creditExpiry) && creditExpiry >= 1 && creditExpiry <= MAX_CREDIT_EXPIRY_DAYS))) return null;
  return { planId, slug, revision, interval: interval as PlanPriceInterval, currency, amount, termDays: termDays as number | null, providerId, providerRef,
    credits, creditExpiry: creditExpiry as PlanCreditExpiry };
}

export interface ResolvedPlanOffer {
  plan: SubscriptionPlanRecord;
  price: PlanPrice;
  mode: 'subscription' | 'payment';
  snapshot: PlanPriceSnapshot;
}

/** Plan administration and plan-offer resolution over a consumer store. */
export class PlanCatalogService {
  constructor(
    private readonly store: PlanCatalogStore,
    private readonly options: PlanCatalogServiceOptions,
  ) {}

  list(options?: { listedOnly?: boolean }): Promise<SubscriptionPlanRecord[]> {
    return this.store.list(options);
  }
  async findById(id: string): Promise<SubscriptionPlanRecord> {
    const plan = await this.store.findById(id);
    if (!plan) throw new PlanCatalogError('not_found', 'Plan not found');
    return plan;
  }
  findBySlug(slug: string): Promise<SubscriptionPlanRecord | null> {
    return SLUG.test(slug) ? this.store.findBySlug(slug) : Promise.resolve(null);
  }
  async create(input: unknown): Promise<SubscriptionPlanRecord> {
    const data = validatePlanWrite(input, { ...this.options, partial: false }) as SubscriptionPlanWrite;
    // Fast, readable conflict; the store's unique constraint remains authoritative under races.
    if (await this.store.findBySlug(data.slug)) throw new PlanCatalogError('conflict', 'Plan slug already exists');
    return this.store.create(data);
  }
  /** Partial update. `expectedRevision` in the body enables optimistic concurrency. */
  async update(id: string, input: unknown): Promise<SubscriptionPlanRecord> {
    let expectedRevision: number | undefined;
    let body = input;
    if (isRecord(input) && 'expectedRevision' in input) {
      const { expectedRevision: revision, ...rest } = input;
      if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0))
        throw new PlanCatalogError('invalid', 'expectedRevision must be a non-negative integer', ['expectedRevision must be a non-negative integer']);
      expectedRevision = revision as number | undefined;
      body = rest;
    }
    const current = await this.findById(id);
    const data = validatePlanWrite(body, { ...this.options, partial: true });
    if (data.slug && data.slug !== current.slug && (await this.store.findBySlug(data.slug)))
      throw new PlanCatalogError('conflict', 'Plan slug already exists');
    const saved = await this.store.update(id, data, { expectedRevision });
    if (!saved) throw new PlanCatalogError('not_found', 'Plan not found');
    return saved;
  }
  async setStatus(id: string, status: unknown): Promise<SubscriptionPlanRecord> {
    if (typeof status !== 'boolean') throw new PlanCatalogError('invalid', 'status must be a boolean', ['status must be a boolean']);
    return this.update(id, { status });
  }
  async delete(id: string): Promise<void> {
    if (!(await this.store.delete(id))) throw new PlanCatalogError('not_found', 'Plan not found');
  }

  /**
   * Resolves a plan offer id for one provider: the plan must be listed, the price must exist with a
   * positive amount and a reference for that provider. Returns the frozen snapshot for the order.
   */
  async resolveOffer(offerId: string, providerId: string): Promise<ResolvedPlanOffer | null> {
    const parsed = parsePlanOfferId(offerId);
    if (!parsed) return null;
    const plan = await this.store.findById(parsed.planId);
    if (!plan || !plan.status) return null;
    const price = plan.prices.find((item) => item.interval === parsed.interval && item.currency === parsed.currency);
    const providerRef = price?.providerRefs[providerId];
    if (!price || !providerRef || toMinorUnits(price.amount, price.currency) <= 0) return null;
    return {
      plan,
      price,
      mode: planCheckoutMode(price.interval),
      snapshot: {
        planId: plan.id, slug: plan.slug, revision: plan.revision, interval: price.interval, currency: price.currency,
        amount: price.amount, termDays: price.termDays, providerId, providerRef,
        credits: price.credits ?? 0, creditExpiry: price.credits ? price.creditExpiry ?? null : null,
      },
    };
  }
}
