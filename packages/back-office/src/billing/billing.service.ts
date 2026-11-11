import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  checkoutPayable, CreditPackCatalogService, HostedCheckoutError, HostedCheckoutService,
  type HostedCheckoutAdapter, type HostedCheckoutOrder, type SubscriptionAdapter, type RefundAdapter, type WebhookRequest,
} from '@zucker-framework/payment';
import type { BillingDatabase } from './billing.database';
import { billingPersistenceConfig, type BillingPersistenceConfig } from './billing.config';
import { BillingCatalog, readBillingCatalog } from './catalog';
import { createCheckoutPersistence } from './checkout-persistence';
import { BillingSubscriptionsService } from './subscriptions.service';
import { BillingRefundsService } from './refunds/refunds.service';
import { readOrderRefundSummary } from './refunds/refunds.projection';
import { BillingExtensions } from './billing-extensions';
import type {
  BillingCheckoutHooks, BillingCheckoutPolicySource, BillingCheckoutPolicyValues, BillingFulfillmentHooks, BillingPlanOffers,
  BillingPromotions, BillingReferrals, BillingRefundHooks,
} from './billing.ports';
import { createCreditPackStore, creditPacksConfigured } from './credit-packs.store';
import type { PaymentCredentialResolver, PaymentProviderSet } from './payment-credentials';

/** Uniform refusal for every promo code cause (unknown, expired, disabled, wrong offer, exhausted, policy off). */
export function promoInvalid(): never {
  throw new BadRequestException({ code: 'PROMO_INVALID', message: 'This promo code cannot be used for this purchase' });
}
const PROMO_ALIAS = /^[A-Za-z0-9_-]{3,32}$/;
const CHECKOUT_HINT = /^[^\s\x00-\x1f\x7f]{1,255}$/;

/** Provider instances and the static catalog; may change at runtime (hot-applied payment settings). */
export interface BillingRuntimeOptions {
  providers: readonly HostedCheckoutAdapter[];
  subscriptionProviders?: readonly SubscriptionAdapter[];
  refundProviders?: readonly RefundAdapter[];
  /** Static offers (JSON, see `readBillingCatalog`): credit packs, credit-only subscriptions and plan seeds. Needs a credit ledger. */
  catalogJson?: string;
  /** Site origin the provider returns the buyer to (http/https, no credentials). */
  webUrl: string;
  /**
   * Revision of the payment connection configuration in effect; recorded on each new order created
   * through a fixed provider list (with `credentials`, the resolver records the revision it used).
   */
  configRevision?: string | null;
  /**
   * Hot-applied payment credentials (D12). When present, new orders use the current saved payment
   * configuration and existing orders, subscriptions and refunds resolve the credentials of their own
   * account; `providers`/`subscriptionProviders`/`refundProviders` then only seed the catalog until
   * its first refresh.
   */
  credentials?: PaymentCredentialResolver;
}
/**
 * A value or a resolver. With a resolver, the static catalog and the config revision recorded on new
 * orders follow it on every call; provider instances follow the saved configuration through `credentials`.
 */
export type BillingRuntimeSource = BillingRuntimeOptions | (() => BillingRuntimeOptions);

/** Composition-time configuration of the billing service (ports and policy, no provider secrets). */
export interface BillingServiceConfig {
  /** Storage mapping and the optional credit ledger (default: template names, plans-only). */
  persistence?: BillingPersistenceConfig;
  referrals?: BillingReferrals | null;
  /** Checkout provider policy (default: any enabled provider, no promo codes). */
  policy?: BillingCheckoutPolicySource | null;
  checkout?: BillingCheckoutHooks;
  refunds?: BillingRefundHooks;
  /**
   * Provider return URLs of a new order (default `<webUrl>/billing/return?order=<id>` and the same
   * with `canceled=1`). Must stay on the site origin.
   */
  returnUrls?(orderId: string, webUrl: URL): { successUrl: string; cancelUrl: string };
  /** Path the provider billing portal returns to (default `/billing/subscriptions`). */
  portalReturnPath?: string;
}

/**
 * Orders, provider webhooks, subscriptions and refunds over `@zucker-framework/payment`. A plain class:
 * `BackOfficeBillingModule` constructs it, or a consumer registers a subclass (see the module docs).
 */
export class BillingService {
  readonly checkout: HostedCheckoutService;
  readonly catalog: BillingCatalog;
  readonly subscriptions: BillingSubscriptionsService;
  readonly refunds: BillingRefundsService;
  /** Credit pack administration and `pack:` offer resolution; null in plans-only mode. */
  readonly packs: CreditPackCatalogService | null;
  /** Plan offers and fulfillment hooks registered by other modules (see {@link usePlanOffers}). */
  readonly extensions = new BillingExtensions();
  readonly persistence: BillingPersistenceConfig;
  /** Adapters that accept new orders now, shared with the catalog and updated in place by {@link refreshProviders}. */
  private readonly liveCheckouts: HostedCheckoutAdapter[];
  private readonly liveSubscriptions: SubscriptionAdapter[];
  private readonly credentials?: PaymentCredentialResolver;
  private readonly hooks: BillingCheckoutHooks;
  private readonly policySource: BillingCheckoutPolicySource | null;
  private promotions: BillingPromotions | null = null;
  constructor(protected readonly database: BillingDatabase, source: BillingRuntimeSource, config: BillingServiceConfig = {}) {
    const current = typeof source === 'function' ? source : () => source;
    const options = current();
    this.persistence = config.persistence ?? billingPersistenceConfig();
    this.hooks = config.checkout ?? {};
    this.policySource = config.policy ?? null;
    const credits = this.persistence.credits;
    const base = new URL(options.webUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid billing site URL');
    let parsed: { json: string | undefined; items: ReturnType<typeof readBillingCatalog> } | null = null;
    const items = () => {
      const json = current().catalogJson;
      if (!parsed || parsed.json !== json) parsed = { json, items: readBillingCatalog(json) };
      // Every static offer grants credits; without a ledger it could never be fulfilled.
      if (parsed.items.length && !credits) throw new Error('[back-office/billing] static catalog offers need a credit ledger (plans-only billing)');
      return parsed.items;
    };
    items(); // fail fast on an invalid catalog
    this.credentials = options.credentials;
    this.liveCheckouts = [...options.providers];
    this.liveSubscriptions = [...options.subscriptionProviders ?? []];
    const storage = this.persistence.storage;
    this.packs = credits ? new CreditPackCatalogService(createCreditPackStore(database, storage)) : null;
    const refresh = () => this.refreshProviders();
    this.catalog = new LiveBillingCatalog(refresh, items, this.liveCheckouts, config.referrals ?? null, this.liveSubscriptions,
      () => this.extensions.planOffers, this.packs ? { service: this.packs, configured: () => creditPacksConfigured(database, storage) } : null);
    this.refunds = new BillingRefundsService(database, this.credentials?.refunds ?? options.refundProviders ?? [],
      { persistence: this.persistence, extensions: this.extensions, hooks: config.refunds });
    this.subscriptions = new BillingSubscriptionsService(database, this.credentials?.subscriptions ?? options.subscriptionProviders ?? [],
      options.webUrl, this.refunds, this.extensions, { persistence: this.persistence, portalReturnPath: config.portalReturnPath });
    const returnUrls = config.returnUrls ?? ((orderId: string, site: URL) => {
      const success = new URL('/billing/return', site), cancel = new URL('/billing/return', site);
      success.searchParams.set('order', orderId);
      cancel.searchParams.set('order', orderId); cancel.searchParams.set('canceled', '1');
      return { successUrl: success.href, cancelUrl: cancel.href };
    });
    this.checkout = new HostedCheckoutService({
      persistence: createCheckoutPersistence(database, this.persistence, { extensions: this.extensions, configRevision: () => current().configRevision ?? null }),
      providers: this.credentials ?? options.providers,
      // The price comes from the catalog; a promotion (never the browser's amount) is frozen on top of it.
      resolveOffer: async selection => {
        const resolved = await this.catalog.resolve(selection);
        const offer = !this.promotions ? (selection.promotionCode === undefined ? resolved : promoInvalid())
          : await this.promotions.apply(selection, resolved);
        await this.hooks.verifyOffer?.(offer, selection);
        return offer;
      },
      prepareFulfillment: (order, observation) => this.refunds.prepareCheckout(order, observation),
      returnUrls: orderId => returnUrls(orderId, base),
    });
  }
  /** Hot-applied payment credentials, when this process manages them (internal; never HTTP). */
  get paymentCredentials(): PaymentCredentialResolver | undefined { return this.credentials; }
  /** True when a credit ledger is configured (otherwise plans-only). */
  get creditsEnabled(): boolean { return !!this.persistence.credits; }
  /**
   * Replaces the catalog's provider lists with the providers that accept new orders now (strict read of
   * the saved payment revisions). Without `credentials` the lists are fixed and this does nothing.
   */
  async refreshProviders(): Promise<void> {
    if (!this.credentials) return;
    const sets: PaymentProviderSet[] = await this.credentials.currentSets();
    // One synchronous swap, so a catalog read never sees checkout and lifecycle adapters of different revisions.
    this.liveCheckouts.splice(0, this.liveCheckouts.length, ...sets.map(set => set.checkout));
    this.liveSubscriptions.splice(0, this.liveSubscriptions.length, ...sets.flatMap(set => set.subscription ? [set.subscription] : []));
  }
  /** The checkout adapters accepting new orders (after the last refresh). */
  liveProviders(): readonly HostedCheckoutAdapter[] { return this.liveCheckouts; }
  /** Registers the plan catalog as the source of plan offers (called by the plan host). */
  usePlanOffers(offers: BillingPlanOffers): void {
    if (this.extensions.planOffers && this.extensions.planOffers !== offers) throw new Error('Plan offers are already registered');
    this.extensions.planOffers = offers;
  }
  /** Registers promo code handling (called by the promotions feature). */
  usePromotions(promotions: BillingPromotions): void {
    if (this.promotions && this.promotions !== promotions) throw new Error('Promotions are already registered');
    this.promotions = promotions;
  }
  /** Adds same-transaction fulfillment hooks (plan entitlement write-back, full-refund term revocation). */
  useFulfillmentHooks(hooks: BillingFulfillmentHooks): void { this.extensions.register(hooks); }

  async present(order: HostedCheckoutOrder) {
    const refund = await readOrderRefundSummary(this.database, order, this.persistence.storage);
    if (order.offer.mode !== 'subscription') return { ...publicCheckoutOrder(order), refund };
    const row = await this.persistence.storage.model(this.database, 'billingSubscriptions').findUnique({ where: { id: order.id },
      select: { ownerId: true, initialFulfilledAt: true } }) as { ownerId: string; initialFulfilledAt: Date | null } | null;
    return { ...publicCheckoutOrder(order, row?.ownerId === order.ownerId ? row.initialFulfilledAt : null), refund };
  }
  async confirm(orderId: string, ownerId: string, checkoutId?: string) {
    const order = await this.checkout.confirm({ orderId, ownerId, checkoutId });
    if (order.offer.mode === 'subscription' && order.fulfilledAt) await this.subscriptions.refresh(order.id, ownerId);
    return this.present(order);
  }
  /**
   * Administrator recovery of an order whose provider response was lost: the provider session id the
   * operator found (for example a Stripe Checkout Session id) is only a lookup hint. The product's
   * `verifyRecovery` hook proves the session belongs to this application and order; the hosted checkout
   * service then reads the provider evidence and verifies reference, account scope, frozen offer and
   * exact money before fulfilling. Idempotent for a fulfilled order.
   */
  async recover(orderId: string, checkoutId: unknown) {
    if (typeof checkoutId !== 'string' || !CHECKOUT_HINT.test(checkoutId)) throw new BadRequestException('Invalid checkout identity');
    if (typeof orderId !== 'string' || !orderId || orderId.length > 255) throw new BadRequestException('Invalid order');
    const order = await this.persistence.storage.model(this.database, 'billingOrders').findUnique({ where: { id: orderId } }) as HostedCheckoutOrder | null;
    if (!order) throw new HostedCheckoutError('not_found', 'Order not found');
    if (order.fulfilledAt) return this.present(order);
    if (order.checkoutId && order.checkoutId !== checkoutId) throw new HostedCheckoutError('conflict', 'The order is bound to another checkout');
    // Optional product check first (for example application metadata on the provider session); the
    // provider evidence itself is always verified by the hosted checkout service below.
    await this.hooks.verifyRecovery?.(checkoutId, order);
    return this.confirm(order.id, order.ownerId, checkoutId);
  }
  async webhook(provider: string, request: WebhookRequest) {
    if (await this.refunds.handleWebhook(provider, request)) return;
    const order = await this.checkout.webhook(provider, request);
    if (order?.offer.mode === 'subscription' && order.fulfilledAt) await this.subscriptions.refresh(order.id, order.ownerId);
    else if (!order) await this.subscriptions.handleWebhook(provider, request);
  }
  /**
   * Effective checkout provider policy. A default provider that is not enabled is reported as null,
   * so the pricing page never preselects it.
   */
  async checkoutPolicy(): Promise<{ defaultProvider: string | null; allowProviderChoice: boolean; promoCodes: 'none' | 'alias' }> {
    const values: BillingCheckoutPolicyValues = this.policySource
      ? await this.policySource() : { defaultProvider: '', allowProviderChoice: true, allowCustomerPromoCodes: false };
    await this.refreshProviders();
    const preferred = values.defaultProvider && this.liveCheckouts.some(provider => provider.id === values.defaultProvider) ? values.defaultProvider : null;
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
    // The catalog checks the selection against the providers enabled now; the order itself records the
    // revision of the adapter `HostedCheckoutService.create` resolves for it.
    await this.refreshProviders();
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
    const orders = createCheckoutPersistence(this.database, this.persistence).orders;
    const where = { ownerId };
    const [data, total] = await Promise.all([
      orders.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 20, take: 20 }), orders.count({ where }),
    ]);
    return { data: await Promise.all(data.map(order => this.present(order))), total, page, pageSize: 20 };
  }
  async balance(ownerId: string) {
    const credits = this.persistence.credits;
    if (!credits?.balance) throw new HostedCheckoutError('unsupported', 'Credit balances are not available');
    const current = await credits.balance(this.database, ownerId);
    return { balance: current.available, frozenBalance: current.frozen, bookBalance: current.bookBalance };
  }
}

/** The catalog over live provider lists: listings refresh them first, so a saved payment profile shows without restart. */
class LiveBillingCatalog extends BillingCatalog {
  constructor(private readonly refresh: () => Promise<void>, ...args: ConstructorParameters<typeof BillingCatalog>) { super(...args); }
  override async list() { await this.refresh(); return super.list(); }
  override async publicPacks(currency?: string, locale?: string) { await this.refresh(); return super.publicPacks(currency, locale); }
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
