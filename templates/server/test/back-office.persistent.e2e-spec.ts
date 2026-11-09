import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ResourceChargeService } from '@zucker-framework/credit';
import type {
  HostedCheckoutAdapter, HostedCheckoutObservation, SubscriptionAdapter, SubscriptionCycleReceipt,
} from '@zucker-framework/payment';
import { managementFixture } from './helpers/management-fixture';
import { BACK_OFFICE_PERMISSIONS, createAdministrator } from '../src/accounts/create-administrator';
import { SubscriptionsModule } from '../src/subscriptions/subscriptions.module';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';
import { MailModule } from '../src/mail/mail.module';
import { createPlanQuotaStore, resourceChargeLookup } from '../src/subscriptions/entitlement-quota';
import { PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, PLAN_TERM_CHANGED_OUTBOX_KIND, planFulfillmentHooks } from '../src/subscriptions/payment-writeback';
import { planSeedsFromBillingCatalog, seedPlans } from '../src/subscriptions/plan-seeds';
import { BillingExtensions } from '../src/billing/billing-extensions';
import { BillingCatalog, readBillingCatalog } from '../src/billing/catalog';
import type { BillingSubscription } from '../src/billing/subscription-persistence';

/** Synthetic one-time payment channel (no network): checkouts are captured explicitly by the test. */
function syntheticPaymentProvider(quotes: Map<string, { amount: string; currency: string }>) {
  const observations = new Map<string, HostedCheckoutObservation>();
  const provider: HostedCheckoutAdapter = {
    id: 'paypal', accountScope: 'synthetic-paypal-sandbox', modes: ['payment'], validate() {},
    // The provider's own price for a catalog reference, when the test sets one.
    async quote(offer) { const money = quotes.get(offer.catalogReference); return money ? { money, mode: 'payment' } : null; },
    async create(order) {
      const fact: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id, mode: order.offer.mode,
        quantity: 1, catalogReference: order.offer.catalogReference, state: 'requires_capture', dueMoney: order.offer.money,
        url: `https://synthetic.invalid/pay/${order.id}` };
      observations.set(fact.checkoutId, fact);
      return structuredClone(fact);
    },
    async retrieve(id) { return structuredClone(observations.get(id)!); },
    async capture(id) {
      const fact = observations.get(id)!;
      const paid = { ...fact, state: 'paid' as const, paidMoney: fact.dueMoney, paymentId: `payment-${id}`, paymentKind: 'capture' as const };
      observations.set(id, paid);
      return structuredClone(paid);
    },
    async verifyWebhook() { return null; },
  };
  return provider;
}

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('back office plans, subscriptions, entitlements, quota and mail (PostgreSQL)', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let service: SubscriptionsService;
  let member: { userId: string; token: string };
  let other: { userId: string; token: string };
  let reader: { userId: string; token: string };
  let buyer: { userId: string; token: string };
  let proId: string;
  const quotes = new Map<string, { amount: string; currency: string }>();
  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token = f.admin.token) =>
    request(f.app.getHttpServer())[method](`/api${path}`).set('Authorization', `Bearer ${token}`);
  const pro = { slug: 'pro', name: 'Pro', status: false, order: 2,
    features: { projects: true, exports: true, adFree: true }, quotas: { projects_per_month: 3, exports_per_day: -1 },
    prices: [
      { interval: 'month', currency: 'USD', amount: '19.9', providerRefs: { stripe: 'price_ProMonthly' } },
      { interval: 'year', currency: 'USD', amount: '199', providerRefs: { stripe: 'price_ProYearly' } },
    ] };

  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, 'http://localhost:4320',
      { providers: [syntheticPaymentProvider(quotes)], catalogJson: '[]', webUrl: 'http://localhost:4202' }, [SubscriptionsModule, MailModule]);
    service = f.app.get(SubscriptionsService);
    member = await f.member('planmember');
    other = await f.member('planother');
    buyer = await f.member('planbuyer');
    reader = await f.member('planreader', ['plans:query', 'subscriptions:query', 'quota:query', 'mail:query']);
  });
  afterAll(async () => { await f?.close(); });

  it('serves the code-declared catalog with translation keys and requires a session for /me', async () => {
    const catalog = (await request(f.app.getHttpServer()).get('/api/billing/entitlements/catalog').expect(200)).body;
    expect(catalog.features.map((item: { key: string }) => item.key)).toEqual(['projects', 'exports', 'prioritySupport', 'adFree']);
    expect(catalog.counters[0]).toEqual({ key: 'projects_per_month', label: 'Projects', labelKey: 'entitlements.counter.projects_per_month',
      unit: 'per month', period: 'month' });
    expect(catalog.features[0].labelKey).toBe('entitlements.feature.projects');
    await request(f.app.getHttpServer()).get('/api/billing/entitlements/me').expect(401);
    const me = (await api('get', '/billing/entitlements/me', member.token).expect(200)).body;
    expect(me).toMatchObject({ active: false, plan: null, status: null, validUntil: null,
      features: { projects: false, adFree: false }, quotas: { projects_per_month: { limit: 0, used: 0, reserved: 0, remaining: 0 } } });
  });

  it('seeds the back-office permission rows so delegated roles can be granted them', async () => {
    for (const code of BACK_OFFICE_PERMISSIONS)
      expect(await f.database.model('permissions').findUnique({ where: { id: code } })).not.toBeNull();
  });

  it('manages plans with prices, RFC permissions, catalog validation, uniqueness and revisions', async () => {
    await api('get', '/management/plans', member.token).expect(403);
    await api('get', '/management/plans', reader.token).expect(200);
    await api('post', '/management/plans', reader.token).send(pro).expect(403);
    const invalid = await api('post', '/management/plans').send({ ...pro, features: { unknown: true }, quotas: { projects_per_month: -2 } }).expect(400);
    // The envelope filter keeps the port's reason and issues for the client.
    expect(invalid.body).toMatchObject({ code: 'invalid', result: { reason: 'invalid', issues: expect.arrayContaining(['unknown feature unknown']) } });
    await api('post', '/management/plans').send({ ...pro, prices: [{ ...pro.prices[0], providerRefs: { stripe: 'prod_x' } }] }).expect(400);
    await api('post', '/management/plans').send({ ...pro, prices: [{ ...pro.prices[0], amount: 19.9 }] }).expect(400);
    const created = (await api('post', '/management/plans').send(pro).expect(201)).body;
    proId = created.id;
    expect(created).toMatchObject({ slug: 'pro', status: false, revision: 0, quotas: { projects_per_month: 3, exports_per_day: -1 },
      prices: [{ interval: 'month', currency: 'USD', amount: '19.90', termDays: null, providerRefs: { stripe: 'price_ProMonthly' } },
        { interval: 'year', amount: '199.00' }] });
    await api('post', '/management/plans').send(pro).expect(409);
    // One provider reference sells one price across all plans.
    await api('post', '/management/plans').send({ ...pro, slug: 'pro-2', prices: [pro.prices[1]] }).expect(409);
    expect((await request(f.app.getHttpServer()).get('/api/billing/plans').expect(200)).body).toEqual([]);
    await api('patch', `/management/plans/${proId}/status`).send({ status: 'yes' }).expect(400);
    expect((await api('patch', `/management/plans/${proId}/status`).send({ status: true }).expect(200)).body).toMatchObject({ status: true, revision: 1 });
    const updated = (await api('put', `/management/plans/${proId}`).send({ name: 'Pro plan', description: 'Synthetic', expectedRevision: 1 }).expect(200)).body;
    expect(updated).toMatchObject({ name: 'Pro plan', features: pro.features, revision: 2, prices: [{ amount: '19.90' }, { amount: '199.00' }] });
    // A second editor still holding revision 1 cannot overwrite that edit.
    const stale = await api('put', `/management/plans/${proId}`).send({ name: 'Lost edit', expectedRevision: 1 }).expect(409);
    expect(stale.body).toMatchObject({ code: 'conflict' });
    const listed = (await request(f.app.getHttpServer()).get('/api/billing/plans').expect(200)).body;
    // Stripe is not configured here, so nothing can sell these prices.
    expect(listed).toEqual([expect.objectContaining({ slug: 'pro', name: 'Pro plan',
      prices: [expect.objectContaining({ interval: 'month', amount: '19.90', purchasable: false, offerId: null, providers: [] }),
        expect.objectContaining({ interval: 'year', amount: '199.00', purchasable: false })] })]);
    expect(JSON.stringify(listed)).not.toContain('price_Pro');
    expect((await request(f.app.getHttpServer()).get('/api/billing/plans?currency=EUR').expect(200)).body[0].prices).toEqual([]);
    await api('get', '/management/plans/missing').expect(404);
    const draft = (await api('post', '/management/plans').send({ slug: 'draft', name: 'Draft',
      prices: [{ interval: 'month', currency: 'JPY', amount: '0' }] }).expect(201)).body;
    await api('put', `/management/plans/${draft.id}`).send({ prices: [{ interval: 'month', currency: 'JPY', amount: '1.5' }] }).expect(400);
    await api('delete', `/management/plans/${draft.id}`).expect(200);
    await api('delete', `/management/plans/${draft.id}`).expect(404);
  });

  it('sells the current plan price and writes back the plan frozen on the order', async () => {
    const pass = (await api('post', '/management/plans').send({ slug: 'pass', name: 'Pass', status: true,
      features: { projects: true }, quotas: { projects_per_month: 1 },
      prices: [{ interval: 'one_time', currency: 'USD', amount: '30.00', termDays: 30, providerRefs: { paypal: 'synthetic-pass' } },
        { interval: 'lifetime', currency: 'USD', amount: '99.00', providerRefs: { paypal: 'synthetic-lifetime' } }] }).expect(201)).body;
    const priceOf = async () => ((await request(f.app.getHttpServer()).get('/api/billing/plans').expect(200)).body as Array<{
      slug: string; prices: Array<{ interval: string; amount: string; offerId: string | null; purchasable: boolean }> }>)
      .find(plan => plan.slug === 'pass')!.prices.find(price => price.interval === 'one_time')!;
    expect(await priceOf()).toMatchObject({ amount: '30.00', purchasable: true, offerId: `plan:${pass.id}:one_time:USD` });
    // An administrator edits the price: public plans and the next checkout use the new amount.
    await api('put', `/management/plans/${pass.id}`).send({ prices: [
      { interval: 'one_time', currency: 'USD', amount: '35.00', termDays: 30, providerRefs: { paypal: 'synthetic-pass' } },
      { interval: 'lifetime', currency: 'USD', amount: '99.00', providerRefs: { paypal: 'synthetic-lifetime' } }] }).expect(200);
    const offer = await priceOf();
    expect(offer.amount).toBe('35.00');
    const checkout = (await api('post', '/billing/orders', buyer.token).set('Origin', f.origin).set('Idempotency-Key', 'synthetic-plan-pass-0001')
      .send({ offerId: offer.offerId, providerId: 'paypal' }).expect(200)).body;
    expect(checkout).toMatchObject({ offerId: offer.offerId, mode: 'payment', money: { amount: '35.00', currency: 'USD' }, title: 'Pass' });
    const order = await f.database.model('billingOrders').findUnique({ where: { id: checkout.id } }) as { offer: { fulfillmentData: { plan: Record<string, unknown>; credits: number } } };
    expect(order.offer.fulfillmentData).toMatchObject({ credits: 0, plan: { planId: pass.id, slug: 'pass', amount: '35.00', interval: 'one_time',
      termDays: 30, providerId: 'paypal', providerRef: 'synthetic-pass' } });
    // While the plan checkout is unsettled, administrators cannot change the term; the 409 names it.
    const blocked = await api('put', `/management/subscriptions/${buyer.userId}`).send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(409);
    expect(blocked.body).toMatchObject({ code: 'pending_payment', result: { details: { blocking: { kind: 'order', id: checkout.id, state: expect.any(String) } } } });
    // A later edit (even a rename of the slug) does not change what this order grants.
    await api('put', `/management/plans/${pass.id}`).send({ slug: 'pass-renamed' }).expect(200);
    // The plan cannot be deleted while an order still needs it for write-back.
    await api('delete', `/management/plans/${pass.id}`).expect(409);
    const paid = (await api('post', `/billing/orders/${checkout.id}/capture`, buyer.token).set('Origin', f.origin).send({ approved: true }).expect(200)).body;
    expect(paid.state).toBe('paid');
    const term = (await api('get', `/management/subscriptions/${buyer.userId}`).expect(200)).body;
    expect(term).toMatchObject({ billingCycle: 'ONE_TIME', source: 'payment', status: 'ACTIVE', active: true, plan: { id: pass.id, slug: 'pass-renamed' } });
    expect(new Date(term.endDate).getTime() - new Date(term.startDate).getTime()).toBe(30 * 86_400_000);
    expect(await f.database.model('userSubscriptionPayments').findUnique({ where: { reference: `order:${checkout.id}` } }))
      .toMatchObject({ planId: pass.id, billingCycle: 'ONE_TIME', orderId: checkout.id });
    expect(await f.database.model('billingOutbox').count({ where: { kind: PLAN_TERM_CHANGED_OUTBOX_KIND, aggregateId: `order:${checkout.id}` } })).toBe(1);
    expect(await f.database.model('creditLots').count({ where: { userId: buyer.userId } })).toBe(0);
    // Lifetime: no end, and it cannot be canceled at period end, only revoked.
    const lifetime = `plan:${pass.id}:lifetime:USD`;
    const life = (await api('post', '/billing/orders', buyer.token).set('Origin', f.origin).set('Idempotency-Key', 'synthetic-plan-life-0001')
      .send({ offerId: lifetime, providerId: 'paypal' }).expect(200)).body;
    await api('post', `/billing/orders/${life.id}/capture`, buyer.token).set('Origin', f.origin).send({ approved: true }).expect(200);
    expect((await api('get', `/management/subscriptions/${buyer.userId}`).expect(200)).body).toMatchObject({ billingCycle: 'LIFETIME', endDate: null, active: true });
    const cancel = await api('delete', `/management/subscriptions/${buyer.userId}`).expect(400);
    expect(cancel.body).toMatchObject({ code: 'invalid' });
    expect((await api('put', `/management/subscriptions/${buyer.userId}`).send({ planSlug: 'pass-renamed', billingCycle: 'LIFETIME', status: 'EXPIRED' })
      .expect(200)).body).toMatchObject({ status: 'EXPIRED', active: false });
    // Draft plans are not sold; a non-plan id with a colon is never a static offer.
    await api('patch', `/management/plans/${pass.id}/status`).send({ status: false }).expect(200);
    await api('post', '/billing/orders', buyer.token).set('Origin', f.origin).set('Idempotency-Key', 'synthetic-plan-draft-001')
      .send({ offerId: lifetime, providerId: 'paypal' }).expect(400);
  });

  it('admits only purchases that improve the term, stacks one-time terms and never resurrects a revoked term', async () => {
    const stacker = await f.member('planstacker');
    const plan = (await api('post', '/management/plans').send({ slug: 'stack', name: 'Stack', status: true,
      features: { projects: true }, quotas: { projects_per_month: 1 },
      prices: [{ interval: 'one_time', currency: 'USD', amount: '10.00', termDays: 10, providerRefs: { paypal: 'synthetic-stack' } },
        { interval: 'lifetime', currency: 'USD', amount: '50.00', providerRefs: { paypal: 'synthetic-stack-life' } }] }).expect(201)).body;
    const oneTime = `plan:${plan.id}:one_time:USD`, lifetime = `plan:${plan.id}:lifetime:USD`;
    let keys = 0;
    const checkout = (offerId: string) => api('post', '/billing/orders', stacker.token).set('Origin', f.origin)
      .set('Idempotency-Key', `synthetic-stack-${String(++keys).padStart(8, '0')}`).send({ offerId, providerId: 'paypal' });
    const pay = async (offerId: string) => {
      const order = (await checkout(offerId).expect(200)).body;
      await api('post', `/billing/orders/${order.id}/capture`, stacker.token).set('Origin', f.origin).send({ approved: true }).expect(200);
      return order.id as string;
    };
    const term = async () => (await api('get', `/management/subscriptions/${stacker.userId}`).expect(200)).body;
    const orders = () => f.database.model('billingOrders').count({ where: { ownerId: stacker.userId } });
    // A provider price that drifted from the plan price fails before an order or payable URL exists.
    quotes.set('synthetic-stack', { amount: '9.00', currency: 'USD' });
    expect((await checkout(oneTime).expect(409)).body).toMatchObject({ code: 'conflict' });
    expect(await orders()).toBe(0);
    quotes.set('synthetic-stack', { amount: '10', currency: 'USD' });
    // Same-plan one-time terms stack: paid days add up instead of overlapping.
    await pay(oneTime);
    const first = await term();
    await pay(oneTime);
    const second = await term();
    expect(new Date(second.endDate).getTime() - new Date(first.endDate).getTime()).toBe(10 * 86_400_000);
    expect(second).toMatchObject({ billingCycle: 'ONE_TIME', startDate: first.startDate, source: 'payment' });
    await pay(lifetime);
    expect(await term()).toMatchObject({ billingCycle: 'LIFETIME', endDate: null });
    // A lifetime term cannot be improved: the purchase is refused before an order exists.
    const before = await orders();
    const refused = await checkout(oneTime).expect(409);
    expect(refused.body).toMatchObject({ code: 'conflict', result: { reason: 'conflict', details: { refusal: 'lifetime_active' } } });
    expect(await orders()).toBe(before);
    // Revocation proceeds although a plan checkout is unsettled; other changes still wait for it.
    await api('put', `/management/subscriptions/${stacker.userId}`).send({ planSlug: 'stack', billingCycle: 'LIFETIME', status: 'EXPIRED' }).expect(200);
    const open = (await checkout(oneTime).expect(200)).body;
    await api('put', `/management/subscriptions/${stacker.userId}`).send({ planSlug: 'stack', billingCycle: 'ONE_TIME',
      endDate: new Date(Date.now() + 86_400_000).toISOString() }).expect(409);
    await api('put', `/management/subscriptions/${stacker.userId}`).send({ planSlug: 'stack', billingCycle: 'LIFETIME', status: 'EXPIRED' }).expect(200);
    // The checkout is paid after the revocation: recorded, flagged for a refund, never applied.
    await api('post', `/billing/orders/${open.id}/capture`, stacker.token).set('Origin', f.origin).send({ approved: true }).expect(200);
    expect(await term()).toMatchObject({ status: 'EXPIRED', active: false });
    expect(await f.database.model('userSubscriptionPayments').findUnique({ where: { reference: `order:${open.id}` } })).not.toBeNull();
    expect(await f.database.model('billingOutbox').findMany({ where: { kind: PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, aggregateId: `order:${open.id}` } }))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ outcome: 'revoked', userId: stacker.userId, amount: '10.00' }) })]);
    // An old unsettled checkout (past any hosted session lifetime) no longer pins the account.
    const pending = (await checkout(oneTime).expect(200)).body;
    await f.database.model('billingOrders').updateMany({ where: { id: pending.id }, data: { state: 'pending', createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    await api('put', `/management/subscriptions/${stacker.userId}`).send({ planSlug: 'stack', billingCycle: 'ONE_TIME',
      endDate: new Date(Date.now() + 86_400_000).toISOString() }).expect(200);
    // Status and activity filters combine (the activity predicate must not replace the status).
    expect((await api('get', '/management/subscriptions?status=EXPIRED&active=active').expect(200)).body.total).toBe(0);
    expect((await api('get', `/management/subscriptions?userId=${stacker.userId}&status=ACTIVE&active=active`).expect(200)).body.total).toBe(1);
  });

  it('never fulfills a plan sale without a registered plan hook', async () => {
    const order = { id: 'no-hook', offer: { mode: 'payment', fulfillmentData: { credits: 0, expiresInDays: null, plan: { planId: proId } } } };
    await expect(f.database.transaction(tx => new BillingExtensions().checkoutFulfilled(tx, order as never))).rejects.toThrow('no plan fulfillment hook');
    const registered = new BillingExtensions();
    registered.register({ plans: true, checkoutFulfilled: async () => undefined });
    await f.database.transaction(tx => registered.checkoutFulfilled(tx, order as never));
    // Credit-only sales need no plan hook.
    await f.database.transaction(tx => new BillingExtensions().checkoutFulfilled(tx, { offer: { fulfillmentData: { credits: 1 } } } as never));
  });

  it('assigns, lists, cancels and guards user subscriptions', async () => {
    await api('put', `/management/subscriptions/${member.userId}`, reader.token).send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(403);
    await api('put', `/management/subscriptions/${member.userId}`).send({ planSlug: 'pro', billingCycle: 'WEEKLY' }).expect(400);
    await api('put', `/management/subscriptions/${member.userId}`).send({ planSlug: 'missing', billingCycle: 'MONTHLY' }).expect(404);
    await api('put', '/management/subscriptions/no-such-user').send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(404);
    await api('get', `/management/subscriptions/${member.userId}`).expect(404);
    const assigned = (await api('put', `/management/subscriptions/${member.userId}`).send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(200)).body;
    expect(assigned).toMatchObject({ status: 'ACTIVE', billingCycle: 'MONTHLY', source: 'admin', active: true,
      user: { id: member.userId, username: 'planmember' }, plan: { slug: 'pro' },
      quotas: { projects_per_month: { limit: 3, used: 0, remaining: 3 }, exports_per_day: { limit: -1, remaining: -1 } } });
    const list = (await api('get', '/management/subscriptions?planSlug=pro&status=ACTIVE&active=active', reader.token).expect(200)).body;
    expect(list).toMatchObject({ total: 1, page: 1, data: [{ userId: member.userId, plan: { slug: 'pro' } }] });
    expect(JSON.stringify(list)).not.toMatch(/password|paymentReference/);
    await api('get', '/management/subscriptions?status=PAUSED').expect(400);
    await api('get', '/management/subscriptions?active=maybe').expect(400);
    // The revoked lifetime term of the previous test is listed as inactive.
    const inactive = (await api('get', '/management/subscriptions?active=inactive').expect(200)).body;
    expect(inactive.data.map((row: { userId: string }) => row.userId)).toEqual([buyer.userId]);
    const me = (await api('get', '/billing/entitlements/me', member.token).expect(200)).body;
    expect(me).toMatchObject({ active: true, plan: { slug: 'pro', name: 'Pro plan' }, status: 'ACTIVE',
      features: { projects: true, exports: true, prioritySupport: false, adFree: true } });
    expect(me.quotas.projects_per_month.period).toMatch(/^\d{4}-\d{2}$/);
    // A referenced plan cannot be deleted.
    await api('delete', `/management/plans/${proId}`).expect(409);
    // A credit-only checkout does not block plan administration; a plan subscription checkout does.
    const base = { ownerId: other.userId, providerId: 'stripe', accountScope: 'synthetic', successUrl: 'https://synthetic.invalid/s',
      cancelUrl: 'https://synthetic.invalid/c', creationState: 'created', captureState: 'idle', state: 'pending' };
    await f.database.model('billingOrders').create({ data: { ...base, id: 'pending-credit-order', offerId: 'credits',
      offer: { mode: 'payment', fulfillmentData: { credits: 10, expiresInDays: null } }, createKey: 'synthetic-create-1', captureKey: 'synthetic-capture-1' } });
    await api('put', `/management/subscriptions/${other.userId}`).send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(200);
    await f.database.model('billingOrders').create({ data: { ...base, id: 'pending-sub-order', offerId: `plan:${proId}:month:USD`,
      offer: { mode: 'subscription', fulfillmentData: { credits: 0, expiresInDays: null, grantBasis: 'period', plan: { planId: proId } } },
      createKey: 'synthetic-create-2', captureKey: 'synthetic-capture-2' } });
    await api('put', `/management/subscriptions/${other.userId}`).send({ planSlug: 'pro', billingCycle: 'YEARLY' }).expect(409);
    // A stale `unknown` checkout no longer pins the account.
    await f.database.model('billingOrders').updateMany({ where: { id: 'pending-sub-order' },
      data: { state: 'unknown', createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    await api('put', `/management/subscriptions/${other.userId}`).send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(200);
    // Cancel keeps the paid term valid until its end date.
    const canceled = (await api('delete', `/management/subscriptions/${member.userId}`).expect(200)).body;
    expect(canceled).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: true, active: true });
    expect((await api('get', '/billing/entitlements/me', member.token).expect(200)).body.active).toBe(true);
    await api('put', `/management/subscriptions/${member.userId}`).send({ planSlug: 'pro', billingCycle: 'MONTHLY', status: 'ACTIVE' }).expect(200);
  });

  it('charges a metered feature once per resource and counter with real locks, release and exhaustion', async () => {
    let calls = 0;
    const use = (feature: 'projects' | 'exports', id: string, fail = false) => service.chargeResource(member.userId, feature, { type: 'project', id }, async charge => {
      calls++;
      if (fail) throw new Error('synthetic work failure');
      return charge.free;
    });
    expect(await use('projects', 'p1')).toBe(false);
    expect(await use('projects', 'p1')).toBe(true);
    // The same project on another counter is charged there (B1), once.
    expect(await use('exports', 'p1')).toBe(false);
    expect(await use('exports', 'p1')).toBe(true);
    await expect(use('projects', 'p2', true)).rejects.toThrow('synthetic work failure');
    expect(await use('projects', 'p2')).toBe(false);
    // Concurrent first uses: one is charged; the others are free after it or told to retry while it runs.
    const results = await Promise.allSettled([use('projects', 'p3'), use('projects', 'p3'), use('projects', 'p3')]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value === false)).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect((result.reason as { getStatus(): number }).getStatus()).toBe(409);
    const me = (await api('get', '/billing/entitlements/me', member.token).expect(200)).body;
    expect(me.quotas.projects_per_month).toMatchObject({ limit: 3, used: 3, reserved: 0, remaining: 0 });
    await expect(use('projects', 'p4')).rejects.toThrow('exhausted');
    // Work inside an already charged project stays free after exhaustion.
    expect(await use('projects', 'p1')).toBe(true);
    const usage = await f.database.model('quotaUsage').findMany({ where: { subjectId: member.userId, counter: 'exports_per_day' } }) as Array<{ used: number; limit: number }>;
    expect(usage).toEqual([expect.objectContaining({ used: 1, limit: -1 })]);
    // Without the feature, nothing is reserved.
    await expect(service.chargeResource(reader.userId, 'projects', { type: 'project', id: 'x' }, async () => 1)).rejects.toThrow('does not include');
    expect(calls).toBeGreaterThan(0);
  });

  it('expires an unswept stale reservation instead of failing the next charge (B3)', async () => {
    // A request that started two minutes ago and died: its row stays RESERVED past expiry, unswept.
    const past = () => new Date(Date.now() - 120_000);
    const crashed = new ResourceChargeService(createPlanQuotaStore(f.database), resourceChargeLookup, { now: past });
    const stale = await crashed.begin({ id: 'stale-export', subjectId: member.userId, counter: 'exports_per_day', amount: 1,
      period: service.entitlements.period('exports_per_day'), limit: -1, policyVersion: 'plan:test', resourceType: 'export',
      resourceId: 'e-stale', expiresAt: new Date(Date.now() - 60_000) });
    expect(stale.reservation?.status).toBe('RESERVED');
    expect(await service.chargeResource(member.userId, 'exports', { type: 'export', id: 'e-stale' }, async charge => charge.free)).toBe(false);
    expect(await f.database.model('quotaReservation').findUnique({ where: { id: 'stale-export' } }))
      .toMatchObject({ status: 'EXPIRED', activeResourceKey: null, reason: 'reservation-expired' });
    // The storage key is required exactly while RESERVED/CONFIRMED.
    await expect(f.database.transaction(tx => tx.query(`INSERT INTO quota_reservations (id,"subjectId",counter,period,amount,"limit","policyVersion","resourceType","resourceId","expiresAt")
      VALUES ('no-key',$1,'exports_per_day','x',1,-1,'v','export','e-key',now() + interval '1 minute')`, [member.userId]))).rejects.toThrow();
  });

  it('lists projected quota records and releases/confirms through the state machine', async () => {
    const charges = new ResourceChargeService(createPlanQuotaStore(f.database), resourceChargeLookup);
    const pending = async (id: string, resourceId: string) => (await charges.begin({ id, subjectId: member.userId, counter: 'exports_per_day',
      amount: 1, period: service.entitlements.period('exports_per_day'), limit: -1, policyVersion: 'plan:test', resourceType: 'export',
      resourceId, expiresAt: new Date(Date.now() + 60_000) })).reservation;
    expect(await pending('admin-release', 'e-release')).not.toBeNull();
    expect(await pending('admin-confirm', 'e-confirm')).not.toBeNull();
    await api('get', '/management/quota-reservations', member.token).expect(403);
    const page = (await api('get', `/management/quota-reservations?userId=${member.userId}&status=RESERVED`, reader.token).expect(200)).body;
    expect(page.total).toBe(2);
    expect(page.data[0]).toEqual(expect.objectContaining({ userId: member.userId, status: 'RESERVED', resourceType: 'export' }));
    expect(JSON.stringify(page)).not.toMatch(/policyVersion|plan:test|subjectId|activeResourceKey/);
    await api('get', '/management/quota-reservations?status=BAD').expect(400);
    // quota_usage has no id column; `id` is not a usage filter (B12).
    await api('get', '/management/quota-usage?id=x').expect(200);
    await api('post', '/management/quota-reservations/admin-release/release', reader.token).send({}).expect(403);
    expect((await api('post', '/management/quota-reservations/admin-release/release').send({ reason: 'support' }).expect(200)).body).toEqual({ id: 'admin-release', changed: true });
    expect((await api('post', '/management/quota-reservations/admin-release/release').send({}).expect(200)).body.changed).toBe(false);
    await api('post', '/management/quota-reservations/admin-release/confirm').expect(409);
    await api('post', '/management/quota-reservations/missing/confirm').expect(404);
    expect((await api('post', '/management/quota-reservations/admin-confirm/confirm').expect(200)).body.changed).toBe(true);
    const detail = (await api('get', '/management/quota-reservations/admin-release').expect(200)).body;
    expect(detail).toMatchObject({ status: 'RELEASED', reason: 'support' });
    const usage = (await api('get', `/management/quota-usage?userId=${member.userId}&counter=exports_per_day`, reader.token).expect(200)).body;
    expect(usage.data).toEqual([expect.objectContaining({ userId: member.userId, used: 3, limit: -1 })]);
  });

  it('writes back paid cycles from the frozen plan snapshot, once per receipt, never from an ended period', async () => {
    const hooks = planFulfillmentHooks(f.database);
    const snapshot = { planId: proId, slug: 'renamed-later', revision: 2, interval: 'year', currency: 'USD', amount: '199.00',
      termDays: null, providerId: 'stripe', providerRef: 'price_ProYearly' };
    const subscription = { initialOrderId: 'sub-order-1', offer: { fulfillmentData: { credits: 0, expiresInDays: null, grantBasis: 'period', plan: snapshot } } } as unknown as BillingSubscription;
    const receipt = (id: string, start: number, end: number) => ({ id, periodStart: new Date(start), periodEnd: new Date(end), paidAt: new Date(start) }) as SubscriptionCycleReceipt;
    const now = Date.now(), year = 365 * 86_400_000;
    const cycle = (value: SubscriptionCycleReceipt, owner = reader.userId, binding = subscription) =>
      f.database.transaction(tx => hooks.cycleFulfilled!(tx, { ownerId: owner, subscription: binding, receipt: value }));
    await cycle(receipt('cycle-synthetic-1', now - 1000, now + year));
    const row = await f.database.model('userSubscriptions').findUnique({ where: { userId: reader.userId } }) as Record<string, unknown>;
    expect(row).toMatchObject({ planId: proId, source: 'payment', billingCycle: 'YEARLY', status: 'ACTIVE', paymentReference: 'cycle:cycle-synthetic-1' });
    // Replays are no-ops; an old, already ended cycle is recorded but never replaces the term.
    await cycle(receipt('cycle-synthetic-1', now - 1000, now + year));
    await cycle(receipt('cycle-synthetic-0', now - 2 * year, now - year));
    expect(await f.database.model('userSubscriptionPayments').count({ where: { userId: reader.userId } })).toBe(2);
    expect(await f.database.model('userSubscriptions').findUnique({ where: { userId: reader.userId } })).toMatchObject({ paymentReference: 'cycle:cycle-synthetic-1' });
    // Credit-only subscriptions leave plan terms unchanged.
    const creditOnly = { initialOrderId: 'x', offer: { fulfillmentData: { credits: 5, expiresInDays: null } } } as unknown as BillingSubscription;
    await cycle(receipt('cycle-credit-only', now, now + year), other.userId, creditOnly);
    expect(await f.database.model('userSubscriptionPayments').count({ where: { userId: other.userId } })).toBe(0);
  });

  it('sells a seeded subscription offer only as its plan', async () => {
    const items = readBillingCatalog(JSON.stringify([{ id: 'pro', title: 'Pro (static)', version: 'v1', mode: 'subscription', amount: '19.90',
      currency: 'USD', credits: 10, providers: { stripe: 'price_Static' } }, { id: 'credit-sub', title: 'Credits', version: 'v1', mode: 'subscription',
      amount: '5.00', currency: 'USD', credits: 10, providers: { stripe: 'price_Credits' } }]));
    const stripe = { id: 'stripe', accountScope: 'synthetic', modes: ['subscription'] } as unknown as HostedCheckoutAdapter;
    const lifecycle = { id: 'stripe', accountScope: 'synthetic', capabilities: { paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' } } as unknown as SubscriptionAdapter;
    const catalog = new BillingCatalog(items, [stripe], [], [lifecycle], () => ({ resolve: async () => null, claims: async id => !!(await service.plans.findBySlug(id)) }));
    // `pro` is a plan now: the static entry is only its seed.
    expect((await catalog.list()).map(offer => offer.id)).toEqual(['credit-sub']);
    await expect(catalog.resolve({ orderId: 'o', ownerId: 'u', offerId: 'pro', providerId: 'stripe' })).rejects.toThrow('unavailable');
    expect((await catalog.resolve({ orderId: 'o', ownerId: 'u', offerId: 'credit-sub', providerId: 'stripe' })).money.amount).toBe('5.00');
  });

  it('serves mail templates and projected delivery logs', async () => {
    await f.database.model('emailLogs').create({ data: { recipient: 'someone@example.invalid', subject: 'Hello', template: 'welcome',
      status: 'failed', errorMessage: 'synthetic', metadata: { idempotencyKey: 'PRIVATE-KEY' } } });
    await api('get', '/management/email-logs', member.token).expect(403);
    const logs = (await api('get', '/management/email-logs?status=failed&to=someone', reader.token).expect(200)).body;
    expect(logs).toMatchObject({ total: 1, data: [{ recipient: 'someone@example.invalid', template: 'welcome', status: 'failed' }] });
    expect(JSON.stringify(logs)).not.toContain('PRIVATE-KEY');
    await api('post', '/management/email-templates', reader.token).send({}).expect(403);
    await api('post', '/management/email-templates').send({ key: 'welcome', name: 'Welcome', htmlContentEn: '<p>Hi {{name}}</p>' }).expect(201);
    const templates = (await api('get', '/management/email-templates', reader.token).expect(200)).body;
    expect(templates).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'welcome', variables: ['name'] })]));
  });

  it('seeds plans with prices from subscription offers once on administrator creation', async () => {
    const seeds = planSeedsFromBillingCatalog(readBillingCatalog(JSON.stringify([
      { id: 'starter', title: 'Starter', version: 'v1', mode: 'subscription', amount: '5.00', currency: 'USD', credits: 10,
        providers: { stripe: 'price_Starter' } },
      { id: 'pack', title: 'Credit pack', version: 'v1', mode: 'payment', amount: '5.00', currency: 'USD', credits: 10, providers: { stripe: 'price_Pack' } },
    ])));
    expect(seeds).toEqual([expect.objectContaining({ slug: 'starter', status: true, features: {}, quotas: {},
      prices: [{ interval: 'month', currency: 'USD', amount: '5.00', termDays: null, providerRefs: { stripe: 'price_Starter' } }] })]);
    await createAdministrator(f.database, { username: 'seedadmin', email: 'seed@example.invalid', password: f.password }, { plans: seeds });
    await f.database.model('subscriptionPlans').updateMany({ where: { slug: 'starter' }, data: { name: 'Edited' } });
    await createAdministrator(f.database, { username: 'seedadmin2', email: 'seed2@example.invalid', password: f.password }, { plans: seeds });
    const seeded = (await api('get', '/management/plans').expect(200)).body.filter((plan: { slug: string }) => plan.slug === 'starter');
    expect(seeded).toEqual([expect.objectContaining({ name: 'Edited', prices: [expect.objectContaining({ amount: '5.00', providerRefs: { stripe: 'price_Starter' } })] })]);
    expect(await f.database.model('menus').findUnique({ where: { id: 'starter:plans' } })).toMatchObject({ path: '/plans', permissions: ['plans:query'] });
    // Seeds are validated like administrator writes; an invalid one is skipped, never fatal.
    const valid = seeds[0];
    expect(await f.database.transaction(tx => seedPlans(tx, [
      { ...valid, slug: 'Bad Slug' }, { ...valid, slug: 'grants', features: { unknown: true } },
      { ...valid, slug: 'normalized', prices: [{ ...valid.prices[0], amount: '7', providerRefs: {} }] },
    ]))).toBe(1);
    expect(await f.database.model('subscriptionPlans').findUnique({ where: { slug: 'grants' } })).toBeNull();
    expect((await api('get', '/management/plans').expect(200)).body.find((item: { slug: string }) => item.slug === 'normalized'))
      .toMatchObject({ prices: [expect.objectContaining({ amount: '7.00' })] });
  });

  it('gives upgraded installations the new permissions and starter menus idempotently (migration data step)', async () => {
    const sql = readFileSync(join(__dirname, '../prisma/migrations/20261109000000_back_office/migration.sql'), 'utf8');
    const step = sql.slice(sql.indexOf('-- Upgraded installations'));
    expect(step.length).toBeGreaterThan(100);
    // An installation set up before this release: no new rows, the old provider-subscription name.
    await f.database.model('menus').deleteMany({ where: { id: { in: ['starter:plans', 'starter:email-logs'] } } });
    await f.database.model('permissions').deleteMany({ where: { id: 'plans:add' } });
    await f.database.model('menus').updateMany({ where: { id: 'starter:subscriptions' }, data: { name: '订阅' } });
    const run = () => f.database.transaction(async tx => {
      for (const statement of step.split(/;\s*\n/).map(part => part.trim()).filter(part => part.replace(/--.*$/gm, '').trim()))
        await tx.query(statement);
    });
    await run();
    await run();
    expect(await f.database.model('permissions').findUnique({ where: { id: 'plans:add' } })).not.toBeNull();
    expect(await f.database.model('menus').findUnique({ where: { id: 'starter:plans' } })).toMatchObject({ parentId: 'starter:commerce', permissions: ['plans:query'] });
    expect(await f.database.model('menus').findUnique({ where: { id: 'starter:email-logs' } })).toMatchObject({ parentId: 'starter:operations' });
    expect(await f.database.model('menus').findUnique({ where: { id: 'starter:subscriptions' } })).toMatchObject({ name: '支付订阅' });
  });
});
