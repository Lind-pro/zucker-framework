import { toMinorUnits } from '../contract/money';
import type { Money } from '../contract/payment-contract';
import { PAYPAL_SUPPORTED_CURRENCIES } from '../contract/adapters/paypal.adapter';
import { record, text } from '../hosted-checkout/validation';
import { PayPalPaymentProtocolError, type PayPalPaymentTransport } from '../providers/paypal';
import { isoDate } from '../subscriptions/validation';
import { RefundProtocolError, type RefundAdapter, type RefundPaymentReference, type RefundState } from './types';
import { compareMoney, exactMoney, identity, sameIdentity, sameMoney, validateCommand, validatePayment } from './validation';

export interface PayPalRefundOptions {
  transport: Pick<PayPalPaymentTransport, 'environment' | 'getCapturePayment' | 'getSalePayment' | 'createCaptureRefund' | 'createSaleRefund' | 'getCaptureRefund' | 'getSaleRefund' | 'verifyWebhookSignature'>;
  accountScope: string; webhookId?: string;
}
const kinds = ['capture', 'transaction'] as const;
function state(value: unknown): RefundState {
  if (value === 'COMPLETED' || value === 'completed') return 'succeeded';
  if (value === 'PENDING' || value === 'pending') return 'pending';
  if (value === 'FAILED' || value === 'failed') return 'failed';
  if (['CANCELLED', 'CANCELED', 'cancelled', 'canceled'].includes(String(value))) return 'canceled';
  return 'unknown';
}
function money(value: unknown, sale: boolean): Money | undefined {
  const raw = record(value), amount = text(sale ? raw?.total : raw?.value), currency = text(sale ? raw?.currency : raw?.currency_code);
  return amount && currency ? exactMoney({ amount, currency }) : undefined;
}
function totalRefundedMoney(raw: Record<string, unknown>, sale: boolean): Money | undefined {
  if (!sale) return money(record(raw.seller_payable_breakdown)?.total_refunded_amount, false);
  const total = record(raw.total_refunded_amount), amount = text(total?.value), currency = text(total?.currency);
  return amount && currency ? exactMoney({ amount, currency }) : undefined;
}
async function call<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { if (error instanceof RefundProtocolError) throw error;
    throw new RefundProtocolError('transport_error', 'PayPal refund request failed; reconcile before another mutation', error instanceof PayPalPaymentProtocolError ? error.outcome : 'unknown'); }
}
export function createPayPalRefundAdapter(options: PayPalRefundOptions): RefundAdapter {
  identity(options.accountScope);
  if (!['live', 'sandbox'].includes(options.transport.environment)) throw new RefundProtocolError('invalid_input', 'PayPal refund environment must be explicit', 'rejected');
  const source = (payment: RefundPaymentReference) => ({ kind: payment.paymentKind === 'capture' ? 'capture' as const : 'transaction' as const, id: payment.paymentId });
  const parentCapture = (raw: Record<string, unknown>): string | undefined => {
    const direct = text(record(record(raw.supplementary_data)?.related_ids)?.capture_id);
    let linked: string | undefined;
    for (const item of Array.isArray(raw.links) ? raw.links : []) {
      const link = record(item); if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
      try {
        const url = new URL(link.href), allowed = options.transport.environment === 'sandbox'
          ? ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'] : ['api.paypal.com', 'api-m.paypal.com'];
        if (url.protocol !== 'https:' || !allowed.includes(url.host) || url.username || url.password || url.search || url.hash) throw new Error();
        const match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (!match || linked && linked !== match[1]) throw new Error(); linked = match[1];
      } catch { throw new RefundProtocolError('verification_failed', 'Invalid PayPal refund payment link'); }
    }
    if (direct && linked && direct !== linked) throw new RefundProtocolError('verification_failed', 'PayPal refund parent identifiers disagree');
    return direct ?? linked;
  };
  const readPayment = async (payment: RefundPaymentReference) => {
    payment = structuredClone(payment);
    validatePayment(payment, kinds);
    const sale = payment.paymentKind === 'transaction';
    const raw = await call(() => sale ? options.transport.getSalePayment(payment.paymentId) : options.transport.getCapturePayment(payment.paymentId));
    sameIdentity(raw.id, payment.paymentId);
    const paidMoney = money(raw.amount, sale); if (!paidMoney) throw new RefundProtocolError('invalid_response', 'PayPal payment has no actual amount');
    sameMoney(paidMoney, payment.paidMoney);
    const status = text(sale ? raw.state : raw.status);
    const settlement = status === 'completed' || status === 'COMPLETED' ? 'paid' as const
      : status === 'partially_refunded' || status === 'PARTIALLY_REFUNDED' ? 'partially_refunded' as const
        : status === 'refunded' || status === 'REFUNDED' ? 'refunded' as const : 'unknown' as const;
    // Capture/sale details do not enumerate all refund receipts or pending refund totals.
    return { ...structuredClone(payment), source: source(payment), settlement,
      refundedMoney: settlement === 'refunded' ? paidMoney : settlement === 'paid' ? { amount: '0', currency: paidMoney.currency } : undefined };
  };
  const observe = (raw: Record<string, unknown>, payment: RefundPaymentReference, fromCreate = false) => {
    const sale = payment.paymentKind === 'transaction';
    const parent = sale ? text(raw.sale_id) : parentCapture(raw);
    if (parent !== undefined) sameIdentity(parent, payment.paymentId);
    else if (!fromCreate) throw new RefundProtocolError('invalid_response', 'PayPal refund does not identify its original payment');
    const actual = money(raw.amount, sale), providerStatus = text(sale ? raw.state : raw.status) ?? 'unknown';
    const total = totalRefundedMoney(raw, sale);
    if (actual && compareMoney(actual, payment.paidMoney) > 0) throw new RefundProtocolError('invalid_response', 'PayPal refund exceeds its payment');
    if (total && compareMoney(total, payment.paidMoney) > 0) throw new RefundProtocolError('invalid_response', 'PayPal total refunds exceed the payment');
    const observed = state(providerStatus);
    return { refundId: identity(raw.id), paymentId: payment.paymentId, paymentKind: payment.paymentKind, source: source(payment),
      state: observed === 'succeeded' && (!actual || compareMoney(actual, { amount: '0', currency: actual.currency }) === 0) ? 'unknown' as const : observed, providerStatus, money: actual, totalRefundedMoney: total,
      occurredAt: isoDate(raw.update_time) ?? isoDate(raw.create_time), commandKey: text(sale ? raw.invoice_number : raw.custom_id) };
  };
  return { id: 'paypal', accountScope: options.accountScope,
    capabilities: { paymentKinds: kinds, partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: false },
    retrievePayment: readPayment,
    async create(command) {
      command = structuredClone(command);
      validateCommand(command, kinds);
      const sale = command.payment.paymentKind === 'transaction';
      if (command.commandKey.length > 78 || command.money.amount.length > (sale ? 10 : 32)) throw new RefundProtocolError('invalid_input', 'PayPal refund key or amount exceeds protocol limits', 'rejected');
      if (!(PAYPAL_SUPPORTED_CURRENCIES as readonly string[]).includes(command.money.currency)) throw new RefundProtocolError('unsupported', 'PayPal refund currency is unsupported', 'rejected');
      try { toMinorUnits(command.money.amount, ['JPY', 'HUF', 'TWD'].includes(command.money.currency) ? 'JPY' : 'USD'); }
      catch { throw new RefundProtocolError('invalid_input', 'PayPal refund amount has unsupported decimals', 'rejected'); }
      const payment = await readPayment(command.payment);
      if (payment.settlement !== 'paid' && payment.settlement !== 'partially_refunded') throw new RefundProtocolError('verification_failed', 'PayPal payment is not refundable', 'rejected');
      // Explicit amounts work for full and partial refunds and never request a larger newly changed remainder.
      const raw = await call(() => sale ? options.transport.createSaleRefund(command.payment.paymentId,
        { amount: { total: command.money.amount, currency: command.money.currency }, invoice_number: command.commandKey, ...(command.reason ? { description: command.reason } : {}) }, command.commandKey)
        : options.transport.createCaptureRefund(command.payment.paymentId,
          { amount: { value: command.money.amount, currency_code: command.money.currency }, custom_id: command.commandKey, ...(command.reason ? { note_to_payer: command.reason } : {}) }, command.commandKey));
      const result = observe(raw, command.payment, true);
      if (result.money) sameMoney(result.money, command.money);
      if (result.commandKey !== undefined) sameIdentity(result.commandKey, command.commandKey);
      return result;
    },
    async retrieve(refundId, payment) {
      payment = structuredClone(payment);
      validatePayment(payment, kinds); identity(refundId);
      const raw = await call(() => payment.paymentKind === 'transaction' ? options.transport.getSaleRefund(refundId) : options.transport.getCaptureRefund(refundId));
      sameIdentity(raw.id, refundId); return observe(raw, payment);
    },
    async verifyWebhook(request) {
      if (!options.webhookId) throw new RefundProtocolError('invalid_input', 'PayPal refund webhook ID is required', 'rejected');
      const body = typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody).toString('utf8');
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
      if (!await options.transport.verifyWebhookSignature(body, headers, options.webhookId)) throw new RefundProtocolError('verification_failed', 'PayPal refund webhook verification failed');
      let event: Record<string, unknown> | undefined;
      try { event = record(JSON.parse(body)); } catch { throw new RefundProtocolError('invalid_response', 'Invalid PayPal refund event JSON'); }
      const type = text(event?.event_type), resource = record(event?.resource);
      if (type !== 'PAYMENT.CAPTURE.REFUNDED' && type !== 'PAYMENT.SALE.REFUNDED') return null;
      if (!resource) throw new RefundProtocolError('invalid_response', 'PayPal refund event has no resource');
      const sale = type === 'PAYMENT.SALE.REFUNDED', parent = sale ? text(resource.sale_id) : parentCapture(resource);
      if (!parent) throw new RefundProtocolError('invalid_response', 'PayPal refund event has no original payment');
      const actual = money(resource.amount, sale), observed = state(sale ? resource.state : resource.status);
      return { eventId: identity(event?.id), refundId: identity(resource.id), source: { kind: sale ? 'transaction' : 'capture', id: parent },
        state: observed === 'succeeded' && (!actual || compareMoney(actual, { amount: '0', currency: actual.currency }) === 0) ? 'unknown' : observed, money: actual, totalRefundedMoney: totalRefundedMoney(resource, sale),
        occurredAt: isoDate(event?.create_time), commandKey: text(sale ? resource.invoice_number : resource.custom_id) };
    },
  };
}
