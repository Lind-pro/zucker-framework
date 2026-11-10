import {
  brandPortError,
  type CreditPack,
  type CreditPackPrice,
  type LocalizedText,
} from '@zucker-framework/fe-types/back-office';
import { toMinorUnits } from '../contract/money';
import {
  DEFAULT_PROVIDER_REF_FORMATS,
  normalizePlanAmount,
  validateCredits,
  validateExpiryDays,
  validateLocalizedText,
  validateProviderRefs,
  type PlanCatalogErrorReason,
} from './plan-catalog';

/**
 * Database-backed credit packs: one-time purchases that grant a fixed number of credits. Like plans,
 * every price is (currency, exact decimal amount, provider references) and checkout freezes a
 * snapshot of the pack price on the order; the grant reads only that snapshot.
 */
export type CreditPackRecord = CreditPack<Date>;
export type { CreditPackPrice };
export type CreditPackWrite = Omit<CreditPackRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;

export class CreditPackCatalogError extends Error {
  constructor(
    readonly reason: PlanCatalogErrorReason,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'CreditPackCatalogError';
    brandPortError(this);
  }
}

/**
 * Persistence port.
 * - `create`/`update` enforce slug uniqueness and provider-reference uniqueness in storage and throw
 *   `CreditPackCatalogError('conflict')`.
 * - `update` is atomic: checks `expectedRevision`, increments `revision`, replaces the price list
 *   when `data.prices` is present.
 * - `delete` refuses packs that an unsettled order still needs (`'referenced'`).
 */
export interface CreditPackStore {
  list(options?: { listedOnly?: boolean }): Promise<CreditPackRecord[]>;
  findById(id: string): Promise<CreditPackRecord | null>;
  findBySlug(slug: string): Promise<CreditPackRecord | null>;
  create(data: CreditPackWrite): Promise<CreditPackRecord>;
  update(id: string, data: Partial<CreditPackWrite>, options: { expectedRevision?: number }): Promise<CreditPackRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface CreditPackCatalogOptions {
  providerRefFormats?: Readonly<Record<string, RegExp>>;
}

export const MAX_CREDIT_PACK_PRICES = 24;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const FIELDS = new Set<string>([
  'slug', 'title', 'titleI18n', 'description', 'descriptionI18n', 'credits', 'expiresInDays', 'status', 'order', 'prices',
]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validates one complete pack price list (it always replaces the stored list). */
export function validateCreditPackPrices(
  value: unknown,
  options: CreditPackCatalogOptions = {},
): { prices: CreditPackPrice[]; issues: string[] } {
  const issues: string[] = [];
  if (!Array.isArray(value)) return { prices: [], issues: ['prices must be an array'] };
  if (value.length > MAX_CREDIT_PACK_PRICES) return { prices: [], issues: [`at most ${MAX_CREDIT_PACK_PRICES} prices`] };
  const formats = options.providerRefFormats ?? DEFAULT_PROVIDER_REF_FORMATS;
  const prices: CreditPackPrice[] = [];
  const currencies = new Set<string>();
  const refs = new Set<string>();
  value.forEach((raw, index) => {
    const at = `prices[${index}]`;
    if (!isRecord(raw)) return void issues.push(`${at} must be an object`);
    const unknown = Object.keys(raw).filter((key) => !['currency', 'amount', 'providerRefs'].includes(key));
    if (unknown.length) issues.push(`${at} has unsupported field ${unknown[0]}`);
    const currency = typeof raw.currency === 'string' && CURRENCY.test(raw.currency) ? raw.currency : null;
    if (!currency) issues.push(`${at}.currency must be a three-letter uppercase code`);
    const amount = currency ? normalizePlanAmount(raw.amount, currency) : null;
    if (currency && amount === null) issues.push(`${at}.amount must be a non-negative decimal string for ${currency}`);
    const providerRefs = validateProviderRefs(raw.providerRefs, at, issues, refs, formats);
    if (currency) {
      if (currencies.has(currency)) issues.push(`${at} duplicates the ${currency} price`);
      currencies.add(currency);
    }
    if (currency && amount !== null) prices.push({ currency, amount, providerRefs });
  });
  return { prices, issues };
}

/**
 * Validates an administrator pack write. `partial` validates only supplied fields (PUT); otherwise
 * slug, title and credits are required. Unknown fields fail; `prices` replaces the whole list.
 */
export function validateCreditPackWrite(
  input: unknown,
  options: CreditPackCatalogOptions & { partial: boolean },
): Partial<CreditPackWrite> {
  if (!isRecord(input))
    throw new CreditPackCatalogError('invalid', 'Credit pack data must be an object', ['credit pack data must be an object']);
  const issues: string[] = [];
  const data: Partial<CreditPackWrite> = {};
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) issues.push(`unsupported field ${key}`);
  const has = (key: string) => input[key] !== undefined;
  if (!options.partial) for (const key of ['slug', 'title', 'credits']) if (!has(key)) issues.push(`${key} is required`);
  if (has('slug')) {
    if (typeof input.slug !== 'string' || !SLUG.test(input.slug)) issues.push('slug must be lowercase letters, digits, _ or -');
    else data.slug = input.slug;
  }
  if (has('title')) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100 || /[\u0000-\u001f\u007f]/.test(input.title))
      issues.push('title must be 1-100 characters');
    else data.title = input.title.trim();
  }
  if (has('titleI18n') || input.titleI18n === null) data.titleI18n = validateLocalizedText(input.titleI18n, 'titleI18n', issues, 100);
  if (has('description') || input.description === null) {
    if (input.description !== null && (typeof input.description !== 'string' || input.description.length > 2000))
      issues.push('description must be at most 2000 characters');
    else data.description = (input.description as string | null)?.trim() || null;
  }
  if (has('descriptionI18n') || input.descriptionI18n === null)
    data.descriptionI18n = validateLocalizedText(input.descriptionI18n, 'descriptionI18n', issues, 2000, true);
  // A pack exists to grant credits: zero is never a valid pack.
  if (has('credits')) data.credits = validateCredits(input.credits, 'credits', issues, 1);
  if (has('expiresInDays') || input.expiresInDays === null) data.expiresInDays = validateExpiryDays(input.expiresInDays, 'expiresInDays', issues);
  if (has('status')) {
    if (typeof input.status !== 'boolean') issues.push('status must be a boolean');
    else data.status = input.status;
  }
  if (has('order')) {
    if (typeof input.order !== 'number' || !Number.isSafeInteger(input.order) || Math.abs(input.order) > 1_000_000)
      issues.push('order must be an integer');
    else data.order = input.order;
  }
  if (has('prices') || !options.partial) {
    const result = validateCreditPackPrices(input.prices ?? [], options);
    issues.push(...result.issues);
    if (!result.issues.length) data.prices = result.prices;
  }
  if (issues.length) throw new CreditPackCatalogError('invalid', `Invalid credit pack: ${issues.join('; ')}`, issues);
  if (!options.partial) {
    data.titleI18n ??= {};
    data.description ??= null;
    data.descriptionI18n ??= {};
    data.expiresInDays ??= null;
    data.status ??= false;
    data.order ??= 0;
    data.prices ??= [];
  }
  return data;
}

// ─── Pack offers (checkout) ─────────────────────────────────────────────────

/** Checkout offer id of one pack price; never collides with static (no ':') or plan offer ids. */
export function packOfferId(packId: string, currency: string): string {
  return `pack:${packId}:${currency}`;
}
export function parsePackOfferId(offerId: string): { packId: string; currency: string } | null {
  const match = /^pack:([A-Za-z0-9_-]{1,64}):([A-Z]{3})$/.exec(offerId);
  return match ? { packId: match[1], currency: match[2] } : null;
}

/** The pack price an order was created for, frozen on the order. */
export interface CreditPackSnapshot {
  [key: string]: string | number | null;
  packId: string;
  slug: string;
  revision: number;
  currency: string;
  amount: string;
  credits: number;
  expiresInDays: number | null;
  providerId: string;
  providerRef: string;
}

export interface ResolvedCreditPackOffer {
  pack: CreditPackRecord;
  price: CreditPackPrice;
  snapshot: CreditPackSnapshot;
}

/** Localized text for `locale` (exact tag, then its language), else the base text. */
export function localizedText(base: string, translations: LocalizedText | undefined, locale: string | undefined): string;
export function localizedText(base: string | null, translations: LocalizedText | undefined, locale: string | undefined): string | null;
export function localizedText(base: string | null, translations: LocalizedText | undefined, locale: string | undefined): string | null {
  if (!locale || !translations) return base;
  if (Object.hasOwn(translations, locale)) return translations[locale];
  const language = locale.split('-')[0];
  return Object.hasOwn(translations, language) ? translations[language] : base;
}

/** Credit pack administration and pack-offer resolution over a consumer store. */
export class CreditPackCatalogService {
  constructor(
    private readonly store: CreditPackStore,
    private readonly options: CreditPackCatalogOptions = {},
  ) {}

  list(options?: { listedOnly?: boolean }): Promise<CreditPackRecord[]> {
    return this.store.list(options);
  }
  async findById(id: string): Promise<CreditPackRecord> {
    const pack = await this.store.findById(id);
    if (!pack) throw new CreditPackCatalogError('not_found', 'Credit pack not found');
    return pack;
  }
  findBySlug(slug: string): Promise<CreditPackRecord | null> {
    return SLUG.test(slug) ? this.store.findBySlug(slug) : Promise.resolve(null);
  }
  async create(input: unknown): Promise<CreditPackRecord> {
    const data = validateCreditPackWrite(input, { ...this.options, partial: false }) as CreditPackWrite;
    // Fast, readable conflict; the store's unique constraint remains authoritative under races.
    if (await this.store.findBySlug(data.slug)) throw new CreditPackCatalogError('conflict', 'Credit pack slug already exists');
    return this.store.create(data);
  }
  /** Partial update. `expectedRevision` in the body enables optimistic concurrency. */
  async update(id: string, input: unknown): Promise<CreditPackRecord> {
    let expectedRevision: number | undefined;
    let body = input;
    if (isRecord(input) && 'expectedRevision' in input) {
      const { expectedRevision: revision, ...rest } = input;
      if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0))
        throw new CreditPackCatalogError('invalid', 'expectedRevision must be a non-negative integer', ['expectedRevision must be a non-negative integer']);
      expectedRevision = revision as number | undefined;
      body = rest;
    }
    const current = await this.findById(id);
    const data = validateCreditPackWrite(body, { ...this.options, partial: true });
    if (data.slug && data.slug !== current.slug && (await this.store.findBySlug(data.slug)))
      throw new CreditPackCatalogError('conflict', 'Credit pack slug already exists');
    const saved = await this.store.update(id, data, { expectedRevision });
    if (!saved) throw new CreditPackCatalogError('not_found', 'Credit pack not found');
    return saved;
  }
  async setStatus(id: string, status: unknown): Promise<CreditPackRecord> {
    if (typeof status !== 'boolean') throw new CreditPackCatalogError('invalid', 'status must be a boolean', ['status must be a boolean']);
    return this.update(id, { status });
  }
  async delete(id: string): Promise<void> {
    if (!(await this.store.delete(id))) throw new CreditPackCatalogError('not_found', 'Credit pack not found');
  }

  /**
   * Resolves a pack offer id for one provider: the pack must be listed and the price must exist with
   * a positive amount and a reference for that provider. Returns the frozen snapshot for the order.
   */
  async resolveOffer(offerId: string, providerId: string): Promise<ResolvedCreditPackOffer | null> {
    const parsed = parsePackOfferId(offerId);
    if (!parsed) return null;
    const pack = await this.store.findById(parsed.packId);
    if (!pack || !pack.status || pack.credits < 1) return null;
    const price = pack.prices.find((item) => item.currency === parsed.currency);
    const providerRef = price?.providerRefs[providerId];
    if (!price || !providerRef || toMinorUnits(price.amount, price.currency) <= 0) return null;
    return {
      pack,
      price,
      snapshot: {
        packId: pack.id, slug: pack.slug, revision: pack.revision, currency: price.currency, amount: price.amount,
        credits: pack.credits, expiresInDays: pack.expiresInDays, providerId, providerRef,
      },
    };
  }
}
