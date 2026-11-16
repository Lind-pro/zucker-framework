import { SubscriptionAssignmentError, type SubscriptionPaymentApplication, type SubscriptionPaymentHistory,
  type UserSubscriptionWrite } from '@zucker-framework/payment';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { SubscriptionsStorage } from './storage';

/** Permanent ledger records, NOT delivery events. Exclude these kinds from outbox TTL/cleanup. */
export const PLAN_PAYMENT_APPLICATION_KIND = 'subscription.payment-application';
export const PLAN_PAYMENT_REFUND_KIND = 'subscription.payment-refund';
export const PLAN_PAYMENT_HISTORY_KINDS: readonly string[] = Object.freeze([PLAN_PAYMENT_APPLICATION_KIND, PLAN_PAYMENT_REFUND_KIND]);

function invalid(): never {
  throw new SubscriptionAssignmentError('unavailable', 'Invalid payment application history; audited reconciliation is required');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function date(value: unknown, nullable = false): Date | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') return invalid();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : invalid();
}
function decode(payload: unknown): SubscriptionPaymentApplication {
  const row = object(payload), evidence = object(row.evidence);
  if (row.version !== 1 || typeof evidence.reference !== 'string' || typeof evidence.userId !== 'string'
    || typeof evidence.planId !== 'string' || (evidence.orderId !== null && typeof evidence.orderId !== 'string') || !['MONTHLY', 'YEARLY', 'ONE_TIME', 'LIFETIME'].includes(String(evidence.billingCycle))) return invalid();
  let previous: UserSubscriptionWrite | null = null;
  if (row.previous !== null) {
    const prior = object(row.previous);
    if (typeof prior.planId !== 'string' || !['payment', 'admin'].includes(String(prior.source))
      || !['ACTIVE', 'TRIALING', 'CANCELED', 'EXPIRED'].includes(String(prior.status))
      || !['MONTHLY', 'YEARLY', 'ONE_TIME', 'LIFETIME'].includes(String(prior.billingCycle))
      || typeof prior.cancelAtPeriodEnd !== 'boolean'
      || (prior.paymentReference !== null && typeof prior.paymentReference !== 'string')
      || (prior.source === 'payment' && !prior.paymentReference)) return invalid();
    previous = { ...prior, startDate: date(prior.startDate), endDate: date(prior.endDate, true), canceledAt: date(prior.canceledAt, true) } as UserSubscriptionWrite;
  }
  return { evidence: { ...evidence, periodStart: date(evidence.periodStart), periodEnd: date(evidence.periodEnd, true) },
    previous, appliedAt: date(row.appliedAt) } as SubscriptionPaymentApplication;
}

/**
 * Schema-compatible ledger in the existing unique (kind, aggregateId) JSON table. All operations
 * run under createUserSubscriptionStore's account lock. Consumers must retain these rows with the
 * payment ledger, including after delivery processing/account deletion; no queue worker owns them.
 * Legacy rows can be imported only from audited before/after application evidence, never inferred
 * from payment periods. Missing history makes the enclosing refund transaction fail closed.
 */
export function createPaymentHistory(storage: SubscriptionsStorage): SubscriptionPaymentHistory<DatabaseAdapter> {
  return {
    async recordApplication(tx, application) {
      const payload = JSON.parse(JSON.stringify({ version: 1, ...application })) as Record<string, unknown>;
      await storage.of(tx).billingOutbox.create({ data: { kind: PLAN_PAYMENT_APPLICATION_KIND,
        aggregateId: application.evidence.reference, payload } });
    },
    async findApplication(tx, reference) {
      const [row] = await storage.of(tx).billingOutbox.findMany({ where: { kind: PLAN_PAYMENT_APPLICATION_KIND, aggregateId: reference },
        select: { payload: true }, take: 1 }) as Array<{ payload: unknown }>;
      return row ? decode(row.payload) : null;
    },
    async recordRefund(tx, reference, userId) {
      const outbox = storage.of(tx).billingOutbox;
      if (await outbox.count({ where: { kind: PLAN_PAYMENT_REFUND_KIND, aggregateId: reference } })) return false;
      await outbox.create({ data: { kind: PLAN_PAYMENT_REFUND_KIND, aggregateId: reference, payload: { version: 1, userId, reference } } });
      return true;
    },
    async isRefunded(tx, reference) {
      return (await storage.of(tx).billingOutbox.count({ where: { kind: PLAN_PAYMENT_REFUND_KIND, aggregateId: reference } })) > 0;
    },
  };
}
