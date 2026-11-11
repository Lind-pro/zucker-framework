import type Stripe from 'stripe';
import { HostedCheckoutService } from './service';
import { createStripeHostedCheckoutAdapter } from './stripe';
import { createCreemHostedCheckoutAdapter } from './creem';
import { snapshotPromotion } from './validation';
import { SubscriptionCycleService } from '../subscription-lifecycle/service';
import type { SubscriptionCyclePersistence, SubscriptionEntitlementBinding } from '../subscription-lifecycle/types';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOffer, HostedCheckoutOrder } from './types';

const promotion = { id: 'promo-1', providerCode: 'promo_1', payable: { amount: '23.20', currency: 'USD' }, discount: { amount: '5.80', currency: 'USD' } };
const base: HostedCheckoutOffer = { version: 'v1', catalogReference: 'price-1', mode: 'payment', money: { amount: '29.00', currency: 'USD' }, description: 'Synthetic' };
const selection = { orderId: 'order-1', ownerId: 'user-1', offerId: 'offer-1', providerId: 'synthetic' };

function fixture(offer: HostedCheckoutOffer, adapterChanges: Partial<HostedCheckoutAdapter> = {}) {
  const rows = new Map<string, HostedCheckoutOrder>();
  const fulfilled: Array<HostedCheckoutObservation | undefined> = [];
  const mismatches: HostedCheckoutObservation[] = [];
  let paid: HostedCheckoutObservation | undefined;
  const store = {
    create: async ({ data }: { data: HostedCheckoutOrder }) => { rows.set(data.id, structuredClone(data)); return structuredClone(data); },
    findUnique: async ({ where }: { where: { id: string } }) => structuredClone(rows.get(where.id) ?? null),
    findMany: async () => [], count: async () => rows.size, update: async () => undefined, updateMany: async () => undefined,
    compareAndSet: async (id: string, expected: Record<string, unknown>, data: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row || Object.entries(expected).some(([key, value]) => row[key as keyof HostedCheckoutOrder] !== value)) return false;
      rows.set(id, { ...row, ...structuredClone(data) } as HostedCheckoutOrder); return true;
    },
  } as never;
  const adapter: HostedCheckoutAdapter = {
    id: 'synthetic', accountScope: 'test', modes: ['payment', 'subscription'], promotions: { modes: ['payment', 'subscription'] }, validate() {},
    async create(order) {
      return { checkoutId: 'cs-1', reference: order.id, catalogReference: 'price-1', mode: order.offer.mode, quantity: 1,
        state: 'pending', dueMoney: order.offer.promotion?.payable ?? order.offer.money, url: 'https://pay.example/1' };
    },
    async retrieve() { return structuredClone(paid!); },
    async verifyWebhook() { return null; },
    ...adapterChanges,
  };
  const service = new HostedCheckoutService({ providers: [adapter], resolveOffer: async () => structuredClone(offer),
    returnUrls: () => ({ successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/cancel' }),
    onPaymentMismatch: (_order, observed) => { mismatches.push(observed); },
    persistence: { orders: store, transaction: work => work({ orders: store, fulfill: async (_order, observed) => { fulfilled.push(observed); } }) } });
  return { service, fulfilled, mismatches,
    pay(changes: Partial<HostedCheckoutObservation> = {}) {
      paid = { checkoutId: 'cs-1', reference: 'order-1', catalogReference: 'price-1', mode: offer.mode, quantity: 1, state: 'paid',
        paidMoney: { amount: '23.2', currency: 'USD' }, subtotalMoney: { amount: '29', currency: 'USD' },
        discountMoney: { amount: '5.80', currency: 'USD' }, discountReferences: ['promo_1'], paymentId: 'pi-1', paymentKind: 'payment-intent',
        ...(offer.mode === 'subscription' ? { subscriptionId: 'sub-1' } : {}), ...changes };
    } };
}

describe('frozen promotions', () => {
  it('fulfils only when provider evidence equals the frozen discount', async () => {
    const forged: Array<Partial<HostedCheckoutObservation>> = [
      { subtotalMoney: undefined }, { discountMoney: undefined }, { subtotalMoney: { amount: '30.00', currency: 'USD' } },
      { discountMoney: { amount: '6.00', currency: 'USD' }, paidMoney: { amount: '23.00', currency: 'USD' } },
      { paidMoney: { amount: '29.00', currency: 'USD' } }, { paidMoney: { amount: '23.20', currency: 'EUR' } },
      { discountReferences: ['promo_other'] }, { discountReferences: ['promo_1', 'promo_2'] },
    ];
    for (const changes of forged) {
      const f = fixture({ ...base, promotion });
      await f.service.create(selection); f.pay(changes);
      await expect(f.service.confirm({ orderId: 'order-1', ownerId: 'user-1' })).rejects.toMatchObject({ code: 'verification_failed' });
      expect(f.fulfilled).toHaveLength(0); expect(f.mismatches).toHaveLength(1);
    }
    const f = fixture({ ...base, promotion });
    await f.service.create(selection); f.pay();
    expect((await f.service.confirm({ orderId: 'order-1', ownerId: 'user-1' })).fulfilledAt).toBeTruthy();
    expect(f.fulfilled).toEqual([expect.objectContaining({ discountReferences: ['promo_1'] })]);
  });

  it('refuses a discount on an order frozen without a promotion', async () => {
    const f = fixture(base);
    await f.service.create(selection);
    f.pay({ paidMoney: { amount: '29.00', currency: 'USD' }, discountMoney: { amount: '1.00', currency: 'USD' } });
    await expect(f.service.confirm({ orderId: 'order-1', ownerId: 'user-1' })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(f.fulfilled).toHaveLength(0);
  });

  it('refuses zero totals, inconsistent amounts and unsupported adapters before an order exists', () => {
    expect(() => snapshotPromotion({ money: base.money, promotion: { ...promotion, payable: { amount: '0', currency: 'USD' }, discount: base.money } }))
      .toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(() => snapshotPromotion({ money: base.money, promotion: { ...promotion, discount: { amount: '5.00', currency: 'USD' } } })).toThrow();
    expect(() => snapshotPromotion({ money: base.money, promotion: { ...promotion, extra: 1 } })).toThrow();
    return Promise.all([
      expect(fixture({ ...base, promotion }, { promotions: undefined }).service.create(selection)).rejects.toMatchObject({ code: 'unsupported' }),
      // D10: a subscription needs a once-only provider discount.
      expect(fixture({ ...base, mode: 'subscription', promotion }).service.create(selection)).rejects.toMatchObject({ code: 'unsupported' }),
      expect(fixture({ ...base, mode: 'subscription', promotion }, { quotePromotion: async () => ({ discount: promotion.discount, duration: 'forever' }) })
        .service.create(selection)).rejects.toMatchObject({ code: 'unsupported' }),
      expect(fixture({ ...base, promotion }, { quotePromotion: async () => ({ discount: { amount: '5.00', currency: 'USD' }, duration: 'once' }) })
        .service.create(selection)).rejects.toMatchObject({ code: 'conflict' }),
      expect(fixture({ ...base, mode: 'subscription', promotion }, { quotePromotion: async () => ({ discount: promotion.discount, duration: 'once' }) })
        .service.create(selection)).resolves.toMatchObject({ creationState: 'created' }),
    ]);
  });

  it('Stripe applies a fixed single-use coupon per session (never a percentage) and maps its evidence', async () => {
    const session = { id: 'cs_1', livemode: false, mode: 'payment', client_reference_id: 'order-1', payment_status: 'paid', status: 'complete',
      amount_total: 2320, amount_subtotal: 2900, total_details: { amount_discount: 580 }, currency: 'usd', payment_intent: 'pi_1',
      metadata: { zucker_promotion_code: 'promo_1' },
      discounts: [{ promotion_code: null, coupon: 'zf_promo_order-1' }], line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price-1' } }] } };
    const create = vi.fn(async () => session), retrieve = vi.fn(async () => session);
    const coupon = { id: 'zf_promo_order-1', livemode: false, amount_off: 580, percent_off: null, currency: 'usd', duration: 'once' };
    const coupons = { create: vi.fn(async () => coupon), retrieve: vi.fn(async () => coupon) };
    const adapter = createStripeHostedCheckoutAdapter({ client: { checkout: { sessions: { create, retrieve } }, webhooks: {}, coupons } as unknown as Pick<Stripe, 'checkout' | 'webhooks' | 'coupons'>,
      accountScope: 'test', livemode: false, now: () => Date.parse('2026-11-10T00:00:00Z') });
    const order = { id: 'order-1', offer: { ...base, promotion }, successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/no',
      createKey: 'key', providerMetadata: null } as unknown as HostedCheckoutOrder;
    const observed = await adapter.create(order);
    expect(coupons.create.mock.calls[0]).toEqual([expect.objectContaining({ id: 'zf_promo_order-1', amount_off: 580, currency: 'usd', duration: 'once',
      max_redemptions: 1, redeem_by: Date.parse('2026-11-10T00:00:00Z') / 1000 + 25 * 3600 }), { idempotencyKey: 'key:coupon' }]);
    expect(coupons.create.mock.calls[0][0]).not.toHaveProperty('percent_off');
    expect(create.mock.calls[0][0]).toMatchObject({ discounts: [{ coupon: 'zf_promo_order-1' }], metadata: { zucker_promotion_code: 'promo_1' } });
    expect(create.mock.calls[0][0]).not.toHaveProperty('allow_promotion_codes');
    expect(observed).toMatchObject({ subtotalMoney: { amount: '29.00' }, discountMoney: { amount: '5.80' }, discountReferences: ['promo_1'], paidMoney: { amount: '23.20' } });
    // A retry after Stripe's idempotency window re-reads the existing coupon and checks it.
    coupons.create.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'resource_already_exists' }));
    await adapter.create(order);
    expect(coupons.retrieve).toHaveBeenCalledWith('zf_promo_order-1');
    coupons.create.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'resource_already_exists' }));
    coupons.retrieve.mockResolvedValueOnce({ ...coupon, amount_off: 500 });
    await expect(adapter.create(order)).rejects.toMatchObject({ code: 'verification_failed' });
    // Without a promotion: no coupon, provider codes disabled.
    await adapter.create({ ...order, offer: base });
    expect(create.mock.calls.at(-1)![0]).toMatchObject({ allow_promotion_codes: false }); expect(create.mock.calls.at(-1)![0]).not.toHaveProperty('discounts');
    expect(await adapter.quotePromotion!({ ...base, promotion })).toEqual({ discount: { amount: '5.80', currency: 'USD' }, duration: 'once' });
    expect(adapter.promotions?.modes).toEqual(['payment', 'subscription']);
  });

  it('Stripe discount references: foreign coupons and promotion codes never match; empty lists are unknown', async () => {
    const base_session = { id: 'cs_2', livemode: false, mode: 'payment', client_reference_id: 'order-2', payment_status: 'paid', status: 'complete',
      amount_total: 2320, amount_subtotal: 2900, total_details: { amount_discount: 580 }, currency: 'usd', payment_intent: 'pi_2',
      metadata: { zucker_promotion_code: 'promo_1' }, line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price-1' } }] } };
    const observe = async (extra: object) => {
      const raw = { ...base_session, ...extra };
      const adapter = createStripeHostedCheckoutAdapter({ client: { checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(async () => raw) } }, webhooks: {} } as unknown as Pick<Stripe, 'checkout' | 'webhooks'>,
        accountScope: 'test', livemode: false });
      return adapter.retrieve('cs_2');
    };
    expect((await observe({ discounts: [{ promotion_code: 'promo_1', coupon: null }] })).discountReferences).toEqual(['promotion_code:promo_1']);
    expect((await observe({ discounts: [{ promotion_code: null, coupon: 'zf_promo_order-1' }] })).discountReferences).toEqual(['coupon:zf_promo_order-1']);
    expect((await observe({ discounts: [{ promotion_code: null, coupon: { id: 'zf_promo_order-2' } }] })).discountReferences).toEqual(['promo_1']);
    expect((await observe({ discounts: [] })).discountReferences).toBeUndefined();
    // No coupons API: promotions are refused before an order exists.
    const plain = createStripeHostedCheckoutAdapter({ client: { checkout: { sessions: {} }, webhooks: {} } as unknown as Pick<Stripe, 'checkout' | 'webhooks'>, accountScope: 'test', livemode: false });
    expect(plain.promotions).toBeUndefined();
  });

  it('PayPal and Creem refuse promotions instead of ignoring them', () => {
    const creem = createCreemHostedCheckoutAdapter({ adapter: {} as never, accountScope: 'test' });
    expect(() => creem.validate({ ...base, promotion })).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });

  it('subscriptions accept the discounted amount for the initial payment only (D10)', async () => {
    const binding: SubscriptionEntitlementBinding = { id: 'b', ownerId: 'o', providerId: 'p', accountScope: 's', subscriptionId: 'sub', catalogReference: 'price',
      money: { amount: '19.00', currency: 'USD' }, initialMoney: { amount: '9.50', currency: 'USD' }, policyVersion: 'v1', policy: { credits: 1 },
      grantBasis: 'period', initialOrderId: 'order', initialPaymentId: 'in_1', initialPaymentKind: 'invoice' };
    const persistence: SubscriptionCyclePersistence = { transaction: async (_id, _owner, work) => work({ binding, findCycle: async () => null,
      findPayment: async () => null, insertReceipt: async () => undefined, fulfill: async () => undefined }) };
    const service = new SubscriptionCycleService(persistence);
    const payment = (id: string, amount: string, start: string, end: string) => ({ bindingId: 'b', ownerId: 'o', providerId: 'p', accountScope: 's',
      payment: { recordId: id, subscriptionId: 'sub', catalogReference: 'price', period: { start, end }, paidMoney: { amount, currency: 'USD' },
        paymentId: id, paymentKind: 'invoice' as const, paidAt: start } });
    await expect(service.apply(payment('in_1', '9.50', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'))).resolves.toMatchObject({ granted: true });
    await expect(service.apply(payment('in_2', '9.50', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))).rejects.toMatchObject({ code: 'verification_failed' });
    await expect(service.apply(payment('in_2', '19.00', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))).resolves.toMatchObject({ granted: true });
    await expect(service.apply(payment('in_1', '19.00', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'))).rejects.toMatchObject({ code: 'verification_failed' });
  });
});
