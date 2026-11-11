import { describe, expect, it } from 'vitest';
import { HostedCheckoutService } from './service';
import { snapshotPromotion } from './validation';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOffer, HostedCheckoutOrder } from './types';

const promotion = { id: 'promo-1', providerCode: 'promo_1', payable: { amount: '23.20', currency: 'USD' }, discount: { amount: '5.80', currency: 'USD' } };
const base: HostedCheckoutOffer = { version: 'v1', catalogReference: 'price-1', mode: 'payment', money: { amount: '29.00', currency: 'USD' }, description: 'Synthetic' };
const selection = { orderId: 'order-1', ownerId: 'user-1', offerId: 'offer-1', providerId: 'synthetic' };

function fixture(offer: HostedCheckoutOffer) {
  const rows = new Map<string, HostedCheckoutOrder>();
  const fulfilled: HostedCheckoutObservation[] = [];
  let seen = 0;
  let paid: HostedCheckoutObservation | undefined;
  const store = {
    create: async ({ data }: { data: HostedCheckoutOrder }) => { rows.set(data.id, structuredClone(data)); return structuredClone(data); },
    findUnique: async ({ where }: { where: { id: string } }) => structuredClone(rows.get(where.id) ?? null),
    findMany: async ({ where }: { where?: { checkoutId?: string } } = {}) => [...rows.values()].filter((row) => !where?.checkoutId || row.checkoutId === where.checkoutId).map((row) => structuredClone(row)),
    count: async () => rows.size, update: async () => undefined, updateMany: async () => undefined,
    compareAndSet: async (id: string, expected: Record<string, unknown>, data: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row || Object.entries(expected).some(([key, value]) => row[key as keyof HostedCheckoutOrder] !== value)) return false;
      rows.set(id, { ...row, ...structuredClone(data) } as HostedCheckoutOrder); return true;
    },
  } as never;
  const adapter: HostedCheckoutAdapter = {
    id: 'synthetic', accountScope: 'test', modes: ['payment'], promotions: { modes: ['payment'] }, validate() {},
    async create(order) {
      return { checkoutId: 'cs-1', reference: order.id, catalogReference: 'price-1', mode: 'payment', quantity: 1, state: 'pending',
        dueMoney: order.offer.promotion?.payable ?? order.offer.money, url: 'https://pay.example/1' };
    },
    async retrieve() { seen++; return structuredClone(paid!); },
    async verifyWebhook() { return { eventId: `evt-${seen}`, checkoutId: 'cs-1', reference: 'order-1' }; },
  };
  const service = new HostedCheckoutService({ providers: [adapter], resolveOffer: async () => structuredClone(offer),
    returnUrls: () => ({ successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/no' }),
    persistence: { orders: store, transaction: (work) => work({ orders: store, fulfill: async (_o, observed) => { fulfilled.push(observed as HostedCheckoutObservation); } }) } });
  return { service, fulfilled, rows,
    pay(changes: Partial<HostedCheckoutObservation> = {}) {
      paid = { checkoutId: 'cs-1', reference: 'order-1', catalogReference: 'price-1', mode: 'payment', quantity: 1, state: 'paid',
        paidMoney: { amount: '23.20', currency: 'USD' }, subtotalMoney: base.money, discountMoney: { amount: '5.80', currency: 'USD' },
        discountReferences: ['promo_1'], paymentId: 'pi-1', paymentKind: 'payment-intent', ...changes };
    } };
}

describe('promotion snapshot: money strings the browser or a bad resolver could smuggle', () => {
  const money = base.money;
  it.each([
    ['payable above the price', { payable: { amount: '30.00', currency: 'USD' }, discount: { amount: '-1.00', currency: 'USD' } }],
    ['negative discount', { payable: { amount: '30.00', currency: 'USD' }, discount: { amount: '-1', currency: 'USD' } }],
    ['exponent notation', { payable: { amount: '2.32e1', currency: 'USD' }, discount: { amount: '5.8', currency: 'USD' } }],
    ['padded amount', { payable: { amount: ' 23.20', currency: 'USD' }, discount: { amount: '5.80', currency: 'USD' } }],
    ['numeric amount', { payable: { amount: 23.2, currency: 'USD' }, discount: { amount: '5.80', currency: 'USD' } }],
    ['lower-case currency', { payable: { amount: '23.20', currency: 'usd' }, discount: { amount: '5.80', currency: 'usd' } }],
    ['sub-minor precision', { payable: { amount: '23.199', currency: 'USD' }, discount: { amount: '5.801', currency: 'USD' } }],
    ['extra money key', { payable: { amount: '23.20', currency: 'USD', x: 1 }, discount: { amount: '5.80', currency: 'USD' } }],
    ['zero discount', { payable: { amount: '29.00', currency: 'USD' }, discount: { amount: '0.00', currency: 'USD' } }],
    ['discount equals price', { payable: { amount: '0.00', currency: 'USD' }, discount: { amount: '29.00', currency: 'USD' } }],
    ['code with space', { providerCode: 'promo 1' }], ['empty code', { providerCode: '' }], ['id too long', { id: 'x'.repeat(129) }],
  ] as Array<[string, Record<string, unknown>]>)('refuses %s', (_name, changes) => {
    expect(() => snapshotPromotion({ money, promotion: { ...promotion, ...changes } })).toThrow();
  });
  it('accepts equal amounts written with different trailing zeros', () => {
    expect(snapshotPromotion({ money, promotion: { ...promotion, payable: { amount: '23.2', currency: 'USD' }, discount: { amount: '5.8', currency: 'USD' } } })).toBeDefined();
  });
  it('rejects a prototype-polluted or class-instance promotion', () => {
    class Fake { id = 'p'; providerCode = 'c'; payable = promotion.payable; discount = promotion.discount; }
    expect(() => snapshotPromotion({ money, promotion: new Fake() })).toThrow();
    expect(() => snapshotPromotion({ money, promotion: [promotion] })).toThrow();
  });
});

describe('HostedCheckoutService promotions: selection and webhook path', () => {
  it('the promotion code in the selection never discounts by itself; only the resolved offer does', async () => {
    const f = fixture(base);
    const order = await f.service.create({ ...selection, promotionCode: 'ANYTHING' });
    expect(order.offer.promotion).toBeUndefined();
    f.pay({ paidMoney: { amount: '23.20', currency: 'USD' } });
    await expect(f.service.confirm({ orderId: 'order-1', ownerId: 'user-1' })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(f.fulfilled).toHaveLength(0);
  });

  it.each([[''], ['   '], ['x'.repeat(129)], [5], [null], [['A']], [{}]])('refuses promotion code %j before resolving the offer', async (code) => {
    const f = fixture(base);
    await expect(f.service.create({ ...selection, promotionCode: code as never })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.rows.size).toBe(0);
  });

  it('the webhook path applies the same verdict as confirm and fulfils a genuine payment once', async () => {
    const forged = fixture({ ...base, promotion });
    await forged.service.create(selection);
    forged.pay({ discountMoney: { amount: '9.00', currency: 'USD' }, paidMoney: { amount: '20.00', currency: 'USD' } });
    await expect(forged.service.webhook('synthetic', { headers: {}, rawBody: Buffer.from('{}') })).rejects.toMatchObject({ code: 'verification_failed' });
    expect(forged.fulfilled).toHaveLength(0);

    const f = fixture({ ...base, promotion });
    await f.service.create(selection);
    f.pay();
    const request = { headers: {}, rawBody: Buffer.from('{}') };
    await Promise.all([f.service.webhook('synthetic', request), f.service.webhook('synthetic', request), f.service.confirm({ orderId: 'order-1', ownerId: 'user-1' })]);
    await f.service.webhook('synthetic', request);
    expect(f.fulfilled).toHaveLength(1);
    f.pay({ paidMoney: { amount: '0.01', currency: 'USD' } }); // later forged replay changes nothing
    await expect(f.service.confirm({ orderId: 'order-1', ownerId: 'user-1' })).resolves.toMatchObject({ fulfilledAt: expect.any(Date) });
    expect(f.fulfilled).toHaveLength(1);
  });

  it('another owner cannot confirm the order', async () => {
    const f = fixture({ ...base, promotion });
    await f.service.create(selection);
    f.pay();
    await expect(f.service.confirm({ orderId: 'order-1', ownerId: 'intruder' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.fulfilled).toHaveLength(0);
  });
});
