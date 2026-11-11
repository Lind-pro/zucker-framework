import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { checkoutPayable, CreditPackCatalogService, HostedCheckoutService, type HostedCheckoutAdapter, type HostedCheckoutOffer, type HostedCheckoutOrder,
  type HostedCheckoutSelection, type SubscriptionAdapter, type RefundAdapter, type WebhookRequest } from '@zucker-framework/payment';
import type { ReferralProvider } from '@zucker-framework/fe-site';
import { ApplicationDatabase } from '../database';
import { BillingCatalog, readBillingCatalog } from './catalog';
import { createCheckoutPersistence } from './checkout-persistence';
import { configuredBillingProviders } from './providers';
import { BillingSubscriptionsService } from './subscriptions.service';
import { readCreditBalance } from '../credits/credits.service';
import { BillingRefundsService } from './refunds/refunds.service';
import { readOrderRefundSummary } from './refunds/refunds.projection';
import { BillingExtensions, type BillingFulfillmentHooks, type BillingPlanOffers } from './billing-extensions';
import { createCreditPackStore, creditPacksConfigured } from './credit-packs.store';
import { BILLING_POLICY, type BillingPolicyValues } from './billing.policy';
import { PolicyService } from '../policy/policy.service';

export const BILLING_OPTIONS = Symbol('BILLING_OPTIONS');

/** Uniform refusal for every promo code cause (unknown, expired, disabled, wrong offer, exhausted, policy off). */
export function promoInvalid(): never {
  throw new BadRequestException({ code: 'PROMO_INVALID', message: 'This promo code cannot be used for this purchase' });
}
const PROMO_ALIAS = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * Promotions as a checkout extension, registered by the promotions feature (see
 * {@link BillingService.usePromotions}) so billing never imports it.
 */
export interface BillingPromotions {
  /**
   * Freeze a server-computed discount onto `offer` (`offer.promotion`) and reserve one use of it for
   * `selection.orderId` under a lock on the promotion, so redemption limits hold under concurrency.
   * With `selection.promotionCode` (an upper-case alias) that promotion or {@link promoInvalid};
   * without it an automatic promotion when one applies, else the offer unchanged. Idempotent per order.
   */
  apply(selection: Readonly<HostedCheckoutSelection>, offer: HostedCheckoutOffer): Promise<HostedCheckoutOffer>;
  /** Drop the reservation of an order that was never created. Idempotent; a created order keeps it. */
  release(orderId: string): Promise<void>;
}
export interface BillingOptions {
  providers: readonly HostedCheckoutAdapter[];
  subscriptionProviders?: readonly SubscriptionAdapter[];
  refundProviders?: readonly RefundAdapter[];
  /** Static offers: credit packs, credit-only subscriptions and the seed of subscription plans. */
  catalogJson?: string;
  webUrl: string;
  referralProviders?: readonly ReferralProvider[];
  /** Revision of the payment connection configuration in effect; recorded on each new order. */
  configRevision?: string | null;
}
/**
 * BILLING_OPTIONS may be a value or a resolver. With a resolver, the static catalog and the config
 * revision recorded on new orders follow the resolver on every call; provider SDK instances are
 * still built once (hot provider swapping is the runtime-settings Phase 1 work).
 */
export type BillingOptionsSource = BillingOptions | (() => BillingOptions);
export function billingOptionsFromEnvironment(env: NodeJS.ProcessEnv): BillingOptions {
  const referrals = (env.BILLING_REFERRAL_PROVIDERS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (referrals.some(value => value !== 'affonso' && value !== 'promotekit')) throw new Error('Unsupported billing referral provider');
  const providers = configuredBillingProviders(env);
  return { providers: providers.checkouts, subscriptionProviders: providers.subscriptions, refundProviders: providers.refunds, catalogJson: env.BILLING_CATALOG_JSON,
    webUrl: env.WEB_URL ?? 'http://localhost:4202', referralProviders: referrals as ReferralProvider[] };
}

@Injectable()
export class BillingService {
  readonly checkout: HostedCheckoutService;
  readonly catalog: BillingCatalog;
  readonly subscriptions: BillingSubscriptionsService;
  readonly refunds: BillingRefundsService;
  /** Credit pack administration (`/management/credit-packs`) and `pack:` offer resolution. */
  readonly packs: CreditPackCatalogService;
  /** Plan offers and fulfillment hooks registered by other modules (see {@link usePlanOffers}). */
  readonly extensions = new BillingExtensions();
  private readonly providerIds: ReadonlySet<string>;
  private promotions: BillingPromotions | null = null;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(BILLING_OPTIONS) source: BillingOptionsSource,
    @Optional() private readonly policies?: PolicyService) {
    const current = typeof source === 'function' ? source : () => source;
    const options = current();
    const base = new URL(options.webUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid billing site URL');
    let parsed: { json: string | undefined; items: ReturnType<typeof readBillingCatalog> } | null = null;
    const items = () => {
      const json = current().catalogJson;
      if (!parsed || parsed.json !== json) parsed = { json, items: readBillingCatalog(json) };
      return parsed.items;
    };
    items(); // fail fast on an invalid catalog
    this.providerIds = new Set(options.providers.map(provider => provider.id));
    this.packs = new CreditPackCatalogService(createCreditPackStore(database));
    this.catalog = new BillingCatalog(items, options.providers, options.referralProviders, options.subscriptionProviders,
      () => this.extensions.planOffers, { service: this.packs, configured: () => creditPacksConfigured(database) });
    this.refunds = new BillingRefundsService(database, options.refundProviders ?? []);
    this.subscriptions = new BillingSubscriptionsService(database, options.subscriptionProviders ?? [], options.webUrl, this.refunds, this.extensions);
    this.checkout = new HostedCheckoutService({
      persistence: createCheckoutPersistence(database, { extensions: this.extensions, configRevision: () => current().configRevision ?? null }),
      providers: options.providers,
      // The price comes from the catalog; a promotion (never the browser's amount) is frozen on top of it.
      resolveOffer: async selection => {
        const offer = await this.catalog.resolve(selection);
        if (!this.promotions) return selection.promotionCode === undefined ? offer : promoInvalid();
        return this.promotions.apply(selection, offer);
      },
      prepareFulfillment: (order, observation) => this.refunds.prepareCheckout(order, observation),
      returnUrls: orderId => {
        const success = new URL('/billing/return', base), cancel = new URL('/billing/return', base);
        success.searchParams.set('order', orderId);
        cancel.searchParams.set('order', orderId); cancel.searchParams.set('canceled', '1');
        return { successUrl: success.href, cancelUrl: cancel.href };
      },
    });
  }
  /** Registers the plan catalog as the source of plan offers (called by SubscriptionsModule). */
  usePlanOffers(offers: BillingPlanOffers): void {
    if (this.extensions.planOffers && this.extensions.planOffers !== offers) throw new Error('Plan offers are already registered');
    this.extensions.planOffers = offers;
  }
  /** Registers promo code handling (called by PromotionsModule). */
  usePromotions(promotions: BillingPromotions): void {
    if (this.promotions && this.promotions !== promotions) throw new Error('Promotions are already registered');
    this.promotions = promotions;
  }
  /** Adds same-transaction fulfillment hooks (for example plan entitlement write-back). */
  useFulfillmentHooks(hooks: BillingFulfillmentHooks): void { this.extensions.register(hooks); }

  async present(order: HostedCheckoutOrder) {
    const refund = await readOrderRefundSummary(this.database, order);
    if (order.offer.mode !== 'subscription') return { ...publicCheckoutOrder(order), refund };
    const row = await this.database.model('billingSubscriptions').findUnique({ where: { id: order.id },
      select: { ownerId: true, initialFulfilledAt: true } }) as { ownerId: string; initialFulfilledAt: Date | null } | null;
    return { ...publicCheckoutOrder(order, row?.ownerId === order.ownerId ? row.initialFulfilledAt : null), refund };
  }
  async confirm(orderId: string, ownerId: string, checkoutId?: string) {
    const order = await this.checkout.confirm({ orderId, ownerId, checkoutId });
    if (order.offer.mode === 'subscription' && order.fulfilledAt) await this.subscriptions.refresh(order.id, ownerId);
    return this.present(order);
  }
  async webhook(provider: string, request: WebhookRequest) {
    if (await this.refunds.handleWebhook(provider, request)) return;
    const order = await this.checkout.webhook(provider, request);
    if (order?.offer.mode === 'subscription' && order.fulfilledAt) await this.subscriptions.refresh(order.id, order.ownerId);
    else if (!order) await this.subscriptions.handleWebhook(provider, request);
  }
  /**
   * Effective checkout provider policy (the `billing` product policy when registered). A default
   * provider that is not enabled is reported as null, so the pricing page never preselects it.
   */
  async checkoutPolicy(): Promise<{ defaultProvider: string | null; allowProviderChoice: boolean; promoCodes: 'none' | 'alias' }> {
    const values: BillingPolicyValues = this.policies?.ids().includes(BILLING_POLICY.id)
      ? await this.policies.get(BILLING_POLICY) : { defaultProvider: '', allowProviderChoice: true, allowCustomerPromoCodes: false };
    const preferred = values.defaultProvider && this.providerIds.has(values.defaultProvider) ? values.defaultProvider : null;
    // Buyers type an alias only; the provider's own code entry stays off (its discount could not be frozen).
    const promoCodes = values.allowCustomerPromoCodes === true && this.promotions ? 'alias' as const : 'none' as const;
    return { defaultProvider: preferred, allowProviderChoice: values.allowProviderChoice, promoCodes };
  }
  async create(ownerId: string, key: string | undefined, body: unknown) {
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable Idempotency-Key is required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid checkout request');
    const input = body as Record<string, unknown>;
    // Exact keys: a provider code, price or discount can never be supplied by the browser.
    if (Object.keys(input).some(field => !['offerId', 'providerId', 'referral', 'promoCode'].includes(field))
      || typeof input.offerId !== 'string' || typeof input.providerId !== 'string') throw new BadRequestException('Invalid checkout selection');
    if (input.promoCode !== undefined && (typeof input.promoCode !== 'string' || !PROMO_ALIAS.test(input.promoCode.trim()))) promoInvalid();
    // With provider choice off, the server (not the pricing page) holds buyers to the default provider.
    const checkout = await this.checkoutPolicy();
    if (!checkout.allowProviderChoice && checkout.defaultProvider && input.providerId !== checkout.defaultProvider)
      throw new BadRequestException('Offer or payment provider is unavailable');
    const promotionCode = typeof input.promoCode === 'string' ? input.promoCode.trim().toUpperCase() : undefined;
    if (promotionCode !== undefined && checkout.promoCodes !== 'alias') promoInvalid();
    const orderId = createHash('sha256').update(JSON.stringify(['checkout', ownerId, key])).digest('hex');
    try {
      return await this.checkout.create({ orderId, ownerId, offerId: input.offerId, providerId: input.providerId,
        providerMetadata: this.catalog.metadata(input.providerId, input.referral),
        ...(promotionCode !== undefined ? { promotionCode } : {}) });
    } catch (error) {
      // A use reserved for an order that was then never created (provider refusal before the order
      // insert) is returned at once instead of holding a limited code until the reservation expires.
      await this.promotions?.release(orderId).catch(() => undefined);
      throw error;
    }
  }
  async list(ownerId: string, pageValue?: string) {
    const page = pageValue === undefined ? 1 : Number(pageValue);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Invalid page');
    const orders = createCheckoutPersistence(this.database).orders;
    const where = { ownerId };
    const [data, total] = await Promise.all([
      orders.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 20, take: 20 }), orders.count({ where }),
    ]);
    return { data: await Promise.all(data.map(order => this.present(order))), total, page, pageSize: 20 };
  }
  async balance(ownerId: string) {
    const current = await readCreditBalance(this.database, ownerId);
    return { balance: current.available, frozenBalance: current.frozen, bookBalance: current.bookBalance };
  }
}

/** Do not expose dispatch keys, private fulfillment policy or affiliate claims to the browser. */
export function publicCheckoutOrder(order: HostedCheckoutOrder, subscriptionFulfilledAt: Date | null = null) {
  return { id: order.id, offerId: order.offerId, providerId: order.providerId,
    title: order.offer.description, mode: order.offer.mode, money: order.offer.money,
    // The frozen amount due (after a promotion) and its discount; the provider code stays private.
    amountDue: checkoutPayable(order.offer), discount: order.offer.promotion?.discount ?? null,
    state: order.state, creationState: order.creationState, captureState: order.captureState,
    checkoutUrl: order.fulfilledAt ? null : order.checkoutUrl,
    fulfilledAt: order.offer.mode === 'subscription' ? subscriptionFulfilledAt : order.fulfilledAt,
    createdAt: order.createdAt, subscriptionId: order.subscriptionId };
}
