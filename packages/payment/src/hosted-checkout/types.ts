import type { Money, WebhookRequest } from '../contract/payment-contract';
import type { OrderPersistence } from '../order-persistence';

export type HostedCheckoutMode = 'payment' | 'subscription';
export type HostedCheckoutState = 'unknown' | 'pending' | 'requires_capture' | 'paid' | 'unpaid';
export type HostedCheckoutPaymentKind = 'payment-intent' | 'invoice' | 'capture' | 'transaction';
export type HostedCheckoutJsonValue = null | boolean | number | string | HostedCheckoutJsonValue[] |
  { [key: string]: HostedCheckoutJsonValue };

/** Resolved by the server's catalog, never accepted as a browser-supplied price. */
export interface HostedCheckoutOffer {
  version: string;
  catalogReference: string;
  mode: HostedCheckoutMode;
  money: Money;
  description: string;
  /** Private, frozen consumer policy for same-transaction fulfillment. Never sent to providers. */
  fulfillmentData?: { [key: string]: HostedCheckoutJsonValue };
  /**
   * A discount computed by the consumer server when the order is created and frozen with it.
   * Absent: the buyer pays exactly `money`. Present: the buyer pays exactly `promotion.payable`
   * (subscriptions: the first invoice only; later cycles pay `money`).
   */
  promotion?: HostedCheckoutPromotion;
}

/**
 * Server-frozen promotion. `money` stays the list price (the provider subtotal); the discount is
 * never taken from the browser or from the provider's report: provider evidence must match it.
 */
export interface HostedCheckoutPromotion {
  /** Consumer promotion identity (redemption and audit records). */
  id: string;
  /** Provider-side code the adapter applies (for Stripe a promotion code ID). Never browser input. */
  providerCode: string;
  /** Exact amount the buyer pays; positive (a zero total is refused) and below `money`. */
  payable: Money;
  /** Exactly `money − payable`, in the offer currency. */
  discount: Money;
}

/** What the provider's own promotion object would discount on this offer (checked before an order exists). */
export interface HostedCheckoutPromotionQuote {
  discount: Money;
  /** How long the provider applies it to a subscription. Subscriptions accept only `once`. */
  duration: 'once' | 'repeating' | 'forever';
}

/** One catalog item, quantity one, with an exact initial amount. Renewals are separate. */
export interface HostedCheckoutOrder {
  id: string;
  ownerId: string;
  offerId: string;
  providerId: string;
  /** Consumer-defined credential/environment identity; do not reuse it for another account. */
  accountScope: string;
  offer: HostedCheckoutOffer;
  /** Public provider metadata, already allowlisted by the consumer server; never entitlement policy. */
  providerMetadata: Record<string, string> | null;
  successUrl: string;
  cancelUrl: string;
  createKey: string;
  captureKey: string;
  creationState: 'prepared' | 'submitting' | 'created';
  captureState: 'idle' | 'submitting' | 'confirmed';
  state: HostedCheckoutState;
  checkoutId: string | null;
  checkoutUrl: string | null;
  paymentId: string | null;
  paymentKind: HostedCheckoutPaymentKind | null;
  subscriptionId: string | null;
  fulfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
  /**
   * Opaque payment-configuration revision this order was created under, written once by the service
   * from {@link HostedCheckoutProviderResolver.current} and never changed afterwards. Absent with a
   * static provider array (a consumer may then record its own value). Only the resolver interprets it.
   */
  configRevision?: string | null;
}

export interface HostedCheckoutObservation {
  checkoutId: string;
  url?: string;
  reference?: string;
  catalogReference?: string;
  mode?: HostedCheckoutMode;
  quantity?: number;
  state: HostedCheckoutState;
  /** Actual paid amount only; no expected-price or amount-due fallback. */
  paidMoney?: Money;
  /** Known payable/approved amount, checked before a new URL or explicit capture; never proves payment. */
  dueMoney?: Money;
  paymentId?: string;
  paymentKind?: HostedCheckoutPaymentKind;
  subscriptionId?: string;
  /** Provider total before discounts. Required evidence for an order frozen with a promotion. */
  subtotalMoney?: Money;
  /** Provider-reported total discount. Required evidence for an order frozen with a promotion. */
  discountMoney?: Money;
  /** Provider identities of the applied discounts (Stripe promotion code IDs); absent when unknown. */
  discountReferences?: string[];
}

export interface HostedCheckoutEvent {
  eventId: string;
  checkoutId: string;
  reference?: string;
}

/** This does not implement the legacy adapter's partial-refund contract. */
export interface HostedCheckoutAdapter {
  readonly id: string;
  readonly accountScope: string;
  readonly modes: readonly HostedCheckoutMode[];
  /** Absent/false means arbitrary provider metadata is unsupported. */
  readonly supportsMetadata?: boolean;
  /**
   * Modes in which this adapter applies `offer.promotion.providerCode` and reports subtotal and
   * discount evidence. Absent: offers with a promotion are refused before an order exists.
   */
  readonly promotions?: { readonly modes: readonly HostedCheckoutMode[] };
  /** Validate protocol/currency limitations before the durable dispatch claim. No I/O. */
  validate(offer: HostedCheckoutOffer): void;
  /**
   * Optional read-only lookup of the provider's own price for `offer.catalogReference`. It runs
   * before an order exists: a provider price whose money (or mode) differs from the offer refuses
   * the checkout with `conflict`, so a catalog edited away from the provider price fails cleanly
   * instead of charging the buyer and then failing verification. Return null when the provider
   * cannot tell (the amount the provider reports at creation is still checked before the URL is
   * released, and paid money is always verified).
   */
  quote?(offer: Readonly<HostedCheckoutOffer>): Promise<{ money: Money; mode?: HostedCheckoutMode } | null>;
  /**
   * Optional read-only lookup of the provider promotion behind `offer.promotion.providerCode`, run
   * before an order exists. Its discount must equal the frozen discount (else `conflict`), and a
   * subscription offer requires this lookup and a `once` duration (first invoice only).
   */
  quotePromotion?(offer: Readonly<HostedCheckoutOffer>): Promise<HostedCheckoutPromotionQuote | null>;
  create(order: Readonly<HostedCheckoutOrder>): Promise<HostedCheckoutObservation>;
  retrieve(checkoutId: string): Promise<HostedCheckoutObservation>;
  capture?(checkoutId: string, idempotencyKey: string): Promise<HostedCheckoutObservation>;
  /** Verify the original request before returning correlation hints. */
  verifyWebhook(request: WebhookRequest): Promise<HostedCheckoutEvent | null>;
}

export interface HostedCheckoutTransaction {
  orders: OrderPersistence<HostedCheckoutOrder>;
  /**
   * Only same-transaction entitlement/ledger/outbox writes. Never call an external service here.
   * `observation` is the verified provider evidence that made the order paid (redemption records).
   */
  fulfill(order: Readonly<HostedCheckoutOrder>, observation?: Readonly<HostedCheckoutObservation>): Promise<void>;
}

export interface HostedCheckoutPersistence {
  orders: OrderPersistence<HostedCheckoutOrder>;
  /** Roll back BOTH order changes and fulfill writes when the callback rejects. No memory fallback. */
  transaction<T>(work: (transaction: HostedCheckoutTransaction) => Promise<T>): Promise<T>;
}

export interface HostedCheckoutSelection {
  /** Generate/persist this server-side; reuse it for duplicate requests. */
  orderId: string;
  /** Comes from the authenticated session. */
  ownerId: string;
  offerId: string;
  providerId: string;
  /** Only a server-side allowlisted mapping, never an unchecked browser metadata object. */
  providerMetadata?: Record<string, string>;
  /**
   * Opaque consumer promotion code (for example an alias the buyer typed), passed only to
   * `resolveOffer`. It is never a price and never sent to a provider; the consumer turns it into
   * `offer.promotion` or refuses it.
   */
  promotionCode?: string;
}

/** The adapter a NEW order is created with, and the configuration revision to record on that order. */
export interface HostedCheckoutCurrentProvider {
  readonly adapter: HostedCheckoutAdapter;
  /** Recorded as `order.configRevision` when defined (opaque; at most 255 characters). */
  readonly configRevision?: string | null;
}

/** Most webhook verification candidates the service tries for one request. */
export const HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES = 8;

/**
 * Credentials that change while orders are open (hot-applied payment configuration). The service
 * calls the resolver once per operation and keeps the adapter it got for that whole operation.
 *
 * - `current`: new orders only. Undefined when the provider does not accept new orders now.
 * - `forOrder`: existing orders (duplicate create, confirm, capture, recovery, webhook retrieval).
 *   It must only return an adapter of `order.providerId` whose `accountScope` equals
 *   `order.accountScope` (the service re-checks both), or undefined when none is available. A
 *   recorded `configRevision` that is malformed or cannot belong to this order must be refused by
 *   throwing `HostedCheckoutError('verification_failed', …)`; never fall back to another account.
 * - `webhookCandidates`: adapters able to verify a webhook of this provider, newest first, one per
 *   distinct account scope and signing secret (for example the current secret and the previous one
 *   during a rotation). The service tries at most {@link HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES},
 *   uses the first that verifies, and then requires the located order's account scope to equal that
 *   adapter's, so a webhook verified for one account never settles an order of another.
 * - `ids`: providers that accept new orders now.
 *
 * Revisions and account scopes are never taken from a request.
 */
export interface HostedCheckoutProviderResolver {
  ids(): Promise<readonly string[]>;
  current(providerId: string): Promise<HostedCheckoutCurrentProvider | undefined>;
  forOrder(order: Readonly<HostedCheckoutOrder>): Promise<HostedCheckoutAdapter | undefined>;
  webhookCandidates(providerId: string): Promise<readonly HostedCheckoutAdapter[]>;
}

export interface HostedCheckoutOptions {
  persistence: HostedCheckoutPersistence;
  /** A fixed adapter list (credentials fixed for the process lifetime) or a resolver (hot-applied credentials). */
  providers: readonly HostedCheckoutAdapter[] | HostedCheckoutProviderResolver;
  resolveOffer(selection: Readonly<HostedCheckoutSelection>): Promise<HostedCheckoutOffer>;
  /** Server-controlled URLs; the browser must not supply redirect destinations. */
  returnUrls(orderId: string): { successUrl: string; cancelUrl: string };
  /**
   * Optional verified-payment preparation outside the persistence transaction (for example,
   * retrieving and durably recording refunds before credit delivery). May run more than once;
   * it must not dispatch a charge/refund. Receives isolated snapshots. The transaction's
   * fulfill port must still recheck persisted delivery restrictions under its own locks.
   */
  prepareFulfillment?(order: Readonly<HostedCheckoutOrder>, observation: Readonly<HostedCheckoutObservation>): Promise<void>;
  /**
   * Called when a provider reports paid money that differs from the frozen offer (for example a
   * tax-exclusive Creem price charged with tax). The order is NOT fulfilled and reconciliation
   * still throws `verification_failed`; use this to persist the case for refund or review.
   * May run on every reconciliation of that order; make it idempotent. Must not dispatch refunds.
   */
  onPaymentMismatch?(order: Readonly<HostedCheckoutOrder>, observation: Readonly<HostedCheckoutObservation>): Promise<void> | void;
  now?: () => Date;
}

export class HostedCheckoutError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'verification_failed' | 'unsupported', message: string) {
    super(message); this.name = 'HostedCheckoutError';
  }
}
