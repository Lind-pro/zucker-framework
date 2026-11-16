import type { DatabaseAdapter } from '@zucker-framework/core';
import { isActiveTerm } from '@zucker-framework/credit';
import { CYCLE_FOR_INTERVAL } from '@zucker-framework/fe-types/back-office';
import {
  HostedCheckoutError, SubscriptionAssignmentService, addBillingCycle, readPlanPriceSnapshot,
  type PlanPriceSnapshot, type SubscriptionPaymentHistory, type SubscriptionPaymentResult, type SubscriptionRefundResult,
} from '@zucker-framework/payment';
import type { SubscriptionsStorage } from './storage';
import type { PlanFulfillmentHooks, PlanPaymentRefunded } from './subscriptions.ports';
import { createUserSubscriptionStore } from './user-subscription.store';
import { createPaymentHistory } from './payment-history';

/** Event written with every plan term change caused by a payment (publish it after commit). */
export const PLAN_TERM_CHANGED_OUTBOX_KIND = 'billing.plan-term-changed';
/**
 * Event for a verified plan payment that was recorded but did not change the term although the buyer
 * paid for it (the term changed between checkout admission and payment). Refund it at the provider;
 * the payment ledger row (`reference`) is the audit trail.
 */
export const PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND = 'billing.plan-payment-unapplied';

export interface PlanPaymentEvent {
  kind: typeof PLAN_TERM_CHANGED_OUTBOX_KIND | typeof PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND;
  /** The payment reference: one event of each kind per payment. */
  aggregateId: string;
  payload: Record<string, unknown>;
}
/** Writes a plan payment event in the fulfillment transaction. */
export type PlanPaymentEventSink = (tx: DatabaseAdapter, event: PlanPaymentEvent) => Promise<void>;

/** Default sink: a row `{kind, aggregateId, payload}` of the storage's `billingOutbox` model. */
export function outboxEventSink(storage: SubscriptionsStorage): PlanPaymentEventSink {
  return async (tx, event) => { await storage.of(tx).billingOutbox.create({ data: { ...event } }); };
}

export interface PlanTermInput {
  userId: string; plan: PlanPriceSnapshot; periodStart: Date; periodEnd: Date | null; reference: string; orderId: string;
  /** Creation time of the checkout order that made the purchase decision. */
  purchasedAt: Date | null;
  /** True for a checkout payment (admitted at checkout), false for a renewal cycle. */
  checkout: boolean;
}

/**
 * Applies one verified payment for the frozen plan snapshot of its order. The plan is the one the
 * order was created for (never re-derived from a slug or provider reference); the payment ledger
 * makes every reference count once, and SubscriptionAssignmentService decides precedence.
 */
export async function recordPlanTerm(database: DatabaseAdapter, storage: SubscriptionsStorage, tx: DatabaseAdapter, input: PlanTermInput,
  events: PlanPaymentEventSink = outboxEventSink(storage),
  history: SubscriptionPaymentHistory<DatabaseAdapter> = createPaymentHistory(storage)): Promise<SubscriptionPaymentResult> {
  const result = await new SubscriptionAssignmentService(createUserSubscriptionStore(database, storage, { transaction: tx, paymentHistory: history }), { activeTerm: isActiveTerm })
    .recordPayment({ userId: input.userId, planId: input.plan.planId, billingCycle: CYCLE_FOR_INTERVAL[input.plan.interval],
      periodStart: input.periodStart, periodEnd: input.periodEnd, reference: input.reference, orderId: input.orderId,
      purchasedAt: input.purchasedAt });
  // `superseded` of a renewal is an out-of-order receipt whose period is already covered; for a
  // checkout payment, like `kept`/`revoked`, it means the buyer paid for nothing.
  const unapplied = result.outcome === 'kept' || result.outcome === 'revoked' || (input.checkout && result.outcome === 'superseded');
  if (unapplied)
    await events(tx, { kind: PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, aggregateId: input.reference,
      payload: { userId: input.userId, planId: input.plan.planId, orderId: input.orderId, reference: input.reference,
        outcome: result.outcome, amount: input.plan.amount, currency: input.plan.currency } });
  if (result.change)
    await events(tx, { kind: PLAN_TERM_CHANGED_OUTBOX_KIND, aggregateId: input.reference,
      payload: { userId: input.userId, planId: input.plan.planId, orderId: input.orderId, outcome: result.outcome,
        billingCycle: result.change.after.billingCycle, endDate: result.change.after.endDate?.toISOString() ?? null } });
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

export interface PlanFulfillmentOptions {
  /** Where plan payment events go. Default {@link outboxEventSink}. */
  events?: PlanPaymentEventSink;
  /** Permanent application/refund ledger. Defaults to the existing outbox JSON storage. */
  paymentHistory?: SubscriptionPaymentHistory<DatabaseAdapter>;
  /**
   * Creation time of a renewing subscription's checkout order (its purchase decision). Default: the
   * `createdAt` of the storage's `billingOrders` row `initialOrderId`.
   */
  purchasedAt?: (tx: DatabaseAdapter, initialOrderId: string) => Promise<Date | null>;
}

/** Plan entitlement write-back hooks for the billing fulfillment transactions. */
export function createPlanFulfillmentHooks(database: DatabaseAdapter, storage: SubscriptionsStorage,
  options: PlanFulfillmentOptions = {}): PlanFulfillmentHooks {
  const events = options.events ?? outboxEventSink(storage);
  const history = options.paymentHistory ?? createPaymentHistory(storage);
  const purchasedAt = options.purchasedAt ?? (async (tx, id) => {
    const order = await storage.of(tx).billingOrders.findUnique({ where: { id }, select: { createdAt: true } }) as { createdAt: Date } | null;
    return order?.createdAt ?? null;
  });
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
      await recordPlanTerm(database, storage, tx, { userId: order.ownerId, plan, periodStart: start, periodEnd: end,
        reference: `order:${order.id}`, orderId: order.id, purchasedAt: order.createdAt, checkout: true }, events, history);
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
      await recordPlanTerm(database, storage, tx, { userId: ownerId, plan, periodStart, periodEnd,
        reference: `cycle:${receipt.id}`, orderId: subscription.initialOrderId,
        purchasedAt: await purchasedAt(tx, subscription.initialOrderId), checkout: receipt.initial === true }, events, history);
    },
    // A payment refunded in full no longer pays for its term (partial refunds keep it).
    async paymentRefunded(tx, input) {
      await revokePlanTerm(database, storage, tx, input, events, history);
    },
  };
}

/**
 * Removes one fully refunded payment from the current entitlement ancestry. Orders without a plan
 * snapshot are ignored; unrefunded payments and administrator baselines survive. History is durable
 * and transaction-bound; repeated refunds do not write duplicate term-change events.
 */
export async function revokePlanTerm(database: DatabaseAdapter, storage: SubscriptionsStorage, tx: DatabaseAdapter,
  input: Readonly<PlanPaymentRefunded>, events: PlanPaymentEventSink = outboxEventSink(storage),
  history: SubscriptionPaymentHistory<DatabaseAdapter> = createPaymentHistory(storage)): Promise<SubscriptionRefundResult | null> {
  const plan = snapshot(input.fulfillmentData);
  if (!plan) return null;
  const result = await new SubscriptionAssignmentService(createUserSubscriptionStore(database, storage, { transaction: tx, paymentHistory: history }), { activeTerm: isActiveTerm })
    .revokePayment({ userId: input.ownerId, reference: input.reference });
  if (result.change)
    await events(tx, { kind: PLAN_TERM_CHANGED_OUTBOX_KIND, aggregateId: `refund:${input.reference}`,
      payload: { userId: input.ownerId, planId: plan.planId, reference: input.reference, outcome: result.outcome,
        billingCycle: result.change.after.billingCycle, endDate: result.change.after.endDate?.toISOString() ?? null,
        status: result.change.after.status } });
  return result;
}
