import { describe, expect, it } from 'vitest';
import { HostedCheckoutError, RefundProtocolError, type HostedCheckoutOrder } from '@zucker-framework/payment';
import {
  billingTestFakeControllers, billingTestFakesEnabled, createBillingTestFakes, FakeCheckoutController, findFakePaymentLedger, signFakeWebhook,
  FAKE_SIGNATURE_HEADER,
} from '../src/billing/test-fakes';

/** Switch parsing, production refusal and the provider-side behaviour of the fake payment adapters (no database). */
const env = { NODE_ENV: 'test', WEB_URL: 'http://localhost:4202' };
const money = (amount: string) => ({ amount, currency: 'USD' });
function order(id: string, mode: 'payment' | 'subscription' = 'payment', promotion?: HostedCheckoutOrder['offer']['promotion']): HostedCheckoutOrder {
  const now = new Date();
  return { id, ownerId: 'owner-1', offerId: 'offer', providerId: 'fake', accountScope: 'fake-test',
    offer: { version: 'v1', catalogReference: 'fake-ref', mode, money: money('10.00'), description: 'Synthetic', fulfillmentData: { credits: 5 }, ...(promotion ? { promotion } : {}) },
    providerMetadata: null, successUrl: `http://localhost:4202/billing/return?order=${id}`, cancelUrl: `http://localhost:4202/billing/return?order=${id}&canceled=1`,
    createKey: `create-${id}`, captureKey: `capture-${id}`, creationState: 'submitting', captureState: 'idle', state: 'unknown',
    checkoutId: null, checkoutUrl: null, paymentId: null, paymentKind: null, subscriptionId: null, fulfilledAt: null, createdAt: now, updatedAt: now, revision: 1 };
}

describe('billing test fakes: switch', () => {
  it('is off unless exactly true, rejects other values and refuses production', () => {
    expect(billingTestFakesEnabled({})).toBe(false);
    expect(billingTestFakesEnabled({ BILLING_TEST_FAKE_PROVIDER: ' false ' })).toBe(false);
    expect(billingTestFakesEnabled({ BILLING_TEST_FAKE_PROVIDER: 'true' })).toBe(true);
    for (const value of ['1', 'yes', 'TRUE']) expect(() => billingTestFakesEnabled({ BILLING_TEST_FAKE_PROVIDER: value })).toThrow(/true or false/);
    expect(() => billingTestFakesEnabled({ BILLING_TEST_FAKE_PROVIDER: 'true', NODE_ENV: 'production' })).toThrow(/production/);
    expect(billingTestFakesEnabled({ BILLING_TEST_FAKE_PROVIDER: 'false', NODE_ENV: 'production' })).toBe(false);
    expect(() => createBillingTestFakes({ NODE_ENV: 'production' })).toThrow(/production/);
    expect(billingTestFakeControllers({})).toEqual([]);
    expect(billingTestFakeControllers({ BILLING_TEST_FAKE_PROVIDER: 'true' })).toEqual([FakeCheckoutController]);
    expect(() => billingTestFakeControllers({ BILLING_TEST_FAKE_PROVIDER: 'true', NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => createBillingTestFakes({ BILLING_TEST_FAKE_CHECKOUT_URL: 'javascript:alert(1)' })).toThrow();
  });
});

describe('billing test fakes: adapters', () => {
  it('creates one checkout per idempotency key, never reveals fulfillment data and pays exactly the frozen amount', async () => {
    const fakes = createBillingTestFakes(env);
    expect(findFakePaymentLedger([fakes.checkout])).toBe(fakes.ledger);
    const created = await fakes.checkout.create(order('o1'));
    expect(await fakes.checkout.create(order('o1'))).toEqual(created);
    expect(created).toMatchObject({ state: 'pending', reference: 'o1', quantity: 1, dueMoney: money('10.00') });
    expect(created.url).toBe(`http://localhost:4202/api/billing/test-checkout/${created.checkoutId}`);
    await expect(fakes.checkout.create({ ...order('o2'), createKey: 'create-o1' })).rejects.toBeInstanceOf(HostedCheckoutError);
    const paid = fakes.ledger.pay(created.checkoutId);
    expect(paid).toMatchObject({ state: 'paid', paidMoney: money('10.00'), paymentKind: 'payment-intent' });
    expect(paid).not.toHaveProperty('discountMoney');
    expect(fakes.ledger.pay(created.checkoutId)).toEqual(paid);
    expect(fakes.ledger.returnUrl(created.checkoutId, 'success')).toBe('http://localhost:4202/billing/return?order=o1');
    await expect(fakes.checkout.retrieve('fakecs_unknown')).rejects.toBeInstanceOf(HostedCheckoutError);
  });

  it('reports promotion evidence (subtotal, discount, reference) and honours declared quotes and overrides', async () => {
    const fakes = createBillingTestFakes(env);
    const promotion = { id: 'promo-1', providerCode: 'FAKE10', payable: money('9.00'), discount: money('1.00') };
    const placed = order('p1', 'payment', promotion);
    expect(await fakes.checkout.quotePromotion!(placed.offer)).toEqual({ discount: money('1.00'), duration: 'once' });
    fakes.ledger.declarePromotion('FAKE10', { discount: money('2.00'), duration: 'forever' });
    expect(await fakes.checkout.quotePromotion!(placed.offer)).toEqual({ discount: money('2.00'), duration: 'forever' });
    const created = await fakes.checkout.create(placed);
    expect(created.dueMoney).toEqual(money('9.00'));
    expect(fakes.ledger.pay(created.checkoutId)).toMatchObject({ paidMoney: money('9.00'), subtotalMoney: money('10.00'), discountMoney: money('1.00'), discountReferences: ['FAKE10'] });
    const other = await fakes.checkout.create(order('p2'));
    fakes.ledger.declareEvidence(other.checkoutId, { discountMoney: money('1.00'), paidMoney: money('9.00') });
    expect(fakes.ledger.pay(other.checkoutId)).toMatchObject({ paidMoney: money('9.00'), discountMoney: money('1.00') });
    expect(() => fakes.ledger.declareEvidence(other.checkoutId, {})).toThrow(HostedCheckoutError);
  });

  it('subscriptions: first period at the payable amount, renewals at list price, cancel', async () => {
    const fakes = createBillingTestFakes(env);
    const promotion = { id: 'promo-1', providerCode: 'FIRST', payable: money('5.00'), discount: money('5.00') };
    const created = await fakes.checkout.create(order('s1', 'subscription', promotion));
    const paid = fakes.ledger.pay(created.checkoutId);
    expect(paid).toMatchObject({ paymentKind: 'invoice', paidMoney: money('5.00') });
    const subscriptionId = paid.subscriptionId!;
    const renewal = fakes.ledger.renew(subscriptionId);
    expect(renewal.paidMoney).toEqual(money('10.00'));
    const periods = (await fakes.subscription.listPaidPeriods(subscriptionId)).data;
    expect(periods).toHaveLength(2);
    expect(periods[1].period.start).toBe(periods[0].period.end);
    expect(await fakes.subscription.retrieve(subscriptionId)).toMatchObject({ provider: 'fake', status: 'active', catalogReference: 'fake-ref', period: periods[1].period });
    expect(await fakes.subscription.cancel(subscriptionId, { mode: 'period_end' })).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
    expect(() => fakes.ledger.renew(subscriptionId)).toThrow();
  });

  it('refunds: idempotent per command key, bounded by the paid amount, settled asynchronously when pending', async () => {
    const fakes = createBillingTestFakes(env);
    const paid = fakes.ledger.pay((await fakes.checkout.create(order('r1'))).checkoutId);
    const payment = { paymentId: paid.paymentId!, paymentKind: paid.paymentKind!, paidMoney: paid.paidMoney! };
    fakes.ledger.setRefundMode('pending');
    const first = await fakes.refund.create({ payment, money: money('4.00'), commandKey: 'k1' });
    expect(await fakes.refund.create({ payment, money: money('4.00'), commandKey: 'k1' })).toEqual(first);
    await expect(fakes.refund.create({ payment, money: money('6.01'), commandKey: 'k2' })).rejects.toBeInstanceOf(RefundProtocolError);
    expect(await fakes.refund.retrievePayment(payment)).toMatchObject({ settlement: 'paid', pendingRefundMoney: money('4.00'), refundedMoney: money('0.00') });
    fakes.ledger.settleRefund(first.refundId!, 'succeeded');
    expect(await fakes.refund.retrievePayment(payment)).toMatchObject({ settlement: 'partially_refunded', refundedMoney: money('4.00') });
    expect((await fakes.refund.listRefunds!(payment)).data).toHaveLength(1);
  });

  it('webhooks: a valid signature is required; each adapter accepts only its own event type', async () => {
    const fakes = createBillingTestFakes(env);
    const created = await fakes.checkout.create(order('w1'));
    const signed = fakes.ledger.checkoutWebhook(created.checkoutId);
    const request = { rawBody: Buffer.from(signed.rawBody), headers: signed.headers };
    expect(await fakes.checkout.verifyWebhook(request)).toMatchObject({ checkoutId: created.checkoutId, reference: 'w1' });
    expect(await fakes.refund.verifyWebhook(request)).toBeNull();
    expect(await fakes.subscription.verifyWebhook!(request)).toBeNull();
    const forged = { rawBody: signed.rawBody.replace('w1', 'w2'), headers: signed.headers };
    await expect(fakes.refund.verifyWebhook(forged)).rejects.toMatchObject({ code: 'verification_failed' });
    await expect(fakes.checkout.verifyWebhook(forged)).rejects.toMatchObject({ code: 'verification_failed' });
    await expect(fakes.refund.verifyWebhook({ rawBody: signed.rawBody, headers: {} })).rejects.toBeInstanceOf(RefundProtocolError);
    const upper = { rawBody: signed.rawBody, headers: { [FAKE_SIGNATURE_HEADER.toUpperCase()]: signed.headers[FAKE_SIGNATURE_HEADER] } };
    expect(await fakes.checkout.verifyWebhook(upper)).not.toBeNull();
    const incomplete = signFakeWebhook('checkout.completed', { checkoutId: 'not-a-fake-id', reference: 'w1' });
    await expect(fakes.checkout.verifyWebhook({ rawBody: incomplete.rawBody, headers: incomplete.headers })).rejects.toBeInstanceOf(HostedCheckoutError);
  });
});
