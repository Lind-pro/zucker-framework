import { toMinorUnits, fromMinorUnits } from '@zucker-framework/payment';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOrder, RefundAdapter, RefundCommand, RefundObservation, RefundPaymentObservation, SubscriptionAdapter, SubscriptionPaidPeriod } from '@zucker-framework/payment';
import type { BillingOptions } from '../../src/billing/billing.service';

/** Protocol substitutes only; HTTP, auth, persistence, holds and reconciliation use the real application. */
export function refundBrowserProviders(webUrl: string) {
  const orders = new Map<string, HostedCheckoutOrder>(), checkouts = new Map<string, HostedCheckoutObservation>();
  const payments = new Map<string, RefundPaymentObservation>(), observations = new Map<string, RefundObservation>(), periods = new Map<string, SubscriptionPaidPeriod[]>();
  const calls: RefundCommand[] = [], modes = new Map<string, 'pending' | 'succeeded'>();
  const hosted: HostedCheckoutAdapter = { id: 'stripe', accountScope: 'synthetic-refund-browser', modes: ['payment', 'subscription'], validate() {},
    async create(order) { orders.set(order.id, structuredClone(order)); const initial: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id, catalogReference: order.offer.catalogReference, mode: order.offer.mode, quantity: 1, state: 'pending', url: 'https://synthetic.invalid/checkout' }; checkouts.set(initial.checkoutId, initial); return structuredClone(initial); },
    async retrieve(id) { return structuredClone(checkouts.get(id)!); }, async verifyWebhook() { return null; } };
  function facts(paymentId: string) {
    const payment = payments.get(paymentId); if (!payment) throw new Error('Synthetic payment was not prepared');
    const rows = [...observations.values()].filter(row => row.paymentId === paymentId);
    const succeeded = rows.filter(row => row.state === 'succeeded').reduce((sum, row) => sum + toMinorUnits(row.money!.amount, 'USD'), 0), pending = rows.filter(row => ['pending', 'unknown', 'requires_action'].includes(row.state)).reduce((sum, row) => sum + toMinorUnits(row.money!.amount, 'USD'), 0);
    return { ...payment, refundedMoney: { amount: fromMinorUnits(succeeded, 'USD'), currency: 'USD' }, pendingRefundMoney: { amount: fromMinorUnits(pending, 'USD'), currency: 'USD' }, settlement: succeeded === toMinorUnits(payment.paidMoney.amount, 'USD') ? 'refunded' as const : succeeded > 0 ? 'partially_refunded' as const : 'paid' as const };
  }
  const refund: RefundAdapter = { id: 'stripe', accountScope: hosted.accountScope, capabilities: { paymentKinds: ['payment-intent', 'invoice'], partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: true },
    async retrievePayment(payment) { return structuredClone(facts(payment.paymentId)); },
    async listRefunds(payment) { return { data: [...observations.values()].filter(row => row.paymentId === payment.paymentId).map(row => structuredClone(row)) }; },
    async retrieve(id) { return structuredClone(observations.get(id)!); },
    async create(command) { calls.push(structuredClone(command)); const id = `receipt-${command.commandKey}`, prior = observations.get(id); if (prior) return structuredClone(prior); const payment = facts(command.payment.paymentId), state = modes.get(command.payment.paymentId) ?? 'pending';
      const row: RefundObservation = { refundId: id, paymentId: command.payment.paymentId, paymentKind: command.payment.paymentKind, source: payment.source, state, providerStatus: state, money: command.money, commandKey: command.commandKey, occurredAt: new Date().toISOString() }; observations.set(id, row); return structuredClone(row); },
    async verifyWebhook() { return null; } };
  const subscriptions: SubscriptionAdapter = { id: 'stripe', accountScope: hosted.accountScope, capabilities: { cancel: [], billingPortal: false, invoices: false, paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' },
    async retrieve(id) { const order = [...orders.values()].find(order => `subscription-${order.id}` === id)!; return { provider: 'stripe', subscriptionId: id, customerId: 'synthetic-customer', catalogReference: order.offer.catalogReference, status: 'active', providerStatus: 'active', payment: { settlement: 'paid' } }; },
    async listPaidPeriods(id) { return { data: structuredClone(periods.get(id) ?? []) }; }, async cancel() { throw new Error('Unused synthetic capability'); } };
  const options: BillingOptions = { providers: [hosted], refundProviders: [refund], subscriptionProviders: [subscriptions], webUrl, catalogJson: JSON.stringify([
    { id: 'credits', title: 'Synthetic refund credits', version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'credit-price' } },
    { id: 'subscription', title: 'Synthetic refund subscription', version: 'v1', mode: 'subscription', amount: '10.00', currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'subscription-price' } },
  ]) };
  return { options, calls, modes, observations,
    paid(id: string) { const order = orders.get(id)!; const paymentId = `payment-${id}`, kind = order.offer.mode === 'subscription' ? 'invoice' as const : 'payment-intent' as const;
      payments.set(paymentId, { paymentId, paymentKind: kind, paidMoney: order.offer.money, source: { kind: 'charge', id: `charge-${id}` }, settlement: 'paid', refundedMoney: { amount: '0.00', currency: 'USD' } });
      const subscriptionId = `subscription-${id}`; periods.set(subscriptionId, [{ recordId: paymentId, paymentId, paymentKind: kind, subscriptionId, catalogReference: order.offer.catalogReference, paidMoney: order.offer.money, paidAt: new Date().toISOString(), period: { start: new Date().toISOString(), end: new Date(Date.now() + 86400000 * 30).toISOString() } }]);
      checkouts.set(`checkout-${id}`, { ...checkouts.get(`checkout-${id}`)!, state: 'paid', paidMoney: order.offer.money, paymentId, paymentKind: kind, ...(order.offer.mode === 'subscription' ? { subscriptionId } : {}) });
      return { paymentId, orderId: id, ownerId: order.ownerId, subscriptionId: id };
    },
    settle(paymentId: string) { for (const row of observations.values()) if (row.paymentId === paymentId) { row.state = 'succeeded'; row.providerStatus = 'succeeded'; } },
  };
}
