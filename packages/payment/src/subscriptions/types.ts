import type { Money, WebhookRequest } from '../contract/payment-contract';
import type { SubscriptionObservation, SubscriptionPeriod } from '../contract/subscription-observation';
import type { HostedCheckoutPaymentKind } from '../hosted-checkout/types';

export interface SubscriptionDetails extends SubscriptionObservation {
  /** Provider price/product/plan identity, never a local offer ID. */
  catalogReference?: string;
}

export interface SubscriptionPaidPeriod {
  /** Stable provider receipt identity; cycle deduplication must still use subscriptionPeriodKey. */
  recordId: string;
  subscriptionId: string;
  catalogReference: string;
  period: SubscriptionPeriod;
  /** Actual settled money, never catalog price, amount due or an estimate. */
  paidMoney: Money;
  paymentId: string;
  paymentKind: HostedCheckoutPaymentKind;
  paidAt: string;
}

/** Actual provider payment evidence without a claim about which service cycle it paid. */
export type SubscriptionPaidReceipt = Omit<SubscriptionPaidPeriod, 'period'>;
export interface SubscriptionPaidReceiptPage {
  data: SubscriptionPaidReceipt[];
  nextCursor?: string;
  issues?: SubscriptionEvidenceIssue[];
}

export interface SubscriptionEvidenceIssue {
  recordId: string;
  code: 'missing_period' | 'ambiguous_period' | 'missing_money' | 'missing_identity' | 'missing_paid_at';
}

export interface SubscriptionPaidPeriodPage {
  data: SubscriptionPaidPeriod[];
  nextCursor?: string;
  /** Incomplete evidence is visible and must not be interpreted as a paid entitlement. */
  issues?: SubscriptionEvidenceIssue[];
}

export interface SubscriptionInvoice {
  id: string;
  subscriptionId?: string;
  customerId?: string;
  url?: string;
  paidMoney?: Money;
  status: 'paid' | 'pending' | 'void' | 'uncollectible' | 'unknown';
}

export type SubscriptionCancelMode = 'immediate' | 'period_end';
export interface SubscriptionAdapter {
  readonly id: string;
  readonly accountScope: string;
  readonly capabilities: {
    readonly paidPeriodProof: 'provider' | 'merchant_receipt' | 'unavailable';
    readonly paidReceiptProof: 'provider' | 'unavailable';
    readonly cancel: readonly SubscriptionCancelMode[];
    readonly billingPortal: boolean;
    readonly invoices: boolean;
  };
  retrieve(subscriptionId: string): Promise<SubscriptionDetails>;
  listPaidPeriods(subscriptionId: string, options?: { cursor?: string }): Promise<SubscriptionPaidPeriodPage>;
  /** Consumer must explicitly choose per-payment entitlement semantics and deduplicate recordId. */
  listPaidReceipts?(subscriptionId: string, options?: { cursor?: string }): Promise<SubscriptionPaidReceiptPage>;
  /** Always re-query the provider after mutation; a successful command is not a lifecycle fact. */
  cancel(subscriptionId: string, options: { mode: SubscriptionCancelMode; reason?: string }): Promise<SubscriptionDetails>;
  createBillingPortal?(input: { customerId: string; returnUrl?: string }): Promise<{ url: string }>;
  retrieveInvoice?(paymentId: string): Promise<SubscriptionInvoice>;
  /** Verify original bytes before exposing correlation hints; the caller must retrieve current facts. */
  verifyWebhook?(request: WebhookRequest): Promise<{ eventId: string; subscriptionId: string } | null>;
}

export class SubscriptionProtocolError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_response' | 'unsupported' | 'verification_failed' | 'transport_error', message: string) {
    super(message); this.name = 'SubscriptionProtocolError';
  }
}
