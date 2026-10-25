import { createHmac } from 'node:crypto';
import { createCreemAdapter } from '../providers/creem';
import { createCreemRefundAdapter } from './creem';
import type { RefundPaymentReference } from './types';
const payment: RefundPaymentReference = { paymentKind: 'transaction', paymentId: 'tran_1', paidMoney: { amount: '29.00', currency: 'USD' } };
function fixture() {
  const transaction: Record<string, unknown> = { id: 'tran_1', mode: 'test', status: 'paid', amount_paid: 2900, currency: 'USD', refunded_amount: null };
  const reply: Record<string, unknown> = { status: 'succeeded' };
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === 'GET' ? transaction : reply)));
  const transport = createCreemAdapter({ apiKey: 'synthetic', environment: 'test', webhookSecret: 'synthetic-signature-secret', fetch: fetcher as unknown as typeof fetch });
  return { adapter: createCreemRefundAdapter({ transport, accountScope: 'creem-synthetic' }), fetcher, transaction, reply };
}
describe('Creem full-remaining refunds without fabricated provider capabilities', () => {
  it('sends only transaction_id and preserves a status-only acknowledgment as unknown evidence', async () => {
    const f = fixture(); const result = await f.adapter.create({ payment, money: payment.paidMoney, commandKey: 'persisted-command' });
    expect(result).toMatchObject({ state: 'unknown', providerStatus: 'succeeded', refundId: undefined, money: undefined });
    expect(f.fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ transaction_id: 'tran_1' }));
    expect(f.fetcher.mock.calls[1][1].headers).not.toHaveProperty('Idempotency-Key');
    expect(f.adapter.capabilities).toEqual({ paymentKinds: ['transaction'], partial: false, requestIdempotency: 'none', retrieveRefund: false, listRefunds: false });
    expect(f.adapter.retrieve).toBeUndefined(); expect(f.adapter.listRefunds).toBeUndefined();
  });
  it('uses actual amount_paid and aggregate refunded_amount to support only the exact remaining total', async () => {
    const f = fixture(); Object.assign(f.transaction, { amount: 9999, status: 'partially_refunded', refunded_amount: 1000 });
    await expect(f.adapter.create({ payment, money: { amount: '10.00', currency: 'USD' }, commandKey: 'partial' })).rejects.toMatchObject({ code: 'unsupported', outcome: 'rejected' });
    expect(f.fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    const facts = await f.adapter.retrievePayment(payment); expect(facts).toMatchObject({ paidMoney: { amount: '29.00' }, refundedMoney: { amount: '10.00' }, settlement: 'partially_refunded' });
    await f.adapter.create({ payment, money: { amount: '19.00', currency: 'USD' }, commandKey: 'remainder' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it.each(['pending', 'requiresAction', 'failed', 'canceled', 'future_status'])('preserves %s as its actual non-success state', async status => {
    const f = fixture(); f.reply.status = status;
    expect((await f.adapter.create({ payment, money: payment.paidMoney, commandKey: 'command' })).state).toBe(status === 'requiresAction' ? 'requires_action' : status === 'future_status' ? 'unknown' : status);
  });
  it('requires actual refund identity and amount before accepting an expanded successful receipt', async () => {
    const f = fixture(); Object.assign(f.reply, { id: 'ref_1', transaction: 'tran_1', refund_amount: 2900, refund_currency: 'USD' });
    expect(await f.adapter.create({ payment, money: payment.paidMoney, commandKey: 'command' })).toMatchObject({ refundId: 'ref_1', state: 'succeeded', money: { amount: '29.00', currency: 'USD' } });
    f.reply.transaction = 'foreign'; await expect(f.adapter.create({ payment, money: payment.paidMoney, commandKey: 'different' })).rejects.toThrow('bound payment');
  });
  it('refuses unknown remaining totals and wrong resource/currency/environment before posting', async () => {
    for (const changes of [{ status: 'partially_refunded', refunded_amount: null }, { amount_paid: 1000 }, { currency: 'EUR' }, { mode: 'prod' }, { id: 'foreign' }]) {
      const f = fixture(); Object.assign(f.transaction, changes);
      await expect(f.adapter.create({ payment, money: payment.paidMoney, commandKey: 'command' })).rejects.toThrow();
      expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    }
  });
  it('parses signed partial-refund facts independently of its full-only command capability', async () => {
    const f = fixture();
    const rawBody = JSON.stringify({ id: 'evt_1', eventType: 'refund.created', created_at: Date.parse('2026-10-24T01:00:00Z'), object: {
      id: 'ref_partial', mode: 'test', status: 'succeeded', refund_amount: 1000, refund_currency: 'USD',
      transaction: { ...f.transaction, status: 'partially_refunded', refunded_amount: 1000 } } });
    const signature = createHmac('sha256', 'synthetic-signature-secret').update(rawBody).digest('hex');
    expect(await f.adapter.verifyWebhook({ rawBody, headers: { 'creem-signature': signature } })).toMatchObject({ eventId: 'evt_1', refundId: 'ref_partial', source: { kind: 'transaction', id: 'tran_1' }, state: 'succeeded', money: { amount: '10.00', currency: 'USD' } });
    await expect(f.adapter.verifyWebhook({ rawBody: `${rawBody} `, headers: { 'creem-signature': signature } })).rejects.toThrow('verification failed');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not retry an unknown transport outcome or expose private response text', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(f.transaction))).mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_ERROR'));
    await expect(f.adapter.create({ payment, money: payment.paidMoney, commandKey: 'one' })).rejects.toMatchObject({ outcome: 'unknown', message: expect.not.stringContaining('PRIVATE') });
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
});
