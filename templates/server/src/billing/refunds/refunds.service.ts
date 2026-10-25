import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { HostedCheckoutError, RefundProtocolError, currencyExponent } from '@zucker-framework/payment';
import type { HostedCheckoutObservation, HostedCheckoutOrder, RefundAdapter, RefundObservation, RefundPaymentObservation,
  RefundPaymentReference, RefundWebhookEvent, SubscriptionCycleReceipt, SubscriptionPaidPeriod, SubscriptionPaidReceipt, WebhookRequest } from '@zucker-framework/payment';
import { ApplicationDatabase, type ApplicationTransaction } from '../../database';
import { createCreditLedger, validateCreditFulfillmentPolicy } from '../ledger';
import type { BillingSubscription, SubscriptionExecutionFence } from '../subscription-persistence';
import { minorAmount, minorMoney, requiredCredits } from './refunds.money';
import { addRefundAlias, lockedRequest, lockedTarget, lockRefundSource, mergeRefundCash, recordRefundEvidence, refundConflict, targetCreditDeficit, updateRefundRow } from './refunds.store';
import type { RefundLocalPayment, RefundRequestRow, RefundTargetRow, RefundTargetType } from './refunds.types';

const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const terminal = new Set(['succeeded', 'failed', 'canceled']);
function sameEvidence(a: RefundWebhookEvent, b: RefundWebhookEvent): boolean {
  const equivalent = (x: RefundWebhookEvent['money'], y: RefundWebhookEvent['money']) => {
    if (!x || !y) return !x && !y;
    const scale = Math.max(currencyExponent(x.currency), (x.amount.split('.')[1] ?? '').length, (y.amount.split('.')[1] ?? '').length);
    return x.currency === y.currency && minorAmount(x.amount, x.currency, scale) === minorAmount(y.amount, y.currency, scale);
  };
  return a.source.kind === b.source.kind && a.source.id === b.source.id && a.refundId === b.refundId && a.commandKey === b.commandKey
    && a.state === b.state && equivalent(a.money, b.money) && equivalent(a.totalRefundedMoney, b.totalRefundedMoney)
    && (a.occurredAt ? Date.parse(a.occurredAt) : null) === (b.occurredAt ? Date.parse(b.occurredAt) : null);
}
interface Lot { id: string; amount: number; remainingAmount: number; isExpired: boolean; expiresAt: Date | null }
function paymentScale(payment: RefundPaymentReference): number {
  const scale = Math.max(currencyExponent(payment.paidMoney.currency), (payment.paidMoney.amount.split('.')[1] ?? '').replace(/0+$/, '').length);
  if (scale > 3) throw new HostedCheckoutError('invalid_input', 'Payment precision exceeds supported refund precision'); return scale;
}
function commandId(actorId: string, key: string | undefined): string {
  if (!actorId || !key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new BadRequestException('A stable refund Idempotency-Key is required');
  return hash(['refund-command', actorId, key]);
}
function pageNumber(value?: string) { const page = value === undefined ? 1 : Number(value); if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Invalid refund page'); return page; }
function bodyRecord(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new BadRequestException('Invalid refund request');
  return value as Record<string, unknown>;
}

/** Durable cash requests and actual provider receipts over existing payment and credit facts. */
export class BillingRefundsService {
  private readonly adapters = new Map<string, RefundAdapter>();
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  private readonly ledger: ReturnType<typeof createCreditLedger>;
  constructor(private readonly database: ApplicationDatabase, adapters: readonly RefundAdapter[]) {
    for (const adapter of adapters) { if (this.adapters.has(adapter.id)) throw new Error('Duplicate refund provider'); this.adapters.set(adapter.id, adapter); }
    this.ledger = createCreditLedger(database, { refundSettlement: true });
  }
  private adapter(providerId: string, accountScope: string) {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new HostedCheckoutError('unsupported', 'Refund provider is unavailable');
    if (adapter.accountScope !== accountScope) throw new HostedCheckoutError('verification_failed', 'Refund provider account changed'); return adapter;
  }
  private reference(row: RefundTargetRow): RefundPaymentReference { return { paymentId: row.paymentId, paymentKind: row.paymentKind, paidMoney: row.paidMoney }; }
  private async transaction<T>(ownerId: string, work: (tx: ApplicationTransaction) => Promise<T>, fence?: SubscriptionExecutionFence): Promise<T> {
    return this.database.transaction(async tx => { await fence?.(tx); await this.coordinator.lockAccount(tx, ownerId); const result = await work(tx); await fence?.(tx); return result; });
  }
  private async order(id: string): Promise<HostedCheckoutOrder> {
    const row = await this.database.model('billingOrders').findUnique({ where: { id } }) as HostedCheckoutOrder | null;
    if (!row) throw new HostedCheckoutError('not_found', 'Payment order was not found'); return row;
  }
  private async local(type: RefundTargetType, id: string): Promise<RefundLocalPayment> {
    if (type === 'order') {
      const order = await this.order(id);
      if (order.state !== 'paid' || !order.paymentId || !order.paymentKind) throw new HostedCheckoutError('conflict', 'Only verified paid orders can be refunded');
      const initialCycle = order.offer.mode === 'subscription' ? await this.database.model('billingSubscriptionCycles').findMany({ where: { bindingId: order.id, initial: true }, take: 1 }) as SubscriptionCycleReceipt[] : [];
      if (initialCycle[0]) return this.local('cycle', initialCycle[0].id);
      const fulfilled = await this.database.model('billingFulfillments').findUnique({ where: { orderId: order.id } });
      return { ownerId: order.ownerId, orderId: order.id, providerId: order.providerId, accountScope: order.accountScope, title: order.offer.description,
        reference: { paymentId: order.paymentId, paymentKind: order.paymentKind, paidMoney: order.offer.money }, totalCredits: validateCreditFulfillmentPolicy(order.offer.fulfillmentData).credits,
        grantRecorded: !!fulfilled, ...(order.offer.mode === 'payment' ? { grantSource: 'purchase' as const, grantSourceId: order.id } : {}) };
    }
    if (type !== 'cycle') throw new BadRequestException('Unsupported refund target');
    const cycle = await this.database.model('billingSubscriptionCycles').findUnique({ where: { id } }) as SubscriptionCycleReceipt | null;
    if (!cycle) throw new HostedCheckoutError('not_found', 'Subscription payment was not found');
    const binding = await this.database.model('billingSubscriptions').findUnique({ where: { id: cycle.bindingId } }) as BillingSubscription | null;
    if (!binding || binding.ownerId !== cycle.ownerId) refundConflict('Subscription payment ownership is inconsistent');
    return { ownerId: cycle.ownerId, orderId: binding.initialOrderId, cycleId: cycle.id, providerId: cycle.providerId, accountScope: cycle.accountScope,
      title: binding.offer.description, reference: { paymentId: cycle.paymentId, paymentKind: cycle.paymentKind, paidMoney: cycle.paidMoney },
      totalCredits: validateCreditFulfillmentPolicy(cycle.policy).credits, grantRecorded: true, grantSource: 'subscription', grantSourceId: cycle.id };
  }
  private async providerFacts(adapter: RefundAdapter, payment: RefundPaymentReference) {
    const snapshot = structuredClone(payment), facts = await adapter.retrievePayment(snapshot), observations: RefundObservation[] = [];
    if (facts.paymentId !== snapshot.paymentId || facts.paymentKind !== snapshot.paymentKind || facts.paidMoney.currency !== snapshot.paidMoney.currency
      || minorAmount(facts.paidMoney.amount, facts.paidMoney.currency, paymentScale(snapshot)) !== minorAmount(snapshot.paidMoney.amount, snapshot.paidMoney.currency, paymentScale(snapshot))) throw new HostedCheckoutError('verification_failed', 'Refund payment evidence differs from its binding');
    if (!['paid', 'partially_refunded', 'refunded'].includes(facts.settlement)) throw new HostedCheckoutError('verification_failed', 'Payment settlement is not verified');
    if (adapter.listRefunds) {
      const cursors = new Set<string>(); let cursor: string | undefined;
      for (let index = 0; ; index++) {
        if (index >= 100) refundConflict('Refund history exceeded the page limit');
        const page = await adapter.listRefunds(snapshot, { cursor }); observations.push(...page.data);
        if (observations.length > 10000) refundConflict('Refund history exceeded the receipt limit');
        if (page.nextCursor === undefined) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) refundConflict('Refund history did not advance'); cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
    } else if (adapter.retrieve) {
      const pending = await this.database.transaction(tx => tx.query<{ refundId: string }>(`SELECT receipt."refundId" FROM billing_refund_receipts AS receipt
        JOIN billing_refund_payments AS payment ON payment.id=receipt."targetId" WHERE payment."providerId"=$1 AND payment."accountScope"=$2
        AND payment."sourceKind"=$3 AND payment."sourceId"=$4 AND receipt.state IN ('pending','requires_action','unknown') LIMIT 101`,
      [adapter.id, adapter.accountScope, facts.source.kind, facts.source.id]));
      if (pending.rows.length > 100) refundConflict('Unresolved refund history exceeds the check limit');
      for (const row of pending.rows) observations.push(await adapter.retrieve(row.refundId, snapshot));
    }
    return { facts, observations };
  }
  private async register(tx: ApplicationTransaction, local: RefundLocalPayment, facts: RefundPaymentObservation): Promise<RefundTargetRow> {
    // Account -> source -> target. Unknown-owner webhooks hold only the source lock, then commit.
    await lockRefundSource(tx, local.providerId, local.accountScope, facts.source.kind, facts.source.id);
    const aliases = await tx.query<RefundTargetRow>(`SELECT DISTINCT payment.* FROM billing_refund_payments AS payment JOIN billing_refund_aliases AS alias ON alias."targetId"=payment.id
      WHERE alias."providerId"=$1 AND alias."accountScope"=$2 AND ((alias."paymentKind"=$3 AND alias."paymentId"=$4) OR (alias."paymentKind"=$5 AND alias."paymentId"=$6))`,
    [local.providerId, local.accountScope, local.reference.paymentKind, local.reference.paymentId, facts.source.kind, facts.source.id]);
    if (aliases.rows.length > 1) refundConflict('Payment aliases refer to different refund targets');
    let row = aliases.rows[0];
    if (row) {
      row = await lockedTarget(tx, row.id);
      if (row.ownerId !== local.ownerId || row.orderId !== local.orderId || row.totalCredits !== local.totalCredits
        || row.paidMoney.currency !== local.reference.paidMoney.currency || BigInt(row.paidMinor) !== minorAmount(local.reference.paidMoney.amount, row.paidMoney.currency, row.minorScale)
        || row.sourceKind !== facts.source.kind || row.sourceId !== facts.source.id || row.cycleId && local.cycleId && row.cycleId !== local.cycleId) refundConflict('Refund target identity is inconsistent');
      if (local.grantRecorded && !row.grantRecorded) refundConflict('Existing fulfillment lacks matching refund grant provenance');
      if (local.cycleId && !row.cycleId) row = await updateRefundRow(tx, 'billing_refund_payments', row.id, { cycleId: local.cycleId });
    } else {
      const minorScale = paymentScale(local.reference);
      const paid = minorAmount(local.reference.paidMoney.amount, local.reference.paidMoney.currency, minorScale); if (paid <= 0n) refundConflict('Refund requires positive actual paid money');
      const id = hash(['refund-payment', local.providerId, local.accountScope, facts.source.kind, facts.source.id]);
      const inserted = await tx.query<RefundTargetRow>(`INSERT INTO billing_refund_payments(id,"ownerId","orderId","cycleId","providerId","accountScope","paymentKind","paymentId","sourceKind","sourceId",title,"paidMoney","paidMinor","minorScale","totalCredits","grantRecorded","grantSource","grantSourceId","observedAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,CURRENT_TIMESTAMP) RETURNING *`,
      [id, local.ownerId, local.orderId, local.cycleId ?? null, local.providerId, local.accountScope, local.reference.paymentKind, local.reference.paymentId,
        facts.source.kind, facts.source.id, local.title, JSON.stringify(local.reference.paidMoney), paid.toString(), minorScale, local.totalCredits,
        local.grantRecorded, local.grantSource ?? null, local.grantSourceId ?? null]); row = inserted.rows[0];
    }
    await addRefundAlias(tx, row, local.reference.paymentKind, local.reference.paymentId); await addRefundAlias(tx, row, facts.source.kind, facts.source.id); return row;
  }
  private async observeLocal(local: RefundLocalPayment, fence?: SubscriptionExecutionFence) {
    const adapter = this.adapter(local.providerId, local.accountScope), { facts, observations } = await this.providerFacts(adapter, local.reference);
    // Cash observations commit independently of all hold/ledger writes. The consumer ledger blocks
    // affected source lots while this known cumulative cash still has unsettled credit recovery.
    const prepared = await this.transaction(local.ownerId, async tx => {
      let row = await this.register(tx, local, facts);
      for (const observation of observations) await recordRefundEvidence(tx, row, observation);
      row = await mergeRefundCash(tx, row, facts); return row;
    }, fence);
    try {
      return await this.transaction(local.ownerId, async tx => {
        let row = await lockedTarget(tx, prepared.id); row = await this.settleActive(tx, row); row = await this.recoverCredits(tx, row);
        if (!row.grantRecorded && !facts.refundedMoney && facts.settlement !== 'paid' && BigInt(row.refundedMinor) === 0n)
          row = await updateRefundRow(tx, 'billing_refund_payments', row.id, { attention: true });
        return row;
      }, fence);
    } catch (error) { await this.markTargetAttention(local.ownerId, prepared.id, fence); throw error; }
  }
  /** Verified checkout observation is prepared outside the original fulfillment transaction. */
  async prepareCheckout(order: Readonly<HostedCheckoutOrder>, observation: Readonly<HostedCheckoutObservation>, fence?: SubscriptionExecutionFence): Promise<void> {
    if (!this.adapters.has(order.providerId)) return;
    if (observation.state !== 'paid' || !observation.paidMoney || !observation.paymentId || !observation.paymentKind) refundConflict('Verified checkout payment is required for refund preparation');
    const persisted = await this.order(order.id);
    if (persisted.ownerId !== order.ownerId || persisted.accountScope !== order.accountScope || persisted.providerId !== order.providerId) refundConflict('Checkout refund preparation identity differs');
    const fulfilled = await this.database.model('billingFulfillments').findUnique({ where: { orderId: order.id } });
    await this.observeLocal({ ownerId: order.ownerId, orderId: order.id, providerId: order.providerId, accountScope: order.accountScope, title: order.offer.description,
      reference: { paymentId: observation.paymentId, paymentKind: observation.paymentKind, paidMoney: observation.paidMoney },
      totalCredits: validateCreditFulfillmentPolicy(order.offer.fulfillmentData).credits, grantRecorded: !!fulfilled,
      ...(order.offer.mode === 'payment' ? { grantSource: 'purchase' as const, grantSourceId: order.id } : {}) }, fence);
  }
  async prepareCycle(bindingId: string, ownerId: string, payment: SubscriptionPaidPeriod | SubscriptionPaidReceipt, fence?: SubscriptionExecutionFence): Promise<void> {
    const binding = await this.database.model('billingSubscriptions').findUnique({ where: { id: bindingId } }) as BillingSubscription | null;
    if (!binding || binding.ownerId !== ownerId) throw new HostedCheckoutError('forbidden', 'Subscription refund preparation owner mismatch');
    if (!this.adapters.has(binding.providerId)) return;
    const cycles = await this.database.model('billingSubscriptionCycles').findMany({ where: { providerId: binding.providerId, accountScope: binding.accountScope, paymentId: payment.paymentId, paymentKind: payment.paymentKind }, take: 1 }) as SubscriptionCycleReceipt[];
    const cycle = cycles[0]; if (cycle && (cycle.ownerId !== ownerId || cycle.bindingId !== bindingId)) refundConflict('Payment already belongs to a different subscription');
    await this.observeLocal({ ownerId, orderId: binding.initialOrderId, cycleId: cycle?.id, providerId: binding.providerId, accountScope: binding.accountScope,
      title: binding.offer.description, reference: { paymentId: payment.paymentId, paymentKind: payment.paymentKind, paidMoney: payment.paidMoney },
      totalCredits: validateCreditFulfillmentPolicy(binding.offer.fulfillmentData).credits, grantRecorded: !!cycle,
      grantSource: 'subscription', grantSourceId: cycle?.id }, fence);
  }
  private async sourceLots(tx: ApplicationTransaction, target: RefundTargetRow): Promise<Lot[]> {
    if (!target.grantRecorded) return [];
    if (!target.grantSource || !target.grantSourceId) refundConflict('Granted payment has no credit provenance');
    const rows = await tx.model('creditLots').findMany({ where: { userId: target.ownerId, source: target.grantSource, sourceId: target.grantSourceId }, orderBy: { id: 'asc' } }) as Lot[];
    await this.ledger.expireInTransaction(tx, { accountId: target.ownerId, lotIds: rows.map(row => row.id), transactionData: { type: 'EXPIRE', description: 'Expired payment credits', metadata: { refundTargetId: target.id } } });
    return await tx.model('creditLots').findMany({ where: { userId: target.ownerId, source: target.grantSource, sourceId: target.grantSourceId }, orderBy: { id: 'asc' } }) as Lot[];
  }
  private journal(target: RefundTargetRow, refundId: string, type: string) { return { type, description: 'Payment refund credit adjustment', metadata: { refundId, source: target.grantSource, sourceId: target.grantSourceId } }; }
  private async recoverCredits(tx: ApplicationTransaction, target: RefundTargetRow): Promise<RefundTargetRow> {
    const deficit = targetCreditDeficit(target);
    if (!deficit) return target.attention ? updateRefundRow(tx, 'billing_refund_payments', target.id, { attention: false }) : target;
    if (!target.grantRecorded) return updateRefundRow(tx, 'billing_refund_payments', target.id, {
      suppressedCredits: target.suppressedCredits + deficit, recoveredCredits: target.recoveredCredits + deficit, attention: false });
    const lots = await this.sourceLots(tx, target);
    const expired = Math.min(deficit, Math.max(0, lots.filter(lot => lot.isExpired).reduce((sum, lot) => sum + lot.remainingAmount, 0) - target.expiredCredits));
    const required = deficit - expired;
    if (required) {
      // A pending request owns its hold. Do not steal it to cover a different uncorrelated refund.
      const allocations = await tx.query<{ amount: string }>(`SELECT COALESCE(SUM(allocation."activeAmount"),0)::text AS amount FROM credit_hold_allocations AS allocation
        JOIN credit_holds AS hold ON hold.id=allocation."holdId" WHERE hold."accountId"=$1 AND allocation."creditLotId"=ANY($2::text[])`, [target.ownerId, lots.map(lot => lot.id)]);
      const free = lots.filter(lot => !lot.isExpired).reduce((sum, lot) => sum + lot.remainingAmount, 0) - Number(allocations.rows[0].amount);
      const recoverable = Math.min(required, Math.max(0, free));
      if (!recoverable) return updateRefundRow(tx, 'billing_refund_payments', target.id, { expiredCredits: target.expiredCredits + expired,
        recoveredCredits: target.recoveredCredits + expired, attention: true });
      const holdId = hash(['refund-observed-credit', target.id, target.refundedMinor, target.recoveredCredits]);
      await this.ledger.hold(tx, { id: holdId, accountId: target.ownerId, amount: recoverable, lotIds: lots.filter(lot => !lot.isExpired).map(lot => lot.id),
        resourceType: 'refund-observation', resourceId: target.id, operationKey: `refund-observed-hold:${holdId}`, transactionData: this.journal(target, holdId, 'FREEZE') });
      const settled = await this.ledger.confirmHold(tx, { id: holdId, accountId: target.ownerId, operationKey: `refund-observed-confirm:${holdId}`,
        transactionData: this.journal(target, holdId, 'REFUND'), expiryTransactionData: this.journal(target, holdId, 'EXPIRE') });
      return updateRefundRow(tx, 'billing_refund_payments', target.id, { revokedCredits: target.revokedCredits + settled.hold.revokedAmount,
        expiredCredits: target.expiredCredits + expired + settled.hold.expiredAmount,
        recoveredCredits: target.recoveredCredits + expired + recoverable, attention: recoverable < required });
    }
    return updateRefundRow(tx, 'billing_refund_payments', target.id, { expiredCredits: target.expiredCredits + expired, recoveredCredits: target.recoveredCredits + expired, attention: false });
  }
  private async settleActive(tx: ApplicationTransaction, target: RefundTargetRow): Promise<RefundTargetRow> {
    if (!target.activeRequestId) return target;
    let row = await lockedRequest(tx, target.activeRequestId);
    if (row.targetId !== target.id || row.ownerId !== target.ownerId) refundConflict('Refund request ownership differs from its payment');
    const receipts = await tx.query<{ refundId: string; state: string; amountMinor: string | null }>(`SELECT "refundId",state,"amountMinor" FROM billing_refund_receipts
      WHERE "targetId"=$1 AND (("commandKey"=$2) OR ($3::text IS NOT NULL AND "refundId"=$3))`, [target.id, row.commandKey, row.providerRefundId]);
    if (receipts.rows.length > 1) {
      await updateRefundRow(tx, 'billing_refund_requests', row.id, { creditState: 'attention', shortfallCredits: targetCreditDeficit(target) });
      return updateRefundRow(tx, 'billing_refund_payments', target.id, { attention: true });
    }
    const receipt = receipts.rows[0];
    if (receipt) {
      if (receipt.amountMinor !== null && BigInt(receipt.amountMinor) !== BigInt(row.requestedMinor)) {
        await updateRefundRow(tx, 'billing_refund_requests', row.id, { creditState: 'attention' });
        return updateRefundRow(tx, 'billing_refund_payments', target.id, { attention: true });
      }
      if (!terminal.has(row.state) || receipt.state === 'succeeded') row = await updateRefundRow(tx, 'billing_refund_requests', row.id,
        { state: receipt.state, providerRefundId: receipt.refundId, confirmationBasis: receipt.state === 'succeeded' ? 'receipt' : null });
    }
    // A proven full return leaves no further money for an unidentified in-flight command to refund.
    // This confirms the target total, never fabricates an individual provider receipt.
    if (!terminal.has(row.state) && BigInt(target.refundedMinor) === BigInt(target.paidMinor)) {
      row = await updateRefundRow(tx, 'billing_refund_requests', row.id, { state: 'succeeded', confirmationBasis: 'payment_total' });
    }
    if (!terminal.has(row.state)) return target;
    const before = { revoked: target.revokedCredits, expired: target.expiredCredits, suppressed: target.suppressedCredits };
    let releasedExpired = 0;
    if (row.holdId) {
      const held = await tx.model('creditHolds').findUnique({ where: { id: row.holdId } }) as { amount: number; status: string } | null;
      if (!held) refundConflict('Refund credit hold was not found');
      const confirm = row.state === 'succeeded' && targetCreditDeficit(target) >= held.amount;
      const settled = await (confirm ? this.ledger.confirmHold(tx, { id: row.holdId, accountId: row.ownerId, operationKey: `refund-confirm:${row.id}`,
        transactionData: this.journal(target, row.id, 'REFUND'), expiryTransactionData: this.journal(target, row.id, 'EXPIRE') })
        : this.ledger.releaseHold(tx, { id: row.holdId, accountId: row.ownerId, operationKey: `refund-release:${row.id}`,
          transactionData: this.journal(target, row.id, 'UNFREEZE'), expiryTransactionData: this.journal(target, row.id, 'EXPIRE') }));
      if (!confirm) releasedExpired = settled.hold.expiredAmount;
      if (confirm) target = await updateRefundRow(tx, 'billing_refund_payments', target.id, {
        revokedCredits: target.revokedCredits + settled.hold.revokedAmount, expiredCredits: target.expiredCredits + settled.hold.expiredAmount,
        recoveredCredits: target.recoveredCredits + settled.hold.revokedAmount + settled.hold.expiredAmount });
    }
    target = await updateRefundRow(tx, 'billing_refund_payments', target.id, { activeRequestId: null });
    target = await this.recoverCredits(tx, target);
    await updateRefundRow(tx, 'billing_refund_requests', row.id, { creditState: target.attention ? 'attention' : row.state === 'succeeded' ? (!target.grantRecorded ? 'suppressed' : 'settled') : 'released',
      revokedCredits: Math.max(0, target.revokedCredits - before.revoked), expiredCredits: Math.max(row.expiredCredits, releasedExpired, target.expiredCredits - before.expired),
      suppressedCredits: Math.max(0, target.suppressedCredits - before.suppressed), shortfallCredits: targetCreditDeficit(target), checkedAt: new Date() });
    await tx.model('billingOutbox').create({ data: { kind: 'billing.refund-settled', aggregateId: row.id,
      payload: { refundId: row.id, ownerId: row.ownerId, cashState: row.state, creditState: target.attention ? 'attention' : 'settled' } } });
    // A previously blocked subscription grant may now continue with the refund-aware allowance.
    await tx.model('billingSubscriptions').updateMany({ where: { initialOrderId: target.orderId }, data: {
      reconcileStatus: 'pending', reconcileErrorCode: null, lastReconcileTaskId: null, nextReconcileAt: new Date(), revision: { increment: 1 } } });
    return target;
  }
  private async targetSnapshot(id: string): Promise<RefundTargetRow> {
    const result = await this.database.transaction(tx => tx.query<RefundTargetRow>('SELECT * FROM billing_refund_payments WHERE id=$1', [id]));
    if (!result.rows[0]) throw new HostedCheckoutError('not_found', 'Refund payment was not found'); return result.rows[0];
  }
  private async requestSnapshot(id: string): Promise<RefundRequestRow> {
    const result = await this.database.transaction(tx => tx.query<RefundRequestRow>('SELECT * FROM billing_refund_requests WHERE id=$1', [id]));
    if (!result.rows[0]) throw new HostedCheckoutError('not_found', 'Refund request was not found'); return result.rows[0];
  }
  async create(actorId: string, key: string | undefined, body: unknown) {
    const id = commandId(actorId, key);
    const input = bodyRecord(body, ['targetType', 'targetId', 'amount', 'reason']);
    if (input.targetType !== 'order' && input.targetType !== 'cycle' || typeof input.targetId !== 'string' || !input.targetId || typeof input.amount !== 'string'
      || input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 255 || /[\u0000-\u001f\u007f]/.test(input.reason))) throw new BadRequestException('Invalid refund selection');
    const local = await this.local(input.targetType, input.targetId), adapter = this.adapter(local.providerId, local.accountScope);
    const amount = minorAmount(input.amount, local.reference.paidMoney.currency, paymentScale(local.reference)), reason = typeof input.reason === 'string' ? input.reason.trim() : null;
    if (amount <= 0n) throw new BadRequestException('Refund amount must be positive');
    const prior = await this.database.transaction(tx => tx.query<RefundRequestRow>('SELECT * FROM billing_refund_requests WHERE id=$1', [id]));
    if (prior.rows[0]) {
      const row = prior.rows[0], target = await this.targetSnapshot(row.targetId);
      if (target.orderId !== local.orderId || target.cycleId !== (local.cycleId ?? null) || BigInt(row.requestedMinor) !== amount || row.reason !== reason) refundConflict('Refund key was reused with different content');
      if (row.state === 'prepared') await this.dispatch(id); return this.get(id);
    }
    const prepared = await this.observeLocal(local);
    await this.transaction(local.ownerId, async tx => {
      const replay = await tx.query<RefundRequestRow>('SELECT * FROM billing_refund_requests WHERE id=$1', [id]);
      if (replay.rows[0]) { if (replay.rows[0].targetId !== prepared.id || BigInt(replay.rows[0].requestedMinor) !== amount || replay.rows[0].reason !== reason) refundConflict('Refund key changed'); return; }
      const target = await lockedTarget(tx, prepared.id), remaining = BigInt(target.paidMinor) - BigInt(target.refundedMinor);
      if (target.activeRequestId || target.attention || BigInt(target.providerPendingMinor ?? '0') > 0n) refundConflict('Existing refund evidence must be reconciled first');
      const pending = await tx.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM billing_refund_receipts WHERE "targetId"=$1 AND state IN ('pending','requires_action','unknown')`, [target.id]);
      if (pending.rows[0].count) refundConflict('Provider has unresolved refunds for this payment');
      if (amount > remaining || !adapter.capabilities.partial && amount !== remaining) throw new HostedCheckoutError('invalid_input', 'Refund amount exceeds the available amount or channel capability');
      const expected = BigInt(target.refundedMinor) + amount, creditAmount = requiredCredits(target.totalCredits, expected, target.paidMinor) - target.recoveredCredits;
      let holdId: string | null = null, expired = 0, suppressed = 0;
      if (!target.grantRecorded) suppressed = creditAmount;
      else {
        const lots = await this.sourceLots(tx, target);
        expired = Math.min(creditAmount, Math.max(0, lots.filter(lot => lot.isExpired).reduce((sum, lot) => sum + lot.remainingAmount, 0) - target.expiredCredits));
        const holdAmount = creditAmount - expired;
        if (holdAmount) {
          holdId = hash(['refund-credit-hold', id]);
          await this.ledger.hold(tx, { id: holdId, accountId: target.ownerId, amount: holdAmount, lotIds: lots.filter(lot => !lot.isExpired).map(lot => lot.id),
            resourceType: 'refund-request', resourceId: id, operationKey: `refund-hold:${id}`, transactionData: this.journal(target, id, 'FREEZE') });
        }
      }
      const money = minorMoney(amount, target.paidMoney.currency, target.minorScale);
      await tx.query(`INSERT INTO billing_refund_requests(id,"targetId","ownerId","actorId","clientKey","commandKey","requestedMinor","beforeRefundedMinor","expectedRefundedMinor",money,reason,"creditAmount","holdId","expiredCredits","suppressedCredits")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)`,
      [id, target.id, target.ownerId, actorId, key, `rf_${id}`, amount.toString(), target.refundedMinor, expected.toString(), JSON.stringify(money), reason, creditAmount, holdId, expired, suppressed]);
      await updateRefundRow(tx, 'billing_refund_payments', target.id, { activeRequestId: id });
      await tx.model('billingOutbox').create({ data: { kind: 'billing.refund-reconcile', aggregateId: id, payload: { refundId: id, ownerId: target.ownerId } } });
    });
    await this.dispatch(id); return this.get(id);
  }
  private async dispatch(id: string): Promise<void> {
    const snapshot = await this.requestSnapshot(id), target = await this.targetSnapshot(snapshot.targetId), adapter = this.adapter(target.providerId, target.accountScope);
    const claimed = await this.transaction(snapshot.ownerId, async tx => {
      await lockedTarget(tx, target.id); const row = await lockedRequest(tx, id);
      if (row.state !== 'prepared') return false;
      await updateRefundRow(tx, 'billing_refund_requests', id, { state: 'submitting' }); return true;
    });
    if (!claimed) return;
    let observation: RefundObservation;
    try {
      observation = await adapter.create({ payment: this.reference(target), money: snapshot.money, commandKey: snapshot.commandKey, ...(snapshot.reason ? { reason: snapshot.reason } : {}) });
    } catch (error) {
      await this.transaction(snapshot.ownerId, async tx => {
        await lockedTarget(tx, target.id); const request = await lockedRequest(tx, id);
        if (terminal.has(request.state)) return;
        await updateRefundRow(tx, 'billing_refund_requests', id, { state: error instanceof RefundProtocolError && error.outcome === 'rejected' ? 'failed' : 'unknown', checkedAt: new Date() });
      });
      try {
        await this.transaction(snapshot.ownerId, async tx => { await mergeRefundCash(tx, await lockedTarget(tx, target.id)); });
        await this.transaction(snapshot.ownerId, async tx => {
          let current = await lockedTarget(tx, target.id); current = await this.settleActive(tx, current); await this.recoverCredits(tx, current);
        });
      } catch (settlementError) { await this.markCreditAttention(snapshot); throw settlementError; }
      if (error instanceof RefundProtocolError && error.outcome === 'rejected') return;
      throw new RefundProtocolError('transport_error', 'Refund submission result is unknown; check the existing request');
    }
    await this.applyObservation(id, observation);
  }
  private async markTargetAttention(ownerId: string, targetId: string, fence?: SubscriptionExecutionFence): Promise<void> {
    await this.transaction(ownerId, async tx => {
      const target = await lockedTarget(tx, targetId); await updateRefundRow(tx, 'billing_refund_payments', target.id, { attention: true });
      if (target.activeRequestId) { await lockedRequest(tx, target.activeRequestId); await updateRefundRow(tx, 'billing_refund_requests', target.activeRequestId, { creditState: 'attention' }); }
    }, fence);
  }
  private async markCreditAttention(snapshot: RefundRequestRow, fence?: SubscriptionExecutionFence): Promise<void> {
    await this.transaction(snapshot.ownerId, async tx => {
      const target = await lockedTarget(tx, snapshot.targetId); await lockedRequest(tx, snapshot.id);
      await updateRefundRow(tx, 'billing_refund_requests', snapshot.id, { creditState: 'attention' });
      await updateRefundRow(tx, 'billing_refund_payments', target.id, { attention: true });
    }, fence);
  }
  private async applyObservation(id: string, input: RefundObservation, fence?: SubscriptionExecutionFence): Promise<void> {
    const observation = structuredClone(input), snapshot = await this.requestSnapshot(id);
    if (observation.state === 'succeeded' && (!observation.refundId || !observation.money)) observation.state = 'unknown';
    // Preserve an authenticated response before applying financial receipts/credit effects. A ledger failure
    // cannot erase the provider refund ID needed to recover a response that already moved real money.
    await this.transaction(snapshot.ownerId, async tx => {
      const target = await lockedTarget(tx, snapshot.targetId), row = await lockedRequest(tx, id);
      if (observation.paymentId !== target.paymentId || observation.paymentKind !== target.paymentKind
        || observation.source.kind !== target.sourceKind || observation.source.id !== target.sourceId
        || observation.commandKey && observation.commandKey !== row.commandKey) refundConflict('Refund command evidence differs from its request');
      if (observation.money && (observation.money.currency !== target.paidMoney.currency
        || minorAmount(observation.money.amount, observation.money.currency, target.minorScale) !== BigInt(row.requestedMinor))) refundConflict('Refund receipt amount differs from the request');
      if (observation.refundId) {
        const eventId = `command:${id}:${hash([observation.refundId, observation.state, observation.money, observation.totalRefundedMoney, observation.occurredAt])}`;
        const evidence: RefundWebhookEvent = { eventId, refundId: observation.refundId, source: observation.source, state: observation.state,
          money: observation.money, totalRefundedMoney: observation.totalRefundedMoney, commandKey: row.commandKey, occurredAt: observation.occurredAt };
        await tx.query(`INSERT INTO billing_refund_events("providerId","accountScope","eventId","sourceKind","sourceId","refundId","commandKey",evidence,"targetId")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`,
        [target.providerId, target.accountScope, eventId, target.sourceKind, target.sourceId, observation.refundId, row.commandKey, JSON.stringify(evidence), target.id]);
      }
      if (!terminal.has(row.state) || observation.state === 'succeeded') await updateRefundRow(tx, 'billing_refund_requests', id,
        { state: observation.state, providerRefundId: observation.refundId ?? row.providerRefundId, checkedAt: new Date(),
          confirmationBasis: observation.state === 'succeeded' && observation.refundId ? 'receipt' : null });
    }, fence);
    try {
      await this.transaction(snapshot.ownerId, async tx => {
        const target = await lockedTarget(tx, snapshot.targetId);
        await recordRefundEvidence(tx, target, observation);
        await mergeRefundCash(tx, target);
      }, fence);
      await this.transaction(snapshot.ownerId, async tx => {
        let target = await lockedTarget(tx, snapshot.targetId); target = await this.settleActive(tx, target); target = await this.recoverCredits(tx, target);
        if (target.attention) await updateRefundRow(tx, 'billing_refund_requests', id, { creditState: 'attention', shortfallCredits: targetCreditDeficit(target) });
      }, fence);
    } catch (error) {
      await this.markCreditAttention(snapshot, fence);
      throw error;
    }
  }
  /** Provider reads only: this method never calls adapter.create, including prepared/unknown requests. */
  async reconcile(id: string, fence?: SubscriptionExecutionFence) {
    const row = await this.requestSnapshot(id), target = await this.targetSnapshot(row.targetId), adapter = this.adapter(target.providerId, target.accountScope);
    if (row.providerRefundId && adapter.retrieve) await this.applyObservation(id, await adapter.retrieve(row.providerRefundId, this.reference(target)), fence);
    const { facts, observations } = await this.providerFacts(adapter, this.reference(target));
    await this.transaction(row.ownerId, async tx => {
      const current = await lockedTarget(tx, target.id);
      for (const observation of observations) await recordRefundEvidence(tx, current, observation);
      await mergeRefundCash(tx, current, facts);
    }, fence);
    try {
      await this.transaction(row.ownerId, async tx => {
        let current = await lockedTarget(tx, target.id); current = await this.settleActive(tx, current); current = await this.recoverCredits(tx, current);
        const request = await lockedRequest(tx, id);
        const patch: Record<string, unknown> = { checkedAt: new Date(), reconcileStatus: 'idle', reconcileErrorCode: null, lastReconcileTaskId: null };
        if (terminal.has(request.state) && current.attention) { patch.creditState = 'attention'; patch.shortfallCredits = targetCreditDeficit(current); }
        await updateRefundRow(tx, 'billing_refund_requests', id, patch);
      }, fence);
    } catch (error) { await this.markCreditAttention(row, fence); throw error; }
    return this.get(id);
  }
  async checkTarget(type: RefundTargetType, id: string, fence?: SubscriptionExecutionFence) {
    const local = await this.local(type, id); await this.observeLocal(local, fence); return this.getTarget(type, id);
  }
  async handleWebhook(providerId: string, request: WebhookRequest): Promise<boolean> {
    const adapter = this.adapters.get(providerId); if (!adapter) return false;
    const event = await adapter.verifyWebhook(request); if (!event) return false;
    const findTarget = async (tx: ApplicationTransaction): Promise<RefundTargetRow | undefined> => (await tx.query<RefundTargetRow>(`SELECT * FROM billing_refund_payments
      WHERE "providerId"=$1 AND "accountScope"=$2 AND "sourceKind"=$3 AND "sourceId"=$4`, [adapter.id, adapter.accountScope, event.source.kind, event.source.id])).rows[0];
    const journal = async (tx: ApplicationTransaction, targetId?: string) => {
      const created = await tx.query<{ eventId: string }>(`INSERT INTO billing_refund_events("providerId","accountScope","eventId","sourceKind","sourceId","refundId","commandKey",evidence,"targetId")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING RETURNING "eventId"`,
      [adapter.id, adapter.accountScope, event.eventId, event.source.kind, event.source.id, event.refundId ?? null, event.commandKey ?? null, JSON.stringify(event), targetId ?? null]);
      const saved = await tx.query<{ evidence: RefundWebhookEvent }>(`SELECT evidence FROM billing_refund_events WHERE "providerId"=$1 AND "accountScope"=$2 AND "eventId"=$3`, [adapter.id, adapter.accountScope, event.eventId]);
      if (!created.rows.length && (!saved.rows[0]?.evidence || !sameEvidence(saved.rows[0].evidence, event))) refundConflict('Verified refund event identity changed');
    };
    let existing = await this.database.transaction(findTarget);
    if (!existing) {
      // Do not acquire an account lock while holding this source-only lock. If ownership appeared,
      // release the source and retry below in the shared account -> source order.
      existing = await this.database.transaction(async tx => {
        await lockRefundSource(tx, adapter.id, adapter.accountScope, event.source.kind, event.source.id);
        const known = await findTarget(tx); if (known) return known;
        await journal(tx); return undefined;
      });
    }
    if (!existing) return true;
    const matched = existing;
    // This is the successful proof's serialization point against normal source-lot consumption.
    await this.transaction(matched.ownerId, async tx => {
      await lockRefundSource(tx, adapter.id, adapter.accountScope, event.source.kind, event.source.id);
      await journal(tx, matched.id);
    });
    try {
      await this.transaction(matched.ownerId, async tx => { await mergeRefundCash(tx, await lockedTarget(tx, matched.id)); });
      await this.transaction(matched.ownerId, async tx => {
        let target = await lockedTarget(tx, matched.id); target = await this.settleActive(tx, target); await this.recoverCredits(tx, target);
      });
    } catch (error) { await this.markTargetAttention(matched.ownerId, matched.id); throw error; }
    return true;
  }
  private async view(row: RefundRequestRow, target: RefundTargetRow) {
    let held = 0;
    if (row.holdId) { const result = await this.database.transaction(tx => tx.query<{ amount: string }>('SELECT COALESCE(SUM("activeAmount"),0)::text AS amount FROM credit_hold_allocations WHERE "holdId"=$1', [row.holdId])); held = Number(result.rows[0].amount); }
    return { id: row.id, targetType: target.cycleId ? 'cycle' as const : 'order' as const, targetId: target.cycleId ?? target.orderId,
      ownerId: row.ownerId, orderId: target.orderId, cycleId: target.cycleId, title: target.title, money: row.money, reason: row.reason,
      state: row.creditState === 'attention' || row.reconcileStatus === 'attention' ? 'attention'
        : row.state === 'succeeded' && row.creditState === 'held' ? 'pending' : row.state,
      cashState: row.state, creditState: row.creditState, reconcileStatus: row.reconcileStatus,
      creditImpact: { held, revoked: row.revokedCredits, expired: row.expiredCredits, suppressed: row.suppressedCredits, shortfall: row.shortfallCredits },
      confirmationBasis: row.confirmationBasis, createdAt: row.createdAt, updatedAt: row.updatedAt, canCheck: !!this.adapters.get(target.providerId) };
  }
  async getByClientKey(actorId: string, key: string) { return this.get(commandId(actorId, key)); }
  async get(id: string) { const row = await this.requestSnapshot(id); return this.view(row, await this.targetSnapshot(row.targetId)); }
  async list(pageValue?: string, state?: string) {
    const page = pageNumber(pageValue); if (state && !['prepared', 'submitting', 'pending', 'requires_action', 'unknown', 'succeeded', 'failed', 'canceled', 'attention'].includes(state)) throw new BadRequestException('Invalid refund state');
    const rows = await this.database.transaction(async tx => {
      const where = `($1::text IS NULL OR CASE WHEN "creditState"='attention' OR "reconcileStatus"='attention' THEN 'attention' ELSE state END=$1)`;
      const data = await tx.query<RefundRequestRow>(`SELECT * FROM billing_refund_requests WHERE ${where} ORDER BY "createdAt" DESC,id LIMIT 20 OFFSET $2`, [state ?? null, (page - 1) * 20]);
      const count = await tx.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM billing_refund_requests WHERE ${where}`, [state ?? null]); return { data: data.rows, total: count.rows[0].count };
    });
    const data = await Promise.all(rows.data.map(async row => this.view(row, await this.targetSnapshot(row.targetId)))); return { data, total: rows.total, page, pageSize: 20 };
  }
  async getTarget(type: RefundTargetType, id: string) {
    const local = await this.local(type, id), adapter = this.adapter(local.providerId, local.accountScope);
    const found = await this.database.transaction(tx => tx.query<RefundTargetRow>(`SELECT payment.* FROM billing_refund_payments AS payment JOIN billing_refund_aliases AS alias ON alias."targetId"=payment.id
      WHERE alias."providerId"=$1 AND alias."accountScope"=$2 AND alias."paymentKind"=$3 AND alias."paymentId"=$4`, [local.providerId, local.accountScope, local.reference.paymentKind, local.reference.paymentId]));
    const row = found.rows[0], scale = row?.minorScale ?? paymentScale(local.reference), paid = row ? BigInt(row.paidMinor) : minorAmount(local.reference.paidMoney.amount, local.reference.paidMoney.currency, scale);
    const active = row?.activeRequestId ? await this.requestSnapshot(row.activeRequestId) : null;
    let pending = active && !terminal.has(active.state) ? BigInt(active.requestedMinor) : 0n, unresolved = false, cashEvidencePending = false;
    if (row) {
      const evidence = await this.database.transaction(async tx => {
        const receipts = await tx.query<{ amountMinor: string | null; commandKey: string | null; refundId: string }>(`SELECT "amountMinor","commandKey","refundId" FROM billing_refund_receipts
          WHERE "targetId"=$1 AND state IN ('pending','requires_action','unknown')`, [row.id]);
        const events = await tx.query<{ count: number; successful: number }>(`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE evidence->>'state'='succeeded')::int AS successful FROM billing_refund_events WHERE "providerId"=$1 AND "accountScope"=$2
          AND "sourceKind"=$3 AND "sourceId"=$4 AND status<>'processed' AND evidence->>'state' IN ('pending','requires_action','unknown','succeeded')`, [row.providerId, row.accountScope, row.sourceKind, row.sourceId]);
        return { receipts: receipts.rows, events: events.rows[0].count, successful: events.rows[0].successful };
      });
      cashEvidencePending = evidence.successful > 0;
      let own = 0n, external = 0n;
      for (const receipt of evidence.receipts) {
        unresolved = true;
        const amount = BigInt(receipt.amountMinor ?? '0');
        if (active && (receipt.commandKey === active.commandKey || receipt.refundId === active.providerRefundId)) own += amount; else external += amount;
      }
      pending = (pending > own ? pending : own) + external;
      const reported = BigInt(row.providerPendingMinor ?? '0'); if (reported > pending) pending = reported;
      unresolved ||= evidence.events > 0 || reported > 0n;
    }
    const refunded = BigInt(row?.refundedMinor ?? '0'), remaining = paid - refunded - pending;
    return { targetType: type, targetId: id, ownerId: local.ownerId, orderId: local.orderId, cycleId: local.cycleId ?? null, title: local.title,
      paidMoney: local.reference.paidMoney, refundedMoney: minorMoney(refunded, local.reference.paidMoney.currency, scale), pendingMoney: minorMoney(pending, local.reference.paidMoney.currency, scale),
      remainingMoney: minorMoney(remaining > 0n ? remaining : 0n, local.reference.paidMoney.currency, scale), totalCredits: local.totalCredits, recoveredCredits: row?.recoveredCredits ?? 0,
      activeRequestId: row?.activeRequestId ?? null, attention: !!row?.attention || cashEvidencePending, cashEvidencePending,
      capabilities: { partial: adapter.capabilities.partial, canCreate: remaining > 0n && !active && !row?.attention && !unresolved, canCheck: true } };
  }
  async cycles(bindingId: string, pageValue?: string) {
    const binding = await this.database.model('billingSubscriptions').findUnique({ where: { id: bindingId } });
    if (!binding) throw new HostedCheckoutError('not_found', 'Subscription was not found');
    const page = pageNumber(pageValue), where = { bindingId };
    const [rows, total] = await Promise.all([this.database.model('billingSubscriptionCycles').findMany({ where, orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20 }), this.database.model('billingSubscriptionCycles').count({ where })]);
    return { data: (rows as SubscriptionCycleReceipt[]).map(row => ({ id: row.id, paidMoney: row.paidMoney, paidAt: row.paidAt,
      period: row.periodStart && row.periodEnd ? { start: row.periodStart, end: row.periodEnd } : null, initial: row.initial })), total, page, pageSize: 20 };
  }
  async due(limit = 25): Promise<Array<{ id: string; ownerId: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid refund scan limit');
    const result = await this.database.transaction(tx => tx.query<{ id: string; ownerId: string }>(`SELECT id,"ownerId" FROM billing_refund_requests
      WHERE state IN ('submitting','pending','requires_action','unknown') AND "creditState"<>'attention' AND "reconcileStatus"<>'attention'
      AND COALESCE("checkedAt","updatedAt")<CURRENT_TIMESTAMP-interval '15 minutes' ORDER BY "updatedAt",id LIMIT $1`, [limit])); return result.rows;
  }
  async events(pageValue?: string) {
    const page = pageNumber(pageValue);
    const result = await this.database.transaction(async tx => {
      const rows = await tx.query<{ providerId: string; accountScope: string; eventId: string; evidence: RefundWebhookEvent; status: string; createdAt: Date; targetId: string | null }>(
        `SELECT event.* FROM billing_refund_events AS event LEFT JOIN billing_refund_payments AS payment ON payment.id=event."targetId"
          WHERE event.status<>'processed' OR payment.attention=true ORDER BY event."createdAt" DESC,event."eventId" LIMIT 20 OFFSET $1`, [(page - 1) * 20]);
      const count = await tx.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM billing_refund_events AS event LEFT JOIN billing_refund_payments AS payment ON payment.id=event."targetId"
          WHERE event.status<>'processed' OR payment.attention=true`); return { rows: rows.rows, total: count.rows[0].count };
    });
    return { data: result.rows.map(row => ({ id: hash(['refund-event', row.providerId, row.accountScope, row.eventId]), providerId: row.providerId,
      state: row.evidence.state, money: row.evidence.money, totalRefundedMoney: row.evidence.totalRefundedMoney,
      status: row.status, matched: !!row.targetId, receivedAt: row.createdAt })), total: result.total, page, pageSize: 20 };
  }
}
