import type Stripe from 'stripe';
import { createStripeRefundAdapter, type StripeRefundOptions } from './stripe';
import type { RefundPaymentReference } from './types';
const reference: RefundPaymentReference = { paymentKind: 'payment-intent', paymentId: 'pi_1', paidMoney: { amount: '29.00', currency: 'USD' } };
function refund(changes: Record<string, unknown> = {}): Stripe.Refund {
  return { id: 're_1', amount: 1000, currency: 'usd', charge: 'ch_1', payment_intent: 'pi_1', status: 'succeeded', created: 1700000000, ...changes } as unknown as Stripe.Refund;
}
function fixture() {
  const charge = { id: 'ch_1', livemode: false, amount_captured: 2900, amount_refunded: 0, currency: 'usd', paid: true, captured: true, status: 'succeeded', payment_intent: 'pi_1' } as unknown as Stripe.Charge;
  const intent = { id: 'pi_1', livemode: false, status: 'succeeded', currency: 'usd', amount_received: 2900, latest_charge: 'ch_1' } as unknown as Stripe.PaymentIntent;
  const invoice = { id: 'in_1', livemode: false, amount_paid: 2900, currency: 'usd', status: 'paid' } as unknown as Stripe.Invoice;
  const inpay = { id: 'inpay_1', livemode: false, invoice: 'in_1', amount_paid: 2900, currency: 'usd', status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } } as unknown as Stripe.InvoicePayment;
  const methods = { intent: vi.fn(async () => intent), charge: vi.fn(async () => charge), invoice: vi.fn(async () => invoice),
    invoicePayments: vi.fn(async () => ({ data: [inpay], has_more: false })), refunds: vi.fn(async () => ({ data: [] as Stripe.Refund[], has_more: false })),
    create: vi.fn(async () => refund()), retrieve: vi.fn(async () => refund()),
    webhook: vi.fn(() => ({ id: 'evt_1', livemode: false, type: 'refund.updated', created: 1700000001, data: { object: refund() } })) };
  const client = { paymentIntents: { retrieve: methods.intent }, charges: { retrieve: methods.charge }, invoices: { retrieve: methods.invoice }, invoicePayments: { list: methods.invoicePayments },
    refunds: { list: methods.refunds, create: methods.create, retrieve: methods.retrieve }, webhooks: { constructEvent: methods.webhook } } as unknown as StripeRefundOptions['client'];
  return { adapter: createStripeRefundAdapter({ client, accountScope: 'stripe-synthetic', livemode: false, webhookSecret: 'synthetic' }), methods, charge, intent, invoice, inpay };
}
describe('Stripe typed refund protocol', () => {
  it('issues partial refunds against verified captured money with the persisted command key', async () => {
    const f = fixture(); const result = await f.adapter.create({ payment: reference, money: { amount: '10.00', currency: 'USD' }, commandKey: 'refund-command', reason: 'requested_by_customer' });
    expect(result).toMatchObject({ refundId: 're_1', paymentId: 'pi_1', paymentKind: 'payment-intent', source: { kind: 'charge', id: 'ch_1' }, state: 'succeeded', money: { amount: '10.00', currency: 'USD' } });
    expect(f.methods.create).toHaveBeenCalledWith({ charge: 'ch_1', amount: 1000, reason: 'requested_by_customer', metadata: { zucker_refund_command: 'refund-command' } }, { idempotencyKey: 'refund-command', maxNetworkRetries: 0 });
  });
  it('supports full remaining refunds after previous successful and pending refunds', async () => {
    const f = fixture(); f.methods.charge.mockResolvedValue({ ...f.charge, amount_refunded: 1000 });
    f.methods.refunds.mockResolvedValue({ data: [refund(), refund({ id: 're_pending', status: 'pending', amount: 400 })], has_more: false });
    f.methods.create.mockResolvedValue(refund({ id: 're_new', amount: 1500 }));
    const observed = await f.adapter.retrievePayment(reference);
    expect(observed).toMatchObject({ settlement: 'partially_refunded', refundedMoney: { amount: '10.00' }, pendingRefundMoney: { amount: '4.00' } });
    await expect(f.adapter.create({ payment: reference, money: { amount: '19.00', currency: 'USD' }, commandKey: 'overlap' })).rejects.toThrow('remaining');
    await expect(f.adapter.create({ payment: reference, money: { amount: '15.00', currency: 'USD' }, commandKey: 'remaining' })).resolves.toMatchObject({ state: 'succeeded' });
    expect(f.methods.create).toHaveBeenCalledOnce();
  });
  it('replays a lost-response full refund for the same command instead of rejecting it (M4)', async () => {
    const f = fixture();
    f.methods.refunds.mockResolvedValue({ data: [refund({ id: 're_full', amount: 2900, metadata: { zucker_refund_command: 'full-1' } })], has_more: false });
    await expect(f.adapter.create({ payment: reference, money: { amount: '29.00', currency: 'USD' }, commandKey: 'full-1' }))
      .resolves.toMatchObject({ refundId: 're_full', state: 'succeeded', commandKey: 'full-1', money: { amount: '29.00' } });
    expect(f.methods.create).not.toHaveBeenCalled();
    // A different command still sees no remaining amount.
    await expect(f.adapter.create({ payment: reference, money: { amount: '1.00', currency: 'USD' }, commandKey: 'other' })).rejects.toThrow('remaining');
    // Same key, different amount is a correlation error, never a second refund.
    await expect(f.adapter.create({ payment: reference, money: { amount: '10.00', currency: 'USD' }, commandKey: 'full-1' })).rejects.toThrow('different amount');
    expect(f.methods.create).not.toHaveBeenCalled();
  });
  it('follows invoice-payment pagination and retains the original invoice while binding its real charge', async () => {
    const f = fixture(); f.methods.invoicePayments.mockResolvedValueOnce({ data: [{ ...f.inpay, id: 'inpay_zero', amount_paid: 0 }], has_more: true }).mockResolvedValueOnce({ data: [f.inpay], has_more: false });
    const result = await f.adapter.create({ payment: { ...reference, paymentId: 'in_1', paymentKind: 'invoice' }, money: { amount: '10.00', currency: 'USD' }, commandKey: 'invoice-command' });
    expect(f.methods.invoicePayments).toHaveBeenLastCalledWith({ invoice: 'in_1', status: 'paid', limit: 100, starting_after: 'inpay_zero' });
    expect(result).toMatchObject({ paymentId: 'in_1', paymentKind: 'invoice', source: { kind: 'charge', id: 'ch_1' } });
  });
  it('supports old invoice charge sources without pretending an invoice is a payment intent', async () => {
    const f = fixture(); f.methods.invoicePayments.mockResolvedValueOnce({ data: [{ ...f.inpay, payment: { type: 'charge', charge: 'ch_1' } }], has_more: false });
    await f.adapter.retrievePayment({ ...reference, paymentId: 'in_1', paymentKind: 'invoice' }); expect(f.methods.intent).not.toHaveBeenCalled();
  });
  it('rejects multi-source, off-provider and shared-intent invoice funding rather than guessing allocation', async () => {
    const f = fixture(), payment = { ...reference, paymentId: 'in_1', paymentKind: 'invoice' as const };
    f.methods.invoicePayments.mockResolvedValueOnce({ data: [f.inpay, { ...f.inpay, id: 'inpay_2' }], has_more: false });
    await expect(f.adapter.retrievePayment(payment)).rejects.toMatchObject({ code: 'unsupported' });
    f.methods.invoicePayments.mockResolvedValueOnce({ data: [{ ...f.inpay, payment: { type: 'payment_record', payment_record: 'payrec' } }], has_more: false });
    await expect(f.adapter.retrievePayment(payment)).rejects.toMatchObject({ code: 'unsupported' });
    f.methods.intent.mockResolvedValueOnce({ ...f.intent, amount_received: 5800 }); await expect(f.adapter.retrievePayment(payment)).rejects.toThrow('amount differs');
  });
  it.each(['pending', 'requires_action', 'failed', 'canceled', 'unrecognized'])('preserves %s without claiming successful movement', async status => {
    const f = fixture(); f.methods.retrieve.mockResolvedValueOnce(refund({ status }));
    expect((await f.adapter.retrieve!('re_1', reference)).state).toBe(status === 'unrecognized' ? 'unknown' : status);
  });
  it('rejects foreign refunds, accounts, amount and currency before any monetary mutation', async () => {
    const f = fixture();
    for (const requested of [{ amount: '-1', currency: 'USD' }, { amount: '30', currency: 'USD' }, { amount: '1', currency: 'EUR' }, { amount: '1.001', currency: 'USD' }]) {
      await expect(f.adapter.create({ payment: reference, money: requested, commandKey: 'bad' })).rejects.toThrow();
    }
    expect(f.methods.intent).not.toHaveBeenCalled(); expect(f.methods.create).not.toHaveBeenCalled();
    f.methods.retrieve.mockResolvedValueOnce(refund({ charge: 'foreign' })); await expect(f.adapter.retrieve!('re_1', reference)).rejects.toThrow('bound payment');
    f.methods.charge.mockResolvedValueOnce({ ...f.charge, livemode: true }); await expect(f.adapter.retrievePayment(reference)).rejects.toThrow('environment');
  });
  it('does not trust incomplete, inconsistent or repeated refund history', async () => {
    const f = fixture(); f.methods.refunds.mockResolvedValueOnce({ data: [], has_more: true });
    await expect(f.adapter.retrievePayment(reference)).rejects.toThrow('did not advance');
    f.methods.refunds.mockResolvedValueOnce({ data: [refund(), refund()], has_more: false });
    await expect(f.adapter.retrievePayment(reference)).rejects.toThrow('repeated');
    f.methods.refunds.mockResolvedValueOnce({ data: [refund({ status: 'unrecognized' })], has_more: false });
    await expect(f.adapter.retrievePayment(reference)).rejects.toThrow('unknown evidence');
  });
  it('redacts SDK failures and never repeats a create after an unknown response', async () => {
    const f = fixture(); f.methods.create.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_SECRET'));
    await expect(f.adapter.create({ payment: reference, money: { amount: '10.00', currency: 'USD' }, commandKey: 'one' })).rejects.toMatchObject({ code: 'transport_error', outcome: 'unknown', message: expect.not.stringContaining('PRIVATE') });
    expect(f.methods.create).toHaveBeenCalledOnce();
    f.methods.create.mockRejectedValueOnce({ type: 'StripeInvalidRequestError', statusCode: 400, message: 'PRIVATE_INVALID_REQUEST' });
    await expect(f.adapter.create({ payment: reference, money: { amount: '10.00', currency: 'USD' }, commandKey: 'two' })).rejects.toMatchObject({ outcome: 'rejected', message: expect.not.stringContaining('PRIVATE') });
  });
  it('verifies exact webhook bytes and event environment before exposing refund facts', async () => {
    const f = fixture(), request = { rawBody: ' {"exact":true}\n', headers: { 'Stripe-Signature': 'signed' } };
    expect(await f.adapter.verifyWebhook(request)).toMatchObject({ eventId: 'evt_1', refundId: 're_1', source: { kind: 'charge', id: 'ch_1' }, state: 'succeeded', money: { amount: '10.00', currency: 'USD' } });
    expect(f.methods.webhook).toHaveBeenCalledWith(request.rawBody, 'signed', 'synthetic');
    f.methods.webhook.mockReturnValueOnce({ id: 'evt_wrong', livemode: true, type: 'refund.updated', created: 1700000001, data: { object: refund() } });
    await expect(f.adapter.verifyWebhook(request)).rejects.toThrow('environment');
    await expect(f.adapter.verifyWebhook({ ...request, headers: {} })).rejects.toThrow('signature');
  });
  it('exposes paginated refund receipts and command correlation for recovery without repeating a mutation', async () => {
    const f = fixture(); f.methods.refunds.mockResolvedValueOnce({ data: [refund({ metadata: { zucker_refund_command: 'stored-command' } })], has_more: true })
      .mockResolvedValueOnce({ data: [refund({ id: 're_2', status: 'pending' })], has_more: false });
    const first = await f.adapter.listRefunds!(reference), second = await f.adapter.listRefunds!(reference, { cursor: first.nextCursor });
    expect(first.data[0].commandKey).toBe('stored-command'); expect(second.data[0].state).toBe('pending');
    expect(f.methods.refunds).toHaveBeenLastCalledWith({ charge: 'ch_1', limit: 100, starting_after: 're_1' });
    expect(f.methods.create).not.toHaveBeenCalled();
    await expect(f.adapter.listRefunds!({ ...reference, paymentId: 'other' }, { cursor: first.nextCursor })).rejects.toThrow();
  });
  it('freezes command identity and amount before waiting for a provider read', async () => {
    const f = fixture(); let release: ((value: Stripe.PaymentIntent) => void) | undefined;
    f.methods.intent.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const command = { payment: structuredClone(reference), money: { amount: '10.00', currency: 'USD' }, commandKey: 'frozen-key' };
    const pending = f.adapter.create(command); command.money.amount = '20.00'; command.commandKey = 'changed-key'; command.payment.paymentId = 'different';
    if (!release) throw new Error('Expected pending provider read'); release(f.intent);
    await pending;
    expect(f.methods.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000, metadata: { zucker_refund_command: 'frozen-key' } }), { idempotencyKey: 'frozen-key', maxNetworkRetries: 0 });
  });
  it('rejects a response correlated to a different durable command', async () => {
    const f = fixture(); f.methods.create.mockResolvedValueOnce(refund({ metadata: { zucker_refund_command: 'foreign-command' } }));
    await expect(f.adapter.create({ payment: reference, money: { amount: '10.00', currency: 'USD' }, commandKey: 'expected-command' })).rejects.toThrow('bound payment');
  });
});
