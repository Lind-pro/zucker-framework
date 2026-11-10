import { describe, expect, it } from 'vitest';
import {
  CreditPackCatalogError, CreditPackCatalogService, MAX_CREDIT_PACK_PRICES, PlanCatalogError, localizedText, packOfferId, parsePackOfferId,
  readPlanPriceSnapshot, validateCreditPackWrite, validatePlanWrite,
  type CreditPackRecord, type CreditPackStore, type CreditPackWrite,
} from '../index';

const validateGrant = (grant: { features: unknown; quotas: unknown }) => ({ features: grant.features as Record<string, boolean>, quotas: grant.quotas as Record<string, number> });
const plan = (extra: object = {}, price: object = {}) => ({ slug: 'p', name: 'P', features: {}, quotas: {},
  prices: [{ interval: 'month', currency: 'USD', amount: '9', providerRefs: {}, ...price }], ...extra });
const issuesOf = (work: () => unknown): string[] => {
  try { work(); } catch (error) { return (error as PlanCatalogError | CreditPackCatalogError).issues as string[]; }
  throw new Error('expected a validation failure');
};
const validatePlan = (input: unknown, partial = false) => validatePlanWrite(input, { validateGrant, partial });

describe('plan price credits and expiry validation', () => {
  it('stores credits and a per-price expiry, normalising to null when no credits are granted', () => {
    expect(validatePlan(plan()).prices?.[0]).toMatchObject({ credits: 0, creditExpiry: null });
    const prices = validatePlan({ ...plan(), prices: [
      { interval: 'month', currency: 'USD', amount: '9', credits: 10, creditExpiry: 'period' },
      { interval: 'one_time', currency: 'USD', amount: '9', termDays: 7, credits: 5, creditExpiry: 30 },
      { interval: 'year', currency: 'USD', amount: '90', credits: 0, creditExpiry: 'period' }] }).prices!;
    expect(prices.map(p => [p.credits, p.creditExpiry])).toEqual([[10, 'period'], [5, 30], [0, null]]);
  });
  it.each([
    ['period on lifetime', { interval: 'lifetime', credits: 1, creditExpiry: 'period' }, /lifetime/],
    ['period on lifetime even with zero credits', { interval: 'lifetime', credits: 0, creditExpiry: 'period' }, /lifetime/],
    ['negative credits', { credits: -1 }, /credits must be an integer/],
    ['fractional credits', { credits: 1.5 }, /credits must be an integer/],
    ['string credits', { credits: '10' }, /credits must be an integer/],
    ['credits above 2^31-1', { credits: 2_147_483_648 }, /credits must be an integer/],
    ['zero expiry days', { credits: 1, creditExpiry: 0 }, /creditExpiry must be/],
    ['expiry above 36500 days', { credits: 1, creditExpiry: 36_501 }, /creditExpiry must be/],
    ['fractional expiry', { credits: 1, creditExpiry: 1.5 }, /creditExpiry must be/],
    ['unknown expiry keyword', { credits: 1, creditExpiry: 'forever' }, /creditExpiry must be/],
    ['string expiry', { credits: 1, creditExpiry: '30' }, /creditExpiry must be/],
  ])('rejects %s', (_name, price, message) => {
    expect(issuesOf(() => validatePlan(plan({}, price))).join('|')).toMatch(message);
  });
  it('accepts the documented maxima', () => {
    expect(validatePlan(plan({}, { credits: 2_147_483_647, creditExpiry: 36_500 })).prices?.[0]).toMatchObject({ credits: 2_147_483_647, creditExpiry: 36_500 });
  });
});

describe('plan presentation field validation', () => {
  it('trims and keeps valid locale keys, including region and script tags', () => {
    const data = validatePlan(plan({ badge: ' Popular ', nameI18n: { zh: ' 专业 ', 'zh-Hans': 'x', 'pt-BR': 'y' }, highlights: [' One '], highlightsI18n: { zh: ['一'] } }));
    expect(data).toMatchObject({ badge: 'Popular', nameI18n: { zh: '专业', 'zh-Hans': 'x', 'pt-BR': 'y' }, highlights: ['One'], highlightsI18n: { zh: ['一'] } });
  });
  it.each([
    ['uppercase language key', { nameI18n: { EN: 'x' } }],
    ['underscore key', { nameI18n: { en_US: 'x' } }],
    ['empty text', { nameI18n: { en: '   ' } }],
    ['non-string text', { nameI18n: { en: 1 } }],
    ['control character', { nameI18n: { en: 'a\nb' } }],
    ['over-long name text', { nameI18n: { en: 'x'.repeat(101) } }],
    ['array instead of map', { nameI18n: ['x'] }],
    ['multiline in badge text', { badgeI18n: { en: 'a\nb' } }],
    ['badge too long', { badge: 'x'.repeat(41) }],
    ['badge empty', { badge: ' ' }],
    ['badge not a string', { badge: 3 }],
    ['featured not boolean', { featured: 'yes' }],
    ['highlight empty', { highlights: [''] }],
    ['highlight too long', { highlights: ['x'.repeat(201)] }],
    ['13 highlights', { highlights: Array.from({ length: 13 }, (_v, i) => `h${i}`) }],
    ['highlights not a list', { highlights: 'one' }],
    ['localized highlights bad key', { highlightsI18n: { 'e n': ['x'] } }],
    ['localized highlights non-list', { highlightsI18n: { en: 'x' } }],
    ['localized highlight over-long', { highlightsI18n: { en: ['x'.repeat(201)] } }],
    ['33 locales', { nameI18n: Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`a${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`, 'x'])) }],
  ])('rejects %s', (_name, extra) => {
    expect(issuesOf(() => validatePlan(plan(extra))).length).toBeGreaterThan(0);
  });
  it('allows multiline description translations but not control characters', () => {
    expect(validatePlan(plan({ descriptionI18n: { en: 'a\nb' } })).descriptionI18n).toEqual({ en: 'a\nb' });
    expect(issuesOf(() => validatePlan(plan({ descriptionI18n: { en: 'a\u0000b' } })))).toHaveLength(1);
  });
  it('null clears the optional fields on a partial write', () => {
    expect(validatePlan({ badge: null, highlights: null, nameI18n: null, highlightsI18n: null }, true))
      .toEqual({ badge: null, highlights: [], nameI18n: {}, highlightsI18n: {} });
  });
});

describe('localizedText fallback', () => {
  it('uses the exact tag, then the language, then the base text; never inherited keys', () => {
    const map = { 'pt-BR': 'br', pt: 'pt', zh: '中' };
    expect(localizedText('base', map, 'pt-BR')).toBe('br');
    expect(localizedText('base', map, 'pt-PT')).toBe('pt');
    expect(localizedText('base', map, 'zh-Hans-CN')).toBe('中');
    expect(localizedText('base', map, 'fr')).toBe('base');
    expect(localizedText('base', map, undefined)).toBe('base');
    expect(localizedText('base', undefined, 'zh')).toBe('base');
    expect(localizedText(null, map, 'fr')).toBeNull();
    expect(localizedText('base', {}, 'constructor')).toBe('base');
  });
});

describe('plan snapshot credit fields', () => {
  const base = { planId: 'p', slug: 's', revision: 1, interval: 'month', currency: 'USD', amount: '9.00', termDays: null, providerId: 'x', providerRef: 'r' };
  it('round-trips period/day/null expiry and refuses period on lifetime', () => {
    expect(readPlanPriceSnapshot({ ...base, credits: 5, creditExpiry: 'period' })).toMatchObject({ credits: 5, creditExpiry: 'period' });
    expect(readPlanPriceSnapshot({ ...base, credits: 5, creditExpiry: 30 })).toMatchObject({ creditExpiry: 30 });
    expect(readPlanPriceSnapshot({ ...base, interval: 'lifetime', credits: 5, creditExpiry: 'period' })).toBeNull();
    expect(readPlanPriceSnapshot({ ...base, credits: 5, creditExpiry: 0 })).toBeNull();
    expect(readPlanPriceSnapshot({ ...base, credits: 5, creditExpiry: 36_501 })).toBeNull();
    expect(readPlanPriceSnapshot({ ...base, credits: 1.5 })).toBeNull();
    expect(readPlanPriceSnapshot({ ...base, credits: 2_147_483_648 })).toBeNull();
  });
});

// ─── credit packs ──────────────────────────────────────────────────────────
const pack = (extra: object = {}) => ({ slug: 'starter', title: 'Starter', credits: 100, prices: [{ currency: 'USD', amount: '9.9', providerRefs: { stripe: 'price_A' } }], ...extra });
const packIssues = (input: unknown, partial = false) => issuesOf(() => validateCreditPackWrite(input, { partial })).join('|');

describe('credit pack write validation', () => {
  it('normalises a complete pack and applies defaults', () => {
    expect(validateCreditPackWrite(pack(), { partial: false })).toEqual({ slug: 'starter', title: 'Starter', credits: 100, titleI18n: {}, description: null,
      descriptionI18n: {}, expiresInDays: null, status: false, order: 0, prices: [{ currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_A' } }] });
  });
  it.each([
    ['zero credits', { credits: 0 }, /credits must be an integer from 1/],
    ['negative credits', { credits: -5 }, /credits/],
    ['fractional credits', { credits: 1.5 }, /credits/],
    ['credits above int4', { credits: 2_147_483_648 }, /credits/],
    ['expiry zero', { expiresInDays: 0 }, /expiresInDays/],
    ['expiry above 36500', { expiresInDays: 36_501 }, /expiresInDays/],
    ['expiry "period" (packs have no period)', { expiresInDays: 'period' }, /expiresInDays/],
    ['uppercase slug', { slug: 'Starter' }, /slug/],
    ['slug with space', { slug: 'a b' }, /slug/],
    ['slug 65 chars', { slug: 'a'.repeat(65) }, /slug/],
    ['empty title', { title: ' ' }, /title/],
    ['control char in title', { title: 'a\nb' }, /title/],
    ['title 101 chars', { title: 'x'.repeat(101) }, /title/],
    ['float price', { prices: [{ currency: 'USD', amount: 9.9 }] }, /amount/],
    ['negative price', { prices: [{ currency: 'USD', amount: '-1' }] }, /amount/],
    ['three decimals in USD', { prices: [{ currency: 'USD', amount: '1.005' }] }, /amount/],
    ['lowercase currency', { prices: [{ currency: 'usd', amount: '1' }] }, /currency/],
    ['duplicate currency', { prices: [{ currency: 'USD', amount: '1' }, { currency: 'USD', amount: '2' }] }, /duplicates/],
    ['same provider ref on two prices', { prices: [{ currency: 'USD', amount: '1', providerRefs: { stripe: 'price_A' } }, { currency: 'EUR', amount: '1', providerRefs: { stripe: 'price_A' } }] }, /another price/],
    ['bad stripe reference format', { prices: [{ currency: 'USD', amount: '1', providerRefs: { stripe: 'prod_X' } }] }, /not a valid stripe reference/],
    ['unknown price field', { prices: [{ currency: 'USD', amount: '1', interval: 'month' }] }, /unsupported field interval/],
    ['unknown pack field', { bonus: 1 }, /unsupported field bonus/],
    ['non-boolean status', { status: 'yes' }, /status/],
    ['fractional order', { order: 1.5 }, /order/],
    ['description 2001 chars', { description: 'x'.repeat(2001) }, /description/],
    ['titleI18n bad key', { titleI18n: { 'e n': 'x' } }, /titleI18n/],
    ['prices not an array', { prices: {} }, /prices must be an array/],
    ['25 prices', { prices: Array.from({ length: MAX_CREDIT_PACK_PRICES + 1 }, (_v, i) => ({ currency: `A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`, amount: '1' })) }, /at most 24/],
  ])('rejects %s', (_name, extra, message) => {
    expect(packIssues(pack(extra))).toMatch(message);
  });
  it('requires slug, title and credits on create but only supplied fields on update', () => {
    expect(packIssues({})).toMatch(/slug is required.*title is required.*credits is required/);
    expect(validateCreditPackWrite({ status: true }, { partial: true })).toEqual({ status: true });
    expect(validateCreditPackWrite({ expiresInDays: null, description: null }, { partial: true })).toEqual({ expiresInDays: null, description: null });
    expect(() => validateCreditPackWrite(null, { partial: true })).toThrow(CreditPackCatalogError);
  });
  it('accepts zero-priced prices on write (free listing) and three-decimal currencies', () => {
    expect(validateCreditPackWrite(pack({ prices: [{ currency: 'USD', amount: '0' }, { currency: 'KWD', amount: '1.5' }] }), { partial: false }).prices)
      .toEqual([{ currency: 'USD', amount: '0.00', providerRefs: {} }, { currency: 'KWD', amount: '1.500', providerRefs: {} }]);
  });
});

function memoryPacks() {
  const rows = new Map<string, CreditPackRecord>();
  const referenced = new Set<string>();
  let n = 0;
  const store: CreditPackStore = {
    async list(options) { return [...rows.values()].filter(row => !options?.listedOnly || row.status).sort((a, b) => a.order - b.order); },
    async findById(id) { return rows.get(id) ?? null; },
    async findBySlug(slug) { return [...rows.values()].find(row => row.slug === slug) ?? null; },
    async create(data: CreditPackWrite) { const row = { ...data, id: `pack-${++n}`, revision: 0, createdAt: new Date(), updatedAt: new Date() }; rows.set(row.id, row); return row; },
    async update(id, data, options) {
      const row = rows.get(id); if (!row) return null;
      if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision) throw new CreditPackCatalogError('conflict', 'stale');
      const next = { ...row, ...data, revision: row.revision + 1 }; rows.set(id, next); return next;
    },
    async delete(id) { if (referenced.has(id)) throw new CreditPackCatalogError('referenced', 'open order'); return rows.delete(id); },
  };
  return { rows, referenced, service: new CreditPackCatalogService(store) };
}
const reasonOf = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { reason?: string }) => error.reason);

describe('CreditPackCatalogService', () => {
  it('creates, rejects duplicate slugs, updates with revision checks and toggles status', async () => {
    const { service } = memoryPacks();
    const created = await service.create(pack());
    expect(await reasonOf(service.create(pack()))).toBe('conflict');
    expect(await reasonOf(service.update(created.id, { credits: 1, expectedRevision: 3 }))).toBe('conflict');
    expect(await reasonOf(service.update(created.id, { credits: 1, expectedRevision: -1 }))).toBe('invalid');
    expect(await reasonOf(service.update(created.id, { credits: 1, expectedRevision: 1.5 }))).toBe('invalid');
    expect((await service.update(created.id, { credits: 5, expectedRevision: 0 })).revision).toBe(1);
    expect(await reasonOf(service.update('missing', { credits: 1 }))).toBe('not_found');
    expect(await reasonOf(service.setStatus(created.id, 'true'))).toBe('invalid');
    expect((await service.setStatus(created.id, true)).status).toBe(true);
    const other = await service.create(pack({ slug: 'other', prices: [] }));
    expect(await reasonOf(service.update(other.id, { slug: 'starter' }))).toBe('conflict');
    expect(await reasonOf(service.update(other.id, { slug: 'other' }))).toBe('resolved');
  });
  it('maps delete: missing is not_found, an open order is referenced', async () => {
    const { service, referenced } = memoryPacks();
    const created = await service.create(pack());
    referenced.add(created.id);
    expect(await reasonOf(service.delete(created.id))).toBe('referenced');
    referenced.clear();
    expect(await reasonOf(service.delete(created.id))).toBe('resolved');
    expect(await reasonOf(service.delete(created.id))).toBe('not_found');
    expect(await reasonOf(service.findById(created.id))).toBe('not_found');
  });
  it('findBySlug never queries the store for a malformed slug', async () => {
    const { service } = memoryPacks();
    expect(await service.findBySlug('A b')).toBeNull();
  });
  it('resolves an offer only for a listed pack with a positive price and a reference for that provider', async () => {
    const { service } = memoryPacks();
    const created = await service.create(pack({ prices: [{ currency: 'USD', amount: '9.9', providerRefs: { stripe: 'price_A' } },
      { currency: 'EUR', amount: '0', providerRefs: { stripe: 'price_Z' } }, { currency: 'GBP', amount: '5', providerRefs: {} }] }));
    const offer = packOfferId(created.id, 'USD');
    expect(parsePackOfferId(offer)).toEqual({ packId: created.id, currency: 'USD' });
    expect(parsePackOfferId('pack:x:usd')).toBeNull();
    expect(parsePackOfferId('plan:x:month:USD')).toBeNull();
    expect(await service.resolveOffer(offer, 'stripe')).toBeNull(); // draft
    await service.setStatus(created.id, true);
    expect((await service.resolveOffer(offer, 'stripe'))?.snapshot).toEqual({ packId: created.id, slug: 'starter', revision: 1, currency: 'USD', amount: '9.90',
      credits: 100, expiresInDays: null, providerId: 'stripe', providerRef: 'price_A' });
    expect(await service.resolveOffer(offer, 'paypal')).toBeNull();
    expect(await service.resolveOffer(packOfferId(created.id, 'EUR'), 'stripe')).toBeNull(); // zero amount
    expect(await service.resolveOffer(packOfferId(created.id, 'GBP'), 'stripe')).toBeNull(); // no ref
    expect(await service.resolveOffer(packOfferId(created.id, 'JPY'), 'stripe')).toBeNull(); // no price
    expect(await service.resolveOffer('starter-credits', 'stripe')).toBeNull();
  });
});
