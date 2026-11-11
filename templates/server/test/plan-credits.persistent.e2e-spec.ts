import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { validatePlanGrant } from '@zucker-framework/credit';
import {
  CreditPackCatalogService, HostedCheckoutService, PlanCatalogService, SubscriptionCycleService,
  type HostedCheckoutAdapter, type HostedCheckoutObservation, type HostedCheckoutOrder, type SubscriptionAdapter,
} from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingCatalog, readBillingCatalog } from '../src/billing/catalog';
import { BillingExtensions } from '@zucker-framework/back-office/billing';
import { createCheckoutPersistence } from '../src/billing/checkout-persistence';
import { createSubscriptionCyclePersistence } from '../src/billing/subscription-persistence';
import { createCreditLedger } from '../src/billing/ledger';
import { createCreditPackStore } from '../src/billing/credit-packs.store';
import { creditPackSeedsFromBillingCatalog, seedCreditPacks } from '../src/billing/credit-pack-seeds';
import { createPlanCatalogStore } from '../src/subscriptions/plan-catalog.store';
import { planFulfillmentHooks } from '../src/subscriptions/payment-writeback';
import { APP_ENTITLEMENT_CATALOG } from '../src/subscriptions/entitlement-catalog';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_plan_credits_${randomUUID().replaceAll('-', '')}`;
const DAY = 86_400_000;

/** Synthetic provider facts only: no SDK, network or real payment. */
function fakeProvider() {
  const observations = new Map<string, HostedCheckoutObservation>();
  const provider: HostedCheckoutAdapter = {
    id: 'synthetic', accountScope: 'synthetic-test-account', modes: ['payment', 'subscription'], validate() {},
    async create(order) {
      const observed: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id,
        catalogReference: order.offer.catalogReference, mode: order.offer.mode, quantity: 1, state: 'pending',
        url: `https://synthetic.invalid/checkout/${order.id}` };
      observations.set(observed.checkoutId, observed);
      return structuredClone(observed);
    },
    async retrieve(id) { return structuredClone(observations.get(id)!); },
    async verifyWebhook() { return null; },
  };
  const lifecycle = { id: 'synthetic', accountScope: 'synthetic-test-account',
    capabilities: { paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' } } as unknown as SubscriptionAdapter;
  return { provider, lifecycle,
    paid(order: HostedCheckoutOrder, changes: Partial<HostedCheckoutObservation> = {}) {
      const id = order.checkoutId ?? `checkout-${order.id}`;
      observations.set(id, { ...observations.get(id)!, state: 'paid', paidMoney: order.offer.money,
        paymentId: `payment-${order.id}`, paymentKind: 'payment-intent', ...changes });
    } };
}

run('plan credits, credit packs and expiry-first consumption (PostgreSQL)', () => {
  let pool: Pool;
  let database: ApplicationDatabase;
  let plans: PlanCatalogService;
  let packs: CreditPackCatalogService;
  const fake = fakeProvider();
  const extensions = new BillingExtensions();
  let checkout: HostedCheckoutService;
  let catalog: BillingCatalog;
  const staticCatalog = readBillingCatalog(JSON.stringify([{ id: 'starter-credits', title: 'Starter credits', version: 'v1',
    mode: 'payment', amount: '5.00', currency: 'USD', credits: 50, expiresInDays: 30, providers: { stripe: 'price_SyntheticStarter' } }]));

  async function user() {
    const id = randomUUID();
    await database.model('users').create({ data: { id, username: `plan_${id.replaceAll('-', '')}`, name: 'Synthetic buyer',
      typeId: 'member', email: `${id}@example.invalid`, status: true } });
    return id;
  }
  const lots = (userId: string) => database.model('creditLots').findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }) as
    Promise<Array<{ id: string; source: string; amount: number; remainingAmount: number; expiresAt: Date | null }>>;
  async function buy(ownerId: string, offerId: string, subscriptionId?: string) {
    const order = await checkout.create({ orderId: randomUUID(), ownerId, offerId, providerId: 'synthetic' });
    fake.paid(order, subscriptionId ? { subscriptionId } : {});
    return checkout.confirm({ orderId: order.id, ownerId });
  }
  function cycle(order: HostedCheckoutOrder, subscriptionId: string, n: number, start: Date, end: Date) {
    return new SubscriptionCycleService(createSubscriptionCyclePersistence(database, undefined, extensions)).apply({
      bindingId: order.id, ownerId: order.ownerId, providerId: 'synthetic', accountScope: 'synthetic-test-account',
      payment: { recordId: `invoice-${order.id}-${n}`, subscriptionId, catalogReference: order.offer.catalogReference,
        paidMoney: order.offer.money, paymentId: `payment-${order.id}-${n}`, paymentKind: 'payment-intent', paidAt: start.toISOString(),
        period: { start: start.toISOString(), end: end.toISOString() } } });
  }

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(parsed.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: parsed.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    parsed.searchParams.set('schema', schema);
    database = new ApplicationDatabase(parsed.href);
    plans = new PlanCatalogService(createPlanCatalogStore(database), { validateGrant: grant => validatePlanGrant(APP_ENTITLEMENT_CATALOG, grant) });
    packs = new CreditPackCatalogService(createCreditPackStore(database));
    extensions.register(planFulfillmentHooks(database));
    catalog = new BillingCatalog(staticCatalog, [fake.provider], [], [fake.lifecycle],
      () => ({ resolve: (offerId, providerId) => plans.resolveOffer(offerId, providerId), claims: async () => false }),
      { service: packs, configured: async () => (await database.model('creditPacks').count({})) > 0 });
    checkout = new HostedCheckoutService({ persistence: createCheckoutPersistence(database, { extensions }), providers: [fake.provider],
      resolveOffer: selection => catalog.resolve(selection),
      returnUrls: id => ({ successUrl: `https://synthetic.invalid/return/${id}`, cancelUrl: 'https://synthetic.invalid/return' }) });
  });
  afterAll(async () => {
    try { await database?.disconnect(); }
    finally {
      if (pool) {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
      }
    }
  });

  it('round-trips plan price credits and presentation fields through the store', async () => {
    const plan = await plans.create({ slug: 'roundtrip', name: 'Round trip', status: true, featured: true, badge: 'Popular',
      highlights: ['One', 'Two'], nameI18n: { zh: '往返' }, highlightsI18n: { zh: ['一'] },
      prices: [{ interval: 'month', currency: 'USD', amount: '9', credits: 10, creditExpiry: 'period', providerRefs: { synthetic: 'rt-m' } },
        { interval: 'one_time', currency: 'USD', amount: '3', termDays: 7, credits: 5, creditExpiry: 14, providerRefs: {} },
        { interval: 'year', currency: 'USD', amount: '90', credits: 0, creditExpiry: 30, providerRefs: {} }] });
    expect(await plans.findById(plan.id)).toMatchObject({ featured: true, badge: 'Popular', highlights: ['One', 'Two'],
      nameI18n: { zh: '往返' }, highlightsI18n: { zh: ['一'] }, descriptionI18n: {}, prices: [
        expect.objectContaining({ interval: 'month', amount: '9.00', credits: 10, creditExpiry: 'period' }),
        expect.objectContaining({ interval: 'year', credits: 0, creditExpiry: null }),
        expect.objectContaining({ interval: 'one_time', credits: 5, creditExpiry: 14 })] });
    await expect(plans.update(plan.id, { prices: [{ interval: 'lifetime', currency: 'USD', amount: '1', credits: 1, creditExpiry: 'period' }] }))
      .rejects.toMatchObject({ reason: 'invalid' });
  });

  it('grants plan credits per cycle expiring at period end; renewal grants again; replay grants nothing', async () => {
    const plan = await plans.create({ slug: 'pro-credits', name: 'Pro', status: true,
      prices: [{ interval: 'month', currency: 'USD', amount: '19.00', credits: 1000, creditExpiry: 'period', providerRefs: { synthetic: 'synthetic-pro-m' } }] });
    const owner = await user();
    const order = await buy(owner, `plan:${plan.id}:month:USD`, 'synthetic-sub-pro');
    expect(order.offer.fulfillmentData).toMatchObject({ credits: 1000, expiresInDays: null, expiresAtPeriodEnd: true, grantBasis: 'period',
      plan: { planId: plan.id, credits: 1000, creditExpiry: 'period' } });
    // A later price edit never changes what this subscription grants on renewal (frozen snapshot).
    await plans.update(plan.id, { prices: [{ interval: 'month', currency: 'USD', amount: '19.00', credits: 5, providerRefs: { synthetic: 'synthetic-pro-m' } }] });
    const start = new Date(Date.now() - DAY), end = new Date(start.getTime() + 30 * DAY), next = new Date(end.getTime() + 30 * DAY);
    expect((await cycle(order, 'synthetic-sub-pro', 1, start, end)).granted).toBe(true);
    expect((await cycle(order, 'synthetic-sub-pro', 1, start, end)).granted).toBe(false);
    expect((await cycle(order, 'synthetic-sub-pro', 2, end, next)).granted).toBe(true);
    const granted = await lots(owner);
    expect(granted.map(lot => [lot.source, lot.amount, lot.expiresAt?.toISOString()]))
      .toEqual([['subscription', 1000, end.toISOString()], ['subscription', 1000, next.toISOString()]]);
    expect(await database.model('userSubscriptions').findUnique({ where: { userId: owner } })).toMatchObject({ planId: plan.id, endDate: next });
  });

  it('grants a one-time plan purchase once, expiring with the term; lifetime credits never expire', async () => {
    const plan = await plans.create({ slug: 'pass-credits', name: 'Pass', status: true, prices: [
      { interval: 'one_time', currency: 'USD', amount: '30.00', termDays: 30, credits: 300, creditExpiry: 'period', providerRefs: { synthetic: 'synthetic-pass' } },
      { interval: 'lifetime', currency: 'USD', amount: '99.00', credits: 7, providerRefs: { synthetic: 'synthetic-life' } }] });
    const owner = await user();
    const paid = await buy(owner, `plan:${plan.id}:one_time:USD`);
    expect(paid.fulfilledAt).toBeInstanceOf(Date);
    // Confirming again replays the paid order without a second grant.
    expect((await checkout.confirm({ orderId: paid.id, ownerId: owner })).fulfilledAt).toEqual(paid.fulfilledAt);
    await buy(owner, `plan:${plan.id}:lifetime:USD`);
    const granted = await lots(owner);
    expect(granted.map(lot => [lot.amount, lot.expiresAt?.getTime() ?? null]))
      .toEqual([[300, paid.fulfilledAt!.getTime() + 30 * DAY], [7, null]]);
  });

  it('sells static payment offers only while credit_packs is empty, then DB packs with a frozen snapshot', async () => {
    // Fallback: the static payment offer is the public pack (not purchasable here: no synthetic reference).
    expect(await catalog.publicPacks()).toEqual([expect.objectContaining({ id: 'starter-credits', slug: 'starter-credits', credits: 50,
      prices: [{ currency: 'USD', amount: '5.00', purchasable: false, offerId: null, providers: [] }] })]);
    expect(await database.transaction(tx => seedCreditPacks(tx, creditPackSeedsFromBillingCatalog(staticCatalog)))).toBe(1);
    // One-time seed: a second run (or a run after an administrator deleted every edit) does not duplicate.
    expect(await database.transaction(tx => seedCreditPacks(tx, creditPackSeedsFromBillingCatalog(staticCatalog)))).toBe(0);
    const seeded = await packs.findBySlug('starter-credits');
    expect(seeded).toMatchObject({ credits: 50, expiresInDays: 30, status: true, prices: [{ currency: 'USD', amount: '5.00', providerRefs: { stripe: 'price_SyntheticStarter' } }] });
    const pack = await packs.create({ slug: 'big', title: 'Big pack', credits: 500, expiresInDays: null, status: true,
      prices: [{ currency: 'USD', amount: '20', providerRefs: { synthetic: 'synthetic-big' } }] });
    // The static entry is no longer sold; the seeded copy has no synthetic reference, so only "big" is offered.
    expect((await catalog.list()).map(offer => offer.id)).toEqual([`pack:${pack.id}:USD`]);
    expect((await catalog.publicPacks('USD')).map(item => [item.slug, item.prices[0]?.offerId ?? null]))
      .toEqual([['starter-credits', null], ['big', `pack:${pack.id}:USD`]]);
    await expect(catalog.resolve({ orderId: 'x', ownerId: 'x', offerId: 'starter-credits', providerId: 'synthetic' })).rejects.toThrow();
    const owner = await user();
    const order = await buy(owner, `pack:${pack.id}:USD`);
    await packs.update(pack.id, { credits: 1 });
    expect(order.offer).toMatchObject({ version: `pack:${pack.id}@0`, money: { amount: '20.00', currency: 'USD' },
      fulfillmentData: { credits: 500, expiresInDays: null, pack: { packId: pack.id, credits: 500 } } });
    expect((await lots(owner)).map(lot => [lot.source, lot.amount])).toEqual([['purchase', 500]]);
    await expect(packs.create({ slug: 'dup-ref', title: 'Dup', credits: 1, prices: [{ currency: 'EUR', amount: '1', providerRefs: { synthetic: 'synthetic-big' } }] }))
      .rejects.toMatchObject({ reason: 'conflict' });
    await expect(packs.create({ slug: 'zero', title: 'Zero', credits: 0 })).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('consumes soonest-expiring credits first and never overdraws under concurrency', async () => {
    const owner = await user();
    const ledger = createCreditLedger(database);
    const grant = (amount: number, expiresAt?: Date) => database.transaction(tx => ledger.grant(tx, { accountId: owner, amount, source: 'grant',
      sourceId: randomUUID(), expiresAt, transactionData: { type: 'GRANT', description: 'Synthetic grant' } }));
    const soon = new Date(Date.now() + 2 * DAY), later = new Date(Date.now() + 20 * DAY);
    await grant(500); // oldest, never expires: drawn last
    await grant(1000, later);
    await grant(1000, soon);
    const spend = (amount: number) => database.transaction(tx => ledger.consume(tx, { accountId: owner, amount,
      transactionData: { type: 'CONSUME', description: 'Synthetic spend' }, consumptionData: { resourceType: 'synthetic', resourceId: randomUUID() } }));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => spend(300)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(8);
    const remaining = await lots(owner);
    expect(remaining.map(lot => [lot.expiresAt?.getTime() ?? null, lot.remainingAmount]))
      .toEqual([[null, 100], [later.getTime(), 0], [soon.getTime(), 0]]);
    expect(await database.model('creditAccount').findUnique({ where: { userId: owner } })).toMatchObject({ balance: 100 });
  });
});
