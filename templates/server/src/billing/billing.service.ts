import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { HostedCheckoutService, type HostedCheckoutAdapter, type HostedCheckoutOrder, type SubscriptionAdapter, type RefundAdapter, type WebhookRequest } from '@zucker-framework/payment';
import type { ReferralProvider } from '@zucker-framework/fe-site';
import { ApplicationDatabase } from '../database';
import { BillingCatalog, readBillingCatalog } from './catalog';
import { createCheckoutPersistence } from './checkout-persistence';
import { configuredBillingProviders } from './providers';
import { BillingSubscriptionsService } from './subscriptions.service';
import { readCreditBalance } from '../credits/credits.service';
import { BillingRefundsService } from './refunds/refunds.service';
import { readOrderRefundSummary } from './refunds/refunds.projection';

export const BILLING_OPTIONS = Symbol('BILLING_OPTIONS');
export interface BillingOptions {
  providers: readonly HostedCheckoutAdapter[];
  subscriptionProviders?: readonly SubscriptionAdapter[];
  refundProviders?: readonly RefundAdapter[];
  catalogJson?: string;
  webUrl: string;
  referralProviders?: readonly ReferralProvider[];
}
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
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(BILLING_OPTIONS) options: BillingOptions) {
    const base = new URL(options.webUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid billing site URL');
    this.catalog = new BillingCatalog(readBillingCatalog(options.catalogJson), options.providers, options.referralProviders, options.subscriptionProviders);
    this.refunds = new BillingRefundsService(database, options.refundProviders ?? []);
    this.subscriptions = new BillingSubscriptionsService(database, options.subscriptionProviders ?? [], options.webUrl, this.refunds);
    this.checkout = new HostedCheckoutService({
      persistence: createCheckoutPersistence(database), providers: options.providers,
      resolveOffer: async selection => this.catalog.resolve(selection),
      prepareFulfillment: (order, observation) => this.refunds.prepareCheckout(order, observation),
      returnUrls: orderId => {
        const success = new URL('/billing/return', base), cancel = new URL('/billing/return', base);
        success.searchParams.set('order', orderId);
        cancel.searchParams.set('order', orderId); cancel.searchParams.set('canceled', '1');
        return { successUrl: success.href, cancelUrl: cancel.href };
      },
    });
  }
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
  async create(ownerId: string, key: string | undefined, body: unknown) {
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable Idempotency-Key is required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid checkout request');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(field => !['offerId', 'providerId', 'referral'].includes(field))
      || typeof input.offerId !== 'string' || typeof input.providerId !== 'string') throw new BadRequestException('Invalid checkout selection');
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
