// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCreemAdapter, observeCreemCheckout, observeCreemSubscription, observeCreemTransaction, observeCreemWebhook, verifyCreemWebhookEvent } from './creem';
import { subscriptionPeriodKey } from '../contract/subscription-observation';
import type { WebhookRequest } from '../contract/payment-contract';

const secret = 'synthetic-webhook-secret';
const checkout = (changes: Record<string, unknown> = {}) => ({ id: 'ch_synthetic', mode: 'test', product: 'prod_synthetic',
  request_id: 'request-1', status: 'pending', checkout_url: 'https://checkout.creem.io/ch_synthetic', ...changes });
const subscription = (changes: Record<string, unknown> = {}) => ({ id: 'sub_synthetic', mode: 'test', status: 'active',
  product: { id: 'prod_synthetic', price: 2900, currency: 'USD', billing_type: 'recurring' }, customer: 'cust_synthetic',
  current_period_start_date: '2026-10-01T00:00:00Z', current_period_end_date: '2026-11-01T00:00:00Z', last_transaction_id: 'tran_synthetic', ...changes });
const event = (eventType: string, object: unknown, id = 'evt_synthetic') => ({ id, eventType, created_at: Date.parse('2026-10-23T12:00:00Z'), object });
function signed(value: unknown): WebhookRequest {
  const rawBody = JSON.stringify(value);
  return { rawBody, headers: { 'creem-signature': createHmac('sha256', secret).update(rawBody).digest('hex') } };
}
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const adapter = createCreemAdapter({ apiKey: 'synthetic-api-key', environment: 'test', webhookSecret: secret, fetch });
  return { fetch, adapter };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

 describe('Creem catalog Checkout transport', () => {
  it.each(['prod_onetime', 'prod_recurring'])('creates %s through the catalog API and forwards stable request identity without inventing payment evidence', async productId => {
    const { fetch, adapter } = setup();
    fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return json(checkout({ product: body.product_id, request_id: body.request_id }));
    });
    const input = { productId, requestId: 'stored-order-attempt', units: 2, successUrl: 'https://consumer.example/return',
      customer: { email: 'synthetic@example.test' }, discountCode: 'SYNTHETIC', affiliateCode: 'synthetic-referral', metadata: { orderId: 'order-1' } };
    const first = await adapter.createCheckout(input);
    const replay = await adapter.createCheckout(input);
    expect(first.id).toBe(replay.id);
    expect(first).toMatchObject({ productId, requestId: 'stored-order-attempt', state: 'created' });
    expect(first.paidMoney).toBeUndefined(); expect(first.dueMoney).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2); // No hidden cache or automatic third request.
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://test-api.creem.io/v1/checkouts');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-api-key': 'synthetic-api-key' } });
      expect(JSON.parse(String(init?.body))).toEqual({ product_id: productId, request_id: 'stored-order-attempt', units: 2,
        success_url: input.successUrl, customer: input.customer, discount_code: 'SYNTHETIC', affiliate_code: 'synthetic-referral', metadata: input.metadata });
    }
  });

  it('transmits a caller-provided one-time custom cents price unchanged and rejects malformed input before dispatch', async () => {
    const { fetch, adapter } = setup(); fetch.mockResolvedValue(json(checkout()));
    await adapter.createCheckout({ productId: 'prod_synthetic', requestId: 'request-1', customPrice: 1500 });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).custom_price).toBe(1500);
    for (const fields of [{ productId: '' }, { requestId: '' }, { units: 0 }, { units: 1.5 }, { customPrice: 99 }, { customPrice: 100000000 }, { successUrl: 'javascript:alert(1)' }]) {
      await expect(adapter.createCheckout({ productId: 'prod_synthetic', requestId: 'request-1', ...fields })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses encoded read-only queries and does not capture during checkout/subscription reconciliation', async () => {
    const { fetch, adapter } = setup();
    fetch.mockResolvedValueOnce(json(checkout({ id: 'ch /?#' })))
      .mockResolvedValueOnce(json(subscription()))
      .mockResolvedValueOnce(json({ id: 'tran_synthetic', mode: 'test', status: 'paid', amount_paid: 3509, currency: 'USD' }));
    await adapter.retrieveCheckout('ch /?#'); await adapter.retrieveSubscription('sub_synthetic');
    expect(await adapter.retrieveTransaction('tran_synthetic')).toMatchObject({ state: 'captured', money: { amount: '35.09', currency: 'USD' } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://test-api.creem.io/v1/checkouts?checkout_id=ch+%2F%3F%23',
      'https://test-api.creem.io/v1/subscriptions?subscription_id=sub_synthetic', 'https://test-api.creem.io/v1/transactions?transaction_id=tran_synthetic']);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('keeps actual paid, amount due and trial/lifecycle evidence distinct', () => {
    expect(observeCreemCheckout(checkout({ status: 'completed', subscription: subscription({ status: 'trialing' }) })).state).toBe('unknown');
    expect(observeCreemCheckout(checkout({ status: 'processing' })).state).toBe('unknown');
    expect(observeCreemCheckout(checkout({ status: 'expired' })).state).toBe('canceled');
    expect(observeCreemCheckout(checkout({ status: 'completed', order: { id: 'ord_1', status: 'paid', transaction: 'tran_1', amount: 2900, amount_due: 3509, amount_paid: 3300, currency: 'USD' } })))
      .toMatchObject({ state: 'captured', orderId: 'ord_1', transactionId: 'tran_1', paidMoney: { amount: '33.00', currency: 'USD' }, dueMoney: { amount: '35.09', currency: 'USD' } });
    expect(observeCreemCheckout(checkout({ status: 'completed', order: { status: 'paid', amount: 2900, currency: 'USD' } })).paidMoney).toBeUndefined();
    expect(() => observeCreemTransaction({ id: 'tran', amount_paid: 1.5, currency: 'USD' })).toThrow('invalid cents');
    expect(observeCreemTransaction({ id: 'tran', status: 'chargeback' }).state).toBe('unknown');
  });

  it('rejects wrong resources, wrong environment and missing identities rather than exposing unrelated provider data', async () => {
    const { fetch, adapter } = setup();
    fetch.mockResolvedValueOnce(json(checkout({ id: 'wrong' })))
      .mockResolvedValueOnce(json(checkout({ mode: 'prod' })))
      .mockResolvedValueOnce(json(checkout({ product: 'another_product' })))
      .mockResolvedValueOnce(json({ status: 'completed' }));
    await expect(adapter.retrieveCheckout('ch_synthetic')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(adapter.retrieveCheckout('ch_synthetic')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(adapter.createCheckout({ productId: 'prod_synthetic', requestId: 'request-1' })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(adapter.createCheckout({ productId: 'prod_synthetic', requestId: 'request-1' })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each(['pending', 'requiresAction', 'failed', 'canceled', 'new-state'])('does not report refund status %s as completed and sends no invented amount/idempotency fields', async status => {
    const { fetch, adapter } = setup(); fetch.mockResolvedValue(json({ status }));
    const result = await adapter.refundTransaction('tran_synthetic');
    expect(result.state).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://test-api.creem.io/v1/refunds');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ transaction_id: 'tran_synthetic' });
    expect(adapter.capabilities.refund).toBe('full-remaining');
    expect(adapter.capabilities.refundIdempotency).toBe('not-declared');
    expect(result).not.toHaveProperty('refundRef'); // This endpoint only promises a status response.
  });

  it('recognizes explicitly succeeded full-remaining refunds without claiming a fabricated receipt ID', async () => {
    const { fetch, adapter } = setup(); fetch.mockResolvedValue(json({ status: 'succeeded' }));
    expect(await adapter.refundTransaction('tran_synthetic')).toMatchObject({ transactionId: 'tran_synthetic', status: 'succeeded', state: 'refunded' });
  });

  it('preserves explicit scheduled cancellation semantics and rejects unsupported combinations', async () => {
    const { fetch, adapter } = setup(); fetch.mockResolvedValue(json(subscription({ status: 'scheduled_cancel' })));
    expect(await adapter.cancelSubscription('sub_synthetic', { mode: 'scheduled', onExecute: 'cancel' })).toMatchObject({ status: 'active', providerStatus: 'scheduled_cancel', cancelAtPeriodEnd: true });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ mode: 'scheduled', onExecute: 'cancel' });
    await expect(adapter.cancelSubscription('sub_synthetic', { mode: 'immediate', onExecute: 'pause' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not automatically retry ambiguous writes and keeps provider errors/secrets out of messages', async () => {
    const { fetch, adapter } = setup();
    fetch.mockRejectedValueOnce(new Error('synthetic-api-key inside transport error'))
      .mockResolvedValueOnce(new Response('synthetic-api-key provider body', { status: 503 }))
      .mockResolvedValueOnce(new Response('synthetic-api-key bad request', { status: 400 }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(adapter.refundTransaction('tran_synthetic')).rejects.toMatchObject({ code: 'transport_error', outcome: 'unknown', message: expect.not.stringContaining('synthetic-api-key') });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(adapter.refundTransaction('tran_synthetic')).rejects.toMatchObject({ code: 'http_error', status: 503, outcome: 'unknown', message: 'Creem returned HTTP 503' });
    await expect(adapter.refundTransaction('tran_synthetic')).rejects.toMatchObject({ status: 400, outcome: 'rejected' });
    await expect(adapter.refundTransaction('tran_synthetic')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe('Creem verified event observations', () => {
  it('verifies exact raw bytes, accepts header casing and rejects tampering, missing/malformed signatures or missing config', () => {
    const original = signed(event('checkout.completed', checkout()));
    expect(verifyCreemWebhookEvent(original, secret).id).toBe('evt_synthetic');
    expect(verifyCreemWebhookEvent({ rawBody: Buffer.from(String(original.rawBody)), headers: { 'Creem-Signature': original.headers['creem-signature'] } }, secret).id).toBe('evt_synthetic');
    const invalidRequests: WebhookRequest[] = [{ ...original, rawBody: `${original.rawBody} ` }, { ...original, headers: {} }, { ...original, headers: { 'creem-signature': 'ab' } },
      { ...original, headers: { ...original.headers, 'CREEM-SIGNATURE': original.headers['creem-signature'] } }];
    for (const request of invalidRequests) {
      expect(() => verifyCreemWebhookEvent(request, secret)).toThrow('signature');
    }
    expect(() => verifyCreemWebhookEvent(original, '')).toThrow('not configured');
    expect(() => verifyCreemWebhookEvent(signed({ eventType: 'checkout.completed', created_at: Date.now(), object: checkout() }), secret)).toThrow('identifier');
  });

  it('separates current cycle and last transaction evidence and makes cycle identity independent of event/product versions', () => {
    const raw = subscription();
    expect(observeCreemSubscription(raw).payment.settlement).toBe('unknown');
    const active = observeCreemWebhook(event('subscription.active', raw));
    expect(active.subscription?.payment.settlement).toBe('unknown');
    const paid = observeCreemWebhook(event('subscription.paid', raw));
    const replay = observeCreemWebhook(event('subscription.paid', { ...raw, product: 'updated-product' }, 'evt_replay'));
    expect(paid.subscription).toMatchObject({ provider: 'creem', subscriptionId: 'sub_synthetic', eventId: 'evt_synthetic',
      payment: { settlement: 'paid', transactionId: 'tran_synthetic', period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' } } });
    const key = (value: NonNullable<typeof paid.subscription>) => subscriptionPeriodKey({ provider: value.provider, accountScope: 'synthetic-store', subscriptionId: value.subscriptionId, period: value.payment.period! });
    expect(key(paid.subscription!)).toBe(key(replay.subscription!));
    expect(observeCreemWebhook(event('subscription.expired', raw)).subscription?.status).toBe('active');
    expect(observeCreemWebhook(event('subscription.trialing', { ...raw, status: 'trialing' })).subscription?.payment.settlement).toBe('unknown');
  });

  it('does not label the current period paid solely because a previous paid transaction is expanded', () => {
    const observed = observeCreemSubscription(subscription({ last_transaction: { id: 'tran_previous', status: 'paid', amount_paid: 2900, currency: 'USD',
      period_start: Date.parse('2026-09-01T00:00:00Z'), period_end: Date.parse('2026-10-01T00:00:00Z') } }));
    expect(observed.payment.period?.end).toBe('2026-10-01T00:00:00.000Z');
    expect(observed.period?.start).toBe('2026-10-01T00:00:00.000Z');
    expect(observed.payment.period).not.toEqual(observed.period);
  });

  it('reports partial refunds from the original transaction and leaves unknown/dispute events nonterminal', () => {
    const refund = observeCreemWebhook(event('refund.created', { id: 'ref_synthetic', status: 'succeeded', refund_amount: 1000, refund_currency: 'USD',
      checkout: 'ch_synthetic', transaction: { id: 'tran_synthetic', status: 'partially_refunded', amount_paid: 2900, currency: 'USD' } }));
    expect(refund.refund).toMatchObject({ id: 'ref_synthetic', transactionId: 'tran_synthetic', checkoutId: 'ch_synthetic', paymentState: 'partially_refunded', money: { amount: '10.00', currency: 'USD' } });
    expect(observeCreemWebhook(event('dispute.created', { id: 'dispute', transaction: { id: 'tran_synthetic', status: 'chargeback' } })).transaction?.state).toBe('unknown');
    expect(observeCreemWebhook(event('future.unknown', { id: 'future' }))).toMatchObject({ type: 'future.unknown', resourceId: 'future' });
    expect(() => observeCreemWebhook(event('refund.created', { id: 'ref', transaction: {} }))).toThrow('identifier');
  });

  it('parseWebhook rejects cross-environment signed events without making a network request', () => {
    const { fetch, adapter } = setup();
    expect(adapter.parseWebhook(signed(event('checkout.completed', checkout()))).eventId).toBe('evt_synthetic');
    expect(() => adapter.parseWebhook(signed(event('checkout.completed', checkout({ mode: 'prod' }))))).toThrow('environment');
    expect(fetch).not.toHaveBeenCalled();
  });
});
