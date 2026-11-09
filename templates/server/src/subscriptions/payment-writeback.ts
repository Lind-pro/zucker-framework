import { CYCLE_FOR_INTERVAL } from '@zucker-framework/fe-types/back-office';
import { isActiveTerm } from '@zucker-framework/credit';
import {
  HostedCheckoutError, SubscriptionAssignmentService, addBillingCycle, readPlanPriceSnapshot,
  type PlanPriceSnapshot, type SubscriptionPaymentResult,
} from '@zucker-framework/payment';
import type { BillingFulfillmentHooks } from '../billing/billing-extensions';
import type { ApplicationDatabase, ApplicationTransaction } from '../database';
import { createUserSubscriptionStore } from './user-subscription.store';

/** Outbox event written with every plan term change caused by a payment (publish it after commit). */
export const PLAN_TERM_CHANGED_OUTBOX_KIND = 'billing.plan-term-changed';
/**
 * Outbox event for a verified plan payment that was recorded but did not change the term although
 * the buyer paid for it: the term changed between checkout admission and payment (a lifetime or a
 * longer administrator grant arrived first, or an administrator revoked the term after the purchase).
 * Refund it in the provider dashboard; the payment ledger row (`reference`) is the audit trail.
 */
export const PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND = 'billing.plan-payment-unapplied';

/**
 * Applies one verified payment for the frozen plan snapshot of its order. The plan is the one the
 * order was created for (never re-derived from a slug or provider reference); the payment ledger
 * makes every reference count once, and SubscriptionAssignmentService decides precedence.
 */
export async function recordPlanTerm(database: ApplicationDatabase, tx: ApplicationTransaction, input: {
  userId: string; plan: PlanPriceSnapshot; periodStart: Date; periodEnd: Date | null; reference: string; orderId: string;
  /** Creation time of the checkout order that made the purchase decision. */
  purchasedAt: Date | null;
  /** True for a checkout payment (admitted at checkout), false for a renewal cycle. */
  checkout: boolean;
}): Promise<SubscriptionPaymentResult> {
  const result = await new SubscriptionAssignmentService(createUserSubscriptionStore(database, tx), { activeTerm: isActiveTerm })
    .recordPayment({ userId: input.userId, planId: input.plan.planId, billingCycle: CYCLE_FOR_INTERVAL[input.plan.interval],
      periodStart: input.periodStart, periodEnd: input.periodEnd, reference: input.reference, orderId: input.orderId,
      purchasedAt: input.purchasedAt });
  // `superseded` of a renewal is an out-of-order receipt whose period is already covered; for a
  // checkout payment, like `kept`/`revoked`, it means the buyer paid for nothing.
  const unapplied = result.outcome === 'kept' || result.outcome === 'revoked' || (input.checkout && result.outcome === 'superseded');
  if (unapplied)
    await tx.model('billingOutbox').create({ data: { kind: PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, aggregateId: input.reference,
      payload: { userId: input.userId, planId: input.plan.planId, orderId: input.orderId, reference: input.reference,
        outcome: result.outcome, amount: input.plan.amount, currency: input.plan.currency } } });
  if (result.change)
    await tx.model('billingOutbox').create({ data: { kind: PLAN_TERM_CHANGED_OUTBOX_KIND, aggregateId: input.reference,
      payload: { userId: input.userId, planId: input.plan.planId, orderId: input.orderId, outcome: result.outcome,
        billingCycle: result.change.after.billingCycle, endDate: result.change.after.endDate?.toISOString() ?? null } } });
  return result;
}

function snapshot(fulfillmentData: unknown): PlanPriceSnapshot | null {
  const raw = fulfillmentData && typeof fulfillmentData === 'object' ? (fulfillmentData as { plan?: unknown }).plan : undefined;
  if (raw === undefined) return null;
  const plan = readPlanPriceSnapshot(raw);
  // A plan order whose snapshot cannot be read must not be fulfilled without its entitlement.
  if (!plan) throw new HostedCheckoutError('conflict', 'Plan snapshot of the order is invalid');
  return plan;
}

/** Plan entitlement write-back, registered on BillingService by SubscriptionsModule. */
export function planFulfillmentHooks(database: ApplicationDatabase): BillingFulfillmentHooks {
  return {
    plans: true,
    // One-time and lifetime plan purchases (checkout mode `payment`).
    async checkoutFulfilled(tx, order) {
      const plan = snapshot(order.offer.fulfillmentData);
      if (!plan || order.offer.mode !== 'payment' || !order.fulfilledAt) return;
      const start = order.fulfilledAt;
      const end = plan.interval === 'lifetime' ? null
        : plan.interval === 'one_time' && plan.termDays ? new Date(start.getTime() + plan.termDays * 86_400_000) : undefined;
      if (end === undefined) throw new HostedCheckoutError('conflict', 'A recurring plan price cannot be sold as a one-time payment');
      await recordPlanTerm(database, tx, { userId: order.ownerId, plan, periodStart: start, periodEnd: end,
        reference: `order:${order.id}`, orderId: order.id, purchasedAt: order.createdAt, checkout: true });
    },
    // Each paid cycle of a plan subscription extends the term by its proven period.
    async cycleFulfilled(tx, { ownerId, subscription, receipt }) {
      const plan = snapshot(subscription.offer.fulfillmentData);
      if (!plan) return; // credit-only subscription
      const cycle = CYCLE_FOR_INTERVAL[plan.interval];
      if (cycle !== 'MONTHLY' && cycle !== 'YEARLY') throw new HostedCheckoutError('conflict', 'A one-time plan price cannot renew');
      const periodStart = receipt.periodStart ?? receipt.paidAt;
      // Receipt-basis channels have no provider period; the plan interval from payment time is the paid term.
      const periodEnd = receipt.periodEnd ?? addBillingCycle(receipt.paidAt, cycle);
      // The subscription's purchase decision is its checkout order: a revocation made after it wins.
      const order = await tx.model('billingOrders').findUnique({ where: { id: subscription.initialOrderId },
        select: { createdAt: true } }) as { createdAt: Date } | null;
      await recordPlanTerm(database, tx, { userId: ownerId, plan, periodStart, periodEnd,
        reference: `cycle:${receipt.id}`, orderId: subscription.initialOrderId, purchasedAt: order?.createdAt ?? null,
        checkout: receipt.initial === true });
    },
  };
}
