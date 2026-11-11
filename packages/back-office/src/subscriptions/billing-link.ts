import type { PendingPaymentBlock } from '@zucker-framework/payment';
import { resolveModelNames } from '../shared/models';
import { requireSql, type SubscriptionBillingLink } from './storage';
import { PENDING_PAYMENT_BLOCK_MS } from './user-subscription.store';

/** Physical tables of the Framework billing host's orders and provider subscriptions. */
export const DEFAULT_BILLING_LINK_TABLES = { orders: 'billing_orders', subscriptions: 'billing_subscriptions' } as const;
export type BillingLinkTableKey = keyof typeof DEFAULT_BILLING_LINK_TABLES;

/**
 * {@link SubscriptionBillingLink} over the Framework billing host's schema (columns `ownerId`,
 * `offer` jsonb with `fulfillmentData.plan`, order `state`/`fulfilledAt`, subscription
 * `status`/`currentPeriodEnd`, `createdAt`). Only table names are configurable; they are validated
 * identifiers and always double-quoted. A schema with other billing columns supplies its own link.
 */
export function createSqlBillingLink(options: { tables?: Partial<Record<BillingLinkTableKey, string>>; pendingBlockMs?: number } = {}): SubscriptionBillingLink {
  const tables = resolveModelNames('subscriptions', DEFAULT_BILLING_LINK_TABLES, options.tables);
  const blockMs = options.pendingBlockMs ?? PENDING_PAYMENT_BLOCK_MS;
  if (!Number.isSafeInteger(blockMs) || blockMs < 0) throw new TypeError('[back-office/subscriptions] pendingBlockMs must be a non-negative integer');
  const orders = `"${tables.orders}"`, subscriptions = `"${tables.subscriptions}"`;
  // Only plan purchases decide the term (credit-only purchases never block). Recent unsettled plan
  // checkouts, and provider plan subscriptions still paying for the term, block; paused, unpaid,
  // canceled and stale pending/unknown states are left to billing reconciliation.
  const pendingSql = `SELECT * FROM (
      (SELECT 'order' AS kind, id, state FROM ${orders}
        WHERE "ownerId"=$1 AND offer->'fulfillmentData'->'plan' IS NOT NULL
          AND state IN ('pending','requires_capture','unknown') AND "createdAt" > $2
        ORDER BY "createdAt" DESC LIMIT 1)
      UNION ALL
      (SELECT 'subscription' AS kind, id, status AS state FROM ${subscriptions}
        WHERE "ownerId"=$1 AND offer->'fulfillmentData'->'plan' IS NOT NULL
          AND (status IN ('active','trialing') OR (status='past_due' AND ("currentPeriodEnd" IS NULL OR "currentPeriodEnd" > $3))
            OR (status='unknown' AND "createdAt" > $2))
        ORDER BY "createdAt" DESC LIMIT 1)
    ) AS blocking LIMIT 1`;
  const referencedSql = `SELECT
      EXISTS (SELECT 1 FROM ${orders} WHERE offer->'fulfillmentData'->'plan'->>'planId'=$1
        AND state <> 'unpaid' AND "fulfilledAt" IS NULL)
      OR EXISTS (SELECT 1 FROM ${subscriptions} WHERE offer->'fulfillmentData'->'plan'->>'planId'=$1
        AND status <> 'canceled') AS referenced`;
  return {
    async pendingPlanPayment(tx, userId, now) {
      const result = await requireSql(tx, 'the billing link').query<PendingPaymentBlock>(pendingSql,
        [userId, new Date(now.getTime() - blockMs), now]);
      return result.rows[0] ?? null;
    },
    async planReferenced(tx, planId) {
      const result = await requireSql(tx, 'the billing link').query<{ referenced: boolean }>(referencedSql, [planId]);
      return result.rows[0]?.referenced === true;
    },
  };
}
