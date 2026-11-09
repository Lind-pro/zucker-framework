import { createPayPalHostedCheckoutAdapter, type PayPalHostedCheckoutOptions } from './paypal';
import type { HostedCheckoutOrder } from './types';
const start = '2026-01-01T00:00:00.000Z';
function fixture() {
  const plan = { id: 'P-PLAN', status: 'ACTIVE', billing_cycles: [{ sequence: 1, tenure_type: 'REGULAR', pricing_scheme: { fixed_price: { value: '29.00', currency_code: 'USD' } } }] };
  const raw = { id: 'I-SUB', plan_id: 'P-PLAN', quantity: '1', custom_id: 'order-1', status: 'ACTIVE', create_time: start, links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=I-SUB' }] };
  const sale = { id: 'SALE-1', status: 'COMPLETED', time: start, amount_with_breakdown: { gross_amount: { value: '29.00', currency_code: 'USD' } } };
  const getOrder = vi.fn(), captureOrder = vi.fn();
  const getSubscription = vi.fn(async () => raw), getSubscriptionPlan = vi.fn(async () => plan), createSubscription = vi.fn(async () => raw);
  const listSubscriptionTransactions = vi.fn(async () => ({ transactions: [sale], nextCursor: undefined as string | undefined }));
  const verifyWebhookSignature = vi.fn(async () => true);
  const transport: PayPalHostedCheckoutOptions['transport'] = { createOrder: vi.fn(), getOrder, captureOrder, getSubscription, getSubscriptionPlan, createSubscription, listSubscriptionTransactions, verifyWebhookSignature };
  const adapter = createPayPalHostedCheckoutAdapter({ transport, accountScope: 'test', webhookId: 'webhook', now: () => new Date('2026-01-15T00:00:00Z') });
  const order = { id: 'order-1', offer: { catalogReference: 'P-PLAN', version: 'v1', mode: 'subscription', money: { amount: '29.00', currency: 'USD' }, description: 'Test plan' },
    createKey: 'create-1', successUrl: 'https://app.example/done', cancelUrl: 'https://app.example/cancel', providerMetadata: null } as HostedCheckoutOrder;
  return { adapter, plan, raw, sale, getOrder, captureOrder, getSubscription, getSubscriptionPlan, createSubscription, listSubscriptionTransactions, verifyWebhookSignature, order };
}
it('creates an approval subscription with a server plan and durable order reference, never a synthetic paid state', async () => {
  const f = fixture(); expect(f.adapter.modes).toContain('subscription');
  expect(await f.adapter.create(f.order)).toMatchObject({ checkoutId: 'I-SUB', subscriptionId: 'I-SUB', state: 'pending', reference: 'order-1', catalogReference: 'P-PLAN', dueMoney: { amount: '29.00', currency: 'USD' } });
  expect(f.createSubscription).toHaveBeenCalledWith({ plan_id: 'P-PLAN', custom_id: 'order-1', quantity: '1', application_context: {
    return_url: f.order.successUrl, cancel_url: f.order.cancelUrl, brand_name: undefined, user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING' } }, 'create-1');
  expect(f.listSubscriptionTransactions).not.toHaveBeenCalled();
});
it('retrieves first actual completed payment across pages and never captures a subscription', async () => {
  const f = fixture();
  f.listSubscriptionTransactions.mockResolvedValueOnce({ transactions: [{ ...f.sale, id: 'later', time: '2026-01-03T00:00:00Z' }], nextCursor: 'page=2' })
    .mockResolvedValueOnce({ transactions: [f.sale], nextCursor: undefined });
  expect(await f.adapter.retrieve('I-SUB')).toMatchObject({ state: 'paid', paymentId: 'SALE-1', paymentKind: 'transaction', paidMoney: { amount: '29.00', currency: 'USD' } });
  expect(f.getOrder).not.toHaveBeenCalled();
  await expect(f.adapter.capture!('I-SUB', 'capture')).rejects.toThrow('automatically'); expect(f.captureOrder).not.toHaveBeenCalled();
});
it('does not reinterpret a refunded initial charge as a later renewal', async () => {
  const f = fixture(); f.listSubscriptionTransactions.mockResolvedValueOnce({ transactions: [{ ...f.sale, status: 'REFUNDED' }, { ...f.sale, id: 'SALE-2', time: '2026-01-04T00:00:00Z' }], nextCursor: undefined });
  expect(await f.adapter.retrieve('I-SUB')).toMatchObject({ state: 'unpaid', paidMoney: undefined, paymentId: undefined });
});
it('confirms historical payment without depending on a currently active or unchanged plan price', async () => {
  const f = fixture(); f.getSubscriptionPlan.mockRejectedValue(new Error('plan was archived'));
  expect(await f.adapter.retrieve('I-SUB')).toMatchObject({ state: 'paid', dueMoney: undefined, paidMoney: { amount: '29.00', currency: 'USD' } });
  expect(f.getSubscriptionPlan).not.toHaveBeenCalled();
});
it('quotes the PayPal plan price for subscriptions only, without creating anything', async () => {
  const f = fixture();
  expect(await f.adapter.quote!(f.order.offer)).toEqual({ money: { amount: '29.00', currency: 'USD' }, mode: 'subscription' });
  expect(await f.adapter.quote!({ ...f.order.offer, mode: 'payment' })).toBeNull();
  expect(f.getSubscriptionPlan).toHaveBeenCalledTimes(1);
  expect(f.createSubscription).not.toHaveBeenCalled();
});
it('rejects plan-price mismatch, trials and setup fees before dispatch', async () => {
  const f = fixture();
  await expect(f.adapter.create({ ...f.order, offer: { ...f.order.offer, money: { amount: '19.00', currency: 'USD' } } })).rejects.toThrow('frozen offer');
  f.getSubscriptionPlan.mockResolvedValueOnce({ ...f.plan, billing_cycles: [{ ...f.plan.billing_cycles[0], tenure_type: 'TRIAL' }] });
  await expect(f.adapter.create(f.order)).rejects.toThrow('without trial');
  f.getSubscriptionPlan.mockResolvedValueOnce({ ...f.plan, payment_preferences: { setup_fee: { value: '1.00', currency_code: 'USD' } } } as typeof f.plan);
  await expect(f.adapter.create(f.order)).rejects.toThrow('setup fees'); expect(f.createSubscription).not.toHaveBeenCalled();
});
it('verifies subscription and sale events and preserves their subscription identity', async () => {
  const f = fixture();
  const request = { headers: {}, rawBody: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-SUB' } }) };
  expect(await f.adapter.verifyWebhook(request)).toEqual({ eventId: 'WH-1', checkoutId: 'I-SUB', reference: undefined });
  f.verifyWebhookSignature.mockResolvedValueOnce(false); await expect(f.adapter.verifyWebhook(request)).rejects.toThrow('verification failed');
});
