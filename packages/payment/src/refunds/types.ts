import type { Money, WebhookRequest } from '../contract/payment-contract';
import type { HostedCheckoutPaymentKind } from '../hosted-checkout/types';

export interface RefundPaymentReference {
  paymentKind: HostedCheckoutPaymentKind;
  paymentId: string;
  /** Frozen actual paid money from a verified order/receipt, never a browser amount. */
  paidMoney: Money;
}
/** The provider money-movement identity; an invoice may resolve to a charge. */
export interface RefundPaymentSource { kind: 'payment-intent' | 'charge' | 'capture' | 'transaction'; id: string }
export interface RefundPaymentObservation extends RefundPaymentReference {
  source: RefundPaymentSource;
  settlement: 'paid' | 'partially_refunded' | 'refunded' | 'unknown';
  /** Absent means the provider did not expose a complete aggregate, never zero. */
  refundedMoney?: Money;
  pendingRefundMoney?: Money;
}
export type RefundState = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
export interface RefundObservation {
  /** Absent for a status-only acknowledgement; never invent a provider receipt ID. */
  refundId?: string;
  paymentId: string;
  paymentKind: HostedCheckoutPaymentKind;
  source: RefundPaymentSource;
  state: RefundState;
  providerStatus: string;
  /** Actual refund money. Succeeded requires complete amount/currency evidence. */
  money?: Money;
  /** Provider-reported cumulative refunds for this source; not a second refund receipt. */
  totalRefundedMoney?: Money;
  occurredAt?: string;
  /** Echoed server correlation, when the provider supports it; still validate payment and amount. */
  commandKey?: string;
}
export interface RefundCommand {
  payment: RefundPaymentReference;
  money: Money;
  /** Persist before dispatch and reuse only for the same intended mutation. */
  commandKey: string;
  reason?: string;
}
export interface RefundWebhookEvent {
  eventId: string;
  refundId?: string;
  source: RefundPaymentSource;
  /** Signature-verified evidence; reconcile against the locally bound payment before applying effects. */
  state: RefundState;
  money?: Money;
  totalRefundedMoney?: Money;
  occurredAt?: string;
  commandKey?: string;
}
export interface RefundAdapter {
  readonly id: string;
  readonly accountScope: string;
  readonly capabilities: {
    readonly paymentKinds: readonly HostedCheckoutPaymentKind[];
    readonly partial: boolean;
    readonly requestIdempotency: 'provider' | 'none';
    readonly retrieveRefund: boolean;
    readonly listRefunds?: boolean;
  };
  retrievePayment(payment: RefundPaymentReference): Promise<RefundPaymentObservation>;
  /** One explicit command; never retries internally. Unknown transport outcomes remain unknown. */
  create(command: RefundCommand): Promise<RefundObservation>;
  retrieve?(refundId: string, payment: RefundPaymentReference): Promise<RefundObservation>;
  listRefunds?(payment: RefundPaymentReference, options?: { cursor?: string }): Promise<{ data: RefundObservation[]; nextCursor?: string }>;
  verifyWebhook(request: WebhookRequest): Promise<RefundWebhookEvent | null>;
}
export class RefundProtocolError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_response' | 'verification_failed' | 'unsupported' | 'transport_error',
    message: string, readonly outcome: 'unknown' | 'rejected' = 'unknown') {
    super(message); this.name = 'RefundProtocolError';
  }
}
