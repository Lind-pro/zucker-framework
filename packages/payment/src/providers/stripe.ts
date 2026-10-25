import { createRequire } from 'node:module';
import type Stripe from 'stripe';
import type { PaymentSettlementState } from './payment-observation';

const requireSdk = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

/** Construct the installed Stripe peer with the consumer's explicit API/transport configuration. */
export function createStripeClient(secretKey: string, options: Stripe.StripeConfig): Stripe {
  const StripeSdk = requireSdk('stripe') as typeof Stripe;
  return new StripeSdk(secretKey, options);
}

/** Verify raw webhook bytes using the installed SDK's timestamp/signature checks. */
export function verifyStripeWebhookEvent(
  client: Pick<Stripe, 'webhooks'>,
  payload: Buffer | string,
  signature: string,
  webhookSecret: string,
): Stripe.Event {
  return client.webhooks.constructEvent(payload, signature, webhookSecret);
}

/** Stripe expandable references can be an ID, an expanded object, or absent. */
export function stripeResourceId(
  value: string | { id: string } | null | undefined,
): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

export interface StripeCheckoutObservation {
  raw: Stripe.Checkout.Session;
  id: string;
  url?: string;
  clientReferenceId?: string;
  paymentIntentId?: string;
  subscriptionId?: string;
  settlement: PaymentSettlementState;
}

export function observeStripeCheckoutSession(
  raw: Stripe.Checkout.Session,
): StripeCheckoutObservation {
  return {
    raw,
    id: raw.id,
    url: raw.url || undefined,
    clientReferenceId: raw.client_reference_id || undefined,
    paymentIntentId: stripeResourceId(raw.payment_intent),
    subscriptionId: stripeResourceId(raw.subscription),
    settlement:
      raw.payment_status === 'paid' ? 'paid' : raw.status === 'expired' ? 'unpaid' : 'unknown',
  };
}

export async function createStripeCheckoutSession(
  client: Pick<Stripe, 'checkout'>,
  params: Stripe.Checkout.SessionCreateParams,
  /** 传入 idempotencyKey 后，重试同一请求不会产生第二个 Session */
  options?: Stripe.RequestOptions,
): Promise<StripeCheckoutObservation> {
  // 未传 options 时保持单参调用，不把 undefined 当作第二个实参转发给 SDK
  return observeStripeCheckoutSession(
    options
      ? await client.checkout.sessions.create(params, options)
      : await client.checkout.sessions.create(params),
  );
}

export async function retrieveStripeCheckoutSession(
  client: Pick<Stripe, 'checkout'>,
  id: string,
  params?: Stripe.Checkout.SessionRetrieveParams,
): Promise<StripeCheckoutObservation> {
  return observeStripeCheckoutSession(params
    ? await client.checkout.sessions.retrieve(id, params)
    : await client.checkout.sessions.retrieve(id));
}

export interface StripePaymentIntentObservation {
  raw: Stripe.PaymentIntent;
  id: string;
  chargeId: string | null;
  paymentMethodType?: string;
  failureCode?: string;
  failureMessage?: string;
  settlement: PaymentSettlementState;
}

export function observeStripePaymentIntent(
  raw: Stripe.PaymentIntent,
): StripePaymentIntentObservation {
  const charge = typeof raw.latest_charge === 'object' ? raw.latest_charge : null;
  return {
    raw,
    id: raw.id,
    chargeId: stripeResourceId(raw.latest_charge) ?? null,
    paymentMethodType: charge?.payment_method_details?.type,
    failureCode: raw.last_payment_error?.code,
    failureMessage: raw.last_payment_error?.message,
    settlement:
      raw.status === 'succeeded' ? 'paid' : raw.status === 'canceled' ? 'unpaid' : 'unknown',
  };
}

export async function retrieveStripePaymentIntent(
  client: Pick<Stripe, 'paymentIntents'>,
  id: string,
  params?: Stripe.PaymentIntentRetrieveParams,
): Promise<StripePaymentIntentObservation> {
  const raw = params
    ? await client.paymentIntents.retrieve(id, params)
    : await client.paymentIntents.retrieve(id);
  return observeStripePaymentIntent(raw);
}
