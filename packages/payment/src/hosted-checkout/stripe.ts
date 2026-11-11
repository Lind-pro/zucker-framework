import type Stripe from 'stripe';
import { fromStripeMinorUnits, toStripeMinorUnits } from '../contract/money';
import { createStripeCheckoutSession, retrieveStripeCheckoutSession, stripeResourceId, verifyStripeWebhookEvent } from '../providers/stripe';
import { HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutObservation, type HostedCheckoutOffer } from './types';
import { snapshotProviderMetadata } from './validation';

export interface StripeHostedCheckoutOptions {
  /**
   * With `prices`, the adapter quotes the Stripe Price before an order is created (see `quote`).
   * With `coupons`, it applies server-frozen promotions: each promoted checkout session gets its own
   * single-use, `once`-duration coupon whose `amount_off` is the server-computed discount, so the
   * Stripe total always equals the frozen payable (Stripe never rounds a percentage). Without
   * `coupons`, promotions are refused before an order exists.
   */
  client: Pick<Stripe, 'checkout' | 'webhooks'> & Partial<Pick<Stripe, 'prices' | 'coupons'>>;
  accountScope: string;
  livemode: boolean;
  webhookSecret?: string;
  /** Clock for the coupon redemption deadline (tests). */
  now?: () => number;
}

/** Deterministic id of the per-order promotion coupon: retries reuse it, and nothing else can redeem it. */
export function stripePromotionCouponId(orderId: string): string {
  return `zf_promo_${orderId}`;
}
/** Session metadata key carrying the frozen promotion's provider code (reported back as the discount reference). */
export const STRIPE_PROMOTION_METADATA_KEY = 'zucker_promotion_code';
/** A promoted session's coupon expires with the promotion reservation (25 h) at the latest. */
const PROMOTION_COUPON_TTL_SECONDS = 25 * 3600;

export function createStripeHostedCheckoutAdapter(options: StripeHostedCheckoutOptions): HostedCheckoutAdapter {
  const observe = (raw: Stripe.Checkout.Session): HostedCheckoutObservation => {
    if (raw.livemode !== options.livemode) throw new HostedCheckoutError('verification_failed', 'Stripe environment mismatch');
    const items = raw.line_items;
    const single = items && !items.has_more && items.data.length === 1 ? items.data[0] : undefined;
    const paymentIntent = stripeResourceId(raw.payment_intent);
    const invoice = stripeResourceId(raw.invoice);
    // Subscription periods are identified by invoice throughout renewal fulfillment.
    // A payment intent is its funding source, not a second subscription receipt.
    const paymentId = raw.mode === 'subscription' ? invoice : paymentIntent ?? invoice;
    const paymentKind = raw.mode === 'subscription' ? (invoice ? 'invoice' : undefined)
      : paymentIntent ? 'payment-intent' : invoice ? 'invoice' : undefined;
    const currency = raw.currency?.toUpperCase();
    const amount = raw.amount_total;
    const subtotal = raw.amount_subtotal, discount = raw.total_details?.amount_discount;
    for (const value of [amount, subtotal, discount]) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new HostedCheckoutError('verification_failed', 'Stripe returned invalid money');
      }
    }
    const minor = (value: number | null | undefined) => currency && value != null
      ? { currency, amount: fromStripeMinorUnits(value, currency) } : undefined;
    // Discount references compared with the frozen order: this order's own coupon reports the frozen
    // provider code (from the session metadata written at creation); any other coupon or promotion code
    // reports its own identity and therefore never matches. Stripe may omit `discounts` (or return an
    // empty list) on some session payloads: that is "unknown" (the amounts are still verified exactly),
    // never "no discount".
    const ownCoupon = raw.client_reference_id ? stripePromotionCouponId(raw.client_reference_id) : undefined;
    const frozenCode = typeof raw.metadata?.[STRIPE_PROMOTION_METADATA_KEY] === 'string' ? raw.metadata[STRIPE_PROMOTION_METADATA_KEY] : undefined;
    const references = Array.isArray(raw.discounts) && raw.discounts.length ? raw.discounts.map(item => {
      const promotionCode = stripeResourceId(item.promotion_code);
      if (promotionCode) return `promotion_code:${promotionCode}`;
      const coupon = stripeResourceId(item.coupon) ?? '';
      return coupon && coupon === ownCoupon && frozenCode ? frozenCode : `coupon:${coupon}`;
    }) : undefined;
    return {
      checkoutId: raw.id, url: raw.url ?? undefined, reference: raw.client_reference_id ?? undefined,
      catalogReference: single?.price?.id, quantity: single?.quantity ?? undefined,
      mode: raw.mode === 'payment' ? 'payment' : raw.mode === 'subscription' ? 'subscription' : undefined,
      state: raw.payment_status === 'paid' ? 'paid' : raw.status === 'expired' ? 'unpaid' : 'pending',
      // ISK/UGX charges use two API decimals, while requiring whole-unit prices.
      paidMoney: raw.payment_status === 'paid' && currency && amount != null
        ? { currency, amount: fromStripeMinorUnits(amount, currency) } : undefined,
      dueMoney: currency && amount != null ? { currency, amount: fromStripeMinorUnits(amount, currency) } : undefined,
      paymentId, paymentKind,
      subscriptionId: stripeResourceId(raw.subscription),
      subtotalMoney: minor(subtotal), discountMoney: minor(discount),
      ...(references ? { discountReferences: references } : {}),
    };
  };
  const prices = options.client.prices;
  const coupons = options.client.coupons;
  const now = options.now ?? Date.now;
  /** Creates (or, after an idempotency-window retry, re-reads and checks) this order's fixed coupon. */
  const promotionCoupon = async (order: Parameters<HostedCheckoutAdapter['create']>[0]): Promise<string> => {
    const promotion = order.offer.promotion!;
    if (!coupons) throw new HostedCheckoutError('unsupported', 'Stripe promotions require the coupons API');
    const currency = promotion.discount.currency;
    const amountOff = toStripeMinorUnits(promotion.discount.amount, currency);
    const id = stripePromotionCouponId(order.id);
    const matches = (coupon: Stripe.Coupon) => coupon.livemode === options.livemode && coupon.amount_off === amountOff
      && coupon.percent_off == null && coupon.currency?.toUpperCase() === currency && coupon.duration === 'once';
    try {
      const created = await coupons.create({ id, amount_off: amountOff, currency: currency.toLowerCase(), duration: 'once',
        max_redemptions: 1, redeem_by: Math.floor(now() / 1000) + PROMOTION_COUPON_TTL_SECONDS, name: 'Promotion',
        metadata: { zucker_order: order.id, zucker_promotion: promotion.id } }, { idempotencyKey: `${order.createKey}:coupon` });
      if (!matches(created)) throw new HostedCheckoutError('verification_failed', 'Stripe coupon differs from the frozen discount');
      return created.id;
    } catch (error) {
      if (error instanceof HostedCheckoutError || (error as { code?: unknown })?.code !== 'resource_already_exists') throw error;
      const existing = await coupons.retrieve(id);
      if (!matches(existing)) throw new HostedCheckoutError('verification_failed', 'Stripe coupon differs from the frozen discount');
      return existing.id;
    }
  };
  return {
    id: 'stripe', accountScope: options.accountScope, modes: ['payment', 'subscription'], supportsMetadata: true,
    // The per-session coupon is `once`, so it also fits subscriptions (first invoice only, D10).
    ...(coupons ? { promotions: { modes: ['payment', 'subscription'] as const } } : {}),
    validate(offer) {
      const { amount, currency } = offer.money;
      toStripeMinorUnits(amount, currency);
      if (offer.promotion) toStripeMinorUnits(offer.promotion.discount.amount, offer.promotion.discount.currency);
    },
    ...(prices ? { quote: async (offer: Readonly<HostedCheckoutOffer>) => {
      const price = await prices.retrieve(offer.catalogReference);
      if (price.livemode !== options.livemode) throw new HostedCheckoutError('verification_failed', 'Stripe environment mismatch');
      if (!price.active) throw new HostedCheckoutError('conflict', 'The Stripe price is archived; this offer is unavailable');
      const currency = price.currency?.toUpperCase();
      const amount = price.unit_amount;
      // Tiered, metered or customer-chosen prices have no single amount to compare.
      if (!currency || amount === null || amount === undefined || !Number.isSafeInteger(amount) || amount < 0) return null;
      return { money: { currency, amount: fromStripeMinorUnits(amount, currency) },
        mode: price.type === 'recurring' ? 'subscription' as const : 'payment' as const };
    } } : {}),
    // The discount Stripe will apply is exactly the server-computed amount (fixed coupon, once).
    ...(coupons ? { quotePromotion: async (offer: Readonly<HostedCheckoutOffer>) => offer.promotion
      ? { discount: { ...offer.promotion.discount }, duration: 'once' as const } : null } : {}),
    async create(order) {
      const metadata = snapshotProviderMetadata(order.providerMetadata ?? undefined);
      const promotion = order.offer.promotion;
      const returnUrl = new URL(order.successUrl);
      returnUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
      // Stripe replaces the literal placeholder after Checkout. The returned value remains an untrusted query hint.
      const successUrl = returnUrl.href.replace('session_id=%7BCHECKOUT_SESSION_ID%7D', 'session_id={CHECKOUT_SESSION_ID}');
      // Stripe allows 50 metadata keys; a promoted session needs one for the frozen provider code.
      if (promotion && metadata && Object.keys(metadata).length >= 50)
        throw new HostedCheckoutError('invalid_input', 'A promoted Stripe checkout allows at most 49 provider metadata fields');
      const coupon = promotion ? await promotionCoupon(order) : undefined;
      const created = await createStripeCheckoutSession(options.client, {
        mode: order.offer.mode, client_reference_id: order.id,
        line_items: [{ price: order.offer.catalogReference, quantity: 1 }],
        success_url: successUrl, cancel_url: order.cancelUrl,
        // `discounts` and `allow_promotion_codes` are mutually exclusive in Stripe. Buyers never enter
        // a provider code: only this order's fixed, single-use coupon is applied (never a percentage).
        ...(coupon ? { discounts: [{ coupon }] } : { allow_promotion_codes: false }),
        automatic_tax: { enabled: false },
        ...(metadata || promotion ? { metadata: { ...(metadata ?? {}), ...(promotion ? { [STRIPE_PROMOTION_METADATA_KEY]: promotion.providerCode } : {}) } } : {}),
      }, { idempotencyKey: order.createKey });
      return observe(created.raw);
    },
    async retrieve(id) {
      return observe((await retrieveStripeCheckoutSession(options.client, id, { expand: ['line_items'] })).raw);
    },
    async verifyWebhook(request) {
      if (!options.webhookSecret) throw new HostedCheckoutError('invalid_input', 'Stripe webhook secret is required');
      const signatures = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === 'stripe-signature');
      const signature = signatures[0]?.[1];
      if (signatures.length !== 1 || !signature) throw new HostedCheckoutError('verification_failed', 'Stripe signature header is required');
      const event = verifyStripeWebhookEvent(options.client,
        typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody),
        signature, options.webhookSecret);
      if (event.livemode !== options.livemode) throw new HostedCheckoutError('verification_failed', 'Stripe event environment mismatch');
      if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) return null;
      const session = event.data.object as Stripe.Checkout.Session;
      return { eventId: event.id, checkoutId: session.id, reference: session.client_reference_id ?? undefined };
    },
  };
}
