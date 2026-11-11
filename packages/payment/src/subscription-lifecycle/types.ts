import type { Money } from '../contract/payment-contract';
import type { HostedCheckoutJsonValue, HostedCheckoutPaymentKind } from '../hosted-checkout/types';
import type { SubscriptionPaidPeriod, SubscriptionPaidReceipt } from '../subscriptions/types';

/** Consumer-owned binding established from an authenticated checkout, never a browser subscription ID. */
export interface SubscriptionEntitlementBinding {
  id: string;
  ownerId: string;
  providerId: string;
  accountScope: string;
  subscriptionId: string;
  catalogReference: string;
  money: Money;
  /**
   * Exact amount of the initial payment when it differs from `money`: a first-invoice promotion
   * frozen at order creation (`offer.promotion.payable`). Every later cycle must pay `money`.
   */
  initialMoney?: Money;
  policyVersion: string;
  /** Explicit consumer policy: never invent provider periods for receipt-only channels. */
  grantBasis: 'period' | 'payment';
  policy: { [key: string]: HostedCheckoutJsonValue };
  initialOrderId: string;
  initialPaymentId: string;
  initialPaymentKind: HostedCheckoutPaymentKind;
}

/** A cycle receipt and its entitlement effects are committed together. Never a pre-grant reservation. */
export interface SubscriptionCycleReceipt {
  id: string;
  cycleKey: string;
  bindingId: string;
  ownerId: string;
  providerId: string;
  accountScope: string;
  subscriptionId: string;
  catalogReference: string;
  basis: 'period' | 'payment';
  periodStart: Date | null;
  periodEnd: Date | null;
  paymentId: string;
  paymentKind: HostedCheckoutPaymentKind;
  recordId: string;
  paidMoney: Money;
  paidAt: Date;
  policyVersion: string;
  policy: { [key: string]: HostedCheckoutJsonValue };
  initial: boolean;
  fulfilledAt: Date;
}

export interface SubscriptionCycleTransaction {
  /** Read under the consumer's account/binding lock on this transaction. */
  binding: Readonly<SubscriptionEntitlementBinding>;
  findCycle(cycleKey: string): Promise<SubscriptionCycleReceipt | null>;
  findPayment(input: { providerId: string; accountScope: string; paymentKind: HostedCheckoutPaymentKind; paymentId: string }): Promise<SubscriptionCycleReceipt | null>;
  insertReceipt(receipt: SubscriptionCycleReceipt): Promise<void>;
  /** Only transaction-bound entitlement/ledger/outbox writes. No external IO. */
  fulfill(receipt: Readonly<SubscriptionCycleReceipt>): Promise<void>;
}

export interface SubscriptionCyclePersistence {
  /** Lock before reading binding; roll back receipt AND fulfill together. Missing/foreign bindings reject. */
  transaction<T>(bindingId: string, ownerId: string, work: (transaction: SubscriptionCycleTransaction) => Promise<T>): Promise<T>;
}

export interface SubscriptionCycleInput {
  bindingId: string;
  ownerId: string;
  /** Actual configured adapter namespace, not a value supplied by a webhook payload. */
  providerId: string;
  accountScope: string;
  payment: SubscriptionPaidPeriod | SubscriptionPaidReceipt;
}
