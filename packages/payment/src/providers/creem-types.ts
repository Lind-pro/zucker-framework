import type { Money } from '../contract/payment-contract';
import type { SettlementState } from '../contract/settlement';
import type { SubscriptionObservation } from '../contract/subscription-observation';

export interface CreemCheckoutRequest {
  productId: string;
  /** Persist before dispatch; forward unchanged on an explicitly authorized retry. */
  requestId: string;
  units?: number;
  successUrl?: string;
  customer?: { id: string; email?: never } | { email: string; id?: never };
  discountCode?: string;
  affiliateCode?: string;
  /** Creem supports a per-unit cents override only for one-time products. */
  customPrice?: number;
  metadata?: Record<string, unknown>;
}
export interface CreemCheckoutObservation {
  raw: Record<string, unknown>;
  id: string;
  requestId?: string;
  productId?: string;
  customerId?: string;
  subscriptionId?: string;
  orderId?: string;
  transactionId?: string;
  url?: string;
  state: SettlementState;
  /** Separate actual payment from amount due; neither falls back to the catalog price. */
  paidMoney?: Money;
  dueMoney?: Money;
}
export interface CreemTransactionObservation {
  raw: Record<string, unknown>;
  id: string;
  orderId?: string;
  subscriptionId?: string;
  state: SettlementState;
  money?: Money;
  refundedMoney?: Money;
  period?: { start: string; end: string };
}
export interface CreemSubscriptionObservation extends SubscriptionObservation {
  raw: Record<string, unknown>;
}
export interface CreemRefundObservation {
  raw: Record<string, unknown>;
  transactionId: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
  /** pending/requiresAction/failed never establish successful money movement. */
  state: 'refunded' | 'unknown';
}
export interface CreemWebhookObservation {
  raw: Record<string, unknown>;
  eventId: string;
  type: string;
  occurredAt: string;
  resourceId?: string;
  checkout?: CreemCheckoutObservation;
  subscription?: CreemSubscriptionObservation;
  transaction?: CreemTransactionObservation;
  refund?: {
    id: string;
    transactionId: string;
    checkoutId?: string;
    orderId?: string;
    status: CreemRefundObservation['status'];
    money?: Money;
    /** State of the entire original payment, not merely this refund's amount. */
    paymentState: SettlementState;
  };
}
export interface CreemAdapterOptions {
  apiKey: string;
  environment: 'test' | 'production';
  webhookSecret?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
