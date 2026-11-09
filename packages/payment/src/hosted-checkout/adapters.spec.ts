import type Stripe from 'stripe';
import type { Order } from '@paypal/paypal-server-sdk';
import { createHmac } from 'node:crypto';
import { createStripeHostedCheckoutAdapter } from './stripe';
import { createPayPalHostedCheckoutAdapter, type PayPalHostedCheckoutOptions } from './paypal';
import { createCreemHostedCheckoutAdapter } from './creem';
import { createCreemAdapter } from '../providers/creem';
import type { HostedCheckoutOrder } from './types';

const order: HostedCheckoutOrder = {
  id: 'order-1', ownerId: 'user-1', offerId: 'offer-1', providerId: 'stripe', accountScope: 'synthetic-account',
  providerMetadata: null,
  offer: { version: 'v1', catalogReference: 'catalog-1', mode: 'payment', money: { amount: '29.00', currency: 'USD' }, description: 'Synthetic item',
    fulfillmentData: { credits: 100, expiresInDays: 30 } },
  successUrl: 'https://app.example/return', cancelUrl: 'https://app.example/cancel', createKey: 'create-1', captureKey: 'capture-1',
  creationState: 'submitting', captureState: 'idle', state: 'unknown', checkoutId: null, checkoutUrl: null,
  paymentId: null, paymentKind: null, subscriptionId: null, fulfilledAt: null, revision: 1,
  createdAt: new Date('2026-10-24T00:00:00Z'), updatedAt: new Date('2026-10-24T00:00:00Z'),
};

function stripeSession(changes: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return { id: 'cs_1', livemode: false, mode: 'payment', client_reference_id: 'order-1', payment_status: 'paid', status: 'complete',
    amount_total: 2900, currency: 'usd', payment_intent: 'pi_1', invoice: null, subscription: null,
    line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'catalog-1' } }] },
    url: 'https://checkout.stripe.com/c/pay/cs_1', ...changes } as unknown as Stripe.Checkout.Session;
}
function stripeFixture() {
  const create = vi.fn(async () => stripeSession());
  const retrieve = vi.fn(async () => stripeSession());
  const constructEvent = vi.fn(() => ({ id: 'evt_1', livemode: false, type: 'checkout.session.completed', data: { object: stripeSession() } }));
  const client = { checkout: { sessions: { create, retrieve } }, webhooks: { constructEvent } } as unknown as Pick<Stripe, 'checkout' | 'webhooks'>;
  const adapter = createStripeHostedCheckoutAdapter({ client, accountScope: 'stripe:test:merchant', livemode: false, webhookSecret: 'synthetic-secret' });
  return { adapter, create, retrieve, constructEvent };
}

describe('Stripe hosted catalog protocol', () => {
  it('quotes the Stripe Price read-only when the client exposes prices', async () => {
    const f = stripeFixture();
    expect(f.adapter.quote).toBeUndefined();
    const prices = { retrieve: vi.fn(async () => ({ id: 'catalog-1', livemode: false, active: true, currency: 'usd', unit_amount: 2900, type: 'one_time' })) };
    const client = { checkout: { sessions: { create: f.create, retrieve: f.retrieve } }, webhooks: { constructEvent: f.constructEvent }, prices } as unknown as Pick<Stripe, 'checkout' | 'webhooks' | 'prices'>;
    const adapter = createStripeHostedCheckoutAdapter({ client, accountScope: 'stripe:test:merchant', livemode: false });
    const offer = { version: 'v1', catalogReference: 'catalog-1', mode: 'payment' as const, money: { amount: '29.00', currency: 'USD' }, description: 'x' };
    expect(await adapter.quote!(offer)).toEqual({ money: { amount: '29.00', currency: 'USD' }, mode: 'payment' });
    expect(prices.retrieve).toHaveBeenCalledWith('catalog-1');
    prices.retrieve.mockResolvedValueOnce({ id: 'catalog-1', livemode: false, active: true, currency: 'usd', unit_amount: 1990, type: 'recurring' });
    expect(await adapter.quote!(offer)).toEqual({ money: { amount: '19.90', currency: 'USD' }, mode: 'subscription' });
    prices.retrieve.mockResolvedValueOnce({ id: 'catalog-1', livemode: false, active: true, currency: 'usd', unit_amount: null as unknown as number, type: 'one_time' });
    expect(await adapter.quote!(offer)).toBeNull();
    prices.retrieve.mockResolvedValueOnce({ id: 'catalog-1', livemode: false, active: false, currency: 'usd', unit_amount: 2900, type: 'one_time' });
    await expect(adapter.quote!(offer)).rejects.toMatchObject({ code: 'conflict' });
    prices.retrieve.mockResolvedValueOnce({ id: 'catalog-1', livemode: true, active: true, currency: 'usd', unit_amount: 2900, type: 'one_time' });
    await expect(adapter.quote!(offer)).rejects.toMatchObject({ code: 'verification_failed' });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('forwards server-side price, fixed returns and persisted idempotency without rebuilding price_data', async () => {
    const f = stripeFixture(); await f.adapter.create(order);
    expect(f.create).toHaveBeenCalledWith({ mode: 'payment', client_reference_id: 'order-1',
      line_items: [{ price: 'catalog-1', quantity: 1 }], success_url: `${order.successUrl}?session_id={CHECKOUT_SESSION_ID}`, cancel_url: order.cancelUrl,
      allow_promotion_codes: false, automatic_tax: { enabled: false } }, { idempotencyKey: 'create-1' });
    expect(JSON.stringify(f.create.mock.calls)).not.toContain('credits');
  });
  it('preserves the consumer order and fragment while replacing a stale session hint', async () => {
    const f = stripeFixture();
    await f.adapter.create({ ...order, successUrl: 'https://app.example/return?order=local-order&session_id=stale#receipt' });
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({
      success_url: 'https://app.example/return?order=local-order&session_id={CHECKOUT_SESSION_ID}#receipt',
    }), expect.anything());
  });
  it('sends allowed public referral metadata without changing correlation', async () => {
    const f = stripeFixture();
    await f.adapter.create({ ...order, providerMetadata: { affonso_referral: 'referral-1', promotekit_referral: 'referral-2' } });
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ client_reference_id: order.id,
      metadata: { affonso_referral: 'referral-1', promotekit_referral: 'referral-2' } }), { idempotencyKey: order.createKey });
    await expect(f.adapter.create({ ...order, providerMetadata: { client_reference_id: 'foreign-order' } })).rejects.toThrow('reserved');
    expect(f.create).toHaveBeenCalledOnce();
  });
  it('retrieves expanded catalog identity read-only and preserves exact paid evidence', async () => {
    const f = stripeFixture();
    expect(await f.adapter.retrieve('cs_1')).toMatchObject({ checkoutId: 'cs_1', reference: 'order-1', catalogReference: 'catalog-1',
      quantity: 1, state: 'paid', paidMoney: { amount: '29.00', currency: 'USD' }, paymentId: 'pi_1', paymentKind: 'payment-intent' });
    expect(f.retrieve).toHaveBeenCalledWith('cs_1', { expand: ['line_items'] });
    expect(f.create).not.toHaveBeenCalled(); expect(f.adapter.capture).toBeUndefined();
  });
  it('does not treat no_payment_required or missing amounts as actual paid money', async () => {
    const f = stripeFixture();
    f.retrieve.mockResolvedValueOnce(stripeSession({ payment_status: 'no_payment_required', amount_total: 0 }));
    expect(await f.adapter.retrieve('cs_1')).toMatchObject({ state: 'pending', paidMoney: undefined });
    f.retrieve.mockResolvedValueOnce(stripeSession({ amount_total: null }));
    expect((await f.adapter.retrieve('cs_1')).paidMoney).toBeUndefined();
    f.retrieve.mockResolvedValueOnce(stripeSession({ mode: 'subscription', payment_intent: null, subscription: { id: 'sub_1' }, invoice: { id: 'in_1' } }));
    expect(await f.adapter.retrieve('cs_1')).toMatchObject({ mode: 'subscription', subscriptionId: 'sub_1', paymentId: 'in_1', paymentKind: 'invoice' });
  });
  it('uses the subscription invoice even when checkout also exposes its payment intent', async () => {
    const f = stripeFixture();
    f.retrieve.mockResolvedValueOnce(stripeSession({ mode: 'subscription', payment_intent: 'pi_1', subscription: 'sub_1', invoice: 'in_1' }));
    expect(await f.adapter.retrieve('cs_1')).toMatchObject({ paymentId: 'in_1', paymentKind: 'invoice' });
    f.retrieve.mockResolvedValueOnce(stripeSession({ mode: 'subscription', payment_intent: 'pi_1', subscription: 'sub_1', invoice: null }));
    expect(await f.adapter.retrieve('cs_1')).toMatchObject({ paymentId: undefined, paymentKind: undefined });
    f.retrieve.mockResolvedValueOnce(stripeSession({ mode: 'payment', payment_intent: 'pi_1', invoice: 'in_1' }));
    expect(await f.adapter.retrieve('cs_1')).toMatchObject({ paymentId: 'pi_1', paymentKind: 'payment-intent' });
  });
  it('refuses to invent a single catalog identity for missing, multiple or paginated line items', async () => {
    const f = stripeFixture();
    for (const line_items of [undefined, { has_more: true, data: [{ quantity: 1, price: { id: 'catalog-1' } }] },
      { has_more: false, data: [{ quantity: 1, price: { id: 'catalog-1' } }, { quantity: 1, price: { id: 'catalog-2' } }] }]) {
      f.retrieve.mockResolvedValueOnce(stripeSession({ line_items }));
      expect((await f.adapter.retrieve('cs_1')).catalogReference).toBeUndefined();
    }
  });
  it('validates provider environment and safe minor units, including UGX charge representation', async () => {
    const f = stripeFixture();
    f.retrieve.mockResolvedValueOnce(stripeSession({ livemode: true }));
    await expect(f.adapter.retrieve('cs_1')).rejects.toThrow('environment');
    f.retrieve.mockResolvedValueOnce(stripeSession({ amount_total: Number.MAX_SAFE_INTEGER + 1 }));
    await expect(f.adapter.retrieve('cs_1')).rejects.toThrow('invalid money');
    f.retrieve.mockResolvedValueOnce(stripeSession({ amount_total: 2900, currency: 'ugx' }));
    expect((await f.adapter.retrieve('cs_1')).paidMoney).toEqual({ amount: '29.00', currency: 'UGX' });
    expect(() => f.adapter.validate({ ...order.offer, money: { amount: '29.5', currency: 'UGX' } })).toThrow();
    f.retrieve.mockResolvedValueOnce(stripeSession({ amount_total: 2900, currency: 'jpy' }));
    expect((await f.adapter.retrieve('cs_1')).paidMoney).toEqual({ amount: '2900', currency: 'JPY' });
  });
  it('verifies the original bytes and excludes renewals from initial checkout handling', async () => {
    const f = stripeFixture(); const bytes = Buffer.from('{ "synthetic": true }');
    expect(await f.adapter.verifyWebhook({ rawBody: bytes, headers: { 'Stripe-Signature': 'signature' } }))
      .toEqual({ eventId: 'evt_1', checkoutId: 'cs_1', reference: 'order-1' });
    expect(f.constructEvent).toHaveBeenCalledWith(bytes, 'signature', 'synthetic-secret');
    expect(f.retrieve).not.toHaveBeenCalled();
    f.constructEvent.mockReturnValueOnce({ id: 'evt_renewal', livemode: false, type: 'invoice.paid', data: { object: stripeSession() } });
    expect(await f.adapter.verifyWebhook({ rawBody: bytes, headers: { 'stripe-signature': 'signature' } })).toBeNull();
    f.constructEvent.mockImplementationOnce(() => { throw new Error('Invalid signature'); });
    await expect(f.adapter.verifyWebhook({ rawBody: bytes, headers: { 'stripe-signature': 'bad' } })).rejects.toThrow('Invalid signature');
  });
});

function paypalOrder(changes: Record<string, unknown> = {}): Order {
  return { id: 'paypal-1', intent: 'CAPTURE', status: 'COMPLETED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=paypal-1' }],
    purchaseUnits: [{ referenceId: 'order-1', amount: { value: '29.00', currencyCode: 'USD' },
      items: [{ name: 'Synthetic item', sku: 'catalog-1', quantity: '1', unitAmount: { value: '29.00', currencyCode: 'USD' } }],
      payments: { captures: [{ id: 'capture-1', status: 'COMPLETED', amount: { value: '29.00', currencyCode: 'USD' } }] } }],
    ...changes } as unknown as Order;
}
function paypalFixture() {
  const response = () => ({ raw: paypalOrder(), settlement: 'paid' as const });
  const transport: PayPalHostedCheckoutOptions['transport'] = {
    createOrder: vi.fn(async () => response()), getOrder: vi.fn(async () => response()),
    captureOrder: vi.fn(async () => response()), verifyWebhookSignature: vi.fn(async () => true),
  };
  const adapter = createPayPalHostedCheckoutAdapter({ transport, accountScope: 'paypal:sandbox:merchant', webhookId: 'synthetic-webhook' });
  return { adapter, transport };
}

describe('PayPal hosted catalog protocol', () => {
  it('rejects unsupported metadata rather than hiding it in a custom ID', async () => {
    const f = paypalFixture();
    expect(f.adapter.supportsMetadata).toBe(false);
    await expect(f.adapter.create({ ...order, providerMetadata: { affonso_referral: 'referral-1' } })).rejects.toThrow('does not support');
    expect(f.transport.createOrder).not.toHaveBeenCalled();
  });
  it('forwards SKU and exact server-side money, and never captures on a read', async () => {
    const f = paypalFixture(); await f.adapter.create({ ...order, providerId: 'paypal' });
    expect(f.transport.createOrder).toHaveBeenCalledWith(expect.objectContaining({ paypalRequestId: 'create-1',
      body: expect.objectContaining({ intent: 'CAPTURE', purchaseUnits: [expect.objectContaining({ referenceId: 'order-1',
        amount: { value: '29.00', currencyCode: 'USD', breakdown: { itemTotal: { value: '29.00', currencyCode: 'USD' } } },
        items: [expect.objectContaining({ sku: 'catalog-1', quantity: '1', unitAmount: { value: '29.00', currencyCode: 'USD' } })] })] }) }));
    expect(JSON.stringify(vi.mocked(f.transport.createOrder).mock.calls)).not.toContain('credits');
    expect(await f.adapter.retrieve('paypal-1')).toMatchObject({ state: 'paid', paymentId: 'capture-1', paymentKind: 'capture',
      paidMoney: { amount: '29.00', currency: 'USD' }, catalogReference: 'catalog-1' });
    expect(f.transport.captureOrder).not.toHaveBeenCalled();
    await f.adapter.capture!('paypal-1', 'stored-capture-key');
    expect(f.transport.captureOrder).toHaveBeenCalledWith({ id: 'paypal-1', paypalRequestId: 'stored-capture-key', prefer: 'return=representation' });
  });
  it('requires completed capture evidence and reads its actual amount instead of purchase-unit total', async () => {
    const f = paypalFixture();
    const raw = paypalOrder(); raw.purchaseUnits![0]!.payments!.captures![0]!.amount!.value = '20.00';
    vi.mocked(f.transport.getOrder).mockResolvedValueOnce({ raw, settlement: 'paid' });
    expect((await f.adapter.retrieve('paypal-1')).paidMoney?.amount).toBe('20.00');
    raw.purchaseUnits![0]!.payments = undefined;
    vi.mocked(f.transport.getOrder).mockResolvedValueOnce({ raw, settlement: 'paid' });
    expect(await f.adapter.retrieve('paypal-1')).toMatchObject({ state: 'pending', paidMoney: undefined });
    vi.mocked(f.transport.getOrder).mockResolvedValueOnce({ raw: { ...raw, status: 'APPROVED' as Order['status'] }, settlement: 'unknown' });
    expect((await f.adapter.retrieve('paypal-1')).state).toBe('requires_capture');
    vi.mocked(f.transport.getOrder).mockResolvedValueOnce({ raw: paypalOrder({ status: 'APPROVED' }), settlement: 'unknown' });
    expect((await f.adapter.retrieve('paypal-1')).state).toBe('unknown');
  });
  it('declares one-time support and applies PayPal-specific currency precision', () => {
    const f = paypalFixture(); expect(f.adapter.modes).toEqual(['payment']);
    expect(() => f.adapter.validate({ ...order.offer, money: { amount: '10.50', currency: 'HUF' } })).toThrow();
    expect(() => f.adapter.validate({ ...order.offer, money: { amount: '10', currency: 'NOT' } })).toThrow('unsupported');
  });
  it('verifies first, then reads only IDs from capture/order notifications', async () => {
    const f = paypalFixture();
    const rawBody = JSON.stringify({ id: 'event-1', event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'capture-1', supplementary_data: { related_ids: { order_id: 'paypal-1' } } } });
    expect(await f.adapter.verifyWebhook({ rawBody, headers: { 'PayPal-Transmission-Id': 'transmission-1' } }))
      .toEqual({ eventId: 'event-1', checkoutId: 'paypal-1' });
    expect(f.transport.verifyWebhookSignature).toHaveBeenCalledWith(rawBody, { 'paypal-transmission-id': 'transmission-1' }, 'synthetic-webhook');
    vi.mocked(f.transport.verifyWebhookSignature).mockResolvedValueOnce(false);
    await expect(f.adapter.verifyWebhook({ rawBody: 'not json', headers: {} })).rejects.toThrow('verification failed');
    expect(f.transport.captureOrder).not.toHaveBeenCalled(); expect(f.transport.getOrder).not.toHaveBeenCalled();
  });
});

function creemFixture() {
  const checkout = { id: 'ch_1', mode: 'test', request_id: 'order-1', product: 'catalog-1', units: 1, status: 'completed',
    checkout_url: 'https://www.creem.io/test/payment/ch_1', order: { id: 'ord_1', type: 'onetime', status: 'paid',
      transaction: 'tx_1', amount_paid: 2900, amount_due: 2900, currency: 'USD' } };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(checkout), { status: 200 }));
  const protocol = createCreemAdapter({ apiKey: 'synthetic-key', environment: 'test', webhookSecret: 'synthetic-secret', fetch });
  return { adapter: createCreemHostedCheckoutAdapter({ adapter: protocol, accountScope: 'creem:test:merchant' }), fetch, checkout };
}

describe('Creem hosted catalog protocol', () => {
  it('forwards public metadata independently of its immutable request ID', async () => {
    const f = creemFixture();
    await f.adapter.create({ ...order, providerMetadata: { affonso_referral: 'referral-1' } });
    expect(JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ request_id: order.id,
      metadata: { affonso_referral: 'referral-1' } });
    await expect(f.adapter.create({ ...order, providerMetadata: { request_id: 'foreign-order' } })).rejects.toThrow('reserved');
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('uses the real Creem boundary with catalog/request IDs and exact cents', async () => {
    const f = creemFixture();
    expect(await f.adapter.create({ ...order, providerId: 'creem' })).toMatchObject({ checkoutId: 'ch_1', reference: 'order-1',
      catalogReference: 'catalog-1', quantity: 1, mode: 'payment', state: 'paid', paidMoney: { amount: '29.00', currency: 'USD' },
      paymentId: 'tx_1', paymentKind: 'transaction' });
    expect(JSON.parse(String(f.fetch.mock.calls[0]![1]?.body))).toEqual({ product_id: 'catalog-1', request_id: 'order-1', units: 1, success_url: order.successUrl });
    await f.adapter.retrieve('ch_1');
    expect(String(f.fetch.mock.calls[1]![0])).toBe('https://test-api.creem.io/v1/checkouts?checkout_id=ch_1');
    expect(f.adapter.capture).toBeUndefined();
    expect('refund' in f.adapter).toBe(false);
  });
  it('separates trials and missing actual money from paid initial checkout', async () => {
    const f = creemFixture();
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...f.checkout, order: undefined,
      product: { id: 'catalog-1', billing_type: 'recurring' }, subscription: { id: 'sub_1', status: 'trialing' } }), { status: 200 }));
    expect(await f.adapter.retrieve('ch_1')).toMatchObject({ mode: 'subscription', state: 'unknown', paidMoney: undefined, subscriptionId: 'sub_1' });
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...f.checkout, order: { ...f.checkout.order, amount_paid: undefined } }), { status: 200 }));
    expect((await f.adapter.retrieve('ch_1')).paidMoney).toBeUndefined();
  });
  it('uses original-byte HMAC verification and keeps subscription renewals outside checkout fulfillment', async () => {
    const f = creemFixture();
    const rawBody = JSON.stringify({ id: 'event-1', eventType: 'checkout.completed', created_at: '2026-10-24T00:00:00Z', object: f.checkout });
    const headers = { 'creem-signature': createHmac('sha256', 'synthetic-secret').update(rawBody).digest('hex') };
    expect(await f.adapter.verifyWebhook({ rawBody, headers })).toEqual({ eventId: 'event-1', checkoutId: 'ch_1', reference: 'order-1' });
    await expect(f.adapter.verifyWebhook({ rawBody: `${rawBody} `, headers })).rejects.toThrow('signature');
    const renewal = JSON.stringify({ id: 'event-2', eventType: 'subscription.paid', created_at: '2026-10-24T00:00:00Z',
      object: { id: 'sub_1', mode: 'test', status: 'active', product: 'catalog-1' } });
    expect(await f.adapter.verifyWebhook({ rawBody: renewal, headers: { 'creem-signature': createHmac('sha256', 'synthetic-secret').update(renewal).digest('hex') } })).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
