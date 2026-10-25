import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookRequest } from '../contract/payment-contract';
import type { SettlementState } from '../contract/settlement';
import type { SubscriptionPeriod, SubscriptionStatus } from '../contract/subscription-observation';
import type {
  CreemAdapterOptions, CreemCheckoutRequest, CreemCheckoutObservation,
  CreemTransactionObservation, CreemSubscriptionObservation, CreemRefundObservation, CreemWebhookObservation,
} from './creem-types';

export class CreemProtocolError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_response' | 'invalid_signature' | 'not_configured' | 'http_error' | 'transport_error',
    message: string, readonly status?: number, readonly outcome: 'unknown' | 'rejected' = 'unknown') {
    super(message); this.name = 'CreemProtocolError';
  }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function requiredRecord(value: unknown): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) throw new CreemProtocolError('invalid_response', 'Creem returned a non-object response');
  return parsed;
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function identity(value: unknown, input = false): string {
  const id = text(value);
  if (!id) throw new CreemProtocolError(input ? 'invalid_input' : 'invalid_response', 'Creem requires a nonempty resource identifier');
  return id;
}
function reference(value: unknown): string | undefined { return text(value) ?? text(record(value)?.id); }
function iso(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function period(startValue: unknown, endValue: unknown): SubscriptionPeriod | undefined {
  const start = iso(startValue), end = iso(endValue);
  return start && end && start < end ? { start, end } : undefined;
}
/** Creem's published API uses integer cents; do not reuse another gateway's currency exponent. */
function money(amount: unknown, currency: unknown) {
  if (amount === undefined || amount === null || currency === undefined || currency === null) return undefined;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new CreemProtocolError('invalid_response', 'Creem returned invalid cents or currency');
  }
  const digits = String(amount).padStart(3, '0');
  return { amount: `${digits.slice(0, -2)}.${digits.slice(-2)}`, currency };
}
function url(value: unknown, input = false): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const parsed = new URL(identity(value, input));
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch { throw new CreemProtocolError(input ? 'invalid_input' : 'invalid_response', 'Creem URL must use HTTP(S) without credentials'); }
}
function refundStatus(value: unknown): CreemRefundObservation['status'] {
  if (value === 'requiresAction') return 'requires_action';
  return ['pending', 'succeeded', 'failed', 'canceled'].includes(String(value)) ? value as CreemRefundObservation['status'] : 'unknown';
}
function transactionState(status: unknown): SettlementState {
  if (status === 'paid') return 'captured';
  if (status === 'refunded') return 'refunded';
  if (status === 'partially_refunded') return 'partially_refunded';
  return 'unknown';
}

export function observeCreemCheckout(value: unknown): CreemCheckoutObservation {
  const raw = requiredRecord(value), order = record(raw.order);
  const paidState = transactionState(order?.status);
  const state = paidState !== 'unknown' ? paidState
    : raw.status === 'pending' ? 'created' : raw.status === 'expired' ? 'canceled' : 'unknown';
  // completed can also represent a free trial; only an order's paid evidence establishes capture.
  return { raw, id: identity(raw.id), requestId: text(raw.request_id), productId: reference(raw.product),
    customerId: reference(raw.customer), subscriptionId: reference(raw.subscription), orderId: reference(raw.order),
    transactionId: reference(order?.transaction), url: url(raw.checkout_url), state,
    paidMoney: order ? money(order.amount_paid, order.currency) : undefined,
    dueMoney: order ? money(order.amount_due, order.currency) : undefined };
}
export function observeCreemTransaction(value: unknown): CreemTransactionObservation {
  const raw = requiredRecord(value);
  return { raw, id: identity(raw.id), orderId: reference(raw.order), subscriptionId: reference(raw.subscription),
    state: transactionState(raw.status), money: money(raw.amount_paid, raw.currency),
    refundedMoney: money(raw.refunded_amount, raw.currency), period: period(raw.period_start, raw.period_end) };
}
export function observeCreemSubscription(value: unknown): CreemSubscriptionObservation {
  const raw = requiredRecord(value), providerStatus = text(raw.status) ?? 'unknown';
  const statuses: Record<string, SubscriptionStatus> = { active: 'active', trialing: 'trialing', past_due: 'past_due',
    unpaid: 'unpaid', paused: 'paused', canceled: 'canceled', scheduled_cancel: 'active' };
  const currentPeriod = period(raw.current_period_start_date, raw.current_period_end_date);
  const transaction = record(raw.last_transaction) ? observeCreemTransaction(raw.last_transaction) : undefined;
  return { raw, provider: 'creem', subscriptionId: identity(raw.id), productId: reference(raw.product),
    customerId: reference(raw.customer), status: statuses[providerStatus] ?? 'unknown', providerStatus,
    period: currentPeriod, cancelAtPeriodEnd: providerStatus === 'scheduled_cancel' ? true : undefined,
    canceledAt: iso(raw.canceled_at), lastTransactionId: reference(raw.last_transaction_id) ?? transaction?.id,
    payment: { settlement: transaction?.state === 'captured' ? 'paid' : 'unknown',
      transactionId: transaction?.id, period: transaction?.period } };
}

/** Verify exact raw bytes before JSON decoding. Persist event IDs in the consumer to reject replay. */
export function verifyCreemWebhookEvent(request: WebhookRequest, secret: string): Record<string, unknown> {
  if (!text(secret)) throw new CreemProtocolError('not_configured', 'Creem webhook secret is not configured');
  const signatures = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === 'creem-signature');
  const signature = signatures[0]?.[1];
  if (signatures.length !== 1 || typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) {
    throw new CreemProtocolError('invalid_signature', 'Invalid Creem webhook signature');
  }
  const expected = createHmac('sha256', secret).update(request.rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new CreemProtocolError('invalid_signature', 'Invalid Creem webhook signature');
  let raw: unknown;
  try { raw = JSON.parse(typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody).toString('utf8')); }
  catch { throw new CreemProtocolError('invalid_response', 'Creem webhook contains invalid JSON'); }
  const event = requiredRecord(raw);
  identity(event.id); identity(event.eventType);
  if (!iso(event.created_at)) throw new CreemProtocolError('invalid_response', 'Creem webhook has no valid event time');
  requiredRecord(event.object);
  return event;
}

/** Decode an already verified event. Never invokes a provider or applies account/product effects. */
export function observeCreemWebhook(value: unknown): CreemWebhookObservation {
  const raw = requiredRecord(value), object = requiredRecord(raw.object);
  const eventId = identity(raw.id), type = identity(raw.eventType), occurredAt = iso(raw.created_at);
  if (!occurredAt) throw new CreemProtocolError('invalid_response', 'Creem webhook has no valid event time');
  const result: CreemWebhookObservation = { raw, eventId, type, occurredAt, resourceId: reference(object) };
  if (type === 'checkout.completed') result.checkout = observeCreemCheckout(object);
  else if (type.startsWith('subscription.')) {
    const subscription = observeCreemSubscription(object);
    subscription.eventId = eventId; subscription.eventType = type; subscription.occurredAt = occurredAt;
    if (type === 'subscription.paid') subscription.payment = {
      settlement: 'paid', transactionId: subscription.lastTransactionId, period: subscription.period,
    };
    // active/trialing/update/expired are lifecycle observations, not additional payments.
    result.subscription = subscription;
  } else if (type === 'refund.created') {
    const transaction = observeCreemTransaction(object.transaction);
    result.transaction = transaction;
    const status = refundStatus(object.status);
    result.refund = { id: identity(object.id), transactionId: transaction.id,
      checkoutId: reference(object.checkout), orderId: reference(object.order) ?? transaction.orderId,
      status, money: money(object.refund_amount, object.refund_currency),
      paymentState: status === 'succeeded' ? transaction.state : 'unknown' };
  } else if (type === 'dispute.created' && record(object.transaction)) {
    result.transaction = observeCreemTransaction(object.transaction);
  }
  return result;
}

export interface CreemCheckoutAdapter {
  readonly id: 'creem';
  readonly capabilities: {
    readonly checkout: 'catalog-one-time-or-subscription';
    readonly refund: 'full-remaining';
    readonly refundIdempotency: 'not-declared';
  };
  createCheckout(input: CreemCheckoutRequest): Promise<CreemCheckoutObservation>;
  retrieveCheckout(id: string): Promise<CreemCheckoutObservation>;
  retrieveTransaction(id: string): Promise<CreemTransactionObservation>;
  retrieveSubscription(id: string): Promise<CreemSubscriptionObservation>;
  listTransactions(input: { customerId: string; productId: string; page?: number }): Promise<{ items: CreemTransactionObservation[]; nextPage?: number }>;
  createCustomerBillingLink(customerId: string): Promise<{ url: string }>;
  cancelSubscription(id: string, options: { mode: 'immediate' | 'scheduled'; onExecute?: 'cancel' | 'pause' }): Promise<CreemSubscriptionObservation>;
  /** Creem only accepts transaction_id: no partial amount and no documented idempotency header. */
  refundTransaction(transactionId: string): Promise<CreemRefundObservation>;
  parseWebhook(request: WebhookRequest): CreemWebhookObservation;
}

export function createCreemAdapter(options: CreemAdapterOptions): CreemCheckoutAdapter {
  if (!text(options.apiKey)) throw new CreemProtocolError('not_configured', 'Creem API key is not configured');
  if (!['test', 'production'].includes(options.environment)) throw new CreemProtocolError('invalid_input', 'Creem environment must be explicit');
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new CreemProtocolError('invalid_input', 'Creem timeout must be positive');
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.environment === 'test' ? 'https://test-api.creem.io' : 'https://api.creem.io';
  const assertMode = (value: Record<string, unknown>) => {
    if (value.mode !== undefined && !(options.environment === 'test' ? ['test', 'sandbox'] : ['prod']).includes(String(value.mode))) {
      throw new CreemProtocolError('invalid_response', 'Creem response environment does not match configuration');
    }
  };
  const request = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
    let serialized: string | undefined;
    try { serialized = body === undefined ? undefined : JSON.stringify(body); }
    catch { throw new CreemProtocolError('invalid_input', 'Creem request is not JSON serializable'); }
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { method, headers: { 'x-api-key': options.apiKey, 'content-type': 'application/json' },
        ...(serialized === undefined ? {} : { body: serialized }), redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch { throw new CreemProtocolError('transport_error', 'Creem request outcome is unknown; reconcile before another mutation'); }
    if (!response.ok) throw new CreemProtocolError('http_error', `Creem returned HTTP ${response.status}`, response.status,
      [400, 401, 403, 404, 422].includes(response.status) ? 'rejected' : 'unknown');
    let parsed: unknown;
    try { parsed = await response.json(); }
    catch { throw new CreemProtocolError('invalid_response', 'Creem response is not valid JSON'); }
    const result = requiredRecord(parsed); assertMode(result); return result;
  };
  const read = async (path: string, parameter: string, id: string) => {
    identity(id, true);
    const result = await request('GET', `${path}?${new URLSearchParams({ [parameter]: id })}`);
    if (result.id !== id) throw new CreemProtocolError('invalid_response', 'Creem returned a different resource');
    return result;
  };
  return {
    id: 'creem', capabilities: { checkout: 'catalog-one-time-or-subscription', refund: 'full-remaining', refundIdempotency: 'not-declared' },
    async createCheckout(input) {
      identity(input.productId, true); identity(input.requestId, true);
      if (input.units !== undefined && (!Number.isSafeInteger(input.units) || input.units <= 0)) throw new CreemProtocolError('invalid_input', 'Creem units must be a positive integer');
      if (input.customPrice !== undefined && (!Number.isSafeInteger(input.customPrice) || input.customPrice < 100 || input.customPrice > 99999999)) throw new CreemProtocolError('invalid_input', 'Creem custom price is outside the supported cents range');
      if (input.customer && (Boolean(text(input.customer.id)) === Boolean(text(input.customer.email)))) throw new CreemProtocolError('invalid_input', 'Creem customer requires either id or email');
      const raw = await request('POST', '/v1/checkouts', {
        product_id: input.productId, request_id: input.requestId,
        ...(input.units === undefined ? {} : { units: input.units }),
        ...(input.successUrl === undefined ? {} : { success_url: url(input.successUrl, true) }),
        ...(input.customer === undefined ? {} : { customer: input.customer }),
        ...(input.discountCode === undefined ? {} : { discount_code: input.discountCode }),
        ...(input.affiliateCode === undefined ? {} : { affiliate_code: input.affiliateCode }),
        ...(input.customPrice === undefined ? {} : { custom_price: input.customPrice }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      const observed = observeCreemCheckout(raw);
      if (observed.requestId !== undefined && observed.requestId !== input.requestId || observed.productId !== input.productId) {
        throw new CreemProtocolError('invalid_response', 'Creem checkout identity differs from the request');
      }
      return observed;
    },
    async retrieveCheckout(id) { return observeCreemCheckout(await read('/v1/checkouts', 'checkout_id', id)); },
    async retrieveTransaction(id) { return observeCreemTransaction(await read('/v1/transactions', 'transaction_id', id)); },
    async retrieveSubscription(id) { return observeCreemSubscription(await read('/v1/subscriptions', 'subscription_id', id)); },
    async listTransactions(input) {
      identity(input.customerId, true); identity(input.productId, true);
      const page = input.page ?? 1;
      if (!Number.isSafeInteger(page) || page < 1) throw new CreemProtocolError('invalid_input', 'Invalid Creem transaction page');
      const query = new URLSearchParams({ customer_id: input.customerId, product_id: input.productId, page_number: String(page), page_size: '100' });
      const raw = await request('GET', `/v1/transactions/search?${query}`);
      const pagination = requiredRecord(raw.pagination);
      if (!Array.isArray(raw.items) || pagination.current_page !== page ||
          !Number.isSafeInteger(pagination.total_pages) || Number(pagination.total_pages) < 0) {
        throw new CreemProtocolError('invalid_response', 'Invalid Creem transaction pagination');
      }
      const next = pagination.next_page;
      if (next != null && (!Number.isSafeInteger(next) || Number(next) !== page + 1 || Number(next) > Number(pagination.total_pages))) {
        throw new CreemProtocolError('invalid_response', 'Creem transaction pagination made no progress');
      }
      if (next == null && Number(pagination.total_pages) > page) throw new CreemProtocolError('invalid_response', 'Incomplete Creem transaction pagination');
      const items = raw.items.map((value) => {
        const item = requiredRecord(value); assertMode(item);
        if (reference(item.customer) !== input.customerId) throw new CreemProtocolError('invalid_response', 'Creem transaction customer mismatch');
        return observeCreemTransaction(item);
      });
      return { items, nextPage: next == null ? undefined : Number(next) };
    },
    async createCustomerBillingLink(customerId) {
      identity(customerId, true);
      const raw = await request('POST', '/v1/customers/billing', { customer_id: customerId });
      const link = url(raw.customer_portal_link);
      if (!link) throw new CreemProtocolError('invalid_response', 'Creem billing portal link is missing');
      return { url: link };
    },
    async cancelSubscription(id, input) {
      identity(id, true);
      if (!['immediate', 'scheduled'].includes(input.mode) || input.onExecute !== undefined && (input.mode !== 'scheduled' || !['cancel', 'pause'].includes(input.onExecute))) {
        throw new CreemProtocolError('invalid_input', 'Creem cancellation mode or scheduled action is invalid');
      }
      const raw = await request('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, {
        mode: input.mode, ...(input.onExecute === undefined ? {} : { onExecute: input.onExecute }),
      });
      if (raw.id !== id) throw new CreemProtocolError('invalid_response', 'Creem returned a different subscription');
      return observeCreemSubscription(raw);
    },
    async refundTransaction(transactionId) {
      identity(transactionId, true);
      const raw = await request('POST', '/v1/refunds', { transaction_id: transactionId });
      const status = refundStatus(raw.status);
      return { raw, transactionId, status, state: status === 'succeeded' ? 'refunded' : 'unknown' };
    },
    parseWebhook(webhook) {
      const event = verifyCreemWebhookEvent(webhook, options.webhookSecret ?? '');
      assertMode(requiredRecord(event.object));
      return observeCreemWebhook(event);
    },
  };
}
