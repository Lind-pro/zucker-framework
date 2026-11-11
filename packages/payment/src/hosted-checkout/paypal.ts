import type { CheckoutPaymentIntent, ItemCategory, Order, OrderApplicationContextShippingPreference, OrderApplicationContextUserAction } from '@paypal/paypal-server-sdk';
import type { PayPalPaymentTransport, PayPalSubscriptionTransaction } from '../providers/paypal';
import { PAYPAL_SUPPORTED_CURRENCIES } from '../contract/adapters/paypal.adapter';
import { toMinorUnits } from '../contract/money';
import { HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutObservation } from './types';
import { canonicalMoney, record, text } from './validation';
import { isoDate, sameId } from '../subscriptions/validation';
import { payPalTransactionMoney } from '../subscriptions/paypal';

export interface PayPalHostedCheckoutOptions {
  transport: Pick<PayPalPaymentTransport, 'createOrder' | 'captureOrder' | 'getOrder' | 'verifyWebhookSignature'> &
    Partial<Pick<PayPalPaymentTransport, 'createSubscription' | 'getSubscription' | 'getSubscriptionPlan' | 'listSubscriptionTransactions'>>;
  accountScope: string;
  webhookId?: string;
  brandName?: string;
  now?: () => Date;
}

export function createPayPalHostedCheckoutAdapter(options: PayPalHostedCheckoutOptions): HostedCheckoutAdapter {
  const subscriptions = options.transport.createSubscription && options.transport.getSubscription &&
    options.transport.getSubscriptionPlan && options.transport.listSubscriptionTransactions ? {
      create: options.transport.createSubscription.bind(options.transport),
      get: options.transport.getSubscription.bind(options.transport),
      plan: options.transport.getSubscriptionPlan.bind(options.transport),
      transactions: options.transport.listSubscriptionTransactions.bind(options.transport),
    } : undefined;
  const planMoney = (plan: Record<string, unknown>) => {
    const cycles = plan.billing_cycles;
    const cycle = Array.isArray(cycles) && cycles.length === 1 ? record(cycles[0]) : undefined;
    const fixed = record(record(cycle?.pricing_scheme)?.fixed_price);
    const setup = record(record(plan.payment_preferences)?.setup_fee);
    const taxes = record(plan.taxes);
    if (plan.status !== 'ACTIVE' || cycle?.tenure_type !== 'REGULAR' || cycle.sequence !== 1 ||
        typeof fixed?.value !== 'string' || typeof fixed.currency_code !== 'string' ||
        setup && (typeof setup.value !== 'string' || !/^0+(?:\.0+)?$/.test(setup.value)) ||
        taxes && (typeof taxes.percentage !== 'string' || !/^0+(?:\.0+)?$/.test(taxes.percentage))) {
      throw new HostedCheckoutError('unsupported', 'PayPal checkout requires an active fixed-price plan without trial, setup fees or tax overrides');
    }
    const money = { amount: fixed.value, currency: fixed.currency_code };
    canonicalMoney(money); return money;
  };
  const observeSubscription = async (raw: Record<string, unknown>, readPayment: boolean, dueMoney?: HostedCheckoutObservation['dueMoney']): Promise<HostedCheckoutObservation> => {
    const id = text(raw.id), planId = text(raw.plan_id);
    if (!id || !planId || !subscriptions) throw new HostedCheckoutError('verification_failed', 'PayPal subscription identity is missing');
    const links = Array.isArray(raw.links) ? raw.links : [];
    const url = text(record(links.find((link) => record(link)?.rel === 'approve'))?.href);
    let first: PayPalSubscriptionTransaction | undefined;
    if (readPayment) {
      let start = isoDate(raw.create_time);
      const until = (options.now?.() ?? new Date()).toISOString();
      if (!start) throw new HostedCheckoutError('verification_failed', 'PayPal subscription creation time is missing');
      let cursor: string | undefined;
      let calls = 0;
      const candidates: PayPalSubscriptionTransaction[] = [];
      while (start < until) {
        if (++calls > 120) throw new HostedCheckoutError('verification_failed', 'PayPal initial transaction history exceeds the bounded lookup');
        const end = new Date(Math.min(Date.parse(until), Date.parse(start) + 31 * 86400000)).toISOString();
        const page = await subscriptions.transactions(id, { startTime: start, endTime: end, ...(cursor ? { cursor } : {}) });
        for (const transaction of page.transactions) {
          if (!['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(transaction.status)) continue;
          const time = isoDate(transaction.time);
          if (!time || time < start || time > end) throw new HostedCheckoutError('verification_failed', 'PayPal initial transaction is outside the requested window');
          candidates.push(transaction);
        }
        if (page.nextCursor) {
          if (page.nextCursor === cursor) throw new HostedCheckoutError('verification_failed', 'PayPal transaction pagination made no progress');
          cursor = page.nextCursor; continue;
        }
        if (candidates.length) {
          first = candidates.sort((a, b) => Date.parse(a.time ?? '') - Date.parse(b.time ?? '') || a.id.localeCompare(b.id))[0]; break;
        }
        start = end; cursor = undefined;
      }
    }
    const paidMoney = first?.status === 'COMPLETED' ? payPalTransactionMoney(first) : undefined;
    return { checkoutId: id, subscriptionId: id, url, reference: text(raw.custom_id), catalogReference: planId,
      quantity: raw.quantity === '1' ? 1 : undefined, mode: 'subscription', dueMoney,
      state: paidMoney ? 'paid' : first || raw.status === 'CANCELLED' || raw.status === 'EXPIRED' ? 'unpaid' : 'pending',
      paidMoney, paymentId: paidMoney ? first?.id : undefined, paymentKind: paidMoney ? 'transaction' : undefined };
  };
  const observe = (raw: Order): HostedCheckoutObservation => {
    if (!raw.id) throw new HostedCheckoutError('verification_failed', 'PayPal order ID is missing');
    const unit = raw.purchaseUnits?.length === 1 ? raw.purchaseUnits[0] : undefined;
    const item = unit?.items?.length === 1 ? unit.items[0] : undefined;
    const captures = unit?.payments?.captures;
    // This single-item workflow does not aggregate partial/multiple capture evidence.
    const captured = captures?.length === 1 && captures[0]?.status === 'COMPLETED' ? captures[0] : undefined;
    const money = captured?.amount;
    return {
      checkoutId: raw.id, url: raw.links?.find((link) => link.rel === 'approve')?.href,
      reference: unit?.referenceId, catalogReference: item?.sku, mode: 'payment',
      quantity: item?.quantity === '1' ? 1 : item?.quantity ? Number(item.quantity) : undefined,
      state: raw.status === 'COMPLETED' && captured ? 'paid'
        : raw.status === 'APPROVED' && raw.intent === 'CAPTURE' && !captures?.length ? 'requires_capture'
        : raw.status === 'APPROVED' ? 'unknown' : raw.status === 'VOIDED' ? 'unpaid' : 'pending',
      paidMoney: money?.value && money.currencyCode ? { amount: money.value, currency: money.currencyCode } : undefined,
      dueMoney: unit?.amount?.value && unit.amount.currencyCode ? { amount: unit.amount.value, currency: unit.amount.currencyCode } : undefined,
      paymentId: captured?.id, paymentKind: captured?.id ? 'capture' : undefined,
    };
  };
  return {
    id: 'paypal', accountScope: options.accountScope, modes: subscriptions ? ['payment', 'subscription'] : ['payment'], supportsMetadata: false,
    validate(offer) {
      // Rejected, not ignored: PayPal reports no subtotal/discount evidence for a frozen promotion.
      if (offer.promotion) throw new HostedCheckoutError('unsupported', 'PayPal checkout does not support promotions');
      if (offer.mode === 'subscription' && !subscriptions) throw new HostedCheckoutError('unsupported', 'PayPal subscription transport is not configured');
      if (!(PAYPAL_SUPPORTED_CURRENCIES as readonly string[]).includes(offer.money.currency)) {
        throw new HostedCheckoutError('unsupported', 'PayPal currency is unsupported');
      }
      toMinorUnits(offer.money.amount, ['JPY', 'HUF', 'TWD'].includes(offer.money.currency) ? 'JPY' : 'USD');
    },
    // One-time orders carry the offer amount itself; only a subscription plan has its own price.
    async quote(offer) {
      if (offer.mode !== 'subscription' || !subscriptions) return null;
      const plan = await subscriptions.plan(offer.catalogReference);
      sameId(plan.id, offer.catalogReference);
      return { money: planMoney(plan), mode: 'subscription' };
    },
    async create(order) {
      if (order.providerMetadata && Reflect.ownKeys(order.providerMetadata).length) {
        throw new HostedCheckoutError('unsupported', 'PayPal Orders does not support arbitrary checkout metadata');
      }
      if (order.offer.mode === 'subscription') {
        if (!subscriptions) throw new HostedCheckoutError('unsupported', 'PayPal subscription transport is not configured');
        const plan = await subscriptions.plan(order.offer.catalogReference);
        sameId(plan.id, order.offer.catalogReference);
        if (canonicalMoney(planMoney(plan)) !== canonicalMoney(order.offer.money)) throw new HostedCheckoutError('verification_failed', 'PayPal plan amount differs from the frozen offer');
        const raw = await subscriptions.create({ plan_id: order.offer.catalogReference, custom_id: order.id, quantity: '1',
          application_context: { return_url: order.successUrl, cancel_url: order.cancelUrl, brand_name: options.brandName,
            user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING' } }, order.createKey);
        if (raw.plan_id !== order.offer.catalogReference || raw.custom_id !== order.id) throw new HostedCheckoutError('verification_failed', 'PayPal subscription differs from the requested catalog or order');
        return observeSubscription(raw, false, planMoney(plan));
      }
      const amount = { value: order.offer.money.amount, currencyCode: order.offer.money.currency };
      return observe((await options.transport.createOrder({
        body: {
          intent: 'CAPTURE' as CheckoutPaymentIntent,
          purchaseUnits: [{ referenceId: order.id, amount: { ...amount, breakdown: { itemTotal: amount } },
            items: [{ name: order.offer.description, sku: order.offer.catalogReference, quantity: '1',
              unitAmount: amount, category: 'DIGITAL_GOODS' as ItemCategory }] }],
          applicationContext: { returnUrl: order.successUrl, cancelUrl: order.cancelUrl,
            brandName: options.brandName, userAction: 'PAY_NOW' as OrderApplicationContextUserAction,
            shippingPreference: 'NO_SHIPPING' as OrderApplicationContextShippingPreference },
        }, paypalRequestId: order.createKey, prefer: 'return=representation',
      })).raw);
    },
    async retrieve(id) {
      if (id.startsWith('I-')) {
        if (!options.transport.getSubscription) throw new HostedCheckoutError('unsupported', 'PayPal subscription transport is not configured');
        const raw = await options.transport.getSubscription(id); sameId(raw.id, id);
        return observeSubscription(raw, true);
      }
      return observe((await options.transport.getOrder({ id })).raw);
    },
    async capture(id, key) {
      if (id.startsWith('I-')) throw new HostedCheckoutError('unsupported', 'PayPal subscriptions collect automatically');
      return observe((await options.transport.captureOrder({ id, paypalRequestId: key, prefer: 'return=representation' })).raw);
    },
    async verifyWebhook(request) {
      if (!options.webhookId) throw new HostedCheckoutError('invalid_input', 'PayPal webhook ID is required');
      const body = typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody).toString('utf8');
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
      if (!await options.transport.verifyWebhookSignature(body, headers, options.webhookId)) {
        throw new HostedCheckoutError('verification_failed', 'PayPal webhook verification failed');
      }
      const raw = record(JSON.parse(body));
      const eventId = text(raw?.id), type = text(raw?.event_type), resource = record(raw?.resource);
      if (!eventId || !type) throw new HostedCheckoutError('verification_failed', 'PayPal event identity is missing');
      if (type.startsWith('BILLING.SUBSCRIPTION.') || type.startsWith('PAYMENT.SALE.')) {
        const checkoutId = type.startsWith('BILLING.SUBSCRIPTION.') ? text(resource?.id) : text(resource?.billing_agreement_id);
        if (!checkoutId) throw new HostedCheckoutError('verification_failed', 'PayPal subscription event identity is missing');
        return { eventId, checkoutId, reference: type.startsWith('BILLING.SUBSCRIPTION.') ? text(resource?.custom_id) : undefined };
      }
      if (type === 'CHECKOUT.ORDER.APPROVED' || type === 'CHECKOUT.ORDER.COMPLETED') {
        const checkoutId = text(resource?.id);
        if (!checkoutId) throw new HostedCheckoutError('verification_failed', 'PayPal event order ID is missing');
        const units = resource?.purchase_units;
        return { eventId, checkoutId, reference: Array.isArray(units) && units.length === 1 ? text(record(units[0])?.reference_id) : undefined };
      }
      if (!['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED'].includes(type)) return null;
      const checkoutId = text(record(record(resource?.supplementary_data)?.related_ids)?.order_id);
      if (!checkoutId) throw new HostedCheckoutError('verification_failed', 'PayPal capture has no order ID');
      return { eventId, checkoutId };
    },
  };
}
