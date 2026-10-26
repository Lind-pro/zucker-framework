import type { PaymentSettlementState } from '../providers/payment-observation';

/** Provider facts, not an access decision or an instruction to grant credits. */
export interface SubscriptionPeriod {
  start: string;
  end: string;
}
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'unpaid' | 'paused' | 'canceled' | 'unknown';
export interface SubscriptionObservation {
  provider: string;
  subscriptionId: string;
  customerId?: string;
  productId?: string;
  status: SubscriptionStatus;
  providerStatus: string;
  period?: SubscriptionPeriod;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string;
  /** A previous transaction ID alone does not prove payment for the current period. */
  lastTransactionId?: string;
  payment: {
    settlement: PaymentSettlementState;
    transactionId?: string;
    period?: SubscriptionPeriod;
  };
  eventId?: string;
  eventType?: string;
  occurredAt?: string;
}

function boundedDate(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Subscription cycle requires timezone-qualified timestamps');
  }
  return new Date(value);
}

/** Stable cycle identity. Persist it under a unique constraint in the grant transaction. */
export function subscriptionPeriodKey(input: {
  provider: string;
  accountScope: string;
  subscriptionId: string;
  period: SubscriptionPeriod;
}): string {
  for (const value of [input.provider, input.accountScope, input.subscriptionId]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Subscription cycle identity must be nonempty');
  }
  const start = boundedDate(input.period.start);
  const end = boundedDate(input.period.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('Subscription cycle requires a valid start and end');
  }
  // Event IDs, product versions and mutable status deliberately do not change the cycle key.
  return JSON.stringify([input.provider, input.accountScope, input.subscriptionId, start.toISOString(), end.toISOString()]);
}
