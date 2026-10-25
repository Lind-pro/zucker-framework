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
  /** Validate protocol/currency limitations before the durable dispatch claim. No I/O. */
  validate(offer: HostedCheckoutOffer): void;
  create(order: Readonly<HostedCheckoutOrder>): Promise<HostedCheckoutObservation>;
  retrieve(checkoutId: string): Promise<HostedCheckoutObservation>;
  capture?(checkoutId: string, idempotencyKey: string): Promise<HostedCheckoutObservation>;
  /** Verify the original request before returning correlation hints. */
  verifyWebhook(request: WebhookRequest): Promise<HostedCheckoutEvent | null>;
}

export interface HostedCheckoutTransaction {
  orders: OrderPersistence<HostedCheckoutOrder>;
  /** Only same-transaction entitlement/ledger/outbox writes. Never call an external service here. */
  fulfill(order: Readonly<HostedCheckoutOrder>): Promise<void>;
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
}

export interface HostedCheckoutOptions {
  persistence: HostedCheckoutPersistence;
  providers: readonly HostedCheckoutAdapter[];
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
  now?: () => Date;
}

export class HostedCheckoutError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'verification_failed' | 'unsupported', message: string) {
    super(message); this.name = 'HostedCheckoutError';
  }
}
