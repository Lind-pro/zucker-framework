import { BadRequestException } from '@nestjs/common';
import type { HostedCheckoutAdapter, HostedCheckoutOffer, HostedCheckoutSelection, SubscriptionAdapter } from '@zucker-framework/payment';
import { parsePlanOfferId, toMinorUnits } from '@zucker-framework/payment';
import { referralMetadata, type ReferralProvider } from '@zucker-framework/fe-site';
import { validateCreditFulfillmentPolicy } from './ledger';
import type { BillingPlanOffers } from './billing-extensions';

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

/** Server-owned commercial configuration. An empty catalog is intentionally valid. */
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

/**
 * Checkout offers. Plans (when a {@link BillingPlanOffers} source is registered) are the single source
 * of plan prices: a `plan:` offer is resolved from the current plan price and its snapshot is frozen
 * on the order. Static BILLING_CATALOG_JSON offers remain for credit packs and credit-only
 * subscriptions; a static subscription offer whose id a plan claims (its seed) is no longer sold.
 */
export class BillingCatalog {
  private readonly items: () => readonly BillingCatalogItem[];
  constructor(items: readonly BillingCatalogItem[] | (() => readonly BillingCatalogItem[]), private readonly providers: readonly HostedCheckoutAdapter[],
    private readonly referrals: readonly ReferralProvider[] = [], private readonly subscriptions: readonly SubscriptionAdapter[] = [],
    private readonly planOffers: () => BillingPlanOffers | null = () => null) {
    this.items = typeof items === 'function' ? items : () => items;
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
  private async claimed(item: BillingCatalogItem): Promise<boolean> {
    const plans = this.planOffers();
    return item.mode === 'subscription' && !!plans && await plans.claims(item.id);
  }
  async list() {
    const offers = [];
    for (const item of this.items()) {
      if (await this.claimed(item)) continue;
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
    const item = this.items().find(offer => offer.id === selection.offerId);
    if (!item || !this.available(item).some(provider => provider.id === selection.providerId) || await this.claimed(item))
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
      // Plans grant entitlement, not credits. The snapshot is what write-back applies.
      fulfillmentData: { credits: 0, expiresInDays: null, ...(resolved.mode === 'subscription' ? { grantBasis: 'period' } : {}), plan: { ...snapshot } } };
  }
  private referralProviders(provider: string): ReferralProvider[] {
    // Official affiliate integration support, not merely a gateway accepting arbitrary metadata.
    if (provider === 'stripe') return [...this.referrals];
    if (provider === 'creem') return this.referrals.filter(value => value === 'affonso');
    return [];
  }
  metadata(provider: string, referral: unknown): Record<string, string> {
    return referralMetadata(referral, { enabledProviders: this.referralProviders(provider) });
  }
}
