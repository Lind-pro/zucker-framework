import { randomUUID } from 'node:crypto';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import type {
  PendingPaymentBlock, SubscriptionPaymentEvidence, UserSubscriptionRecord, UserSubscriptionStore,
} from '@zucker-framework/payment';
import type { ApplicationDatabase, ApplicationTransaction } from '../database';

const coordinator = new PostgresCreditOperationCoordinator();
/**
 * An unsettled plan checkout (`pending`, `requires_capture` or `unknown`) and a provider subscription
 * still `unknown` block administrator term changes only while they are this young. Hosted checkout
 * sessions expire within 24 hours (Stripe's maximum; PayPal approvals and Creem sessions are
 * shorter), so an older one can no longer be paid normally and is left to reconciliation instead of
 * pinning the account. A late payment is still applied by the ledger's precedence rules.
 */
export const PENDING_PAYMENT_BLOCK_MS = 24 * 60 * 60 * 1000;
/** @deprecated Use {@link PENDING_PAYMENT_BLOCK_MS}; it now also bounds `pending`/`requires_capture`. */
export const UNKNOWN_PAYMENT_BLOCK_MS = PENDING_PAYMENT_BLOCK_MS;

/**
 * `user_subscriptions` + `user_subscription_payments` binding. Every writer takes the same account
 * lock as billing checkout and subscription-cycle fulfillment, so an administrator cannot overwrite
 * a term while a payment for that account is being applied. Pass `transaction` to reuse a caller's
 * transaction (payment write-back inside fulfillment); the lock is re-entrant within one transaction.
 */
export function createUserSubscriptionStore(database: ApplicationDatabase, transaction?: ApplicationTransaction,
  now: () => Date = () => new Date()): UserSubscriptionStore<ApplicationTransaction> {
  return {
    transaction: async (userId, work) => {
      const run = async (tx: ApplicationTransaction) => { await coordinator.lockAccount(tx, userId); return work(tx); };
      return transaction ? run(transaction) : database.transaction(run);
    },
    async userAssignable(tx, userId) {
      const user = await tx.model('users').findUnique({ where: { id: userId }, select: { status: true } }) as { status: boolean } | null;
      return user?.status === true;
    },
    find: async (tx, userId) => await tx.model('userSubscriptions').findUnique({ where: { userId } }) as UserSubscriptionRecord | null,
    findPlanBySlug: async (tx, slug) => await tx.model('subscriptionPlans').findUnique({ where: { slug }, select: { id: true, slug: true, status: true } }) as { id: string; slug: string; status: boolean } | null,
    findPlanById: async (tx, id) => await tx.model('subscriptionPlans').findUnique({ where: { id }, select: { id: true, slug: true, status: true } }) as { id: string; slug: string; status: boolean } | null,
    async pendingPayment(tx, userId) {
      // Only plan purchases decide the plan term (credit-only purchases never block). Recent unsettled
      // plan checkouts, and provider plan subscriptions that are still paying for the term, block;
      // paused, unpaid, canceled and stale pending/unknown states are left to billing reconciliation.
      // The caller decides what a block prevents (revocation and cancel ignore checkouts).
      const unknownSince = new Date(now().getTime() - PENDING_PAYMENT_BLOCK_MS);
      const result = await tx.query<PendingPaymentBlock>(`SELECT * FROM (
          (SELECT 'order' AS kind, id, state FROM billing_orders
            WHERE "ownerId"=$1 AND offer->'fulfillmentData'->'plan' IS NOT NULL
              AND state IN ('pending','requires_capture','unknown') AND "createdAt" > $2
            ORDER BY "createdAt" DESC LIMIT 1)
          UNION ALL
          (SELECT 'subscription' AS kind, id, status AS state FROM billing_subscriptions
            WHERE "ownerId"=$1 AND offer->'fulfillmentData'->'plan' IS NOT NULL
              AND (status IN ('active','trialing') OR (status='past_due' AND ("currentPeriodEnd" IS NULL OR "currentPeriodEnd" > $3))
                OR (status='unknown' AND "createdAt" > $2))
            ORDER BY "createdAt" DESC LIMIT 1)
        ) AS blocking LIMIT 1`, [userId, unknownSince, now()]);
      return result.rows[0] ?? null;
    },
    async recordPaymentEvidence(tx, evidence: SubscriptionPaymentEvidence) {
      const inserted = await tx.query<{ id: string }>(`INSERT INTO user_subscription_payments
          (id, reference, "userId", "planId", "billingCycle", "periodStart", "periodEnd", "orderId")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (reference) DO NOTHING RETURNING id`,
      [randomUUID(), evidence.reference, evidence.userId, evidence.planId, evidence.billingCycle, evidence.periodStart,
        evidence.periodEnd, evidence.orderId]);
      return inserted.rows.length === 1;
    },
    findPaymentEvidence: async (tx, reference) => await tx.model('userSubscriptionPayments').findUnique({ where: { reference },
      select: { reference: true, userId: true, planId: true, billingCycle: true, periodStart: true, periodEnd: true, orderId: true } }) as SubscriptionPaymentEvidence | null,
    async save(tx, userId, data) {
      // Safe as update-then-insert because every writer holds the account lock; userId is unique.
      const changed = await tx.model('userSubscriptions').updateMany({ where: { userId }, data: { ...data, updatedAt: new Date() } });
      if (!changed.count) await tx.model('userSubscriptions').create({ data: { userId, ...data } });
      return await tx.model('userSubscriptions').findUnique({ where: { userId } }) as UserSubscriptionRecord;
    },
  };
}
