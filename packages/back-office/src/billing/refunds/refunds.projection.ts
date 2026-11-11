import { HostedCheckoutError, type HostedCheckoutOrder, type Money, type RefundWebhookEvent } from '@zucker-framework/payment';
import { billingTransaction, DEFAULT_BILLING_STORAGE, type BillingDatabase, type BillingStorage } from '../billing.database';
import { minorAmount, minorMoney } from './refunds.money';

export interface PublicRefundSummary {
  state: 'none' | 'pending' | 'partial' | 'full';
  refundedMoney: Money;
  /** Current requested/observed pending money, not evidence of a completed refund. */
  pendingMoney: Money | null;
  suppressedCredits: number;
  recoveredCredits: number;
  needsAttention: boolean;
}
export type RefundSummaryOrder = Pick<HostedCheckoutOrder, 'id' | 'ownerId' | 'providerId' | 'accountScope' | 'paymentId' | 'paymentKind'>;

/** Original payment facts stay immutable; this separately projects locally verified refund facts. */
export async function readOrderRefundSummary(database: BillingDatabase, order: Readonly<RefundSummaryOrder>,
  storage: BillingStorage = DEFAULT_BILLING_STORAGE): Promise<PublicRefundSummary | null> {
  if (!order.paymentId || !order.paymentKind) return null;
  const t = storage.t;
  return billingTransaction(database, async tx => {
    const result = await tx.query<{ id: string; ownerId: string; orderId: string; paidMoney: Money; paidMinor: string;
      refundedMinor: string; providerPendingMinor: string | null; minorScale: number; suppressedCredits: number;
      recoveredCredits: number; attention: boolean; activeRequestId: string | null; sourceKind: string; sourceId: string }>(`SELECT payment.id,payment."ownerId",payment."orderId",
        payment."paidMoney",payment."paidMinor",payment."refundedMinor",payment."providerPendingMinor",payment."minorScale",
        payment."suppressedCredits",payment."recoveredCredits",payment.attention,payment."activeRequestId",payment."sourceKind",payment."sourceId"
      FROM ${t.refundPayments} AS payment JOIN ${t.refundAliases} AS alias ON alias."targetId"=payment.id
      WHERE alias."providerId"=$1 AND alias."accountScope"=$2 AND alias."paymentKind"=$3 AND alias."paymentId"=$4`,
    [order.providerId, order.accountScope, order.paymentKind, order.paymentId]);
    const row = result.rows[0]; if (!row) return null;
    if (result.rows.length !== 1 || row.ownerId !== order.ownerId || row.orderId !== order.id)
      throw new HostedCheckoutError('conflict', 'Refund summary does not belong to this payment');
    const requests = await tx.query<{ requestedMinor: string; active: boolean; attention: boolean }>(`SELECT "requestedMinor",
        (id=$2 AND state NOT IN ('succeeded','failed','canceled')) AS active,
        ("creditState"='attention' OR "reconcileStatus"='attention') AS attention
      FROM ${t.refundRequests} WHERE "targetId"=$1 AND (id=$2 OR "creditState"='attention' OR "reconcileStatus"='attention')`,
    [row.id, row.activeRequestId]);
    const unresolvedReceipts = await tx.query<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${t.refundReceipts}
      WHERE "targetId"=$1 AND state IN ('pending','requires_action','unknown')) AS pending`, [row.id]);
    const requested = requests.rows.filter(request => request.active).map(request => BigInt(request.requestedMinor));
    const pending = [row.providerPendingMinor === null ? 0n : BigInt(row.providerPendingMinor), ...requested].reduce((a, b) => a > b ? a : b);
    // A confirmed response is journaled before credit settlement. That settlement may roll back,
    // so its target aggregate cannot be the only read model for money already returned by the provider.
    const receiptRows = await tx.query<{ refundId: string; amountMinor: string; totalRefundedMinor: string | null }>(
      `SELECT "refundId","amountMinor","totalRefundedMinor" FROM ${t.refundReceipts} WHERE "targetId"=$1 AND state='succeeded'`, [row.id]);
    const eventRows = await tx.query<{ evidence: RefundWebhookEvent }>(`SELECT evidence FROM ${t.refundEvents}
      WHERE "providerId"=$1 AND "accountScope"=$2 AND "sourceKind"=$3 AND "sourceId"=$4 AND evidence->>'state'='succeeded'`,
    [order.providerId, order.accountScope, row.sourceKind, row.sourceId]);
    const actual = new Map<string, bigint>();
    let refunded = BigInt(row.refundedMinor);
    const bound = (value: bigint) => {
      if (value < 0n || value > BigInt(row.paidMinor)) throw new HostedCheckoutError('conflict', 'Refund evidence exceeds the original payment');
      return value;
    };
    const record = (id: string, amount: bigint) => {
      bound(amount);
      if (!id || amount === 0n || actual.has(id) && actual.get(id) !== amount)
        throw new HostedCheckoutError('conflict', 'Refund evidence contains inconsistent receipt amounts');
      actual.set(id, amount);
    };
    const money = (value: Money) => {
      if (value.currency !== row.paidMoney.currency) throw new HostedCheckoutError('conflict', 'Refund evidence currency differs from payment');
      return bound(minorAmount(value.amount, value.currency, row.minorScale));
    };
    for (const receipt of receiptRows.rows) {
      record(receipt.refundId, BigInt(receipt.amountMinor));
      const total = bound(BigInt(receipt.totalRefundedMinor ?? '0')); if (total > refunded) refunded = total;
    }
    for (const { evidence } of eventRows.rows) {
      if (evidence.refundId && evidence.money) record(evidence.refundId, money(evidence.money));
      if (evidence.totalRefundedMoney) { const total = money(evidence.totalRefundedMoney); if (total > refunded) refunded = total; }
    }
    const sum = bound([...actual.values()].reduce((total, amount) => total + amount, 0n));
    if (sum > refunded) refunded = sum;
    const full = refunded === BigInt(row.paidMinor);
    return { state: full ? 'full' : refunded > 0n ? 'partial'
      : pending > 0n || unresolvedReceipts.rows[0]?.pending ? 'pending' : 'none',
      refundedMoney: minorMoney(refunded, row.paidMoney.currency, row.minorScale),
      pendingMoney: pending > 0n ? minorMoney(pending, row.paidMoney.currency, row.minorScale) : null,
      suppressedCredits: row.suppressedCredits, recoveredCredits: row.recoveredCredits,
      needsAttention: row.attention || refunded > BigInt(row.refundedMinor) || requests.rows.some(request => request.attention) };
  });
}
