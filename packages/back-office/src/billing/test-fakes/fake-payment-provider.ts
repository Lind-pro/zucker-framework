import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  checkoutPayable, fromMinorUnits, HostedCheckoutError, RefundProtocolError, SubscriptionProtocolError, toMinorUnits,
  type HostedCheckoutAdapter, type HostedCheckoutEvent, type HostedCheckoutObservation, type HostedCheckoutOffer,
  type HostedCheckoutOrder, type HostedCheckoutPaymentKind, type HostedCheckoutPromotionQuote, type Money,
  type RefundAdapter, type RefundObservation, type RefundPaymentObservation, type RefundPaymentReference,
  type RefundPaymentSource, type RefundState, type RefundWebhookEvent, type SubscriptionAdapter,
  type SubscriptionDetails, type SubscriptionPaidPeriod, type SubscriptionStatus, type WebhookRequest,
} from '@zucker-framework/payment';

/**
 * TEST-ONLY in-memory payment provider (`fake`, account scope `fake-test`) for checkout, renewal and
 * refund runs without a paid provider. The consumer decides when it exists (the Framework template:
 * `BILLING_TEST_FAKE_PROVIDER=true`, refused when `NODE_ENV=production`); never enable it in production.
 */
export const FAKE_PAYMENT_PROVIDER_ID = 'fake';
export const FAKE_PAYMENT_ACCOUNT_SCOPE = 'fake-test';
/** Fixed and public on purpose: the fake signs its own webhooks so tests can replay and forge them. */
export const FAKE_WEBHOOK_SECRET = 'zucker-fake-payment-webhook-secret-test-only';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/** Lets the test-checkout controller find the ledger behind the configured fake adapter. */
export const FAKE_PAYMENT_LEDGER = Symbol.for('zucker:back-office:billing:fakePaymentLedger');
export type FakeCheckoutAdapter = HostedCheckoutAdapter & { readonly [FAKE_PAYMENT_LEDGER]: FakePaymentLedger };

export type FakeWebhookType = 'checkout.completed' | 'subscription.updated' | 'refund.updated';
export interface FakeWebhookEnvelope { id: string; type: FakeWebhookType; created: string; data: Record<string, unknown> }
export interface FakeSignedWebhook { rawBody: string; headers: Record<string, string> }

/** Evidence a test declares for one checkout before it is paid (promotion and mismatch scenarios). */
export interface FakeCheckoutEvidence {
  paidMoney?: Money;
  subtotalMoney?: Money;
  discountMoney?: Money;
  discountReferences?: string[];
}

interface FakeCheckout {
  checkoutId: string;
  orderId: string;
  ownerKey: string;
  offer: Omit<HostedCheckoutOffer, 'fulfillmentData'>;
  successUrl: string;
  cancelUrl: string;
  url: string;
  state: 'pending' | 'paid';
  evidence: FakeCheckoutEvidence;
  paymentId?: string;
  paymentKind?: HostedCheckoutPaymentKind;
  subscriptionId?: string;
  paidMoney?: Money;
}
interface FakePayment { paymentId: string; paymentKind: HostedCheckoutPaymentKind; source: RefundPaymentSource; paidMoney: Money }
interface FakeSubscription {
  subscriptionId: string;
  customerId: string;
  catalogReference: string;
  /** List price: every renewal pays this (a promotion applies to the first invoice only, D10). */
  money: Money;
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string;
  periods: SubscriptionPaidPeriod[];
}

const MAX_CHECKOUTS = 10_000;
const DAY_MS = 86_400_000;
const ID = { checkout: /^fakecs_[0-9a-f]{32}$/, subscription: /^fakesub_[0-9a-f]{32}$/, refund: /^fakere_[0-9a-f]{32}$/ };
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const clone = <T>(value: T): T => structuredClone(value);

export function isFakeCheckoutId(value: string): boolean { return ID.checkout.test(value); }
export function isFakeSubscriptionId(value: string): boolean { return ID.subscription.test(value); }
export function isFakeRefundId(value: string): boolean { return ID.refund.test(value); }

/** Strict exact money for test-declared evidence (same shape the payment package canonicalises). */
export function parseFakeMoney(value: unknown, label: string): Money {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'amount' && key !== 'currency'))
    throw new Error(`${label} must be {amount, currency}`);
  const { amount, currency } = value as Record<string, unknown>;
  if (typeof amount !== 'string' || !/^\d{1,12}(?:\.\d{1,4})?$/.test(amount) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
    throw new Error(`${label} must be an exact decimal amount and an upper-case ISO currency`);
  return { amount, currency };
}

function sign(rawBody: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', FAKE_WEBHOOK_SECRET).update(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody)).digest('hex')}`;
}

/** Builds a webhook exactly as the fake provider sends it (also usable by tests to forge or replay). */
export function signFakeWebhook(type: FakeWebhookType, data: Record<string, unknown>, eventId = id('evt_fake')): FakeSignedWebhook {
  const envelope: FakeWebhookEnvelope = { id: eventId, type, created: new Date().toISOString(), data };
  const rawBody = JSON.stringify(envelope);
  return { rawBody, headers: { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: sign(rawBody) } };
}

/**
 * Signature first, then shape. A missing or wrong signature is an error (the caller answers 4xx);
 * a verified event of another kind is returned for the adapter to ignore.
 */
export function verifyFakeWebhook(request: WebhookRequest, fail: (message: string) => never): FakeWebhookEnvelope {
  const header = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === FAKE_SIGNATURE_HEADER)?.[1];
  const raw = request.rawBody;
  if (typeof header !== 'string' || raw === undefined || raw === null) return fail('Fake webhook signature is missing');
  const expected = Buffer.from(sign(raw)), actual = Buffer.from(header);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return fail('Fake webhook signature is invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return fail('Fake webhook body is not JSON'); }
  const event = parsed as Partial<FakeWebhookEnvelope> | null;
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !/^evt_fake_[0-9a-f]{32}$/.test(event.id)
    || !['checkout.completed', 'subscription.updated', 'refund.updated'].includes(event.type as string)
    || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return fail('Fake webhook body is invalid');
  return event as FakeWebhookEnvelope;
}

/**
 * The fake provider's own state, in process memory: one server process only, lost on restart (a
 * restarted server answers `not_found` for older checkouts; create a new order). It is the "provider
 * side": the application still verifies every observation exactly as it does for a real provider.
 */
export class FakePaymentLedger {
  private readonly checkouts = new Map<string, FakeCheckout>();
  private readonly byCreateKey = new Map<string, string>();
  private readonly payments = new Map<string, FakePayment>();
  private readonly subscriptions = new Map<string, FakeSubscription>();
  private readonly refunds = new Map<string, RefundObservation>();
  private readonly refundsByCommand = new Map<string, string>();
  private readonly promotionQuotes = new Map<string, HostedCheckoutPromotionQuote | null>();
  private nextRefundState: 'pending' | 'succeeded' | 'failed' = 'succeeded';

  constructor(readonly checkoutBaseUrl: string, readonly periodDays = 30) {}

  // ── provider side of the adapters ────────────────────────────────────
  create(order: Readonly<HostedCheckoutOrder>): HostedCheckoutObservation {
    const existing = this.byCreateKey.get(order.createKey);
    if (existing) {
      const checkout = this.checkouts.get(existing)!;
      if (checkout.orderId !== order.id) throw new HostedCheckoutError('conflict', 'Fake idempotency key reused for another order');
      return this.observe(checkout);
    }
    if (this.checkouts.size >= MAX_CHECKOUTS) throw new HostedCheckoutError('unsupported', 'Fake payment provider is full; restart the test server');
    const checkoutId = id('fakecs');
    const { fulfillmentData: _private, ...offer } = clone(order.offer);
    const checkout: FakeCheckout = { checkoutId, orderId: order.id, ownerKey: createHash('sha256').update(order.ownerId).digest('hex').slice(0, 24),
      offer, successUrl: order.successUrl, cancelUrl: order.cancelUrl, url: `${this.checkoutBaseUrl}/${checkoutId}`, state: 'pending', evidence: {} };
    this.checkouts.set(checkoutId, checkout);
    this.byCreateKey.set(order.createKey, checkoutId);
    return this.observe(checkout);
  }
  retrieve(checkoutId: string): HostedCheckoutObservation { return this.observe(this.checkout(checkoutId)); }

  private checkout(checkoutId: string): FakeCheckout {
    const checkout = typeof checkoutId === 'string' ? this.checkouts.get(checkoutId) : undefined;
    if (!checkout) throw new HostedCheckoutError('not_found', 'Fake checkout is unknown (the fake provider keeps state in memory only)');
    return checkout;
  }
  private observe(checkout: FakeCheckout): HostedCheckoutObservation {
    const base: HostedCheckoutObservation = { checkoutId: checkout.checkoutId, url: checkout.url, reference: checkout.orderId,
      catalogReference: checkout.offer.catalogReference, mode: checkout.offer.mode, quantity: 1, state: checkout.state };
    if (checkout.state !== 'paid') return { ...base, dueMoney: clone(checkoutPayable(checkout.offer)) };
    const promotion = checkout.offer.promotion, evidence = checkout.evidence;
    const subtotalMoney = evidence.subtotalMoney ?? (promotion ? checkout.offer.money : undefined);
    const discountMoney = evidence.discountMoney ?? promotion?.discount;
    const discountReferences = evidence.discountReferences ?? (promotion ? [promotion.providerCode] : undefined);
    return clone({ ...base, paidMoney: checkout.paidMoney, paymentId: checkout.paymentId, paymentKind: checkout.paymentKind,
      ...(checkout.subscriptionId ? { subscriptionId: checkout.subscriptionId } : {}),
      ...(subtotalMoney ? { subtotalMoney } : {}), ...(discountMoney ? { discountMoney } : {}),
      ...(discountReferences ? { discountReferences } : {}) });
  }
  quotePromotion(offer: Readonly<HostedCheckoutOffer>): HostedCheckoutPromotionQuote | null {
    const promotion = offer.promotion;
    if (!promotion) return null;
    // Undeclared codes behave like a correctly configured, once-only provider coupon.
    if (this.promotionQuotes.has(promotion.providerCode)) return clone(this.promotionQuotes.get(promotion.providerCode)!);
    return { discount: clone(promotion.discount), duration: 'once' };
  }

  // ── buyer and test-control side (the controller) ─────────────────────
  /** What the hosted page may show: description and amounts only. */
  summary(checkoutId: string) {
    const checkout = this.checkout(checkoutId);
    return { description: checkout.offer.description, mode: checkout.offer.mode, money: clone(checkout.offer.money),
      amountDue: clone(checkoutPayable(checkout.offer)), discount: clone(checkout.offer.promotion?.discount ?? null), state: checkout.state };
  }
  returnUrl(checkoutId: string, outcome: 'success' | 'cancel'): string {
    const checkout = this.checkout(checkoutId);
    return outcome === 'success' ? checkout.successUrl : checkout.cancelUrl;
  }
  declareEvidence(checkoutId: string, evidence: FakeCheckoutEvidence): FakeCheckoutEvidence {
    const checkout = this.checkout(checkoutId);
    if (checkout.state !== 'pending') throw new HostedCheckoutError('conflict', 'Evidence can only be declared before payment');
    checkout.evidence = clone(evidence);
    return clone(checkout.evidence);
  }
  /** `null` makes the provider report that it cannot tell; a quote with another amount or duration triggers the service's refusal. */
  declarePromotion(providerCode: string, quote: HostedCheckoutPromotionQuote | null): void {
    if (this.promotionQuotes.size >= 1000 && !this.promotionQuotes.has(providerCode)) throw new HostedCheckoutError('unsupported', 'Too many fake promotions');
    this.promotionQuotes.set(providerCode, clone(quote));
  }
  /** Idempotent: paying a paid checkout changes nothing. */
  pay(checkoutId: string): HostedCheckoutObservation {
    const checkout = this.checkout(checkoutId);
    if (checkout.state === 'paid') return this.observe(checkout);
    const paidAt = new Date(), subscription = checkout.offer.mode === 'subscription';
    const paidMoney = clone(checkout.evidence.paidMoney ?? checkoutPayable(checkout.offer));
    const payment = this.recordPayment(subscription ? 'invoice' : 'payment-intent', paidMoney);
    checkout.state = 'paid'; checkout.paidMoney = paidMoney; checkout.paymentId = payment.paymentId; checkout.paymentKind = payment.paymentKind;
    if (subscription) {
      const subscriptionId = id('fakesub');
      this.subscriptions.set(subscriptionId, { subscriptionId, customerId: `fakecus_${checkout.ownerKey}`,
        catalogReference: checkout.offer.catalogReference, money: clone(checkout.offer.money), status: 'active', cancelAtPeriodEnd: false,
        periods: [this.period(subscriptionId, checkout.offer.catalogReference, payment, paidAt, paidAt)] });
      checkout.subscriptionId = subscriptionId;
    }
    return this.observe(checkout);
  }
  /** The next paid period at the list price, starting where the last one ended. */
  renew(subscriptionId: string): SubscriptionPaidPeriod {
    const subscription = this.subscription(subscriptionId);
    if (subscription.status === 'canceled' || subscription.cancelAtPeriodEnd)
      throw new SubscriptionProtocolError('invalid_input', 'Fake subscription is canceled or ends at period end');
    const last = subscription.periods[subscription.periods.length - 1];
    const payment = this.recordPayment('invoice', clone(subscription.money));
    const period = this.period(subscriptionId, subscription.catalogReference, payment, new Date(last.period.end), new Date());
    subscription.periods.push(period);
    return clone(period);
  }
  private recordPayment(paymentKind: HostedCheckoutPaymentKind, paidMoney: Money): FakePayment {
    const payment: FakePayment = { paymentId: id(paymentKind === 'invoice' ? 'fakein' : 'fakepi'), paymentKind,
      source: { kind: 'charge', id: id('fakech') }, paidMoney };
    this.payments.set(payment.paymentId, payment);
    return payment;
  }
  private period(subscriptionId: string, catalogReference: string, payment: FakePayment, start: Date, paidAt: Date): SubscriptionPaidPeriod {
    return { recordId: payment.paymentId, subscriptionId, catalogReference, paidMoney: clone(payment.paidMoney),
      paymentId: payment.paymentId, paymentKind: payment.paymentKind, paidAt: paidAt.toISOString(),
      period: { start: start.toISOString(), end: new Date(start.getTime() + this.periodDays * DAY_MS).toISOString() } };
  }
  private subscription(subscriptionId: string): FakeSubscription {
    const subscription = typeof subscriptionId === 'string' ? this.subscriptions.get(subscriptionId) : undefined;
    if (!subscription) throw new SubscriptionProtocolError('invalid_input', 'Fake subscription is unknown');
    return subscription;
  }
  subscriptionDetails(subscriptionId: string): SubscriptionDetails {
    const subscription = this.subscription(subscriptionId), last = subscription.periods[subscription.periods.length - 1];
    return clone({ provider: FAKE_PAYMENT_PROVIDER_ID, subscriptionId, customerId: subscription.customerId,
      catalogReference: subscription.catalogReference, status: subscription.status, providerStatus: subscription.status,
      period: last.period, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      ...(subscription.canceledAt ? { canceledAt: subscription.canceledAt } : {}), payment: { settlement: 'paid' as const } });
  }
  paidPeriods(subscriptionId: string): SubscriptionPaidPeriod[] { return clone(this.subscription(subscriptionId).periods); }
  cancelSubscription(subscriptionId: string, mode: 'immediate' | 'period_end'): SubscriptionDetails {
    const subscription = this.subscription(subscriptionId);
    if (mode === 'immediate') { subscription.status = 'canceled'; subscription.canceledAt ??= new Date().toISOString(); }
    else subscription.cancelAtPeriodEnd = true;
    return this.subscriptionDetails(subscriptionId);
  }

  // ── refunds ──────────────────────────────────────────────────────────
  setRefundMode(state: 'pending' | 'succeeded' | 'failed'): void { this.nextRefundState = state; }
  private payment(reference: RefundPaymentReference): FakePayment {
    const payment = this.payments.get(reference?.paymentId);
    if (!payment || payment.paymentKind !== reference.paymentKind) throw new RefundProtocolError('invalid_input', 'Fake payment is unknown', 'rejected');
    return payment;
  }
  private minor(money: Money): number { return toMinorUnits(money.amount, money.currency); }
  paymentFacts(reference: RefundPaymentReference): RefundPaymentObservation {
    const payment = this.payment(reference), rows = [...this.refunds.values()].filter(row => row.paymentId === payment.paymentId);
    const sum = (states: RefundState[]) => rows.filter(row => states.includes(row.state)).reduce((total, row) => total + this.minor(row.money!), 0);
    const refunded = sum(['succeeded']), pending = sum(['pending', 'requires_action', 'unknown']), paid = this.minor(payment.paidMoney);
    const currency = payment.paidMoney.currency;
    return clone({ paymentId: payment.paymentId, paymentKind: payment.paymentKind, paidMoney: payment.paidMoney, source: payment.source,
      settlement: refunded === 0 ? 'paid' as const : refunded >= paid ? 'refunded' as const : 'partially_refunded' as const,
      refundedMoney: { amount: fromMinorUnits(refunded, currency), currency }, pendingRefundMoney: { amount: fromMinorUnits(pending, currency), currency } });
  }
  createRefund(command: { payment: RefundPaymentReference; money: Money; commandKey: string }): RefundObservation {
    const prior = this.refundsByCommand.get(command.commandKey);
    if (prior) return clone(this.refunds.get(prior)!);
    const payment = this.payment(command.payment), facts = this.paymentFacts(command.payment);
    if (command.money.currency !== payment.paidMoney.currency) throw new RefundProtocolError('invalid_input', 'Refund currency differs from the payment', 'rejected');
    const amount = this.minor(command.money);
    const remaining = this.minor(payment.paidMoney) - this.minor(facts.refundedMoney!) - this.minor(facts.pendingRefundMoney!);
    if (amount <= 0 || amount > remaining) throw new RefundProtocolError('invalid_input', 'Refund amount exceeds the refundable amount', 'rejected');
    const state = this.nextRefundState;
    const row: RefundObservation = { refundId: id('fakere'), paymentId: payment.paymentId, paymentKind: payment.paymentKind, source: clone(payment.source),
      state, providerStatus: state, money: clone(command.money), commandKey: command.commandKey, occurredAt: new Date().toISOString() };
    this.refunds.set(row.refundId!, row); this.refundsByCommand.set(command.commandKey, row.refundId!);
    return clone(row);
  }
  refund(refundId: string): RefundObservation {
    const row = this.refunds.get(refundId);
    if (!row) throw new RefundProtocolError('invalid_input', 'Fake refund is unknown', 'rejected');
    return clone(row);
  }
  refundsFor(reference: RefundPaymentReference): RefundObservation[] {
    this.payment(reference);
    return [...this.refunds.values()].filter(row => row.paymentId === reference.paymentId).map(clone);
  }
  /** Moves a pending refund to its final state (the provider's asynchronous settlement). */
  settleRefund(refundId: string, state: 'succeeded' | 'failed' | 'canceled'): RefundObservation {
    const row = this.refunds.get(refundId);
    if (!row) throw new RefundProtocolError('invalid_input', 'Fake refund is unknown', 'rejected');
    if (row.state !== state && !['pending', 'requires_action', 'unknown'].includes(row.state))
      throw new RefundProtocolError('invalid_input', 'Fake refund is already final', 'rejected');
    row.state = state; row.providerStatus = state; row.occurredAt = new Date().toISOString();
    return clone(row);
  }

  // ── webhooks the fake sends ──────────────────────────────────────────
  checkoutWebhook(checkoutId: string): FakeSignedWebhook {
    const checkout = this.checkout(checkoutId);
    return signFakeWebhook('checkout.completed', { checkoutId, reference: checkout.orderId });
  }
  subscriptionWebhook(subscriptionId: string): FakeSignedWebhook {
    this.subscription(subscriptionId);
    return signFakeWebhook('subscription.updated', { subscriptionId });
  }
  refundWebhook(refundId: string): FakeSignedWebhook {
    const row = this.refund(refundId);
    return signFakeWebhook('refund.updated', { refundId, source: row.source, state: row.state, money: row.money,
      commandKey: row.commandKey, occurredAt: row.occurredAt });
  }
}

/** Validates the hosted page base (absolute http(s), no credentials, query or fragment); trailing slashes removed. */
export function fakeCheckoutBaseUrl(raw: string, label = 'Fake checkout URL'): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be an absolute http(s) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(`${label} must be an absolute http(s) URL without credentials, query or fragment`);
  return url.href.replace(/\/+$/, '');
}

const refundStates: readonly RefundState[] = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled', 'unknown'];

export interface FakePaymentProviderOptions {
  /** Absolute base of the hosted test checkout page (`<base>/<checkoutId>`), for example `<site>/api/billing/test-checkout`. */
  checkoutBaseUrl: string;
  /** Length of a fake subscription period (default 30 days). */
  periodDays?: number;
}

/** TEST-ONLY adapters with id `fake` and account scope `fake-test`, sharing one in-memory ledger. */
export function createFakePaymentProvider(options: FakePaymentProviderOptions): {
  checkout: FakeCheckoutAdapter; subscription: SubscriptionAdapter; refund: RefundAdapter; ledger: FakePaymentLedger;
} {
  const periodDays = options.periodDays ?? 30;
  if (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 366) throw new Error('Fake subscription period must be 1..366 days');
  const ledger = new FakePaymentLedger(fakeCheckoutBaseUrl(options.checkoutBaseUrl), periodDays);
  const id = FAKE_PAYMENT_PROVIDER_ID, accountScope = FAKE_PAYMENT_ACCOUNT_SCOPE;

  const checkout: FakeCheckoutAdapter = {
    id, accountScope, modes: ['payment', 'subscription'], promotions: { modes: ['payment', 'subscription'] },
    [FAKE_PAYMENT_LEDGER]: ledger,
    validate() {},
    async quotePromotion(offer) { return ledger.quotePromotion(offer); },
    async create(order) { return ledger.create(order); },
    async retrieve(checkoutId) { return ledger.retrieve(checkoutId); },
    async verifyWebhook(request): Promise<HostedCheckoutEvent | null> {
      const event = verifyFakeWebhook(request, message => { throw new HostedCheckoutError('verification_failed', message); });
      if (event.type !== 'checkout.completed') return null;
      const { checkoutId, reference } = event.data;
      if (typeof checkoutId !== 'string' || !isFakeCheckoutId(checkoutId) || typeof reference !== 'string' || !reference)
        throw new HostedCheckoutError('verification_failed', 'Fake checkout webhook is incomplete');
      return { eventId: event.id, checkoutId, reference };
    },
  };
  const subscription: SubscriptionAdapter = {
    id, accountScope,
    capabilities: { paidPeriodProof: 'provider', paidReceiptProof: 'unavailable', cancel: ['immediate', 'period_end'], billingPortal: false, invoices: false },
    async retrieve(subscriptionId) { return ledger.subscriptionDetails(subscriptionId); },
    async listPaidPeriods(subscriptionId) { return { data: ledger.paidPeriods(subscriptionId) }; },
    async cancel(subscriptionId, { mode }) { return ledger.cancelSubscription(subscriptionId, mode); },
    async verifyWebhook(request) {
      const event = verifyFakeWebhook(request, message => { throw new SubscriptionProtocolError('verification_failed', message); });
      if (event.type !== 'subscription.updated') return null;
      const { subscriptionId } = event.data;
      if (typeof subscriptionId !== 'string' || !isFakeSubscriptionId(subscriptionId))
        throw new SubscriptionProtocolError('verification_failed', 'Fake subscription webhook is incomplete');
      return { eventId: event.id, subscriptionId };
    },
  };
  const refund: RefundAdapter = {
    id, accountScope,
    capabilities: { paymentKinds: ['payment-intent', 'invoice'], partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: true },
    async retrievePayment(payment) { return ledger.paymentFacts(payment); },
    async create(command) { return ledger.createRefund(command); },
    async retrieve(refundId) { return ledger.refund(refundId); },
    async listRefunds(payment) { return { data: ledger.refundsFor(payment) }; },
    async verifyWebhook(request): Promise<RefundWebhookEvent | null> {
      // The billing webhook route asks the refund adapter first, so this is where a bad signature is refused.
      const event = verifyFakeWebhook(request, message => { throw new RefundProtocolError('verification_failed', message, 'rejected'); });
      if (event.type !== 'refund.updated') return null;
      const { refundId, source, state, money, commandKey, occurredAt } = event.data as Record<string, unknown>;
      const sourceValue = source as RefundPaymentSource | undefined;
      if (typeof refundId !== 'string' || !isFakeRefundId(refundId) || !sourceValue || sourceValue.kind !== 'charge' || typeof sourceValue.id !== 'string'
        || !refundStates.includes(state as RefundState) || (commandKey !== undefined && typeof commandKey !== 'string')
        || (occurredAt !== undefined && typeof occurredAt !== 'string'))
        throw new RefundProtocolError('verification_failed', 'Fake refund webhook is incomplete', 'rejected');
      let parsedMoney: Money | undefined;
      try { parsedMoney = money === undefined ? undefined : parseFakeMoney(money, 'money'); }
      catch { throw new RefundProtocolError('verification_failed', 'Fake refund webhook money is invalid', 'rejected'); }
      return { eventId: event.id, refundId, source: { kind: 'charge', id: sourceValue.id }, state: state as RefundState,
        ...(parsedMoney ? { money: parsedMoney } : {}), ...(commandKey ? { commandKey: commandKey as string } : {}),
        ...(occurredAt ? { occurredAt: occurredAt as string } : {}) };
    },
  };
  return { checkout, subscription, refund, ledger };
}

/** The fake ledger behind the configured checkout adapters, if the fake provider is among them. */
export function findFakePaymentLedger(providers: readonly HostedCheckoutAdapter[]): FakePaymentLedger | null {
  const adapter = providers.find(provider => provider.id === FAKE_PAYMENT_PROVIDER_ID && FAKE_PAYMENT_LEDGER in provider) as FakeCheckoutAdapter | undefined;
  return adapter?.[FAKE_PAYMENT_LEDGER] ?? null;
}
