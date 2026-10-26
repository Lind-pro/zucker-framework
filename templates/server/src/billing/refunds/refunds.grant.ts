import { HostedCheckoutError, type HostedCheckoutOrder, type SubscriptionCycleReceipt } from '@zucker-framework/payment';
import type { ApplicationTransaction } from '../../database';
import type { BillingSubscription } from '../subscription-persistence';
import { validateCreditFulfillmentPolicy } from '../ledger';
import type { RefundTargetRow } from './refunds.types';
import { requiredCredits } from './refunds.money';

/** Call under the existing account lock, after transaction-bound payment/receipt persistence and before granting lots. */
async function allowance(tx: ApplicationTransaction, input: { ownerId: string; orderId: string; cycleId?: string;
  providerId: string; accountScope: string; paymentKind: string; paymentId: string; credits: number; source: string; sourceId: string }) {
  const result = await tx.query<RefundTargetRow>(`SELECT payment.* FROM billing_refund_payments AS payment
    JOIN billing_refund_aliases AS alias ON alias."targetId"=payment.id
    WHERE alias."providerId"=$1 AND alias."accountScope"=$2 AND alias."paymentKind"=$3 AND alias."paymentId"=$4 FOR UPDATE OF payment`,
  [input.providerId, input.accountScope, input.paymentKind, input.paymentId]);
  const row = result.rows[0];
  // Existing consumers without a configured refund adapter preserve their established fulfillment contract.
  if (!row) return { credits: input.credits, suppressedCredits: 0 };
  if (row.ownerId !== input.ownerId || row.orderId !== input.orderId || row.totalCredits !== input.credits
    || row.cycleId && input.cycleId && row.cycleId !== input.cycleId || row.grantRecorded) throw new HostedCheckoutError('conflict', 'Refund payment and fulfillment identity differ');
  const pending = await tx.query<{ count: number }>(`SELECT (
    (SELECT COUNT(*) FROM billing_refund_receipts WHERE "targetId"=$1 AND state IN ('pending','requires_action','unknown')) +
    (SELECT COUNT(*) FROM billing_refund_events WHERE "providerId"=$2 AND "accountScope"=$3 AND "sourceKind"=$4 AND "sourceId"=$5
      AND status<>'processed' AND evidence->>'state' IN ('pending','requires_action','unknown','succeeded'))
    )::int AS count`, [row.id, row.providerId, row.accountScope, row.sourceKind, row.sourceId]);
  if (row.activeRequestId || row.attention || BigInt(row.refundedMinor) < BigInt(row.paidMinor)
    && (BigInt(row.providerPendingMinor ?? '0') > 0n || pending.rows[0].count)) {
    throw new HostedCheckoutError('conflict', 'Refund verification must finish before credits are granted');
  }
  const suppressedCredits = requiredCredits(row.totalCredits, row.refundedMinor, row.paidMinor);
  await tx.query(`UPDATE billing_refund_payments SET "grantRecorded"=true,"grantSource"=$2,"grantSourceId"=$3,
    "cycleId"=COALESCE("cycleId",$4),"suppressedCredits"=$5,"recoveredCredits"="revokedCredits"+"expiredCredits"+$5,
    revision=revision+1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [row.id, input.source, input.sourceId, input.cycleId ?? null, suppressedCredits]);
  return { credits: input.credits - suppressedCredits, suppressedCredits };
}
export function refundCheckoutGrant(tx: ApplicationTransaction, order: Readonly<HostedCheckoutOrder>) {
  if (!order.paymentId || !order.paymentKind || order.offer.mode !== 'payment') throw new HostedCheckoutError('verification_failed', 'Verified one-time payment is required');
  return allowance(tx, { ownerId: order.ownerId, orderId: order.id, providerId: order.providerId, accountScope: order.accountScope,
    paymentId: order.paymentId, paymentKind: order.paymentKind, credits: validateCreditFulfillmentPolicy(order.offer.fulfillmentData).credits,
    source: 'purchase', sourceId: order.id });
}
export function refundCycleGrant(tx: ApplicationTransaction, binding: Readonly<BillingSubscription>, receipt: Readonly<SubscriptionCycleReceipt>) {
  return allowance(tx, { ownerId: receipt.ownerId, orderId: binding.initialOrderId, cycleId: receipt.id,
    providerId: receipt.providerId, accountScope: receipt.accountScope, paymentId: receipt.paymentId, paymentKind: receipt.paymentKind,
    credits: validateCreditFulfillmentPolicy(receipt.policy).credits, source: 'subscription', sourceId: receipt.id });
}
