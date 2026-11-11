import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOrder } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingService, type BillingOptions } from '../src/billing/billing.service';
import { PromotionsService } from '../src/promotions/promotions.service';
import type { PolicyService } from '@zucker-framework/back-office/settings';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_promotions_${randomUUID().replaceAll('-', '')}`;

/** Synthetic provider that applies the frozen promotion and reports subtotal/discount evidence. */
function fakeStripe() {
  const observations = new Map<string, HostedCheckoutObservation>();
  const provider: HostedCheckoutAdapter = {
    id: 'stripe', accountScope: 'synthetic-promotions', modes: ['payment'], promotions: { modes: ['payment'] }, validate() {},
    async create(order) {
      const payable = order.offer.promotion?.payable ?? order.offer.money;
      const observed: HostedCheckoutObservation = { checkoutId: `cs-${order.id}`, reference: order.id, catalogReference: order.offer.catalogReference,
        mode: order.offer.mode, quantity: 1, state: 'pending', dueMoney: payable, url: `https://synthetic.invalid/pay/${order.id}` };
      observations.set(observed.checkoutId, observed);
      return structuredClone(observed);
    },
    async retrieve(id) { return structuredClone(observations.get(id)!); },
    async verifyWebhook(request) {
      return JSON.parse(Buffer.from(request.rawBody).toString('utf8')) as { eventId: string; checkoutId: string; reference: string };
    },
  };
  return {
    provider,
    /** What the provider would report for this order after payment (optionally forged). */
    pay(order: HostedCheckoutOrder, changes: Partial<HostedCheckoutObservation> = {}) {
      const promotion = order.offer.promotion;
      observations.set(order.checkoutId!, { ...observations.get(order.checkoutId!)!, state: 'paid',
        paidMoney: promotion?.payable ?? order.offer.money, paymentId: `pi-${order.id}`, paymentKind: 'payment-intent',
        ...(promotion ? { subtotalMoney: order.offer.money, discountMoney: promotion.discount, discountReferences: [promotion.providerCode] } : {}),
        ...changes });
    },
    webhook(order: HostedCheckoutOrder) {
      return { headers: {}, rawBody: Buffer.from(JSON.stringify({ eventId: `evt-${order.id}`, checkoutId: order.checkoutId, reference: order.id })) };
    },
  };
}

run('promotions with PostgreSQL', () => {
  let pool: Pool, database: ApplicationDatabase, billing: BillingService, promotions: PromotionsService;
  const fake = fakeStripe();
  const policy = { promo: true };
  const actor = randomUUID();

  async function user() {
    const id = randomUUID();
    await database.model('users').create({ data: { id, username: `promo_${id.replaceAll('-', '')}`, name: 'Synthetic buyer',
      typeId: 'member', email: `${id}@example.invalid`, status: true } });
    return id;
  }
  async function promotion(changes: Record<string, unknown> = {}) {
    return promotions.create(actor, { alias: `CODE${randomUUID().slice(0, 8).toUpperCase()}`, providerId: 'stripe', providerCode: 'promo_synthetic',
      target: '*', currency: null, discountType: 'percent', percentOff: 20, amountOff: null, maxRedemptions: null,
      status: 'active', startsAt: null, endsAt: null, note: null, ...changes });
  }
  const key = () => randomUUID().replaceAll('-', '');
  const buy = (owner: string, promoCode?: string, idempotencyKey = key()) =>
    billing.create(owner, idempotencyKey, { offerId: 'credits', providerId: 'stripe', ...(promoCode ? { promoCode } : {}) });

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(parsed.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: parsed.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    parsed.searchParams.set('schema', schema);
    database = new ApplicationDatabase(parsed.href);
    const options: BillingOptions = { providers: [fake.provider], webUrl: 'http://localhost:4202',
      catalogJson: JSON.stringify([{ id: 'credits', title: 'Synthetic credits', version: 'v1', mode: 'payment', amount: '12.00',
        currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'price_synthetic' } }]) };
    const policies = { ids: () => ['billing'], get: async () => ({ defaultProvider: '', allowProviderChoice: true, allowCustomerPromoCodes: policy.promo }) };
    billing = new BillingService(database, options, policies as unknown as PolicyService);
    promotions = new PromotionsService(database, billing);
  });
  afterAll(async () => {
    try { await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('freezes the server-computed discount, fulfils once with the offer credits and records one redemption', async () => {
    const owner = await user(), promo = await promotion();
    const order = await buy(owner, promo.alias!.toLowerCase());
    expect(order.offer.money).toEqual({ amount: '12.00', currency: 'USD' });
    expect(order.offer.promotion).toEqual({ id: promo.id, providerCode: 'promo_synthetic',
      payable: { amount: '9.60', currency: 'USD' }, discount: { amount: '2.40', currency: 'USD' } });
    expect(publicView(await billing.present(order))).toMatchObject({ amountDue: { amount: '9.60' }, discount: { amount: '2.40' } });
    fake.pay(order);
    await Promise.all([billing.webhook('stripe', fake.webhook(order)), billing.webhook('stripe', fake.webhook(order)),
      billing.confirm(order.id, owner)]);
    expect(await database.model('creditAccount').findUnique({ where: { userId: owner } })).toMatchObject({ balance: 100 });
    expect(await database.model('promotionRedemptions').findMany({ where: { promotionId: promo.id } })).toEqual([
      expect.objectContaining({ orderId: order.id, status: 'redeemed', reference: 'promo_synthetic', discountAmount: '2.40', payableAmount: '9.60' })]);
  });

  it('refuses a discounted payment on an order frozen without a promotion and forged promotion evidence', async () => {
    const owner = await user();
    const plain = await buy(owner);
    expect(plain.offer.promotion).toBeUndefined();
    fake.pay(plain, { paidMoney: { amount: '9.60', currency: 'USD' }, subtotalMoney: { amount: '12.00', currency: 'USD' },
      discountMoney: { amount: '2.40', currency: 'USD' } });
    await expect(billing.confirm(plain.id, owner)).rejects.toMatchObject({ code: 'verification_failed' });
    const promo = await promotion();
    const discounted = await buy(owner, promo.alias!);
    fake.pay(discounted, { discountReferences: ['promo_foreign'] });
    await expect(billing.confirm(discounted.id, owner)).rejects.toMatchObject({ code: 'verification_failed' });
    fake.pay(discounted, { subtotalMoney: undefined });
    await expect(billing.confirm(discounted.id, owner)).rejects.toMatchObject({ code: 'verification_failed' });
    expect(await database.model('creditAccount').findUnique({ where: { userId: owner } })).toBeNull();
  });

  it('gives exactly one of 10 concurrent orders the last use of a code; one idempotency key reserves once', async () => {
    const promo = await promotion({ maxRedemptions: 1 });
    const owners = await Promise.all(Array.from({ length: 10 }, () => user()));
    const results = await Promise.allSettled(owners.map(owner => buy(owner, promo.alias!)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter(item => item.status === 'rejected'))
      expect((result as PromiseRejectedResult).reason.getResponse()).toMatchObject({ code: 'PROMO_INVALID' });
    expect(await database.model('promotionRedemptions').count({ where: { promotionId: promo.id } })).toBe(1);

    const shared = await promotion({ maxRedemptions: 1 }), owner = await user(), sameKey = key();
    const orders = await Promise.allSettled(Array.from({ length: 10 }, () => buy(owner, shared.alias!, sameKey)));
    const ids = new Set(orders.filter(item => item.status === 'fulfilled').map(item => (item as PromiseFulfilledResult<HostedCheckoutOrder>).value.id));
    expect(ids.size).toBe(1);
    expect(await database.model('promotionRedemptions').count({ where: { promotionId: shared.id } })).toBe(1);
  });

  it('refuses unknown, disabled, expired, wrong-target, zero-total and policy-off codes uniformly', async () => {
    const owner = await user();
    const refused = async (code: string) => {
      const error = await buy(owner, code).then(() => null, (reason: { getResponse(): unknown }) => reason.getResponse());
      expect(error).toMatchObject({ code: 'PROMO_INVALID' });
    };
    await refused('NOPE-CODE');
    await refused((await promotion({ status: 'disabled' })).alias!);
    await refused((await promotion({ endsAt: new Date(Date.now() - 1000).toISOString() })).alias!);
    // A target the management API would refuse today (no such offer) can still exist from an older catalog.
    await database.model('promotions').create({ data: { alias: 'WRONG-TARGET', providerId: 'stripe', providerCode: 'promo_synthetic',
      target: 'offer:other', discountType: 'percent', percentOff: 20 } });
    await refused('WRONG-TARGET');
    await refused((await promotion({ currency: 'EUR' })).alias!);
    await refused((await promotion({ discountType: 'amount', percentOff: null, amountOff: '12.00', currency: 'USD' })).alias!);
    await expect(billing.create(owner, key(), { offerId: 'credits', providerId: 'stripe', providerCode: 'promo_synthetic' }))
      .rejects.toThrow('Invalid checkout selection');
    policy.promo = false;
    try {
      expect((await billing.checkoutPolicy()).promoCodes).toBe('none');
      await refused((await promotion()).alias!);
    } finally { policy.promo = true; }
    expect((await billing.checkoutPolicy()).promoCodes).toBe('alias');
  });

  it('management is revision-checked, audited and refuses deleting a used promotion', async () => {
    const promo = await promotion();
    const updated = await promotions.update(actor, promo.id, { ...editable(promo), percentOff: 30, expectedRevision: promo.revision });
    expect(updated).toMatchObject({ percentOff: 30, revision: promo.revision + 1 });
    await expect(promotions.update(actor, promo.id, { ...editable(promo), expectedRevision: promo.revision })).rejects.toMatchObject({ status: 409 });
    await expect(promotion({ alias: promo.alias })).rejects.toMatchObject({ status: 409 });
    await buy(await user(), promo.alias!);
    await expect(promotions.remove(actor, promo.id, String(updated.revision))).rejects.toMatchObject({ status: 409 });
    const disabled = await promotions.status(actor, promo.id, { status: 'disabled', expectedRevision: updated.revision });
    expect(disabled.status).toBe('disabled');
    expect(await database.model('operationLogs').count({ where: { module: 'promotions', targetId: promo.id } })).toBe(3);
  });
});

function publicView(value: unknown) { return value as Record<string, unknown>; }
function editable(row: Record<string, unknown>) {
  const { id: _id, revision: _revision, createdAt: _c, updatedAt: _u, usage: _usage, ...rest } = row;
  return { ...rest, startsAt: null, endsAt: null };
}
