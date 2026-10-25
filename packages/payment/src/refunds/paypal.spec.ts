import { createPayPalRefundAdapter, type PayPalRefundOptions } from './paypal';
import { PayPalPaymentProtocolError, PayPalPaymentTransport } from '../providers/paypal';
import type { RefundPaymentReference } from './types';
const capture: RefundPaymentReference = { paymentKind: 'capture', paymentId: 'CAPTURE_1', paidMoney: { amount: '29.00', currency: 'USD' } };
const sale: RefundPaymentReference = { ...capture, paymentKind: 'transaction', paymentId: 'SALE_1' };
const captureRefund = { id: 'REFUND_1', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' },
  links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE_1' }], update_time: '2026-10-24T01:00:00Z' };
const saleRefund = { id: 'REFUND_2', state: 'completed', sale_id: 'SALE_1', amount: { total: '10.00', currency: 'USD' } };
function fixture() {
  const transport = { environment: 'sandbox' as const,
    getCapturePayment: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: capture.paymentId, status: 'COMPLETED', amount: { value: '29.00', currency_code: 'USD' } })),
    getSalePayment: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: sale.paymentId, state: 'completed', amount: { total: '29.00', currency: 'USD' } })),
    createCaptureRefund: vi.fn(async (): Promise<Record<string, unknown>> => captureRefund), createSaleRefund: vi.fn(async (): Promise<Record<string, unknown>> => saleRefund),
    getCaptureRefund: vi.fn(async (): Promise<Record<string, unknown>> => captureRefund), getSaleRefund: vi.fn(async (): Promise<Record<string, unknown>> => saleRefund),
    verifyWebhookSignature: vi.fn(async () => true) } satisfies PayPalRefundOptions['transport'];
  return { transport, adapter: createPayPalRefundAdapter({ transport, accountScope: 'paypal-synthetic', webhookId: 'synthetic-webhook' }) };
}
describe('PayPal typed capture and subscription-sale refunds', () => {
  it('sends partial capture money using the capture protocol and persisted key', async () => {
    const f = fixture();
    expect(await f.adapter.create({ payment: capture, money: { amount: '10.00', currency: 'USD' }, commandKey: 'capture-refund-key', reason: 'Requested refund' })).toMatchObject({ refundId: 'REFUND_1', state: 'succeeded', source: { kind: 'capture', id: 'CAPTURE_1' }, money: { amount: '10.00', currency: 'USD' } });
    expect(f.transport.createCaptureRefund).toHaveBeenCalledWith('CAPTURE_1', { amount: { value: '10.00', currency_code: 'USD' }, note_to_payer: 'Requested refund', custom_id: 'capture-refund-key' }, 'capture-refund-key');
    expect(f.transport.createSaleRefund).not.toHaveBeenCalled();
  });
  it('routes sale refunds and lookups independently without confusing a sale ID with a capture ID', async () => {
    const f = fixture();
    expect(await f.adapter.create({ payment: sale, money: { amount: '10.00', currency: 'USD' }, commandKey: 'sale-key', reason: 'Requested refund' })).toMatchObject({ refundId: 'REFUND_2', paymentKind: 'transaction', source: { kind: 'transaction', id: 'SALE_1' } });
    expect(f.transport.createSaleRefund).toHaveBeenCalledWith('SALE_1', { amount: { total: '10.00', currency: 'USD' }, description: 'Requested refund', invoice_number: 'sale-key' }, 'sale-key');
    await f.adapter.retrieve!('REFUND_2', sale); expect(f.transport.getSaleRefund).toHaveBeenCalledWith('REFUND_2');
    expect(f.transport.getCapturePayment).not.toHaveBeenCalled(); expect(f.transport.createCaptureRefund).not.toHaveBeenCalled();
  });
  it('supports explicit full amounts and never invents partial or pending aggregates', async () => {
    const f = fixture(); f.transport.createCaptureRefund.mockResolvedValueOnce({ ...captureRefund, amount: { value: '29.00', currency_code: 'USD' } });
    await f.adapter.create({ payment: capture, money: capture.paidMoney, commandKey: 'full-key' });
    expect(f.transport.createCaptureRefund).toHaveBeenCalledWith('CAPTURE_1', { amount: { value: '29.00', currency_code: 'USD' }, custom_id: 'full-key' }, 'full-key');
    f.transport.getCapturePayment.mockResolvedValueOnce({ id: 'CAPTURE_1', status: 'PARTIALLY_REFUNDED', amount: { value: '29.00', currency_code: 'USD' } });
    const fact = await f.adapter.retrievePayment(capture); expect(fact.settlement).toBe('partially_refunded');
    expect(fact.refundedMoney).toBeUndefined(); expect(fact.pendingRefundMoney).toBeUndefined();
  });
  it.each(['PENDING', 'FAILED', 'CANCELLED', 'NEW_STATUS'])('does not turn %s into a successful refund', async status => {
    const f = fixture(); f.transport.getCaptureRefund.mockResolvedValueOnce({ ...captureRefund, status });
    expect((await f.adapter.retrieve!('REFUND_1', capture)).state).toBe(({ PENDING: 'pending', FAILED: 'failed', CANCELLED: 'canceled', NEW_STATUS: 'unknown' } as Record<string, string>)[status]);
  });
  it('does not invent actual money from an acknowledged successful response', async () => {
    const f = fixture(); f.transport.createCaptureRefund.mockResolvedValueOnce({ id: 'REFUND_1', status: 'COMPLETED' });
    expect(await f.adapter.create({ payment: capture, money: { amount: '10.00', currency: 'USD' }, commandKey: 'no-amount' })).toMatchObject({ state: 'unknown', money: undefined });
    f.transport.getCaptureRefund.mockResolvedValueOnce({ ...captureRefund, amount: { value: '0.00', currency_code: 'USD' } });
    expect((await f.adapter.retrieve!('REFUND_1', capture)).state).toBe('unknown');
  });
  it('rejects bad currency, amount, unsupported references and sale protocol limits before provider IO', async () => {
    const f = fixture();
    for (const command of [
      { payment: capture, money: { amount: '10', currency: 'EUR' }, commandKey: 'a' },
      { payment: capture, money: { amount: '30', currency: 'USD' }, commandKey: 'a' },
      { payment: { ...capture, paymentKind: 'invoice' as const }, money: capture.paidMoney, commandKey: 'a' },
      { payment: sale, money: { amount: '1.001', currency: 'USD' }, commandKey: 'a' },
      { payment: sale, money: sale.paidMoney, commandKey: 'x'.repeat(79) },
    ]) await expect(f.adapter.create(command)).rejects.toThrow();
    expect(f.transport.getCapturePayment).not.toHaveBeenCalled(); expect(f.transport.getSalePayment).not.toHaveBeenCalled();
  });
  it.each(['https://api.paypal.com/v2/payments/captures/CAPTURE_1', 'https://evil.invalid/v2/payments/captures/CAPTURE_1', 'https://api.sandbox.paypal.com/v2/payments/captures/OTHER'])('rejects foreign parent evidence %s', async href => {
    const f = fixture(); f.transport.getCaptureRefund.mockResolvedValueOnce({ ...captureRefund, links: [{ rel: 'up', href }] });
    await expect(f.adapter.retrieve!('REFUND_1', capture)).rejects.toThrow();
  });
  it('requires original payment identity on lookup and validates actual bound money', async () => {
    const f = fixture(); f.transport.getCaptureRefund.mockResolvedValueOnce({ ...captureRefund, links: [] });
    await expect(f.adapter.retrieve!('REFUND_1', capture)).rejects.toThrow('original payment');
    f.transport.getSaleRefund.mockResolvedValueOnce({ ...saleRefund, sale_id: 'other' }); await expect(f.adapter.retrieve!('REFUND_2', sale)).rejects.toThrow('bound payment');
    f.transport.getCapturePayment.mockResolvedValueOnce({ id: 'CAPTURE_1', status: 'COMPLETED', amount: { value: '20.00', currency_code: 'USD' } });
    await expect(f.adapter.retrievePayment(capture)).rejects.toThrow('amount differs');
  });
  it('preserves rejected versus unknown transport outcomes without retrying or exposing raw errors', async () => {
    const f = fixture(), command = { payment: capture, money: { amount: '10.00', currency: 'USD' }, commandKey: 'one' };
    f.transport.createCaptureRefund.mockRejectedValueOnce(new Error('PRIVATE_RESPONSE'));
    await expect(f.adapter.create(command)).rejects.toMatchObject({ outcome: 'unknown', message: expect.not.stringContaining('PRIVATE') });
    expect(f.transport.createCaptureRefund).toHaveBeenCalledOnce();
    f.transport.createCaptureRefund.mockRejectedValueOnce(new PayPalPaymentProtocolError('rejected', 422));
    await expect(f.adapter.create({ ...command, commandKey: 'two' })).rejects.toMatchObject({ outcome: 'rejected' });
  });
  it('verifies capture and sale webhook bodies before returning correctly typed parent facts', async () => {
    const f = fixture();
    const request = { rawBody: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.SALE.REFUNDED', resource: saleRefund }), headers: { 'PayPal-Transmission-Id': 'synthetic' } };
    expect(await f.adapter.verifyWebhook(request)).toMatchObject({ eventId: 'WH-1', refundId: 'REFUND_2', state: 'succeeded', source: { kind: 'transaction', id: 'SALE_1' } });
    expect(f.transport.verifyWebhookSignature).toHaveBeenCalledWith(request.rawBody, { 'paypal-transmission-id': 'synthetic' }, 'synthetic-webhook');
    f.transport.verifyWebhookSignature.mockResolvedValueOnce(false); await expect(f.adapter.verifyWebhook(request)).rejects.toThrow('verification failed');
  });
  it('retains server command correlation on queries and refuses mismatched create acknowledgements', async () => {
    const f = fixture(); f.transport.getCaptureRefund.mockResolvedValueOnce({ ...captureRefund, custom_id: 'stored-command' });
    expect((await f.adapter.retrieve!('REFUND_1', capture)).commandKey).toBe('stored-command');
    f.transport.getSaleRefund.mockResolvedValueOnce({ ...saleRefund, invoice_number: 'stored-sale-command' });
    expect((await f.adapter.retrieve!('REFUND_2', sale)).commandKey).toBe('stored-sale-command');
    f.transport.createCaptureRefund.mockResolvedValueOnce({ ...captureRefund, custom_id: 'foreign-command' });
    await expect(f.adapter.create({ payment: capture, money: { amount: '10.00', currency: 'USD' }, commandKey: 'expected' })).rejects.toThrow('bound payment');
  });
  it('keeps cumulative provider refund totals separate from this individual refund amount', async () => {
    const f = fixture(); f.transport.getCaptureRefund.mockResolvedValueOnce({ ...captureRefund,
      seller_payable_breakdown: { total_refunded_amount: { value: '15.00', currency_code: 'USD' } } });
    expect(await f.adapter.retrieve!('REFUND_1', capture)).toMatchObject({ money: { amount: '10.00' }, totalRefundedMoney: { amount: '15.00', currency: 'USD' } });
    f.transport.getSaleRefund.mockResolvedValueOnce({ ...saleRefund, total_refunded_amount: { value: '20.00', currency: 'USD' } });
    expect((await f.adapter.retrieve!('REFUND_2', sale)).totalRefundedMoney).toEqual({ amount: '20.00', currency: 'USD' });
  });
});

it('transport sends fixed authenticated v1/v2 endpoints with representation and never follows provider redirects', async () => {
  const replies: Record<string, unknown>[] = [{ id: 'CAPTURE_1' }, { id: 'SALE_1' }, captureRefund, saleRefund, captureRefund, saleRefund];
  const fetcher = vi.fn(async (url: string, _request: RequestInit) => new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'synthetic-access' } : replies.shift())));
  const transport = new PayPalPaymentTransport({ mode: 'sandbox', clientId: 'synthetic', clientSecret: 'synthetic', fetcher: fetcher as unknown as typeof fetch });
  await transport.getCapturePayment('CAPTURE_1'); await transport.getSalePayment('SALE_1');
  await transport.createCaptureRefund('CAPTURE_1', { amount: { value: '10.00', currency_code: 'USD' } }, 'cap-key');
  await transport.createSaleRefund('SALE_1', { amount: { total: '10.00', currency: 'USD' } }, 'sale-key');
  await transport.getCaptureRefund('REFUND_1'); await transport.getSaleRefund('REFUND_2');
  const mutations = fetcher.mock.calls.filter(([url]) => url.endsWith('/refund'));
  expect(mutations.map(([url]) => url)).toEqual(['https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE_1/refund', 'https://api.sandbox.paypal.com/v1/payments/sale/SALE_1/refund']);
  expect(mutations[0][1]).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal), headers: { Authorization: 'Bearer synthetic-access', Prefer: 'return=representation', 'PayPal-Request-Id': 'cap-key' } });
  expect(mutations[1][1].body).toBe(JSON.stringify({ amount: { total: '10.00', currency: 'USD' } }));
  expect(fetcher.mock.calls.map(([url]) => url)).toContain('https://api.sandbox.paypal.com/v1/payments/refund/REFUND_2');
});
it('transport never retries server failures and redacts provider response bodies', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic' })))
    .mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_RESPONSE', { status: 503 }));
  const transport = new PayPalPaymentTransport({ mode: 'sandbox', clientId: 'synthetic', clientSecret: 'synthetic', fetcher });
  await expect(transport.createSaleRefund('SALE_1', {}, 'command')).rejects.toMatchObject({ outcome: 'unknown', status: 503, message: expect.not.stringContaining('PRIVATE') });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
