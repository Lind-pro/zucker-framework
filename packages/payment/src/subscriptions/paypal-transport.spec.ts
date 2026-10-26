import { PayPalPaymentTransport } from '../providers/paypal';
const startTime = '2026-01-01T00:00:00.000Z', endTime = '2026-02-01T00:00:00.000Z';
function fixture(replies: Array<Record<string, unknown> | number>) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'synthetic-access' }));
    const reply = replies.shift();
    return typeof reply === 'number' ? new Response(null, { status: reply }) : new Response(JSON.stringify(reply));
  });
  const transport = new PayPalPaymentTransport({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret', mode: 'sandbox', fetcher: fetcher as unknown as typeof fetch });
  return { transport, fetcher };
}
it('creates with fixed plan, durable key and bounded authenticated requests, then retrieves identity', async () => {
  const f = fixture([{ id: 'I-1' }, { id: 'I-1' }, { id: 'P-1' }]);
  const input = { plan_id: 'P-1', custom_id: 'order-1', quantity: '1' as const, application_context: { return_url: 'https://app.example/done', cancel_url: 'https://app.example/cancel', user_action: 'SUBSCRIBE_NOW' as const, shipping_preference: 'NO_SHIPPING' as const } };
  await f.transport.createSubscription(input, 'request-1'); await f.transport.getSubscription('I-1'); await f.transport.getSubscriptionPlan('P-1');
  expect(f.fetcher).toHaveBeenNthCalledWith(2, 'https://api.sandbox.paypal.com/v1/billing/subscriptions', expect.objectContaining({
    redirect: 'error', signal: expect.any(AbortSignal), body: JSON.stringify(input), headers: expect.objectContaining({ Authorization: 'Bearer synthetic-access', 'PayPal-Request-Id': 'request-1' }) }));
  expect(f.fetcher).toHaveBeenNthCalledWith(4, 'https://api.sandbox.paypal.com/v1/billing/subscriptions/I-1?fields=plan', expect.anything());
});
it('accepts 204 cancellation without inventing a representation and never retries it', async () => {
  const f = fixture([204]); await f.transport.cancelSubscription('I-1', 'User requested cancellation');
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.fetcher).toHaveBeenLastCalledWith('https://api.sandbox.paypal.com/v1/billing/subscriptions/I-1/cancel', expect.objectContaining({ body: JSON.stringify({ reason: 'User requested cancellation' }) }));
  await expect(f.transport.cancelSubscription('I-1', '')).rejects.toThrow('reason');
});
it('paginates only same-environment/resource/window links and rebuilds requests on the configured origin', async () => {
  const query = new URLSearchParams({ start_time: startTime, end_time: endTime, page: '2' }).toString();
  const f = fixture([{ transactions: [{ id: 'SALE-1', status: 'COMPLETED' }], total_pages: 2,
    links: [{ rel: 'next', href: `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-1/transactions?${query}` }] }, { transactions: [{ id: 'SALE-2', status: 'PENDING' }], total_pages: 2 }]);
  const one = await f.transport.listSubscriptionTransactions('I-1', { startTime, endTime });
  const two = await f.transport.listSubscriptionTransactions('I-1', { startTime, endTime, cursor: one.nextCursor });
  expect(two.transactions[0].id).toBe('SALE-2'); expect(two.nextCursor).toBeUndefined();
  expect(f.fetcher.mock.calls[3][0]).toBe(`https://api.sandbox.paypal.com/v1/billing/subscriptions/I-1/transactions?${query}`);
});
it.each(['https://evil.example', 'https://api.paypal.com', 'http://api.sandbox.paypal.com'])('rejects foreign next-page origin %s', async (origin) => {
  const query = new URLSearchParams({ start_time: startTime, end_time: endTime, page: '2' });
  const f = fixture([{ transactions: [], links: [{ rel: 'next', href: `${origin}/v1/billing/subscriptions/I-1/transactions?${query}` }] }]);
  await expect(f.transport.listSubscriptionTransactions('I-1', { startTime, endTime })).rejects.toThrow('pagination link');
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('fails closed for truncation, wrong resources, transport errors and raw sensitive response bodies', async () => {
  const f = fixture([{ transactions: [], total_pages: 2 }, { id: 'I-foreign' }, 500]);
  await expect(f.transport.listSubscriptionTransactions('I-1', { startTime, endTime })).rejects.toThrow('no next page');
  await expect(f.transport.getSubscription('I-1')).rejects.toThrow('different subscription');
  await expect(f.transport.cancelSubscription('I-1', 'test')).rejects.toThrow('outcome may be unknown');
  const broken = new PayPalPaymentTransport({ clientId: 'x', clientSecret: 'y', mode: 'sandbox', fetcher: vi.fn(async () => { throw new Error('secret-http-body'); }) });
  await expect(broken.getSubscription('I-1')).rejects.toThrow(/^PayPal subscription request failed; outcome may be unknown$/);
});
it('rejects a missing intermediate next page rather than truncating recovered renewals', async () => {
  const f = fixture([{ transactions: [{ id: 'SALE-2', status: 'COMPLETED' }], total_pages: 3 }]);
  const cursor = new URLSearchParams({ start_time: startTime, end_time: endTime, page: '2' }).toString();
  await expect(f.transport.listSubscriptionTransactions('I-1', { startTime, endTime, cursor })).rejects.toThrow('no next page');
});
