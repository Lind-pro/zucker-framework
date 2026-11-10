import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { CreditPackCatalogService, HostedCheckoutService, type HostedCheckoutAdapter, type HostedCheckoutOrder, type SubscriptionAdapter, type RefundAdapter, type WebhookRequest } from '@zucker-framework/payment';
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
      resolveOffer: selection => this.catalog.resolve(selection),
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
  async checkoutPolicy(): Promise<{ defaultProvider: string | null; allowProviderChoice: boolean }> {
    const values: BillingPolicyValues = this.policies?.ids().includes(BILLING_POLICY.id)
      ? await this.policies.get(BILLING_POLICY) : { defaultProvider: '', allowProviderChoice: true };
    const preferred = values.defaultProvider && this.providerIds.has(values.defaultProvider) ? values.defaultProvider : null;
    return { defaultProvider: preferred, allowProviderChoice: values.allowProviderChoice };
  }
  async create(ownerId: string, key: string | undefined, body: unknown) {
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable Idempotency-Key is required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid checkout request');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(field => !['offerId', 'providerId', 'referral'].includes(field))
      || typeof input.offerId !== 'string' || typeof input.providerId !== 'string') throw new BadRequestException('Invalid checkout selection');
    // With provider choice off, the server (not the pricing page) holds buyers to the default provider.
    const checkout = await this.checkoutPolicy();
    if (!checkout.allowProviderChoice && checkout.defaultProvider && input.providerId !== checkout.defaultProvider)
      throw new BadRequestException('Offer or payment provider is unavailable');
    const orderId = createHash('sha256').update(JSON.stringify(['checkout', ownerId, key])).digest('hex');
    return this.checkout.create({ orderId, ownerId, offerId: input.offerId, providerId: input.providerId,
      providerMetadata: this.catalog.metadata(input.providerId, input.referral) });
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
    state: order.state, creationState: order.creationState, captureState: order.captureState,
    checkoutUrl: order.fulfilledAt ? null : order.checkoutUrl,
    fulfilledAt: order.offer.mode === 'subscription' ? subscriptionFulfilledAt : order.fulfilledAt,
    createdAt: order.createdAt, subscriptionId: order.subscriptionId };
}
