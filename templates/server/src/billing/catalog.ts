import { BadRequestException } from '@nestjs/common';
import type { HostedCheckoutAdapter, HostedCheckoutOffer, HostedCheckoutSelection, SubscriptionAdapter } from '@zucker-framework/payment';
import { toMinorUnits } from '@zucker-framework/payment';
import { referralMetadata, type ReferralProvider } from '@zucker-framework/fe-site';
import { validateCreditFulfillmentPolicy } from './ledger';

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

export class BillingCatalog {
  constructor(private readonly items: readonly BillingCatalogItem[], private readonly providers: readonly HostedCheckoutAdapter[],
    private readonly referrals: readonly ReferralProvider[] = [], private readonly subscriptions: readonly SubscriptionAdapter[] = []) {}

  private grantBasis(item: BillingCatalogItem, provider: string): 'period' | 'payment' {
    return item.subscriptionGrantBasis?.[provider as keyof NonNullable<BillingCatalogItem['subscriptionGrantBasis']>] ?? 'period';
  }

  private available(item: BillingCatalogItem) {
    return this.providers.filter(provider => {
      if (!provider.modes.includes(item.mode) || !item.providers[provider.id as keyof BillingCatalogItem['providers']]) return false;
      if (item.mode !== 'subscription') return true;
      const lifecycle = this.subscriptions.find(value => value.id === provider.id && value.accountScope === provider.accountScope);
      return lifecycle && (this.grantBasis(item, provider.id) === 'period'
        ? lifecycle.capabilities.paidPeriodProof !== 'unavailable'
        : lifecycle.capabilities.paidReceiptProof === 'provider' && !!lifecycle.listPaidReceipts);
    });
  }
  list() {
    return this.items.map(item => ({ id: item.id, title: item.title, mode: item.mode,
      money: { amount: item.amount, currency: item.currency }, credits: item.credits, expiresInDays: item.expiresInDays,
      providers: this.available(item).map(provider => ({ id: provider.id,
        requiresCapture: item.mode === 'payment' && !!provider.capture, referralProviders: this.referralProviders(provider.id),
        ...(item.mode === 'subscription' ? { grantBasis: this.grantBasis(item, provider.id) } : {}) })),
    })).filter(item => item.providers.length);
  }
  resolve(selection: Readonly<HostedCheckoutSelection>): HostedCheckoutOffer {
    const item = this.items.find(offer => offer.id === selection.offerId);
    if (!item || !this.available(item).some(provider => provider.id === selection.providerId)) throw new BadRequestException('Offer or payment provider is unavailable');
    const catalogReference = item.providers[selection.providerId as keyof BillingCatalogItem['providers']];
    if (!catalogReference) throw new BadRequestException('Offer is not available with this provider');
    return { version: item.version, catalogReference, description: item.title, mode: item.mode,
      money: { amount: item.amount, currency: item.currency },
      fulfillmentData: { credits: item.credits, expiresInDays: item.expiresInDays,
        ...(item.mode === 'subscription' ? { grantBasis: this.grantBasis(item, selection.providerId) } : {}) } };
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
