import { HostedCheckoutError, type Money, type RefundObservation, type RefundPaymentObservation, type RefundWebhookEvent } from '@zucker-framework/payment';
import type { ApplicationTransaction } from '../../database';
import { minorAmount, requiredCredits } from './refunds.money';
import type { RefundRequestRow, RefundTargetRow } from './refunds.types';

export function refundConflict(message: string): never { throw new HostedCheckoutError('conflict', message); }
export const targetColumns = new Set(['cycleId', 'refundedMinor', 'providerPendingMinor', 'recoveredCredits', 'revokedCredits', 'expiredCredits', 'suppressedCredits', 'grantRecorded', 'grantSource', 'grantSourceId', 'activeRequestId', 'attention', 'observedAt']);
export const requestColumns = new Set(['state', 'creditState', 'holdId', 'expiredCredits', 'suppressedCredits', 'revokedCredits', 'shortfallCredits', 'providerRefundId', 'confirmationBasis', 'checkedAt', 'lastReconcileTaskId', 'reconcileStatus', 'reconcileErrorCode']);
export async function updateRefundRow<T>(tx: ApplicationTransaction, table: 'billing_refund_payments' | 'billing_refund_requests', id: string, patch: Record<string, unknown>): Promise<T> {
  const allowed = table === 'billing_refund_payments' ? targetColumns : requestColumns, keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !allowed.has(key))) throw new Error('Invalid internal refund update');
  const set = keys.map((key, index) => `"${key}"=$${index + 2}`).join(',');
  const rows = await tx.query<T>(`UPDATE ${table} SET ${set},revision=revision+1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [id, ...keys.map(key => patch[key])]);
  if (!rows.rows[0]) refundConflict('Refund record disappeared'); return rows.rows[0];
}
export async function lockRefundSource(tx: ApplicationTransaction, providerId: string, accountScope: string, sourceKind: string, sourceId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':billing-refund-source:' || $1, 0))::text AS locked",
    [JSON.stringify([providerId, accountScope, sourceKind, sourceId])]);
}
export async function lockedTarget(tx: ApplicationTransaction, id: string): Promise<RefundTargetRow> {
  const result = await tx.query<RefundTargetRow>('SELECT * FROM billing_refund_payments WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new HostedCheckoutError('not_found', 'Refund payment was not found'); return result.rows[0];
}
export async function lockedRequest(tx: ApplicationTransaction, id: string): Promise<RefundRequestRow> {
  const result = await tx.query<RefundRequestRow>('SELECT * FROM billing_refund_requests WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new HostedCheckoutError('not_found', 'Refund request was not found'); return result.rows[0];
}
export async function addRefundAlias(tx: ApplicationTransaction, target: RefundTargetRow, kind: string, id: string): Promise<void> {
  await tx.query(`INSERT INTO billing_refund_aliases("providerId","accountScope","paymentKind","paymentId","targetId")
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [target.providerId, target.accountScope, kind, id, target.id]);
  const row = await tx.query<{ targetId: string }>(`SELECT "targetId" FROM billing_refund_aliases
    WHERE "providerId"=$1 AND "accountScope"=$2 AND "paymentKind"=$3 AND "paymentId"=$4`, [target.providerId, target.accountScope, kind, id]);
  if (row.rows[0]?.targetId !== target.id) refundConflict('Funding source already belongs to a different payment');
}
function amount(target: RefundTargetRow, value: Money | undefined): bigint | undefined {
  if (!value) return undefined;
  if (value.currency !== target.paidMoney.currency) refundConflict('Refund currency differs from the payment');
  const minor = minorAmount(value.amount, value.currency, target.minorScale);
  if (minor > BigInt(target.paidMinor)) refundConflict('Refund exceeds the original payment'); return minor;
}
export async function recordRefundEvidence(tx: ApplicationTransaction, target: RefundTargetRow, observation: RefundObservation | RefundWebhookEvent): Promise<void> {
  if (observation.source.kind !== target.sourceKind || observation.source.id !== target.sourceId) refundConflict('Refund source differs from the verified payment');
  if (!observation.refundId) return;
  const paid = amount(target, observation.money), total = amount(target, observation.totalRefundedMoney);
  if (observation.state === 'succeeded' && (paid === undefined || paid === 0n)) refundConflict('Successful refund requires actual positive money');
  const prior = await tx.query<{ targetId: string; sourceKind: string; sourceId: string; amountMinor: string | null; state: string; commandKey: string | null }>(
    `SELECT * FROM billing_refund_receipts WHERE "providerId"=$1 AND "accountScope"=$2 AND "refundId"=$3 FOR UPDATE`, [target.providerId, target.accountScope, observation.refundId]);
  const existing = prior.rows[0];
  if (existing && (existing.targetId !== target.id || existing.sourceKind !== target.sourceKind || existing.sourceId !== target.sourceId
    || existing.amountMinor !== null && paid !== undefined && BigInt(existing.amountMinor) !== paid
    || existing.commandKey && observation.commandKey && existing.commandKey !== observation.commandKey)) refundConflict('Refund receipt identity or amount changed');
  // A delayed failed/pending notification cannot undo proven returned money.
  const state = existing?.state === 'succeeded' ? 'succeeded' : observation.state;
  const occurredAt = observation.occurredAt && Number.isFinite(Date.parse(observation.occurredAt)) ? new Date(observation.occurredAt) : null;
  await tx.query(`INSERT INTO billing_refund_receipts("providerId","accountScope","refundId","targetId","sourceKind","sourceId","commandKey",state,money,"amountMinor","totalRefundedMinor","occurredAt")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
    ON CONFLICT("providerId","accountScope","refundId") DO UPDATE SET state=EXCLUDED.state,
      money=COALESCE(billing_refund_receipts.money,EXCLUDED.money),"amountMinor"=COALESCE(billing_refund_receipts."amountMinor",EXCLUDED."amountMinor"),
      "totalRefundedMinor"=CASE WHEN EXCLUDED.state='succeeded' THEN GREATEST(COALESCE(billing_refund_receipts."totalRefundedMinor",'0')::numeric,COALESCE(EXCLUDED."totalRefundedMinor",'0')::numeric)::text ELSE billing_refund_receipts."totalRefundedMinor" END,
      "commandKey"=COALESCE(billing_refund_receipts."commandKey",EXCLUDED."commandKey"),"updatedAt"=CURRENT_TIMESTAMP`,
  [target.providerId, target.accountScope, observation.refundId, target.id, target.sourceKind, target.sourceId, observation.commandKey ?? null,
    state, observation.money ? JSON.stringify(observation.money) : null, paid?.toString() ?? null, total?.toString() ?? null, occurredAt]);
}
export async function mergeRefundCash(tx: ApplicationTransaction, target: RefundTargetRow, facts?: RefundPaymentObservation): Promise<RefundTargetRow> {
  if (facts && (facts.source.kind !== target.sourceKind || facts.source.id !== target.sourceId)) refundConflict('Verified payment source changed');
  const events = await tx.query<{ eventId: string; evidence: RefundWebhookEvent }>(`SELECT "eventId",evidence FROM billing_refund_events
    WHERE "providerId"=$1 AND "accountScope"=$2 AND "sourceKind"=$3 AND "sourceId"=$4 AND status<>'processed' ORDER BY "createdAt" FOR UPDATE`,
  [target.providerId, target.accountScope, target.sourceKind, target.sourceId]);
  let eventCumulative = 0n;
  for (const event of events.rows) {
    const reported = event.evidence.state === 'succeeded' ? amount(target, event.evidence.totalRefundedMoney) : undefined;
    if (reported !== undefined && reported > eventCumulative) eventCumulative = reported;
    await recordRefundEvidence(tx, target, event.evidence);
    await tx.query(`UPDATE billing_refund_events SET "targetId"=$4,status=$5,"processedAt"=CURRENT_TIMESTAMP
      WHERE "providerId"=$1 AND "accountScope"=$2 AND "eventId"=$3`, [target.providerId, target.accountScope, event.eventId, target.id,
        event.evidence.refundId || ['failed', 'canceled'].includes(event.evidence.state) || reported !== undefined && reported > 0n ? 'processed' : 'attention']);
  }
  const totals = await tx.query<{ sum: string; cumulative: string }>(`SELECT COALESCE(SUM("amountMinor"::numeric),0)::text AS sum,
    COALESCE(MAX("totalRefundedMinor"::numeric),0)::text AS cumulative FROM billing_refund_receipts WHERE "targetId"=$1 AND state='succeeded'`, [target.id]);
  const observed = facts ? amount(target, facts.refundedMoney) : undefined;
  const values = [BigInt(target.refundedMinor), BigInt(totals.rows[0].sum), BigInt(totals.rows[0].cumulative), eventCumulative, observed ?? 0n];
  const refunded = values.reduce((a, b) => a > b ? a : b);
  if (refunded > BigInt(target.paidMinor)) refundConflict('Cumulative refunds exceed the original payment');
  const pending = facts ? amount(target, facts.pendingRefundMoney) : undefined;
  const patch: Record<string, unknown> = { refundedMinor: refunded.toString() };
  if (facts) { patch.observedAt = new Date(); patch.providerPendingMinor = pending?.toString() ?? null; }
  return updateRefundRow(tx, 'billing_refund_payments', target.id, patch);
}
export function targetCreditDeficit(target: RefundTargetRow): number {
  return Math.max(0, requiredCredits(target.totalCredits, target.refundedMinor, target.paidMinor) - target.recoveredCredits);
}
