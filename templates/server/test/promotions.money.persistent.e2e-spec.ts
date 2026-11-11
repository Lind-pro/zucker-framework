import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { validatePlanGrant } from '@zucker-framework/credit';
import { PlanCatalogService, SubscriptionCycleService, toMinorUnits,
  type HostedCheckoutAdapter, type HostedCheckoutObservation, type HostedCheckoutOrder, type SubscriptionAdapter } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingService, type BillingOptions } from '../src/billing/billing.service';
import { createSubscriptionCyclePersistence } from '../src/billing/subscription-persistence';
import { PromotionsService } from '../src/promotions/promotions.service';
import { computePromotion, type PromotionRow } from '../src/promotions/promotions.validation';
import { createPlanCatalogStore } from '../src/subscriptions/plan-catalog.store';
import { planFulfillmentHooks } from '../src/subscriptions/payment-writeback';
import { APP_ENTITLEMENT_CATALOG } from '../src/subscriptions/entitlement-catalog';
import type { PolicyService } from '@zucker-framework/back-office/settings';

/**
 * Money safety of promotions (WP 3.4). The browser can only name an offer and, when policy allows,
 * a promo alias; the paid amount is the server-frozen payable and every provider observation is
 * compared with it. Synthetic provider and data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const DAY = 86_400_000;

type Money = { amount: string; currency: string };

function fakeProvider() {
  const observations = new Map<string, HostedCheckoutObservation>();
  const state = { failCreate: false, failQuote: false, created: [] as HostedCheckoutOrder[] };
  const provider: HostedCheckoutAdapter = {
    id: 'stripe', accountScope: 'synthetic-money', modes: ['payment', 'subscription'],
    promotions: { modes: ['payment', 'subscription'] }, validate() {},
    async quotePromotion(offer) { if (state.failQuote) { state.failQuote = false; throw new Error('quote unavailable'); } return { discount: offer.promotion!.discount, duration: 'once' }; },
    async create(order) {
      if (state.failCreate) { state.failCreate = false; throw new Error('provider refused'); }
      state.created.push(structuredClone(order));
      const observed: HostedCheckoutObservation = { checkoutId: `cs-${order.id}`, reference: order.id, catalogReference: order.offer.catalogReference,
        mode: order.offer.mode, quantity: 1, state: 'pending', dueMoney: order.offer.promotion?.payable ?? order.offer.money,
        url: `https://synthetic.invalid/pay/${order.id}` };
      observations.set(observed.checkoutId, observed);
      return structuredClone(observed);
    },
    async retrieve(id) { return structuredClone(observations.get(id)!); },
    async verifyWebhook(request) { return JSON.parse(Buffer.from(request.rawBody).toString('utf8')); },
  };
  return { provider, state,
    /** The honest paid observation for an order; `changes` forge individual facts. */
    pay(order: HostedCheckoutOrder, changes: Partial<HostedCheckoutObservation> = {}) {
      const promotion = order.offer.promotion;
      observations.set(order.checkoutId!, { ...observations.get(order.checkoutId!)!, state: 'paid',
        paidMoney: promotion?.payable ?? order.offer.money, paymentId: `payment-${order.id}`, paymentKind: 'payment-intent',
        ...(order.offer.mode === 'subscription' ? { subscriptionId: `sub-${order.id}` } : {}),
        ...(promotion ? { subtotalMoney: order.offer.money, discountMoney: promotion.discount, discountReferences: [promotion.providerCode] } : {}),
        ...changes });
    },
    webhook(order: HostedCheckoutOrder) {
      return { headers: {}, rawBody: Buffer.from(JSON.stringify({ eventId: `evt-${order.id}`, checkoutId: order.checkoutId, reference: order.id })) };
    } };
}

async function boot(catalog: unknown[]) {
  const schema = `zucker_promo_money_${randomUUID().replaceAll('-', '')}`;
  const parsed = new URL(databaseUrl!);
  if (!/(?:_dev|_test|_tests)$/.test(parsed.pathname)) throw new Error('Use an explicitly designated development/test database');
  const pool = new Pool({ connectionString: parsed.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  parsed.searchParams.set('schema', schema);
  const database = new ApplicationDatabase(parsed.href);
  const fake = fakeProvider();
  const lifecycle = { id: 'stripe', accountScope: 'synthetic-money', capabilities: { paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' } } as unknown as SubscriptionAdapter;
  const options: BillingOptions = { providers: [fake.provider], subscriptionProviders: [lifecycle], webUrl: 'http://localhost:4202', catalogJson: JSON.stringify(catalog) };
  const policies = { ids: () => ['billing'], get: async () => ({ defaultProvider: '', allowProviderChoice: true, allowCustomerPromoCodes: true }) };
  const billing = new BillingService(database, options, policies as unknown as PolicyService);
  const promotions = new PromotionsService(database, billing);
  const actor = randomUUID();
  const helpers = {
    async user() {
      const id = randomUUID();
      await database.model('users').create({ data: { id, username: `pm_${id.replaceAll('-', '')}`, name: 'Synthetic buyer', typeId: 'member',
        email: `${id}@example.invalid`, status: true } });
      return id;
    },
    promotion: (changes: Record<string, unknown> = {}) => promotions.create(actor, { alias: `CODE${randomUUID().slice(0, 8).toUpperCase()}`,
      providerId: 'stripe', providerCode: 'promo_synthetic', target: '*', currency: null, discountType: 'percent', percentOff: 20,
      amountOff: null, maxRedemptions: null, status: 'active', startsAt: null, endsAt: null, note: null, ...changes }),
    buy: (owner: string, body: Record<string, unknown>, key = randomUUID().replaceAll('-', '')) =>
      billing.create(owner, key, { providerId: 'stripe', ...body }),
    balance: async (owner: string) => ((await database.model('creditAccount').findUnique({ where: { userId: owner } })) as { balance: number } | null)?.balance ?? 0,
    redemptions: (promotionId: string) => database.model('promotionRedemptions').findMany({ where: { promotionId } }) as Promise<Array<{ orderId: string; status: string }>>,
    fulfillments: (orderId: string) => database.model('billingFulfillments').count({ where: { orderId } }),
  };
  const close = async () => {
    try { await database.disconnect(); }
    finally { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
  };
  return { database, billing, promotions, fake, actor, close, ...helpers };
}

const staticCatalog = [
  { id: 'credits', title: 'Credits', version: 'v1', mode: 'payment', amount: '12.00', currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'price_credits' } },
  { id: 'auto', title: 'Auto', version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD', credits: 10, expiresInDays: null, providers: { stripe: 'price_auto' } },
  { id: 'cheap', title: 'Cheap', version: 'v1', mode: 'payment', amount: '0.01', currency: 'USD', credits: 1, expiresInDays: null, providers: { stripe: 'price_cheap' } },
  { id: 'yen', title: 'Yen', version: 'v1', mode: 'payment', amount: '1000', currency: 'JPY', credits: 5, expiresInDays: null, providers: { stripe: 'price_yen' } },
];

run('promotions: the client can never lower the paid amount (PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { t = await boot(staticCatalog); });
  afterAll(async () => { await t?.close(); });

  it('ignores or refuses every tampered request field before provider IO', async () => {
    const owner = await t.user(), promo = await t.promotion();
    const before = t.fake.state.created.length;
    const forged: Array<Record<string, unknown>> = [
      { offerId: 'credits', amount: '0.01' }, { offerId: 'credits', price: '0.01' }, { offerId: 'credits', currency: 'JPY' },
      { offerId: 'credits', payable: { amount: '0.01', currency: 'USD' } }, { offerId: 'credits', discount: '11.99' },
      { offerId: 'credits', promotion: { id: promo.id, providerCode: 'x', payable: { amount: '0.01', currency: 'USD' } } },
      { offerId: 'credits', providerCode: 'promo_synthetic' }, { offerId: 'credits', offer: { money: { amount: '0.01', currency: 'USD' } } },
      { offerId: 'credits', quantity: 100 }, { offerId: 'credits', metadata: { amount: '0' } }, { offerId: 'credits', promoCode: promo.alias, amountOff: '11' },
      { offerId: { id: 'credits' } }, { offerId: ['credits'] }, { offerId: 'credits', providerId: ['stripe'] }, { offerId: 'credits', providerId: { $ne: 1 } },
      { offerId: 'nope' }, { offerId: 'pack:missing:USD' }, { offerId: '__proto__' },
    ];
    for (const body of forged) await expect(t.buy(owner, body), JSON.stringify(body)).rejects.toThrow();
    expect(t.fake.state.created).toHaveLength(before);
    expect(await t.database.model('billingOrders').count({ where: { ownerId: owner } })).toBe(0);
    expect(await t.redemptions(promo.id)).toEqual([]);
  });

  it('refuses malformed promo aliases uniformly and accepts case and whitespace only as the same alias', async () => {
    const owner = await t.user(), promo = await t.promotion();
    for (const code of ['', '  ', 'ab', 'a'.repeat(33), "X' OR '1'='1", 'CODE;DROP', ['CODE'], { alias: promo.alias }, null, 12345, true, promo.alias + '\u0000'])
      await expect(t.buy(owner, { offerId: 'credits', promoCode: code }), JSON.stringify(code)).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    expect(await t.redemptions(promo.id)).toEqual([]);
    const order = await t.buy(owner, { offerId: 'credits', promoCode: `  ${promo.alias!.toLowerCase()}  ` });
    expect(order.offer.promotion?.id).toBe(promo.id);
  });

  it('a code only applies to its own target, provider and currency; swapping offerId never transfers a discount', async () => {
    const owner = await t.user();
    const forAuto = await t.promotion({ target: 'offer:auto' });
    const paypal = await t.promotion({ providerId: 'paypal' });
    const eur = await t.promotion({ currency: 'EUR' });
    await expect(t.buy(owner, { offerId: 'credits', promoCode: forAuto.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    await expect(t.buy(owner, { offerId: 'credits', promoCode: paypal.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    await expect(t.buy(owner, { offerId: 'yen', promoCode: eur.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    const ok = await t.buy(owner, { offerId: 'auto', promoCode: forAuto.alias });
    expect(ok.offer.promotion?.payable).toEqual({ amount: '8.00', currency: 'USD' });
    for (const row of [forAuto, paypal, eur]) expect((await t.redemptions(row.id)).length).toBe(row.id === forAuto.id ? 1 : 0);
  });

  it('server arithmetic: payable is always positive, below the list price, and payable + discount = price', async () => {
    const row = (changes: Partial<PromotionRow>) => ({ id: 'p', alias: null, providerId: 'stripe', providerCode: 'c', target: '*', currency: null,
      discountType: 'percent', percentOff: 1, amountOff: null, maxRedemptions: null, status: 'active', startsAt: null, endsAt: null, note: null,
      revision: 0, createdAt: new Date(), updatedAt: new Date(), ...changes }) as PromotionRow;
    const prices: Money[] = [{ amount: '0.01', currency: 'USD' }, { amount: '0.02', currency: 'USD' }, { amount: '0.99', currency: 'USD' },
      { amount: '12.01', currency: 'USD' }, { amount: '99999.99', currency: 'USD' }, { amount: '1', currency: 'JPY' }, { amount: '1000', currency: 'JPY' }, { amount: '7', currency: 'JPY' }];
    let applied = 0;
    for (const price of prices) for (let percent = 1; percent <= 99; percent++) {
      const frozen = computePromotion(row({ percentOff: percent }), { money: price });
      if (!frozen) continue;
      applied++;
      const total = toMinorUnits(price.amount, price.currency), pay = toMinorUnits(frozen.payable.amount, price.currency), off = toMinorUnits(frozen.discount.amount, price.currency);
      expect(pay).toBeGreaterThan(0); expect(off).toBeGreaterThan(0); expect(pay).toBeLessThan(total); expect(pay + off).toBe(total);
      expect(frozen.payable.currency).toBe(price.currency);
    }
    expect(applied).toBeGreaterThan(500);
    // Fixed amounts: equal to or above the price, wrong currency, and non-positive never apply.
    expect(computePromotion(row({ discountType: 'amount', percentOff: null, amountOff: '12.00', currency: 'USD' }), { money: { amount: '12.00', currency: 'USD' } })).toBeNull();
    expect(computePromotion(row({ discountType: 'amount', percentOff: null, amountOff: '50.00', currency: 'USD' }), { money: { amount: '12.00', currency: 'USD' } })).toBeNull();
    expect(computePromotion(row({ discountType: 'amount', percentOff: null, amountOff: '1.00', currency: 'USD' }), { money: { amount: '1000', currency: 'JPY' } })).toBeNull();
    expect(computePromotion(row({ discountType: 'amount', percentOff: null, amountOff: '0', currency: 'USD' }), { money: { amount: '12.00', currency: 'USD' } })).toBeNull();
    expect(computePromotion(row({ percentOff: 100 }), { money: { amount: '12.00', currency: 'USD' } })).toBeNull();
    expect(computePromotion(row({ percentOff: 0 }), { money: { amount: '12.00', currency: 'USD' } })).toBeNull();
    // The management API cannot even store a 100 % / zero / negative / fractional-yen discount.
    for (const body of [{ percentOff: 100 }, { percentOff: 0 }, { percentOff: -5 }, { percentOff: 10.5 }, { percentOff: '20' }, { maxRedemptions: 0 }, { maxRedemptions: -1 },
      { discountType: 'amount', percentOff: null, amountOff: '0', currency: 'USD' }, { discountType: 'amount', percentOff: null, amountOff: '-1', currency: 'USD' },
      { discountType: 'amount', percentOff: null, amountOff: '1.5', currency: 'JPY' }, { discountType: 'amount', percentOff: null, amountOff: '1e1', currency: 'USD' }])
      await expect(t.promotion(body), JSON.stringify(body)).rejects.toMatchObject({ status: 400 });
  });

  it('a discount that would leave nothing to pay is refused, never fulfilled for free', async () => {
    const owner = await t.user();
    const half = await t.promotion({ percentOff: 50 });
    await expect(t.buy(owner, { offerId: 'cheap', promoCode: half.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    const full = await t.promotion({ discountType: 'amount', percentOff: null, amountOff: '12.00', currency: 'USD' });
    await expect(t.buy(owner, { offerId: 'credits', promoCode: full.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    const yen = await t.promotion({ percentOff: 15 });
    expect((await t.buy(owner, { offerId: 'yen', promoCode: yen.alias })).offer.promotion).toMatchObject({
      payable: { amount: '850', currency: 'JPY' }, discount: { amount: '150', currency: 'JPY' } });
    expect(await t.database.model('billingOrders').count({ where: { ownerId: owner, offerId: 'cheap' } })).toBe(0);
  });

  it.each([
    ['subtotal above the offer', { subtotalMoney: { amount: '13.00', currency: 'USD' } }],
    ['subtotal below the offer', { subtotalMoney: { amount: '9.60', currency: 'USD' } }],
    ['subtotal missing', { subtotalMoney: undefined }],
    ['discount larger than frozen', { discountMoney: { amount: '3.00', currency: 'USD' }, paidMoney: { amount: '9.00', currency: 'USD' } }],
    ['discount smaller than frozen', { discountMoney: { amount: '1.00', currency: 'USD' } }],
    ['discount missing', { discountMoney: undefined }],
    ['paid at list price', { paidMoney: { amount: '12.00', currency: 'USD' } }],
    ['paid below the frozen payable', { paidMoney: { amount: '0.01', currency: 'USD' } }],
    ['paid above the frozen payable', { paidMoney: { amount: '9.61', currency: 'USD' } }],
    ['paid in another currency', { paidMoney: { amount: '9.60', currency: 'EUR' } }],
    ['paid amount in exponent form', { paidMoney: { amount: '9.6e0', currency: 'USD' } }],
    ['paid amount negative', { paidMoney: { amount: '-9.60', currency: 'USD' } }],
    ['foreign discount code', { discountReferences: ['promo_foreign'] }],
    ['two discount codes', { discountReferences: ['promo_synthetic', 'promo_other'] }],
    ['empty discount reference list', { discountReferences: [] }],
    ['no money reported but state paid', { paidMoney: undefined }],
  ] as Array<[string, Partial<HostedCheckoutObservation>]>)('observation with %s: no fulfilment, no credits, reservation stays reserved', async (_name, changes) => {
    const owner = await t.user(), promo = await t.promotion();
    const order = await t.buy(owner, { offerId: 'credits', promoCode: promo.alias });
    expect(order.offer.promotion?.payable).toEqual({ amount: '9.60', currency: 'USD' });
    t.fake.pay(order, changes);
    await expect(t.billing.confirm(order.id, owner)).resolves.toBeDefined().catch(() => undefined);
    const stored = await t.billing.checkout.get(order.id, owner);
    expect(stored.fulfilledAt).toBeNull();
    expect(await t.balance(owner)).toBe(0);
    expect(await t.fulfillments(order.id)).toBe(0);
    expect(await t.redemptions(promo.id)).toEqual([expect.objectContaining({ orderId: order.id, status: 'reserved' })]);
    // The webhook path must reach the same verdict.
    await t.billing.webhook('stripe', t.fake.webhook(order)).catch(() => undefined);
    expect(await t.balance(owner)).toBe(0);
    expect((await t.billing.checkout.get(order.id, owner)).fulfilledAt).toBeNull();
    // The honest observation later still fulfils exactly once (the order is not poisoned).
    t.fake.pay(order);
    await t.billing.confirm(order.id, owner);
    expect(await t.balance(owner)).toBe(100);
    expect(await t.redemptions(promo.id)).toEqual([expect.objectContaining({ orderId: order.id, status: 'redeemed' })]);
  });

  it('an order frozen without a promotion rejects any discount evidence, including a foreign code', async () => {
    const owner = await t.user();
    for (const changes of [
      { paidMoney: { amount: '9.60', currency: 'USD' }, discountMoney: { amount: '2.40', currency: 'USD' }, subtotalMoney: { amount: '12.00', currency: 'USD' } },
      { discountMoney: { amount: '0.01', currency: 'USD' } }, { discountReferences: ['promo_synthetic'] },
    ] as Array<Partial<HostedCheckoutObservation>>) {
      const order = await t.buy(owner, { offerId: 'credits' });
      expect(order.offer.promotion).toBeUndefined();
      t.fake.pay(order, changes);
      await expect(t.billing.confirm(order.id, owner)).rejects.toMatchObject({ code: 'verification_failed' });
      expect((await t.billing.checkout.get(order.id, owner)).fulfilledAt).toBeNull();
    }
    expect(await t.balance(owner)).toBe(0);
    // Zero discount evidence is harmless.
    const clean = await t.buy(owner, { offerId: 'credits' });
    t.fake.pay(clean, { discountMoney: { amount: '0.00', currency: 'USD' }, discountReferences: [] });
    await t.billing.confirm(clean.id, owner);
    expect(await t.balance(owner)).toBe(100);
  });

  it('the frozen discount survives later promotion edits, and a re-priced payment is refused', async () => {
    const owner = await t.user(), promo = await t.promotion({ percentOff: 20 });
    const order = await t.buy(owner, { offerId: 'credits', promoCode: promo.alias });
    const edited = await t.promotions.update(t.actor, promo.id, { alias: promo.alias, providerId: 'stripe', providerCode: 'promo_changed', target: '*',
      currency: null, discountType: 'percent', percentOff: 90, amountOff: null, maxRedemptions: null, status: 'disabled', startsAt: null, endsAt: null,
      note: null, expectedRevision: promo.revision });
    expect(edited.percentOff).toBe(90);
    // The provider now applies the 90 % promotion: it is not what was frozen.
    t.fake.pay(order, { paidMoney: { amount: '1.20', currency: 'USD' }, discountMoney: { amount: '10.80', currency: 'USD' }, discountReferences: ['promo_changed'] });
    await expect(t.billing.confirm(order.id, owner)).rejects.toMatchObject({ code: 'verification_failed' });
    expect(await t.balance(owner)).toBe(0);
    t.fake.pay(order);
    await t.billing.confirm(order.id, owner);
    expect(await t.balance(owner)).toBe(100);
    expect(order.offer.promotion?.providerCode).toBe('promo_synthetic');
  });

  it('webhook replays and concurrent confirmations fulfil once and redeem once', async () => {
    const owner = await t.user(), promo = await t.promotion({ maxRedemptions: 1 });
    const order = await t.buy(owner, { offerId: 'credits', promoCode: promo.alias });
    t.fake.pay(order);
    const settled = await Promise.allSettled([...Array.from({ length: 6 }, () => t.billing.webhook('stripe', t.fake.webhook(order))),
      ...Array.from({ length: 3 }, () => t.billing.confirm(order.id, owner))]);
    expect(settled.filter(item => item.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    await t.billing.webhook('stripe', t.fake.webhook(order));
    await t.billing.confirm(order.id, owner);
    expect(await t.balance(owner)).toBe(100);
    expect(await t.fulfillments(order.id)).toBe(1);
    expect(await t.redemptions(promo.id)).toEqual([expect.objectContaining({ status: 'redeemed' })]);
    // Replaying with a forged observation after fulfilment cannot change the outcome.
    t.fake.pay(order, { paidMoney: { amount: '0.01', currency: 'USD' } });
    await t.billing.confirm(order.id, owner).catch(() => undefined);
    expect(await t.balance(owner)).toBe(100);
  });

  it("another account cannot confirm, read or ride an order's reservation", async () => {
    const owner = await t.user(), other = await t.user(), promo = await t.promotion({ maxRedemptions: 1 });
    const key = randomUUID().replaceAll('-', '');
    const order = await t.buy(owner, { offerId: 'credits', promoCode: promo.alias }, key);
    t.fake.pay(order);
    await expect(t.billing.confirm(order.id, other)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.billing.checkout.get(order.id, other)).rejects.toMatchObject({ code: 'forbidden' });
    // Same idempotency key from another account is a different order and the single use is gone.
    await expect(t.buy(other, { offerId: 'credits', promoCode: promo.alias }, key)).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    expect(await t.balance(other)).toBe(0);
    expect(await t.redemptions(promo.id)).toHaveLength(1);
  });

  it('10 concurrent redemptions of a 1-use code give exactly one discount; N-use codes give exactly N', async () => {
    const single = await t.promotion({ maxRedemptions: 1 });
    const owners = await Promise.all(Array.from({ length: 10 }, () => t.user()));
    const results = await Promise.allSettled(owners.map(owner => t.buy(owner, { offerId: 'credits', promoCode: single.alias })));
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(await t.redemptions(single.id)).toHaveLength(1);

    const triple = await t.promotion({ maxRedemptions: 3 });
    const many = await Promise.all(Array.from({ length: 12 }, () => t.user()));
    const outcome = await Promise.allSettled(many.map(owner => t.buy(owner, { offerId: 'credits', promoCode: triple.alias })));
    expect(outcome.filter(item => item.status === 'fulfilled')).toHaveLength(3);
    expect(await t.redemptions(triple.id)).toHaveLength(3);

    // One buyer racing the same code with different idempotency keys also holds at most N slots.
    const solo = await t.user(), pair = await t.promotion({ maxRedemptions: 2 });
    const racing = await Promise.allSettled(Array.from({ length: 8 }, () => t.buy(solo, { offerId: 'credits', promoCode: pair.alias })));
    expect(racing.filter(item => item.status === 'fulfilled')).toHaveLength(2);
  });

  it('a limited automatic promotion discounts exactly N concurrent buyers; the rest pay list price', async () => {
    await t.database.model('promotions').create({ data: { alias: null, providerId: 'stripe', providerCode: 'promo_auto', target: 'offer:auto',
      discountType: 'percent', percentOff: 30, maxRedemptions: 1 } });
    const owners = await Promise.all(Array.from({ length: 8 }, () => t.user()));
    const orders = await Promise.all(owners.map(owner => t.buy(owner, { offerId: 'auto' })));
    expect(orders.filter(order => order.offer.promotion)).toHaveLength(1);
    for (const order of orders.filter(item => !item.offer.promotion)) expect(order.offer.money).toEqual({ amount: '10.00', currency: 'USD' });
    // Every undiscounted order still demands the full price.
    const plain = orders.find(item => !item.offer.promotion)!;
    t.fake.pay(plain, { paidMoney: { amount: '7.00', currency: 'USD' } });
    await expect(t.billing.confirm(plain.id, plain.ownerId)).rejects.toMatchObject({ code: 'verification_failed' });
  });

  it('reservation expiry, unpaid release and provider refusal return the slot; a late honest payment is still honoured', async () => {
    const promo = await t.promotion({ maxRedemptions: 1 });
    const [a, b, c, d] = await Promise.all([t.user(), t.user(), t.user(), t.user()]);
    const orderA = await t.buy(a, { offerId: 'credits', promoCode: promo.alias });
    await expect(t.buy(b, { offerId: 'credits', promoCode: promo.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });

    // A's reservation lapses: B can take the slot.
    await t.database.model('promotionRedemptions').update({ where: { orderId: orderA.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const orderB = await t.buy(b, { offerId: 'credits', promoCode: promo.alias });
    await expect(t.buy(c, { offerId: 'credits', promoCode: promo.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });

    // An order the provider reported unpaid releases the slot at once.
    await t.database.model('billingOrders').update({ where: { id: orderB.id }, data: { state: 'unpaid' } });
    t.fake.state.failQuote = true;
    await expect(t.buy(c, { offerId: 'credits', promoCode: promo.alias })).rejects.toThrow(); // refused before the order insert: slot released
    expect(await t.database.model('billingOrders').count({ where: { ownerId: c } })).toBe(0);
    const orderC = await t.buy(c, { offerId: 'credits', promoCode: promo.alias });
    expect(orderC.offer.promotion?.id).toBe(promo.id);
    await expect(t.buy(d, { offerId: 'credits', promoCode: promo.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });

    // A paid after its slot was reused: the buyer paid the frozen price, so it is honoured (and only once).
    t.fake.pay(orderA);
    await t.billing.confirm(orderA.id, a);
    await t.billing.confirm(orderA.id, a);
    expect(await t.balance(a)).toBe(100);
    const rows = await t.redemptions(promo.id);
    expect(rows.find(item => item.orderId === orderA.id)?.status).toBe('redeemed');
    expect(rows.filter(item => item.status === 'redeemed')).toHaveLength(1);
    // Redeemed uses plus live reservations still block new buyers.
    await expect(t.buy(d, { offerId: 'credits', promoCode: promo.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
  });

  it('a disabled, expired or not-yet-started promotion is refused at order creation, even for a known alias', async () => {
    const owner = await t.user();
    const soon = await t.promotion({ startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const gone = await t.promotion({ endsAt: new Date(Date.now() - 1_000).toISOString(), startsAt: new Date(Date.now() - 3_600_000).toISOString() });
    for (const row of [soon, gone]) await expect(t.buy(owner, { offerId: 'credits', promoCode: row.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    const live = await t.promotion();
    await t.promotions.status(t.actor, live.id, { status: 'disabled', expectedRevision: live.revision });
    await expect(t.buy(owner, { offerId: 'credits', promoCode: live.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
  });
});

run('promotions on plan and credit-pack targets, first subscription cycle only (PostgreSQL)', () => {
  let t: Awaited<ReturnType<typeof boot>>;
  let plans: PlanCatalogService;
  beforeAll(async () => {
    t = await boot([]);
    plans = new PlanCatalogService(createPlanCatalogStore(t.database), { validateGrant: grant => validatePlanGrant(APP_ENTITLEMENT_CATALOG, grant) });
    t.billing.usePlanOffers({ resolve: (offerId, providerId) => plans.resolveOffer(offerId, providerId), claims: async () => false });
    t.billing.useFulfillmentHooks(planFulfillmentHooks(t.database));
  });
  afterAll(async () => { await t?.close(); });

  const cycle = (order: HostedCheckoutOrder, n: number, paid: Money, start: Date, end: Date, initial = false) =>
    new SubscriptionCycleService(createSubscriptionCyclePersistence(t.database, undefined, t.billing.extensions)).apply({
      bindingId: order.id, ownerId: order.ownerId, providerId: 'stripe', accountScope: 'synthetic-money',
      payment: { recordId: `invoice-${order.id}-${n}`, subscriptionId: `sub-${order.id}`, catalogReference: order.offer.catalogReference,
        paidMoney: paid, paymentId: initial ? `payment-${order.id}` : `payment-${order.id}-${n}`, paymentKind: 'payment-intent',
        paidAt: start.toISOString(), period: { start: start.toISOString(), end: end.toISOString() } } });

  it('discounts the first invoice only: renewals at the discounted price are refused, full price is granted', async () => {
    const plan = await plans.create({ slug: 'first-cycle', name: 'First cycle', status: true,
      prices: [{ interval: 'month', currency: 'USD', amount: '20.00', credits: 500, creditExpiry: 'period', providerRefs: { stripe: 'price_FirstCycle1' } }] });
    const offerId = `plan:${plan.id}:month:USD`;
    const promo = await t.promotion({ target: `plan:${plan.id}`, percentOff: 50 });
    const owner = await t.user();
    const order = await t.buy(owner, { offerId, promoCode: promo.alias });
    expect(order.offer.promotion).toMatchObject({ payable: { amount: '10.00' }, discount: { amount: '10.00' } });
    expect(order.offer.money).toEqual({ amount: '20.00', currency: 'USD' });
    t.fake.pay(order);
    await t.billing.checkout.confirm({ orderId: order.id, ownerId: owner });
    expect(await t.redemptions(promo.id)).toEqual([expect.objectContaining({ orderId: order.id, status: 'redeemed' })]);

    const start = new Date(Date.now() - DAY), end = new Date(start.getTime() + 30 * DAY), next = new Date(end.getTime() + 30 * DAY);
    await expect(cycle(order, 1, { amount: '10.00', currency: 'USD' }, start, end, true)).resolves.toMatchObject({ granted: true });
    // Renewal charged at the first-cycle price must be refused (a provider coupon with forever duration).
    await expect(cycle(order, 2, { amount: '10.00', currency: 'USD' }, end, next)).rejects.toMatchObject({ code: 'verification_failed' });
    await expect(cycle(order, 2, { amount: '0.01', currency: 'USD' }, end, next)).rejects.toMatchObject({ code: 'verification_failed' });
    await expect(cycle(order, 2, { amount: '20.00', currency: 'USD' }, end, next)).resolves.toMatchObject({ granted: true });
    // Replaying the initial invoice with different money is refused as changed evidence, and the first replay is a no-op.
    await expect(cycle(order, 1, { amount: '20.00', currency: 'USD' }, start, end, true)).rejects.toMatchObject({ code: 'conflict' });
    await expect(cycle(order, 1, { amount: '10.00', currency: 'USD' }, start, end, true)).resolves.toMatchObject({ granted: false });
    expect(await t.database.model('creditLots').count({ where: { userId: owner } })).toBe(2);
  });

  it('a discounted order cannot start with a full-price first invoice, and an undiscounted one cannot pay less', async () => {
    const plan = await plans.create({ slug: 'plain-sub', name: 'Plain', status: true,
      prices: [{ interval: 'month', currency: 'USD', amount: '8.00', credits: 50, creditExpiry: 'period', providerRefs: { stripe: 'price_PlainSub1' } }] });
    const offerId = `plan:${plan.id}:month:USD`;
    const owner = await t.user();
    const plain = await t.buy(owner, { offerId });
    t.fake.pay(plain);
    await t.billing.checkout.confirm({ orderId: plain.id, ownerId: owner });
    const start = new Date(Date.now() - DAY), end = new Date(start.getTime() + 30 * DAY);
    await expect(cycle(plain, 1, { amount: '4.00', currency: 'USD' }, start, end, true)).rejects.toMatchObject({ code: 'verification_failed' });
    await expect(cycle(plain, 1, { amount: '8.00', currency: 'USD' }, start, end, true)).resolves.toMatchObject({ granted: true });
  });

  it('a subscription promotion needs a provider coupon that applies once', async () => {
    const plan = await plans.create({ slug: 'forever', name: 'Forever coupon', status: true,
      prices: [{ interval: 'month', currency: 'USD', amount: '20.00', credits: 5, creditExpiry: 'period', providerRefs: { stripe: 'price_Forever1' } }] });
    const promo = await t.promotion({ target: `plan:${plan.id}` });
    const original = t.fake.provider.quotePromotion!;
    t.fake.provider.quotePromotion = async offer => ({ discount: offer.promotion!.discount, duration: 'forever' });
    try {
      await expect(t.buy(await t.user(), { offerId: `plan:${plan.id}:month:USD`, promoCode: promo.alias })).rejects.toMatchObject({ code: 'unsupported' });
      t.fake.provider.quotePromotion = async offer => ({ discount: { amount: '9.99', currency: offer.money.currency }, duration: 'once' });
      await expect(t.buy(await t.user(), { offerId: `plan:${plan.id}:month:USD`, promoCode: promo.alias })).rejects.toMatchObject({ code: 'conflict' });
    } finally { t.fake.provider.quotePromotion = original; }
  });

  it('applies to credit-pack and plan targets only, not to others, and automatic promotions skip subscriptions', async () => {
    const pack = await t.billing.packs.create({ slug: 'promo-pack', title: 'Promo pack', credits: 200, expiresInDays: null, status: true,
      prices: [{ currency: 'USD', amount: '30.00', providerRefs: { stripe: 'price_PromoPack1' } }] });
    const other = await t.billing.packs.create({ slug: 'other-pack', title: 'Other pack', credits: 20, expiresInDays: null, status: true,
      prices: [{ currency: 'USD', amount: '3.00', providerRefs: { stripe: 'price_OtherPack1' } }] });
    const owner = await t.user();
    const promo = await t.promotion({ target: `pack:${pack.id}`, percentOff: 10 });
    const order = await t.buy(owner, { offerId: `pack:${pack.id}:USD`, promoCode: promo.alias });
    expect(order.offer.promotion).toMatchObject({ payable: { amount: '27.00' }, discount: { amount: '3.00' } });
    await expect(t.buy(owner, { offerId: `pack:${other.id}:USD`, promoCode: promo.alias })).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    t.fake.pay(order, { paidMoney: { amount: '3.00', currency: 'USD' } }); // the cheaper pack's price
    await expect(t.billing.confirm(order.id, owner)).rejects.toMatchObject({ code: 'verification_failed' });
    expect(await t.balance(owner)).toBe(0);
    t.fake.pay(order);
    await t.billing.confirm(order.id, owner);
    expect(await t.balance(owner)).toBe(200);

    const plan = await plans.create({ slug: 'auto-skip', name: 'Auto skip', status: true,
      prices: [{ interval: 'month', currency: 'USD', amount: '15.00', credits: 5, creditExpiry: 'period', providerRefs: { stripe: 'price_AutoSkip1' } }] });
    await t.database.model('promotions').create({ data: { alias: null, providerId: 'stripe', providerCode: 'promo_auto_plan', target: `plan:${plan.id}`,
      discountType: 'percent', percentOff: 50 } });
    const sub = await t.buy(await t.user(), { offerId: `plan:${plan.id}:month:USD` });
    expect(sub.offer.promotion).toBeUndefined();
    expect(sub.offer.money).toEqual({ amount: '15.00', currency: 'USD' });
  });
});
