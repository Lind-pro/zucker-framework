import type Stripe from 'stripe';
import { fromStripeMinorUnits, toStripeMinorUnits } from '../contract/money';
import { createStripeCheckoutSession, retrieveStripeCheckoutSession, stripeResourceId, verifyStripeWebhookEvent } from '../providers/stripe';
import { HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutObservation, type HostedCheckoutOffer } from './types';
import { snapshotProviderMetadata } from './validation';

export interface StripeHostedCheckoutOptions {
  /** With `prices`, the adapter quotes the Stripe Price before an order is created (see `quote`). */
  client: Pick<Stripe, 'checkout' | 'webhooks'> & Partial<Pick<Stripe, 'prices'>>;
  accountScope: string;
  livemode: boolean;
  webhookSecret?: string;
}

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
    if (amount !== undefined && amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) {
      throw new HostedCheckoutError('verification_failed', 'Stripe returned invalid money');
    }
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
    };
  };
  const prices = options.client.prices;
  return {
    id: 'stripe', accountScope: options.accountScope, modes: ['payment', 'subscription'], supportsMetadata: true,
    validate(offer) {
      const { amount, currency } = offer.money;
      toStripeMinorUnits(amount, currency);
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
    async create(order) {
      const metadata = snapshotProviderMetadata(order.providerMetadata ?? undefined);
      const returnUrl = new URL(order.successUrl);
      returnUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
      // Stripe replaces the literal placeholder after Checkout. The returned value remains an untrusted query hint.
      const successUrl = returnUrl.href.replace('session_id=%7BCHECKOUT_SESSION_ID%7D', 'session_id={CHECKOUT_SESSION_ID}');
      const created = await createStripeCheckoutSession(options.client, {
        mode: order.offer.mode, client_reference_id: order.id,
        line_items: [{ price: order.offer.catalogReference, quantity: 1 }],
        success_url: successUrl, cancel_url: order.cancelUrl,
        allow_promotion_codes: false, automatic_tax: { enabled: false },
        ...(metadata ? { metadata } : {}),
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
