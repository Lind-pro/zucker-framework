import { BadRequestException } from '@nestjs/common';
import type { HostedCheckoutAdapter, HostedCheckoutOffer, HostedCheckoutSelection, SubscriptionAdapter } from '@zucker-framework/payment';
import { localizedText, packOfferId, parsePackOfferId, parsePlanOfferId, toMinorUnits, type CreditPackCatalogService } from '@zucker-framework/payment';
import type { PublicCreditPack } from '@zucker-framework/fe-types/back-office';
import { validateCreditFulfillmentPolicy } from './credit-policy';
import type { BillingPlanOffers, BillingReferrals } from './billing.ports';

export interface BillingCatalogItem {
  id: string;
  title: string;
  version: string;
  mode: 'payment' | 'subscription';
  amount: string;
  currency: string;
  credits: number;
  expiresInDays: number | null;
  providers: Partial<Record<'stripe' | 'paypal' | 'creem', string>>;
  subscriptionGrantBasis?: Partial<Record<'stripe' | 'paypal' | 'creem', 'period' | 'payment'>>;
}
const providerIds = new Set(['stripe', 'paypal', 'creem']);
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }

/**
 * Server-owned static commercial configuration (JSON array of offers; the Framework template reads
 * it from `BILLING_CATALOG_JSON`). An empty catalog is intentionally valid.
 */
export function readBillingCatalog(serialized: string | undefined): readonly BillingCatalogItem[] {
  let value: unknown;
  try { value = JSON.parse(serialized ?? '[]'); } catch { throw new Error('BILLING_CATALOG_JSON is invalid'); }
  if (!Array.isArray(value) || value.length > 100) throw new Error('Billing catalog must contain at most 100 offers');
  const ids = new Set<string>();
  const currencies = new Set(Intl.supportedValuesOf('currency'));
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid billing offer');
    const allowed = ['id', 'title', 'version', 'mode', 'amount', 'currency', 'credits', 'expiresInDays', 'providers', 'subscriptionGrantBasis'];
    if (Object.keys(raw).some(key => !allowed.includes(key)) || !text(raw.id, 64) || !/^[a-z0-9][a-z0-9_-]*$/.test(raw.id)
      || ids.has(raw.id) || !text(raw.title) || !text(raw.version, 100) || !['payment', 'subscription'].includes(raw.mode)
      || !text(raw.amount, 32) || !text(raw.currency, 3) || !currencies.has(raw.currency)
      || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)
      || !Object.keys(raw.providers).length || Object.entries(raw.providers).some(([key, ref]) => !providerIds.has(key) || !text(ref, 255))) {
      throw new Error('Invalid or duplicate billing offer');
    }
    const basis = raw.subscriptionGrantBasis;
    if (basis !== undefined && (!basis || typeof basis !== 'object' || Array.isArray(basis)
      || raw.mode !== 'subscription' || Object.entries(basis).some(([provider, value]) => !providerIds.has(provider)
        || !raw.providers[provider] || (value !== 'period' && value !== 'payment')))) throw new Error('Invalid subscription grant basis');
    // Only channels with actual period evidence may use this implicit policy.
    // PayPal's receipt policy is an explicit application choice, never a fabricated period.
    if (raw.mode === 'subscription' && raw.providers.paypal && basis?.paypal !== 'payment')
      throw new Error('PayPal subscriptions require an explicit payment-receipt grant basis');
    if (toMinorUnits(raw.amount, raw.currency) <= 0) throw new Error('Billing offers require a positive exact amount');
    const policy = validateCreditFulfillmentPolicy({ credits: raw.credits, expiresInDays: raw.expiresInDays ?? null });
    ids.add(raw.id);
    return Object.freeze({ id: raw.id, title: raw.title, version: raw.version, mode: raw.mode,
      amount: raw.amount, currency: raw.currency, ...policy, providers: Object.freeze({ ...raw.providers }),
      ...(basis === undefined ? {} : { subscriptionGrantBasis: Object.freeze({ ...basis }) }) });
  });
}

/** Database credit packs as checkout offers (see {@link BillingCatalog}). */
export interface BillingPackOffers {
  service: CreditPackCatalogService;
  /** True when the `credit_packs` table has any row; static payment offers are then no longer sold. */
  configured(): Promise<boolean>;
}

/**
 * Checkout offers. Plans (when a {@link BillingPlanOffers} source is registered) are the single source
 * of plan prices: a `plan:` offer is resolved from the current plan price and its snapshot is frozen
 * on the order. Credit packs come from the `credit_packs` table (`pack:` offers, snapshot frozen on the
 * order); static BILLING_CATALOG_JSON payment offers are sold only while that table is empty (seed and
 * fallback). Static credit-only subscriptions remain; a static subscription offer whose id a plan
 * claims (its seed) is no longer sold.
 */
export class BillingCatalog {
  private readonly items: () => readonly BillingCatalogItem[];
  constructor(items: readonly BillingCatalogItem[] | (() => readonly BillingCatalogItem[]), private readonly providers: readonly HostedCheckoutAdapter[],
    private readonly referrals: BillingReferrals | null = null, private readonly subscriptions: readonly SubscriptionAdapter[] = [],
    private readonly planOffers: () => BillingPlanOffers | null = () => null,
    private readonly packOffers: BillingPackOffers | null = null) {
    this.items = typeof items === 'function' ? items : () => items;
  }
  /** Static payment offers are replaced by database packs as soon as one pack exists. */
  private async staticPacksSold(): Promise<boolean> {
    return !this.packOffers || !(await this.packOffers.configured());
  }

  private grantBasis(item: BillingCatalogItem, provider: string): 'period' | 'payment' {
    return item.subscriptionGrantBasis?.[provider as keyof NonNullable<BillingCatalogItem['subscriptionGrantBasis']>] ?? 'period';
  }
  private supports(provider: HostedCheckoutAdapter, mode: 'payment' | 'subscription', basis: 'period' | 'payment'): boolean {
    if (!provider.modes.includes(mode)) return false;
    if (mode !== 'subscription') return true;
    const lifecycle = this.subscriptions.find(value => value.id === provider.id && value.accountScope === provider.accountScope);
    return !!lifecycle && (basis === 'period'
      ? lifecycle.capabilities.paidPeriodProof !== 'unavailable'
      : lifecycle.capabilities.paidReceiptProof === 'provider' && !!lifecycle.listPaidReceipts);
  }
  private available(item: BillingCatalogItem) {
    return this.providers.filter(provider => item.providers[provider.id as keyof BillingCatalogItem['providers']]
      && this.supports(provider, item.mode, this.grantBasis(item, provider.id)));
  }
  /**
   * Providers that can sell a plan price now. Plan subscriptions use proven provider periods (the
   * plan term is the paid period); a provider that cannot prove periods does not sell them.
   */
  planProviders(mode: 'payment' | 'subscription', providerRefs: Readonly<Record<string, string>>): string[] {
    return this.providers.filter(provider => !!providerRefs[provider.id] && this.supports(provider, mode, 'period')).map(provider => provider.id);
  }
  private async claimed(item: BillingCatalogItem, staticPacks: () => Promise<boolean>): Promise<boolean> {
    if (item.mode === 'payment') return !(await staticPacks());
    const plans = this.planOffers();
    return item.mode === 'subscription' && !!plans && await plans.claims(item.id);
  }
  /** Providers that can sell a one-time pack price now. */
  packProviders(providerRefs: Readonly<Record<string, string>>): string[] {
    return this.providers.filter(provider => !!providerRefs[provider.id] && this.supports(provider, 'payment', 'payment')).map(provider => provider.id);
  }
  /**
   * Credit packs for `GET /billing/plans`: listed database packs, or (while the table is empty) the
   * static payment offers they replace, projected to the same shape (`id`/`slug`/`offerId` = offer id).
   * Prices are optionally narrowed to one currency; text is localized for `locale` when translated.
   */
  async publicPacks(currency?: string, locale?: string): Promise<PublicCreditPack[]> {
    if (this.packOffers && !(await this.staticPacksSold()))
      return (await this.packOffers.service.list({ listedOnly: true })).map(pack => ({
        id: pack.id, slug: pack.slug, title: localizedText(pack.title, pack.titleI18n, locale),
        description: localizedText(pack.description, pack.descriptionI18n, locale),
        credits: pack.credits, expiresInDays: pack.expiresInDays, order: pack.order,
        prices: pack.prices.filter(price => !currency || price.currency === currency).map(price => {
          const providers = toMinorUnits(price.amount, price.currency) > 0 ? this.packProviders(price.providerRefs) : [];
          return { currency: price.currency, amount: price.amount, purchasable: providers.length > 0,
            offerId: providers.length ? packOfferId(pack.id, price.currency) : null, providers };
        }),
      }));
    return this.items().filter(item => item.mode === 'payment').map((item, order) => {
      const providers = this.available(item).map(provider => provider.id);
      return { id: item.id, slug: item.id, title: item.title, description: null, credits: item.credits,
        expiresInDays: item.expiresInDays, order,
        prices: currency && item.currency !== currency ? [] : [{ currency: item.currency, amount: item.amount,
          purchasable: providers.length > 0, offerId: providers.length ? item.id : null, providers }] };
    });
  }
  /** `GET /billing/catalog`: listed database packs (one offer per price) or the static offers they replace. */
  async list() {
    const offers = [];
    let staticPacks: Promise<boolean> | undefined;
    const sold = () => (staticPacks ??= this.staticPacksSold());
    if (this.packOffers && !(await sold()))
      for (const pack of await this.packOffers.service.list({ listedOnly: true }))
        for (const price of pack.prices) {
          const providers = toMinorUnits(price.amount, price.currency) > 0 ? this.packProviders(price.providerRefs) : [];
          if (!providers.length) continue;
          offers.push({ id: packOfferId(pack.id, price.currency), title: pack.title, mode: 'payment' as const,
            money: { amount: price.amount, currency: price.currency }, credits: pack.credits, expiresInDays: pack.expiresInDays,
            providers: providers.map(id => ({ id, requiresCapture: !!this.providers.find(provider => provider.id === id)?.capture,
              referralProviders: this.referralProviders(id) })) });
        }
    for (const item of this.items()) {
      if (await this.claimed(item, sold)) continue;
      const providers = this.available(item);
      if (!providers.length) continue;
      offers.push({ id: item.id, title: item.title, mode: item.mode,
        money: { amount: item.amount, currency: item.currency }, credits: item.credits, expiresInDays: item.expiresInDays,
        providers: providers.map(provider => ({ id: provider.id,
          requiresCapture: item.mode === 'payment' && !!provider.capture, referralProviders: this.referralProviders(provider.id),
          ...(item.mode === 'subscription' ? { grantBasis: this.grantBasis(item, provider.id) } : {}) })) });
    }
    return offers;
  }
  async resolve(selection: Readonly<HostedCheckoutSelection>): Promise<HostedCheckoutOffer> {
    if (parsePlanOfferId(selection.offerId)) return this.resolvePlan(selection);
    if (parsePackOfferId(selection.offerId)) return this.resolvePack(selection);
    const item = this.items().find(offer => offer.id === selection.offerId);
    if (!item || !this.available(item).some(provider => provider.id === selection.providerId)
      || await this.claimed(item, () => this.staticPacksSold()))
      throw new BadRequestException('Offer or payment provider is unavailable');
    const catalogReference = item.providers[selection.providerId as keyof BillingCatalogItem['providers']];
    if (!catalogReference) throw new BadRequestException('Offer is not available with this provider');
    return { version: item.version, catalogReference, description: item.title, mode: item.mode,
      money: { amount: item.amount, currency: item.currency },
      fulfillmentData: { credits: item.credits, expiresInDays: item.expiresInDays,
        ...(item.mode === 'subscription' ? { grantBasis: this.grantBasis(item, selection.providerId) } : {}) } };
  }
  /** Price, currency and provider reference come from the plan as it is now, frozen on the order. */
  private async resolvePlan(selection: Readonly<HostedCheckoutSelection>): Promise<HostedCheckoutOffer> {
    // The plan source also refuses a purchase that would not improve the buyer's term (409).
    const resolved = await this.planOffers()?.resolve(selection.offerId, selection.providerId, selection.ownerId);
    const provider = this.providers.find(value => value.id === selection.providerId);
    if (!resolved || !provider || !this.supports(provider, resolved.mode, 'period'))
      throw new BadRequestException('Offer or payment provider is unavailable');
    const { snapshot } = resolved;
    return { version: `plan:${snapshot.planId}@${snapshot.revision}`, catalogReference: snapshot.providerRef,
      description: resolved.plan.name, mode: resolved.mode, money: { amount: snapshot.amount, currency: snapshot.currency },
      // The plan term (write-back) and the per-period credits both come from this frozen snapshot;
      // renewals reuse it, so a later price edit never changes what an existing subscription grants.
      fulfillmentData: { credits: snapshot.credits,
        expiresInDays: typeof snapshot.creditExpiry === 'number' ? snapshot.creditExpiry : null,
        ...(snapshot.credits > 0 && snapshot.creditExpiry === 'period' ? { expiresAtPeriodEnd: true } : {}),
        ...(resolved.mode === 'subscription' ? { grantBasis: 'period' } : {}), plan: { ...snapshot } } };
  }
  /** Amount, currency, credits and expiry come from the pack as it is now, frozen on the order. */
  private async resolvePack(selection: Readonly<HostedCheckoutSelection>): Promise<HostedCheckoutOffer> {
    const resolved = this.packOffers ? await this.packOffers.service.resolveOffer(selection.offerId, selection.providerId) : null;
    const provider = this.providers.find(value => value.id === selection.providerId);
    if (!resolved || !provider || !this.supports(provider, 'payment', 'payment'))
      throw new BadRequestException('Offer or payment provider is unavailable');
    const { snapshot } = resolved;
    return { version: `pack:${snapshot.packId}@${snapshot.revision}`, catalogReference: snapshot.providerRef,
      description: resolved.pack.title, mode: 'payment', money: { amount: snapshot.amount, currency: snapshot.currency },
      fulfillmentData: { credits: snapshot.credits, expiresInDays: snapshot.expiresInDays, pack: { ...snapshot } } };
  }
  /** Referral programs the provider officially supports (none without a referral port). */
  referralProviders(provider: string): string[] {
    return this.referrals ? [...this.referrals.providers(provider)] : [];
  }
  /** Provider checkout metadata from the browser's referral value (never trusted, never required). */
  metadata(provider: string, referral: unknown): Record<string, string> {
    return this.referrals ? this.referrals.metadata(provider, referral) : {};
  }
}
