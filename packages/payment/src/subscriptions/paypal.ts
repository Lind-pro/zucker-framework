import type { SubscriptionPeriod, SubscriptionStatus } from '../contract/subscription-observation';
import { record, text } from '../hosted-checkout/validation';
import type { PayPalPaymentTransport, PayPalSubscriptionTransaction } from '../providers/paypal';
import { SubscriptionProtocolError, type SubscriptionAdapter, type SubscriptionDetails, type SubscriptionPaidPeriodPage, type SubscriptionPaidReceiptPage } from './types';
import { assertPeriod, decodeCursor, encodeCursor, isoDate, requiredId, sameId, validMoney } from './validation';

/** A merchant's durable assignment, not a guessed timestamp-to-frequency calculation. */
export interface PayPalSubscriptionPeriodReceipt {
  accountScope: string;
  subscriptionId: string;
  catalogReference: string;
  paymentId: string;
  period: SubscriptionPeriod;
}
export interface PayPalSubscriptionOptions {
  transport: Pick<PayPalPaymentTransport, 'getSubscription' | 'listSubscriptionTransactions' | 'cancelSubscription' | 'verifyWebhookSignature'>;
  accountScope: string;
  webhookId?: string;
  now?: () => Date;
  /** Resolve by the exact settled transaction ID using durable merchant billing evidence.
   * PayPal v1 transactions have no period/cycle number; current plan/cycle counts cannot prove historical assignment.
   * Return null when a receipt is missing. Never assign a cycle by payment time or by transaction sort order.
   */
  resolvePeriodReceipt?(input: { accountScope: string; subscription: Readonly<Record<string, unknown>>;
    transaction: Readonly<PayPalSubscriptionTransaction> }): Promise<PayPalSubscriptionPeriodReceipt | null>;
}

export function observePayPalSubscription(raw: Record<string, unknown>): SubscriptionDetails {
  const providerStatus = text(raw.status) ?? 'UNKNOWN';
  const statuses: Record<string, SubscriptionStatus> = { ACTIVE: 'active', SUSPENDED: 'paused', CANCELLED: 'canceled', EXPIRED: 'canceled' };
  return { provider: 'paypal', subscriptionId: requiredId(raw.id), catalogReference: text(raw.plan_id),
    productId: text(record(raw.plan)?.product_id), customerId: text(record(raw.subscriber)?.payer_id),
    status: statuses[providerStatus] ?? 'unknown', providerStatus,
    // last_payment.time is a processing timestamp, not a billing-period boundary or transaction identity.
    payment: { settlement: 'unknown' } };
}

export function payPalTransactionMoney(transaction: PayPalSubscriptionTransaction) {
  const money = transaction.amount_with_breakdown?.gross_amount;
  return money?.value && money.currency_code ? validMoney({ amount: money.value, currency: money.currency_code }) : undefined;
}

export async function verifyPayPalSubscriptionEvent(options: Pick<PayPalSubscriptionOptions, 'transport' | 'webhookId'>,
  request: Parameters<NonNullable<SubscriptionAdapter['verifyWebhook']>>[0]) {
  if (!options.webhookId) throw new SubscriptionProtocolError('invalid_input', 'PayPal webhook ID is required');
  const body = typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody).toString('utf8');
  const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!await options.transport.verifyWebhookSignature(body, headers, options.webhookId)) throw new SubscriptionProtocolError('verification_failed', 'PayPal webhook verification failed');
  const event = record(JSON.parse(body)), resource = record(event?.resource);
  const eventId = requiredId(event?.id), type = text(event?.event_type);
  const subscriptionId = type?.startsWith('BILLING.SUBSCRIPTION.') ? text(resource?.id)
    : type?.startsWith('PAYMENT.SALE.') ? text(resource?.billing_agreement_id) : undefined;
  return subscriptionId ? { eventId, subscriptionId } : null;
}

export function createPayPalSubscriptionAdapter(options: PayPalSubscriptionOptions): SubscriptionAdapter {
  requiredId(options.accountScope);
  const get = async (id: string) => {
    const raw = await options.transport.getSubscription(requiredId(id)); sameId(raw.id, id); return raw;
  };
  const readPage = async (id: string, input: { cursor?: string } = {}) => {
      const subscription = await get(id);
      const catalogReference = text(subscription.plan_id);
      if (!catalogReference) throw new SubscriptionProtocolError('invalid_response', 'PayPal plan identity is missing');
      const createdAt = isoDate(subscription.create_time);
      if (!createdAt) throw new SubscriptionProtocolError('invalid_response', 'PayPal subscription creation time is missing');
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      if (cursor && (cursor.provider !== 'paypal' || cursor.accountScope !== options.accountScope || cursor.subscriptionId !== id || cursor.planId !== catalogReference)) {
        throw new SubscriptionProtocolError('invalid_input', 'PayPal cursor identity mismatch');
      }
      const start = cursor ? isoDate(cursor.start) : createdAt;
      const until = cursor ? isoDate(cursor.until) : (options.now?.() ?? new Date()).toISOString();
      if (!start || !until || start < createdAt || start > until) throw new SubscriptionProtocolError('invalid_input', 'Invalid PayPal transaction window cursor');
      if (start === until) return { subscription, transactions: [] as PayPalSubscriptionTransaction[], result: { data: [] } as SubscriptionPaidReceiptPage };
      const end = new Date(Math.min(Date.parse(until), Date.parse(start) + 31 * 86400000)).toISOString();
      const page = await options.transport.listSubscriptionTransactions(id, { startTime: start, endTime: end,
        ...(cursor?.next ? { cursor: requiredId(cursor.next) } : {}) });
      const result: SubscriptionPaidReceiptPage = { data: [], issues: [] };
      for (const transaction of page.transactions) {
        if (transaction.status !== 'COMPLETED') continue;
        const paidAt = isoDate(transaction.time), paidMoney = payPalTransactionMoney(transaction);
        if (!paidAt || paidAt < start || paidAt > end) throw new SubscriptionProtocolError('invalid_response', 'PayPal transaction time is outside the requested window');
        if (!paidMoney) { result.issues?.push({ recordId: transaction.id, code: 'missing_money' }); continue; }
        result.data.push({ recordId: transaction.id, subscriptionId: id, catalogReference,
          paidMoney, paymentId: transaction.id, paymentKind: 'transaction', paidAt });
      }
      if (page.nextCursor || end < until) result.nextCursor = encodeCursor({ provider: 'paypal', accountScope: options.accountScope,
        subscriptionId: id, planId: catalogReference, start: page.nextCursor ? start : end, until,
        ...(page.nextCursor ? { next: page.nextCursor } : {}) });
      return { subscription, transactions: page.transactions, result };
  };
  return { id: 'paypal', accountScope: options.accountScope,
    capabilities: { cancel: ['immediate'], billingPortal: false, invoices: false, paidReceiptProof: 'provider',
      paidPeriodProof: options.resolvePeriodReceipt ? 'merchant_receipt' : 'unavailable' },
    async retrieve(id) { return observePayPalSubscription(await get(id)); },
    async listPaidReceipts(id, input) { return (await readPage(id, input)).result; },
    async listPaidPeriods(id, input) {
      const { subscription, transactions, result: receipts } = await readPage(id, input);
      const result: SubscriptionPaidPeriodPage = { data: [], nextCursor: receipts.nextCursor, issues: [...(receipts.issues ?? [])] };
      for (const paid of receipts.data) {
        const transaction = transactions.find((value) => value.id === paid.paymentId);
        if (!transaction) throw new SubscriptionProtocolError('invalid_response', 'PayPal transaction evidence is missing');
        const receipt = await options.resolvePeriodReceipt?.({ accountScope: options.accountScope,
          subscription: structuredClone(subscription), transaction: structuredClone(transaction) });
        if (!receipt) { result.issues?.push({ recordId: paid.recordId, code: 'missing_period' }); continue; }
        sameId(receipt.accountScope, options.accountScope); sameId(receipt.subscriptionId, id);
        sameId(receipt.catalogReference, paid.catalogReference); sameId(receipt.paymentId, paid.paymentId);
        result.data.push({ ...paid, period: assertPeriod(receipt.period) });
      }
      return result;
    },
    async cancel(id, input) {
      if (input.mode !== 'immediate') throw new SubscriptionProtocolError('unsupported', 'PayPal does not support scheduled cancellation');
      await options.transport.cancelSubscription(requiredId(id), input.reason ?? 'Canceled by subscriber');
      return observePayPalSubscription(await get(id));
    },
    verifyWebhook(request) { return verifyPayPalSubscriptionEvent(options, request); },
  };
}
