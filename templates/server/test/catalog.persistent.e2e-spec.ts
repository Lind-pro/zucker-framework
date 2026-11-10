import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { HostedCheckoutAdapter } from '@zucker-framework/payment';
import { managementFixture } from './helpers/management-fixture';
import { SubscriptionsModule } from '../src/subscriptions/subscriptions.module';

/** Synthetic one-time channel; nothing is paid in this suite. */
const provider: HostedCheckoutAdapter = {
  id: 'paypal', accountScope: 'synthetic-paypal-sandbox', modes: ['payment'], validate() {},
  async create() { throw new Error('not used'); }, async retrieve() { throw new Error('not used'); }, async verifyWebhook() { return null; },
};

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
run('public pricing catalog and credit pack administration (PostgreSQL + HTTP)', () => {
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let viewer: { userId: string; token: string };
  let buyer: { userId: string; token: string };
  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token = f.admin.token) =>
    request(f.app.getHttpServer())[method](`/api${path}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    f = await managementFixture(process.env.TEST_DATABASE_URL!, 'http://localhost:4320',
      { providers: [provider], catalogJson: '[]', webUrl: 'http://localhost:4202' }, [SubscriptionsModule]);
    viewer = await f.member('packviewer', ['plans:query']);
    buyer = await f.member('packbuyer');
  });
  afterAll(async () => { await f?.close(); });

  it('enforces plans:* on credit pack management and validates writes server-side', async () => {
    const body = { slug: 'starter', title: 'Starter', titleI18n: { zh: '入门包' }, credits: 100, expiresInDays: 90, status: true, order: 1,
      prices: [{ currency: 'USD', amount: '9.9', providerRefs: { paypal: 'synthetic-pack-usd' } },
        { currency: 'EUR', amount: '9', providerRefs: {} }] };
    await api('post', '/management/credit-packs', viewer.token).send(body).expect(403);
    await api('post', '/management/credit-packs', buyer.token).send(body).expect(403);
    const created = (await api('post', '/management/credit-packs').send(body).expect(201)).body;
    expect(created).toMatchObject({ slug: 'starter', credits: 100, revision: 0,
      prices: [{ currency: 'EUR', amount: '9.00' }, { currency: 'USD', amount: '9.90', providerRefs: { paypal: 'synthetic-pack-usd' } }] });
    expect((await api('get', '/management/credit-packs', viewer.token).expect(200)).body).toHaveLength(1);
    await api('put', `/management/credit-packs/${created.id}`, viewer.token).send({ credits: 1 }).expect(403);
    await api('patch', `/management/credit-packs/${created.id}/status`, viewer.token).send({ status: false }).expect(403);
    await api('delete', `/management/credit-packs/${created.id}`, viewer.token).expect(403);
    // Exact decimal strings only; a float price or an unknown field is refused.
    await api('post', '/management/credit-packs').send({ ...body, slug: 'float', prices: [{ currency: 'USD', amount: 9.9 }] }).expect(400);
    await api('post', '/management/credit-packs').send({ ...body, slug: 'extra', bonus: 1 }).expect(400);
    await api('put', `/management/credit-packs/${created.id}`).send({ credits: 120, expectedRevision: 5 }).expect(409);
    expect((await api('put', `/management/credit-packs/${created.id}`).send({ credits: 120, expectedRevision: 0 }).expect(200)).body)
      .toMatchObject({ credits: 120, revision: 1 });
  });

  it('serves plans, packs and checkout policy; marks the current plan only for its holder', async () => {
    const plan = (await api('post', '/management/plans').send({ slug: 'pro', name: 'Pro', nameI18n: { zh: '专业版' }, status: true,
      featured: true, badge: 'Popular', highlights: ['1000 credits / month'],
      prices: [{ interval: 'one_time', currency: 'USD', amount: '30', termDays: 30, credits: 1000, creditExpiry: 'period',
        providerRefs: { paypal: 'synthetic-pro-pass' } }] }).expect(201)).body;
    const anonymous = await request(f.app.getHttpServer()).get('/api/billing/plans?currency=USD&locale=zh').expect(200);
    expect(anonymous.headers['cache-control'] ?? '').not.toContain('private');
    expect(anonymous.body).toMatchObject({
      checkout: { defaultProvider: null, allowProviderChoice: true },
      plans: [{ slug: 'pro', name: '专业版', featured: true, badge: 'Popular', highlights: ['1000 credits / month'], current: false,
        prices: [{ interval: 'one_time', credits: 1000, creditExpiry: 'period', purchasable: true, offerId: `plan:${plan.id}:one_time:USD` }] }],
      packs: [{ slug: 'starter', title: '入门包', credits: 120, prices: [{ currency: 'USD', purchasable: true, providers: ['paypal'] }] }],
    });
    expect(JSON.stringify(anonymous.body)).not.toContain('synthetic-pack-usd');
    await api('put', `/management/subscriptions/${buyer.userId}`).send({ planSlug: 'pro', billingCycle: 'MONTHLY' }).expect(200);
    const mine = await api('get', '/billing/plans', buyer.token).expect(200);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(mine.body.plans[0].current).toBe(true);
    expect((await api('get', '/billing/plans', viewer.token).expect(200)).body.plans[0].current).toBe(false);
    // A bad token on a public page reads as anonymous rather than failing.
    expect((await api('get', '/billing/plans', 'not-a-token').expect(200)).body.plans[0].current).toBe(false);
    expect((await request(f.app.getHttpServer()).get('/api/billing/currencies').expect(200)).body).toEqual({ currencies: ['EUR', 'USD'], default: 'USD' });
  });
});
