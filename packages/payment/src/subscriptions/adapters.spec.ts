import type Stripe from 'stripe';
import { createStripeSubscriptionAdapter } from './stripe';
import { createCreemSubscriptionAdapter } from './creem';
import { createCreemAdapter } from '../providers/creem';
import { createPayPalSubscriptionAdapter, type PayPalSubscriptionOptions } from './paypal';
import { encodeCursor } from './validation';

const start = '2026-01-01T00:00:00.000Z', end = '2026-02-01T00:00:00.000Z';
const seconds = (s: string) => Date.parse(s) / 1000;
function invoice(id = 'in_1', changes: Record<string, unknown> = {}): Stripe.Invoice {
  return { id, livemode: false, status: 'paid', currency: 'usd', amount_paid: 2387,
    customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } },
    status_transitions: { paid_at: seconds(start) }, hosted_invoice_url: 'https://invoice.stripe.com/i/synthetic',
    lines: { has_more: false, data: [{ id: 'il_1', quantity: 1, period: { start: seconds(start), end: seconds(end) },
      parent: { subscription_item_details: { subscription: 'sub_1', proration: false } }, pricing: { price_details: { price: 'price_1' } } }] },
    ...changes } as unknown as Stripe.Invoice;
}
function stripeFixture() {
  const raw = { id: 'sub_1', livemode: false, status: 'active', customer: 'cus_1', latest_invoice: invoice(), cancel_at_period_end: false,
    items: { has_more: false, data: [{ price: { id: 'price_1', product: 'prod_1' }, current_period_start: seconds(start), current_period_end: seconds(end) }] } };
  const subscriptions = { retrieve: vi.fn(async () => raw), update: vi.fn(), cancel: vi.fn() };
  const invoices = { list: vi.fn(async () => ({ data: [invoice()], has_more: false })), retrieve: vi.fn(async () => invoice()) };
  const createPortal = vi.fn(async () => ({ customer: 'cus_1', url: 'https://billing.stripe.com/p/session' }));
  const constructEvent = vi.fn(() => ({ id: 'evt_1', livemode: false, type: 'invoice.paid', data: { object: invoice() } }));
  const client = { subscriptions, invoices, billingPortal: { sessions: { create: createPortal } }, webhooks: { constructEvent } } as unknown as Parameters<typeof createStripeSubscriptionAdapter>[0]['client'];
  return { adapter: createStripeSubscriptionAdapter({ client, accountScope: 'stripe-test', livemode: false, webhookSecret: 'synthetic' }),
    subscriptions, invoices, createPortal, constructEvent, raw };
}

describe('Stripe subscription protocol', () => {
  it('reads current item periods without inventing last invoice payment periods', async () => {
    const f = stripeFixture();
    expect(await f.adapter.retrieve('sub_1')).toMatchObject({ catalogReference: 'price_1', period: { start, end }, payment: { transactionId: 'in_1', settlement: 'paid' } });
    expect((await f.adapter.retrieve('sub_1')).payment.period).toBeUndefined();
  });
  it('paginates offline invoices with actual amount and stable invoice receipt identity', async () => {
    const f = stripeFixture();
    f.invoices.list.mockResolvedValueOnce({ data: [invoice()], has_more: true })
      .mockResolvedValueOnce({ data: [invoice('in_2', { amount_paid: 1999 })], has_more: false });
    const first = await f.adapter.listPaidPeriods('sub_1');
    const second = await f.adapter.listPaidPeriods('sub_1', { cursor: first.nextCursor });
    expect(first.data[0]).toEqual({ recordId: 'in_1', subscriptionId: 'sub_1', catalogReference: 'price_1', period: { start, end },
      paidMoney: { amount: '23.87', currency: 'USD' }, paymentId: 'in_1', paymentKind: 'invoice', paidAt: start });
    expect(second.data[0]?.paidMoney.amount).toBe('19.99');
    expect(f.invoices.list).toHaveBeenLastCalledWith({ subscription: 'sub_1', status: 'paid', limit: 100, starting_after: 'in_1' });
  });
  it('reports ambiguous/prorated/partial line evidence and does not grant zero paid invoices', async () => {
    const f = stripeFixture(), prorated = invoice();
    prorated.lines.data[0].parent!.subscription_item_details!.proration = true;
    f.invoices.list.mockResolvedValueOnce({ has_more: false, data: [prorated, invoice('in_empty', { lines: { data: [], has_more: true } }), invoice('in_free', { amount_paid: 0 })] });
    const result = await f.adapter.listPaidPeriods('sub_1');
    expect(result.data).toEqual([]); expect(result.issues).toHaveLength(2);
  });
  it('rejects foreign account/subscription/customer and nonadvancing pagination', async () => {
    const f = stripeFixture();
    f.invoices.list.mockResolvedValueOnce({ has_more: false, data: [invoice('in_foreign', { customer: 'cus_foreign' })] });
    await expect(f.adapter.listPaidPeriods('sub_1')).rejects.toThrow('different resource');
    f.invoices.list.mockResolvedValueOnce({ has_more: false, data: [invoice('in_wrong', { livemode: true })] });
    await expect(f.adapter.listPaidPeriods('sub_1')).rejects.toThrow('environment');
    await expect(f.adapter.listPaidPeriods('sub_1', { cursor: encodeCursor({ provider: 'stripe', accountScope: 'other', subscriptionId: 'sub_1', after: 'in_1' }) })).rejects.toThrow('cursor identity');
    f.invoices.list.mockResolvedValueOnce({ has_more: true, data: [] });
    await expect(f.adapter.listPaidPeriods('sub_1')).rejects.toThrow('no progress');
  });
  it('returns only re-read cancellation facts, including still-active or unknown outcomes', async () => {
    const f = stripeFixture();
    expect((await f.adapter.cancel('sub_1', { mode: 'period_end' })).cancelAtPeriodEnd).toBe(false);
    expect(f.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    f.subscriptions.retrieve.mockResolvedValueOnce({ ...f.raw, status: 'future_status' });
    expect((await f.adapter.cancel('sub_1', { mode: 'immediate' })).status).toBe('unknown');
    expect(f.subscriptions.cancel).toHaveBeenCalledWith('sub_1');
  });
  it('creates a customer-specific portal and retrieves actual invoice facts', async () => {
    const f = stripeFixture();
    expect(await f.adapter.createBillingPortal!({ customerId: 'cus_1', returnUrl: 'https://app.example/billing' })).toEqual({ url: 'https://billing.stripe.com/p/session' });
    await f.adapter.createBillingPortal!({ customerId: 'cus_1', returnUrl: 'http://localhost:4202/billing/subscriptions' });
    expect(f.createPortal).toHaveBeenLastCalledWith({ customer: 'cus_1', return_url: 'http://localhost:4202/billing/subscriptions' });
    expect(await f.adapter.retrieveInvoice!('in_1')).toMatchObject({ id: 'in_1', subscriptionId: 'sub_1', customerId: 'cus_1', status: 'paid', paidMoney: { amount: '23.87', currency: 'USD' } });
    f.createPortal.mockResolvedValueOnce({ customer: 'foreign', url: 'https://billing.stripe.com/p/session' });
    await expect(f.adapter.createBillingPortal!({ customerId: 'cus_1' })).rejects.toThrow('different resource');
  });
  it('verifies original webhook bytes before correlating invoice subscription', async () => {
    const f = stripeFixture(); const request = { rawBody: ' {"untouched":true}', headers: { 'Stripe-Signature': 'signed' } };
    expect(await f.adapter.verifyWebhook!(request)).toEqual({ eventId: 'evt_1', subscriptionId: 'sub_1' });
    expect(f.constructEvent).toHaveBeenCalledWith(request.rawBody, 'signed', 'synthetic');
    await expect(f.adapter.verifyWebhook!({ ...request, headers: {} })).rejects.toThrow('signature');
  });
});

function creemFixture() {
  const transaction = { id: 'tran_1', mode: 'test', customer: 'cust_1', subscription: 'sub_1', amount_paid: 2387, currency: 'USD', status: 'paid',
    created_at: Date.parse(start), period_start: Date.parse(start), period_end: Date.parse(end) };
  const subscription = { id: 'sub_1', mode: 'test', customer: 'cust_1', product: 'prod_1', status: 'active', current_period_start_date: start, current_period_end_date: end };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/transactions/search')) return new Response(JSON.stringify({ items: [transaction], pagination: { current_page: 1, total_pages: 1, next_page: null } }));
    if (url.includes('/customers/billing')) return new Response(JSON.stringify({ customer_portal_link: 'https://creem.io/portal/one' }));
    if (init.method === 'POST') return new Response(JSON.stringify({ ...subscription, status: 'scheduled_cancel' }));
    return new Response(JSON.stringify(subscription));
  });
  const transport = createCreemAdapter({ apiKey: 'synthetic', environment: 'test', fetch: fetcher as unknown as typeof fetch });
  return { adapter: createCreemSubscriptionAdapter({ transport, accountScope: 'creem-test' }), fetcher, transaction, subscription };
}
describe('Creem subscription protocol', () => {
  it('uses product/customer search pagination and exact transaction periods/paid cents', async () => {
    const f = creemFixture();
    const page = await f.adapter.listPaidPeriods('sub_1');
    expect(page.data[0]).toMatchObject({ recordId: 'tran_1', period: { start, end }, paidMoney: { amount: '23.87', currency: 'USD' }, catalogReference: 'prod_1' });
    expect(f.fetcher.mock.calls[1][0]).toBe('https://test-api.creem.io/v1/transactions/search?customer_id=cust_1&product_id=prod_1&page_number=1&page_size=100');
  });
  it('keeps another subscription out and reports missing evidence', async () => {
    const f = creemFixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(f.subscription))).mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ ...f.transaction, id: 'other', subscription: 'sub_other' }, { ...f.transaction, period_end: undefined }],
      pagination: { current_page: 1, total_pages: 1, next_page: null } })));
    const page = await f.adapter.listPaidPeriods('sub_1'); expect(page.data).toEqual([]);
    expect(page.issues).toEqual([{ recordId: 'tran_1', code: 'missing_period' }]);
  });
  it('recovers later Creem transaction pages with a subscription-bound cursor', async () => {
    const f = creemFixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(f.subscription)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [f.transaction], pagination: { current_page: 1, total_pages: 2, next_page: 2 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(f.subscription)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...f.transaction, id: 'tran_2' }], pagination: { current_page: 2, total_pages: 2, next_page: null } })));
    const first = await f.adapter.listPaidPeriods('sub_1');
    const second = await f.adapter.listPaidPeriods('sub_1', { cursor: first.nextCursor });
    expect(second.data[0]?.recordId).toBe('tran_2'); expect(second.nextCursor).toBeUndefined();
    expect(f.fetcher.mock.calls[3][0]).toContain('page_number=2');
  });
  it('re-reads cancellation and exposes portal capability without invented invoices/returns', async () => {
    const f = creemFixture();
    expect((await f.adapter.cancel('sub_1', { mode: 'period_end' })).status).toBe('active');
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1].body))).toEqual({ mode: 'scheduled', onExecute: 'cancel' });
    expect(await f.adapter.createBillingPortal!({ customerId: 'cust_1' })).toEqual({ url: 'https://creem.io/portal/one' });
    await expect(f.adapter.createBillingPortal!({ customerId: 'cust_1', returnUrl: 'https://app.example' })).rejects.toThrow('return URL');
    expect(f.adapter.retrieveInvoice).toBeUndefined();
  });
  it('rejects returned environment/customer mismatches and incomplete pagination', async () => {
    for (const change of [{ customer: 'foreign' }, { mode: 'prod' }]) {
      const f = creemFixture();
      f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(f.subscription))).mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ ...f.transaction, ...change }], pagination: { current_page: 1, total_pages: 1, next_page: null } })));
      await expect(f.adapter.listPaidPeriods('sub_1')).rejects.toThrow();
    }
    const f = creemFixture();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(f.subscription))).mockResolvedValueOnce(new Response(JSON.stringify({ items: [], pagination: { current_page: 1, total_pages: 2, next_page: null } })));
    await expect(f.adapter.listPaidPeriods('sub_1')).rejects.toThrow('Incomplete');
  });
});

function paypalFixture(extra: Partial<PayPalSubscriptionOptions> = {}) {
  const raw = { id: 'I-SUB', plan_id: 'P-PLAN', status: 'ACTIVE', create_time: start, start_time: start,
    subscriber: { payer_id: 'payer' }, billing_info: { next_billing_time: end, last_payment: { time: start, amount: { value: '29.00', currency_code: 'USD' } } } };
  const transaction = { id: 'SALE-1', status: 'COMPLETED', time: start, amount_with_breakdown: { gross_amount: { value: '23.87', currency_code: 'USD' } } };
  const transport = { getSubscription: vi.fn(async () => raw), cancelSubscription: vi.fn(async () => undefined),
    listSubscriptionTransactions: vi.fn(async (_id: string, _input: { startTime: string; endTime: string; cursor?: string }) => ({ transactions: [transaction], nextCursor: undefined as string | undefined })),
    verifyWebhookSignature: vi.fn(async () => true) };
  const adapter = createPayPalSubscriptionAdapter({ transport, accountScope: 'paypal-test', now: () => new Date('2026-01-15T00:00:00Z'), webhookId: 'webhook', ...extra });
  return { adapter, transport, raw, transaction };
}
describe('PayPal subscription payment evidence', () => {
  it('exposes actual paid receipts and never guesses period from next billing or payment time', async () => {
    const f = paypalFixture();
    const page = await f.adapter.listPaidReceipts!('I-SUB');
    expect(page.data[0]).toEqual({ recordId: 'SALE-1', subscriptionId: 'I-SUB', catalogReference: 'P-PLAN', paidMoney: { amount: '23.87', currency: 'USD' }, paymentId: 'SALE-1', paymentKind: 'transaction', paidAt: start });
    expect((await f.adapter.retrieve('I-SUB')).period).toBeUndefined();
    expect(await f.adapter.listPaidPeriods('I-SUB')).toMatchObject({ data: [], issues: [{ recordId: 'SALE-1', code: 'missing_period' }] });
    expect(f.adapter.capabilities).toMatchObject({ paidReceiptProof: 'provider', paidPeriodProof: 'unavailable', billingPortal: false, invoices: false });
  });
  it('recovers multiple offline windows and pages without moving the snapshot end', async () => {
    const f = paypalFixture({ now: () => new Date('2026-03-15T00:00:00Z') });
    f.transport.listSubscriptionTransactions.mockResolvedValueOnce({ transactions: [f.transaction], nextCursor: 'page=2' })
      .mockResolvedValueOnce({ transactions: [], nextCursor: undefined }).mockResolvedValueOnce({ transactions: [{ ...f.transaction, id: 'SALE-2', time: end }], nextCursor: undefined });
    const one = await f.adapter.listPaidReceipts!('I-SUB'); const two = await f.adapter.listPaidReceipts!('I-SUB', { cursor: one.nextCursor });
    const three = await f.adapter.listPaidReceipts!('I-SUB', { cursor: two.nextCursor });
    expect(three.data[0]?.paymentId).toBe('SALE-2');
    expect(f.transport.listSubscriptionTransactions.mock.calls[1]).toEqual(['I-SUB', { startTime: start, endTime: end, cursor: 'page=2' }]);
    expect(f.transport.listSubscriptionTransactions.mock.calls[2][1]).toMatchObject({ startTime: end, endTime: '2026-03-04T00:00:00.000Z' });
  });
  it('does not emit pending/failed/refunded transactions as paid receipts', async () => {
    const f = paypalFixture();
    f.transport.listSubscriptionTransactions.mockResolvedValueOnce({ transactions: ['PENDING', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].map((status) => ({ ...f.transaction, status })), nextCursor: undefined });
    expect((await f.adapter.listPaidReceipts!('I-SUB')).data).toEqual([]);
  });
  it('validates an explicit durable period receipt against account, plan and payment identities', async () => {
    const resolver = vi.fn(async () => ({ accountScope: 'paypal-test', subscriptionId: 'I-SUB', catalogReference: 'P-PLAN', paymentId: 'SALE-1', period: { start, end } }));
    const f = paypalFixture({ resolvePeriodReceipt: resolver });
    expect((await f.adapter.listPaidPeriods('I-SUB')).data[0]?.period).toEqual({ start, end });
    resolver.mockResolvedValueOnce({ accountScope: 'foreign', subscriptionId: 'I-SUB', catalogReference: 'P-PLAN', paymentId: 'SALE-1', period: { start, end } });
    await expect(f.adapter.listPaidPeriods('I-SUB')).rejects.toThrow('different resource');
  });
  it('rejects wrong resource and foreign or malformed cursors', async () => {
    const f = paypalFixture();
    f.transport.getSubscription.mockResolvedValueOnce({ ...f.raw, id: 'I-FOREIGN' });
    await expect(f.adapter.retrieve('I-SUB')).rejects.toThrow('different resource');
    await expect(f.adapter.listPaidReceipts!('I-SUB', { cursor: encodeCursor({ provider: 'paypal', accountScope: 'foreign', subscriptionId: 'I-SUB', planId: 'P-PLAN' }) })).rejects.toThrow('identity mismatch');
  });
  it('never claims scheduled cancellation and returns the post-command read even when active', async () => {
    const f = paypalFixture();
    await expect(f.adapter.cancel('I-SUB', { mode: 'period_end' })).rejects.toThrow('scheduled');
    expect(f.transport.cancelSubscription).not.toHaveBeenCalled();
    expect((await f.adapter.cancel('I-SUB', { mode: 'immediate' })).status).toBe('active');
    f.transport.getSubscription.mockRejectedValueOnce(new Error('synthetic disconnect'));
    await expect(f.adapter.cancel('I-SUB', { mode: 'immediate' })).rejects.toThrow('disconnect');
  });
  it('only uses verified billing/sale webhook correlation', async () => {
    const f = paypalFixture(); const request = { headers: {}, rawBody: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-SUB' } }) };
    expect(await f.adapter.verifyWebhook!(request)).toEqual({ eventId: 'WH-1', subscriptionId: 'I-SUB' });
    f.transport.verifyWebhookSignature.mockResolvedValueOnce(false);
    await expect(f.adapter.verifyWebhook!(request)).rejects.toThrow('verification failed');
  });
});
