import type Stripe from 'stripe';
import { fromMinorUnits, toMinorUnits } from '../contract/money';
import type { Money } from '../contract/payment-contract';
import { stripeResourceId, verifyStripeWebhookEvent } from '../providers/stripe';
import { text } from '../hosted-checkout/validation';
import { decodeCursor, encodeCursor } from '../subscriptions/validation';
import { RefundProtocolError, type RefundAdapter, type RefundPaymentReference, type RefundState } from './types';
import { compareMoney, identity, protocolCall, sameIdentity, sameMoney, subtractMoney, validateCommand, validatePayment } from './validation';

export interface StripeRefundOptions {
  client: Pick<Stripe, 'paymentIntents' | 'charges' | 'invoices' | 'invoicePayments' | 'refunds' | 'webhooks'>;
  accountScope: string; livemode: boolean; webhookSecret?: string;
}
const kinds = ['payment-intent', 'invoice'] as const;
function state(value: string | null): RefundState {
  if (value === 'pending') return 'pending'; if (value === 'requires_action') return 'requires_action';
  if (value === 'succeeded') return 'succeeded'; if (value === 'failed') return 'failed';
  if (value === 'canceled') return 'canceled'; return 'unknown';
}
function money(amount: number, currency: string): Money {
  if (!Number.isSafeInteger(amount) || amount < 0 || !/^[a-z]{3}$/.test(currency)) throw new RefundProtocolError('invalid_response', 'Invalid Stripe refund money');
  const code = currency.toUpperCase(); return { amount: fromMinorUnits(amount, code === 'UGX' ? 'USD' : code), currency: code };
}
export function createStripeRefundAdapter(options: StripeRefundOptions): RefundAdapter {
  identity(options.accountScope);
  const mode = (value: { livemode: boolean }) => { if (value.livemode !== options.livemode) throw new RefundProtocolError('verification_failed', 'Stripe refund environment mismatch'); };
  const intentCharge = async (id: string, paidMoney: Money) => {
    const intent = await protocolCall(() => options.client.paymentIntents.retrieve(id)); sameIdentity(intent.id, id); mode(intent);
    sameMoney(money(intent.amount_received, intent.currency), paidMoney);
    if (intent.status !== 'succeeded') throw new RefundProtocolError('verification_failed', 'Stripe payment has not settled');
    const chargeId = stripeResourceId(intent.latest_charge);
    if (!chargeId) throw new RefundProtocolError('invalid_response', 'Stripe settled payment has no charge');
    const charge = await protocolCall(() => options.client.charges.retrieve(chargeId));
    sameIdentity(charge.id, chargeId); sameIdentity(stripeResourceId(charge.payment_intent), id); return charge;
  };
  const resolve = async (payment: RefundPaymentReference) => {
    validatePayment(payment, kinds);
    let charge: Stripe.Charge;
    if (payment.paymentKind === 'payment-intent') charge = await intentCharge(payment.paymentId, payment.paidMoney);
    else {
      const invoice = await protocolCall(() => options.client.invoices.retrieve(payment.paymentId)); sameIdentity(invoice.id, payment.paymentId); mode(invoice);
      sameMoney(money(invoice.amount_paid, invoice.currency), payment.paidMoney);
      if (invoice.status !== 'paid') throw new RefundProtocolError('verification_failed', 'Stripe invoice is not paid');
      const settled: Stripe.InvoicePayment[] = []; let after: string | undefined;
      for (let pageIndex = 0; ; pageIndex++) {
        if (pageIndex >= 100) throw new RefundProtocolError('invalid_response', 'Stripe invoice payment history exceeds the page limit');
        const page = await protocolCall(() => options.client.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 100, ...(after ? { starting_after: after } : {}) }));
        for (const item of page.data) { mode(item); sameIdentity(stripeResourceId(item.invoice), invoice.id); if (item.status === 'paid' && item.amount_paid !== 0) settled.push(item); }
        if (!page.has_more) break;
        const next = page.data.at(-1)?.id; if (!next || next === after) throw new RefundProtocolError('invalid_response', 'Stripe invoice pagination did not advance'); after = next;
      }
      if (settled.length !== 1) throw new RefundProtocolError('unsupported', 'Stripe invoice refund requires one attributable settled payment', 'rejected');
      const item = settled[0];
      if (item.amount_paid === null) throw new RefundProtocolError('invalid_response', 'Stripe invoice payment has no settled amount');
      sameMoney(money(item.amount_paid, item.currency), payment.paidMoney);
      if (item.payment.type === 'payment_intent') {
        const id = stripeResourceId(item.payment.payment_intent); if (!id) throw new RefundProtocolError('invalid_response', 'Stripe invoice payment intent is missing');
        charge = await intentCharge(id, payment.paidMoney);
      } else if (item.payment.type === 'charge') {
        const id = stripeResourceId(item.payment.charge); if (!id) throw new RefundProtocolError('invalid_response', 'Stripe invoice charge is missing');
        charge = await protocolCall(() => options.client.charges.retrieve(id)); sameIdentity(charge.id, id);
      } else throw new RefundProtocolError('unsupported', 'Stripe invoice payment source cannot be refunded by this adapter', 'rejected');
    }
    mode(charge); sameMoney(money(charge.amount_captured, charge.currency), payment.paidMoney);
    if (!charge.paid || !charge.captured || charge.status !== 'succeeded') throw new RefundProtocolError('verification_failed', 'Stripe charge is not captured');
    return charge;
  };
  const observe = (raw: Stripe.Refund, payment: RefundPaymentReference, chargeId: string) => {
    identity(raw.id); sameIdentity(stripeResourceId(raw.charge), chargeId);
    if (raw.amount === 0) throw new RefundProtocolError('invalid_response', 'Stripe refund has no positive money movement');
    const actual = money(raw.amount, raw.currency);
    if (compareMoney(actual, payment.paidMoney) > 0) throw new RefundProtocolError('invalid_response', 'Stripe refund exceeds its payment');
    return { refundId: raw.id, paymentId: payment.paymentId, paymentKind: payment.paymentKind,
      source: { kind: 'charge' as const, id: chargeId }, state: state(raw.status), providerStatus: raw.status ?? 'unknown', money: actual,
      occurredAt: Number.isSafeInteger(raw.created) ? new Date(raw.created * 1000).toISOString() : undefined,
      commandKey: text(raw.metadata?.zucker_refund_command) };
  };
  const adapter: RefundAdapter = { id: 'stripe', accountScope: options.accountScope,
    capabilities: { paymentKinds: kinds, partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: true },
    async retrievePayment(payment) {
      payment = structuredClone(payment);
      const charge = await resolve(payment); let after: string | undefined, pending = 0n, successful = 0n;
      const seen = new Set<string>();
      for (let pageIndex = 0; ; pageIndex++) {
        if (pageIndex >= 100) throw new RefundProtocolError('invalid_response', 'Stripe refund history exceeds the page limit');
        const page = await protocolCall(() => options.client.refunds.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) }));
        for (const refund of page.data) {
          const observed = observe(refund, payment, charge.id);
          if (seen.has(refund.id)) throw new RefundProtocolError('invalid_response', 'Stripe refund history repeated a receipt'); seen.add(refund.id);
          if (observed.state === 'unknown') throw new RefundProtocolError('invalid_response', 'Stripe refund aggregate has unknown evidence');
          if (observed.state === 'succeeded') successful += BigInt(refund.amount);
          if (observed.state === 'pending' || observed.state === 'requires_action') pending += BigInt(refund.amount);
        }
        if (!page.has_more) break;
        const next = page.data.at(-1)?.id; if (!next || next === after) throw new RefundProtocolError('invalid_response', 'Stripe refund pagination did not advance'); after = next;
      }
      if (successful + pending > BigInt(charge.amount_captured) || successful > BigInt(Number.MAX_SAFE_INTEGER) || pending > BigInt(Number.MAX_SAFE_INTEGER)) throw new RefundProtocolError('invalid_response', 'Stripe refund aggregate exceeds captured money');
      // Individual refund statuses distinguish pending from settled money; the charge counter does not.
      return { ...structuredClone(payment), source: { kind: 'charge', id: charge.id }, settlement: successful === BigInt(charge.amount_captured) ? 'refunded' : successful > 0n ? 'partially_refunded' : 'paid',
        refundedMoney: money(Number(successful), charge.currency), pendingRefundMoney: money(Number(pending), charge.currency) };
    },
    async create(command) {
      command = structuredClone(command);
      validateCommand(command, kinds);
      let amount: number;
      try {
        amount = toMinorUnits(command.money.amount, command.money.currency === 'UGX' ? 'USD' : command.money.currency);
        if (['UGX', 'ISK'].includes(command.money.currency)) toMinorUnits(command.money.amount, 'JPY');
      } catch { throw new RefundProtocolError('invalid_input', 'Stripe refund amount has unsupported decimals or range', 'rejected'); }
      const payment = await adapter.retrievePayment(command.payment);
      if (!payment.refundedMoney || !payment.pendingRefundMoney) throw new RefundProtocolError('invalid_response', 'Stripe refund aggregates are unavailable');
      if (compareMoney(command.money, subtractMoney(subtractMoney(command.payment.paidMoney, payment.refundedMoney), payment.pendingRefundMoney)) > 0) throw new RefundProtocolError('invalid_input', 'Refund exceeds the remaining captured amount', 'rejected');
      const allowedReason = ['duplicate', 'fraudulent', 'requested_by_customer'].includes(command.reason ?? '') ? command.reason as Stripe.RefundCreateParams.Reason : undefined;
      const raw = await protocolCall(() => options.client.refunds.create({ charge: payment.source.id, amount,
        metadata: { zucker_refund_command: command.commandKey, ...(!allowedReason && command.reason ? { refund_reason: command.reason } : {}) },
        ...(allowedReason ? { reason: allowedReason } : {}) }, { idempotencyKey: command.commandKey, maxNetworkRetries: 0 }));
      const result = observe(raw, command.payment, payment.source.id);
      if (result.money) sameMoney(result.money, command.money);
      if (result.commandKey !== undefined) sameIdentity(result.commandKey, command.commandKey);
      return result;
    },
    async retrieve(refundId, payment) {
      payment = structuredClone(payment);
      const charge = await resolve(payment), raw = await protocolCall(() => options.client.refunds.retrieve(identity(refundId))); sameIdentity(raw.id, refundId);
      return observe(raw, payment, charge.id);
    },
    async listRefunds(payment, input = {}) {
      payment = structuredClone(payment); input = { ...input };
      const charge = await resolve(payment);
      let cursor: Record<string, unknown> | undefined;
      try { cursor = input.cursor ? decodeCursor(input.cursor) : undefined; }
      catch { throw new RefundProtocolError('invalid_input', 'Invalid Stripe refund cursor', 'rejected'); }
      if (cursor && (cursor.provider !== 'stripe' || cursor.accountScope !== options.accountScope || cursor.paymentId !== payment.paymentId
        || cursor.paymentKind !== payment.paymentKind || cursor.chargeId !== charge.id)) throw new RefundProtocolError('invalid_input', 'Stripe refund cursor identity mismatch', 'rejected');
      const after = cursor ? identity(cursor.after) : undefined;
      const page = await protocolCall(() => options.client.refunds.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) }));
      const data = page.data.map(raw => observe(raw, payment, charge.id));
      const last = data.at(-1)?.refundId;
      if (page.has_more && (!last || last === after)) throw new RefundProtocolError('invalid_response', 'Stripe refund pagination did not advance');
      return { data, nextCursor: page.has_more ? encodeCursor({ provider: 'stripe', accountScope: options.accountScope,
        paymentId: payment.paymentId, paymentKind: payment.paymentKind, chargeId: charge.id, after: last }) : undefined };
    },
    async verifyWebhook(request) {
      if (!options.webhookSecret) throw new RefundProtocolError('invalid_input', 'Stripe refund webhook secret is required', 'rejected');
      const signatures = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === 'stripe-signature');
      if (signatures.length !== 1 || !signatures[0][1]) throw new RefundProtocolError('verification_failed', 'Stripe refund signature is required');
      let event: Stripe.Event;
      try { event = verifyStripeWebhookEvent(options.client, typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody), signatures[0][1], options.webhookSecret); }
      catch { throw new RefundProtocolError('verification_failed', 'Stripe refund signature verification failed'); }
      mode(event);
      if (!['refund.created', 'refund.updated', 'refund.failed'].includes(event.type)) return null;
      const raw = event.data.object as Stripe.Refund, chargeId = stripeResourceId(raw.charge);
      if (!chargeId) throw new RefundProtocolError('invalid_response', 'Stripe refund event has no charge identity');
      if (raw.amount === 0) throw new RefundProtocolError('invalid_response', 'Stripe refund event has no positive money movement');
      return { eventId: identity(event.id), refundId: identity(raw.id), source: { kind: 'charge', id: chargeId }, state: state(raw.status),
        money: money(raw.amount, raw.currency), occurredAt: new Date(event.created * 1000).toISOString(), commandKey: text(raw.metadata?.zucker_refund_command) };
    },
  };
  return adapter;
}
