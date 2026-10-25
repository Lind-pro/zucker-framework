import type { Money } from '../contract/payment-contract';
import { record, text } from '../hosted-checkout/validation';
import { CreemProtocolError, type CreemCheckoutAdapter } from '../providers/creem';
import { isoDate } from '../subscriptions/validation';
import { RefundProtocolError, type RefundAdapter, type RefundPaymentReference, type RefundState } from './types';
import { compareMoney, identity, sameIdentity, sameMoney, subtractMoney, validateCommand, validatePayment } from './validation';

export interface CreemRefundOptions {
  transport: Pick<CreemCheckoutAdapter, 'retrieveTransaction' | 'refundTransaction' | 'parseWebhook'>;
  accountScope: string;
}
const kinds = ['transaction'] as const;
function state(value: unknown): RefundState {
  if (value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'canceled') return value;
  if (value === 'requiresAction' || value === 'requires_action') return 'requires_action'; return 'unknown';
}
function cents(amount: unknown, currency: unknown): Money | undefined {
  if (amount == null || currency == null) return undefined;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RefundProtocolError('invalid_response', 'Creem returned invalid refund cents');
  const digits = String(amount).padStart(3, '0'); return { amount: `${digits.slice(0, -2)}.${digits.slice(-2)}`, currency };
}
async function call<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof RefundProtocolError) throw error;
    throw new RefundProtocolError('transport_error', 'Creem refund request failed; reconcile before another mutation', error instanceof CreemProtocolError ? error.outcome : 'unknown');
  }
}
export function createCreemRefundAdapter(options: CreemRefundOptions): RefundAdapter {
  identity(options.accountScope);
  const retrievePayment = async (payment: RefundPaymentReference) => {
    payment = structuredClone(payment);
    validatePayment(payment, kinds);
    const transaction = await call(() => options.transport.retrieveTransaction(payment.paymentId)); sameIdentity(transaction.id, payment.paymentId);
    if (!transaction.money) throw new RefundProtocolError('invalid_response', 'Creem transaction has no actual paid money');
    sameMoney(transaction.money, payment.paidMoney);
    const refunded = transaction.refundedMoney ?? (transaction.state === 'captured' ? { amount: '0', currency: transaction.money.currency } : undefined);
    if (refunded && compareMoney(refunded, payment.paidMoney) > 0) throw new RefundProtocolError('invalid_response', 'Creem refunded amount exceeds payment');
    return { ...structuredClone(payment), source: { kind: 'transaction' as const, id: payment.paymentId },
      settlement: transaction.state === 'captured' ? 'paid' as const : transaction.state === 'refunded' ? 'refunded' as const
        : transaction.state === 'partially_refunded' ? 'partially_refunded' as const : 'unknown' as const,
      refundedMoney: refunded };
  };
  return { id: 'creem', accountScope: options.accountScope,
    capabilities: { paymentKinds: kinds, partial: false, requestIdempotency: 'none', retrieveRefund: false, listRefunds: false },
    retrievePayment,
    async create(command) {
      command = structuredClone(command);
      validateCommand(command, kinds);
      const payment = await retrievePayment(command.payment);
      if (payment.settlement !== 'paid' && payment.settlement !== 'partially_refunded') throw new RefundProtocolError('verification_failed', 'Creem transaction is not refundable', 'rejected');
      if (!payment.refundedMoney) throw new RefundProtocolError('invalid_response', 'Creem remaining refundable amount is unknown', 'rejected');
      if (compareMoney(command.money, subtractMoney(payment.paidMoney, payment.refundedMoney)) !== 0) throw new RefundProtocolError('unsupported', 'Creem supports only the full remaining refundable amount', 'rejected');
      const result = await call(() => options.transport.refundTransaction(command.payment.paymentId)); sameIdentity(result.transactionId, command.payment.paymentId);
      const raw = result.raw, transaction = text(raw.transaction) ?? text(record(raw.transaction)?.id);
      if (transaction) sameIdentity(transaction, command.payment.paymentId);
      const refundId = text(raw.id), actual = cents(raw.refund_amount, raw.refund_currency);
      if (actual) sameMoney(actual, command.money);
      const observed = state(result.status);
      return { refundId, paymentId: command.payment.paymentId, paymentKind: command.payment.paymentKind, source: payment.source,
        state: observed === 'succeeded' && (!refundId || !actual) ? 'unknown' : observed,
        providerStatus: text(raw.status) ?? 'unknown', money: actual,
        totalRefundedMoney: cents(record(raw.transaction)?.refunded_amount, record(raw.transaction)?.currency),
        occurredAt: typeof raw.created_at === 'number' && Number.isFinite(new Date(raw.created_at).getTime()) ? new Date(raw.created_at).toISOString() : isoDate(raw.created_at) };
    },
    async verifyWebhook(request) {
      let event: ReturnType<CreemCheckoutAdapter['parseWebhook']>;
      try { event = options.transport.parseWebhook(request); }
      catch { throw new RefundProtocolError('verification_failed', 'Creem refund webhook verification failed'); }
      if (!event.refund) return null;
      const refund = event.refund, observed = state(refund.status);
      return { eventId: identity(event.eventId), refundId: identity(refund.id), source: { kind: 'transaction', id: identity(refund.transactionId) },
        state: observed === 'succeeded' && (!refund.money || compareMoney(refund.money, { amount: '0', currency: refund.money.currency }) === 0) ? 'unknown' : observed, money: refund.money,
        totalRefundedMoney: event.transaction?.refundedMoney, occurredAt: event.occurredAt };
    },
  };
}
