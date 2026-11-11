import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { MenuController, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { ZuckerMonitoringModule } from '@zucker-framework/monitoring';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { createAdministrator } from '../src/accounts/create-administrator';
import { BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { BillingModule } from '../src/billing/billing.module';
import { BILLING_POLICIES } from '../src/billing/billing.policy';
import { SubscriptionsModule } from '../src/subscriptions/subscriptions.module';
import { PromotionsModule } from '../src/promotions';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { applicationCorsOptions } from '../src/http-options';
import { createBillingTestFakes, FakeCheckoutController } from '../src/billing/test-fakes';

/**
 * Fake payment provider scenarios (WP 3.7, Sonnet) over HTTP + PostgreSQL: promotions (order fulfilled at the
 * payable amount, mismatching evidence and non-"once" quotes refused, subscription first invoice discounted and
 * renewals at list price), asynchronous refunds (settle through the signed webhook, failed, replay), both
 * subscription cancel modes, and the hosted page's CSP and HTML escaping.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_fakepay_sc_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticFakePay9!';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-fake-scenarios-jwt-at-least-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-for-fake-sc' };
const HOSTILE = `<script>alert(1)</script> "quoted" & 'single' <img src=x onerror=alert(2)>`;

run('fake payment provider scenarios (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, admin: string, buyer: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const fakes = createBillingTestFakes(env);
  const options: BillingOptions = { providers: [fakes.checkout], subscriptionProviders: [fakes.subscription], refundProviders: [fakes.refund], webUrl: origin, catalogJson: '[]' };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const http = () => request(app.getHttpServer());
  const api = (method: 'get' | 'post', path: string, token = admin) => http()[method](`/api${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`);
  const balance = async () => (await api('get', '/billing/balance', buyer.token).expect(200)).body.balance as number;
  const pathOf = (url: string) => new URL(url).pathname;
  const idOf = (url: string) => url.split('/').pop()!;
  const usd = (amount: string) => ({ amount, currency: 'USD' });
  const control = (path: string, body?: object) => http().post(`/api/billing/test-checkout/${path}`).send(body);

  async function pack(slug: string, amount = '10.00', credits = 100, title = `Pack ${slug}`) {
    return (await api('post', '/management/credit-packs').send({ slug, title, credits, expiresInDays: 30, status: true,
      prices: [{ currency: 'USD', amount, providerRefs: { fake: `${slug}-usd` } }] }).expect(201)).body;
  }
  async function plan(slug: string, amount = '5', credits = 7) {
    return (await api('post', '/management/plans').send({ slug, name: `Plan ${slug}`, status: true,
      prices: [{ interval: 'month', currency: 'USD', amount, credits, creditExpiry: 'period', providerRefs: { fake: `${slug}-month` } }] }).expect(201)).body;
  }
  const order = (offerId: string) => api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`).send({ offerId, providerId: 'fake' });
  async function promotion(providerCode: string, percentOff = 20) {
    return database.model('promotions').create({ data: { alias: null, providerId: 'fake', providerCode, target: '*', discountType: 'percent', percentOff } });
  }
  /** Turns on buyer-entered promo codes (needed for subscriptions: automatic promotions are one-time offers only). */
  let promoCodesAllowed = false;
  async function allowPromoCodes() {
    if (promoCodesAllowed) return;
    promoCodesAllowed = true;
    const view = (await api('get', '/management/policies/billing').expect(200)).body;
    return http().put('/api/management/policies/billing').set('Origin', origin).set('Authorization', `Bearer ${admin}`)
      .send({ expectedRevision: view.revision, values: { allowCustomerPromoCodes: true } }).expect(200);
  }
  const disable = (providerCode: string) => database.model('promotions').updateMany({ where: { providerCode }, data: { status: 'disabled' } });
  const refund = (orderId: string, amount: string) => api('post', '/billing/refunds').set('Idempotency-Key', randomUUID()).send({ targetType: 'order', targetId: orderId, amount });
  const payRef = (checkoutId: string) => { const paid = fakes.ledger.retrieve(checkoutId); return { paymentId: paid.paymentId!, paymentKind: paid.paymentKind! }; };

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }), ZuckerConfigModule.forRoot(), ZuckerMonitoringModule,
      ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {} }), ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'permissions'] }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits,
        billing: limits, 'billing-webhook': limits, 'api-default': limits } }),
      RuntimeSettingsModule, PolicyModule.forRoot({ policies: [...BILLING_POLICIES] }), AccountModule, BillingModule, SubscriptionsModule, PromotionsModule],
      controllers: [MenuController, FakeCheckoutController],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }, { provide: BILLING_OPTIONS, useValue: options }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(BILLING_OPTIONS).useValue(options).compile();
    app = module.createNestApplication({ rawBody: true }); app.enableCors(applicationCorsOptions({ ACCOUNT_ORIGINS: origin }));
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    await createAdministrator(database, { username: 'fakescadmin', email: 'fakescadmin@example.invalid', password });
    admin = (await http().post('/api/authorize/login').set('Origin', origin).send({ username: 'fakescadmin', password }).expect(200)).body.token;
    const email = 'fakescbuyer@example.invalid', action = (path: string, body: object) => http().post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username: 'fakescbuyer', email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username: 'fakescbuyer', password }).expect(200);
    buyer = { id: logged.body.userId, token: logged.body.token };
  });
  afterEach(() => { fakes.ledger.setRefundMode('succeeded'); });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  describe('promotions', () => {
    it('a promoted order is fulfilled at the payable amount and records one redemption', async () => {
      const item = await pack('promo-pack'), promo = await promotion('FAKEPROMO20');
      try {
        const before = await balance();
        const created = (await order(`pack:${item.id}:USD`).expect(200)).body;
        expect(created).toMatchObject({ money: usd('10.00'), amountDue: usd('8.00'), discount: usd('2.00') });
        expect(JSON.stringify(created)).not.toContain('FAKEPROMO20');
        const path = pathOf(created.checkoutUrl);
        const page = await http().get(path).expect(200);
        expect(page.text).toContain('Amount due: <strong>8.00 USD</strong>');
        expect(page.text).toContain('List price 10.00 USD, discount 2.00 USD');
        await http().post(`${path}/pay`).expect(303);
        expect(await balance()).toBe(before + 100);
        expect((await api('get', `/billing/orders/${created.id}`, buyer.token).expect(200)).body).toMatchObject({ state: 'paid' });
        const paid = fakes.ledger.retrieve(idOf(created.checkoutUrl));
        expect(paid).toMatchObject({ paidMoney: usd('8.00'), subtotalMoney: usd('10.00'), discountMoney: usd('2.00'), discountReferences: ['FAKEPROMO20'] });
        expect(await database.model('promotionRedemptions').findMany({ where: { promotionId: promo.id } }))
          .toEqual([expect.objectContaining({ orderId: created.id, status: 'redeemed', reference: 'FAKEPROMO20', discountAmount: '2.00', payableAmount: '8.00' })]);
        expect((await http().get(path).expect(200)).text).toContain('already paid');
      } finally { await disable('FAKEPROMO20'); }
    });

    it('refuses to fulfil when the provider evidence does not match the frozen promotion', async () => {
      const item = await pack('mismatch-pack');
      await promotion('FAKEMISMATCH');
      try {
        for (const [label, evidence] of [
          ['wrong discount amount', { discountMoney: usd('1.00') }],
          ['wrong paid amount', { paidMoney: usd('10.00') }],
          ['foreign promotion reference', { discountReferences: ['promo_foreign'] }],
          ['no promotion reference', { discountReferences: [] }],
          ['wrong subtotal', { subtotalMoney: usd('11.00') }],
        ] as const) {
          const before = await balance();
          const created = (await order(`pack:${item.id}:USD`).expect(200)).body;
          const path = pathOf(created.checkoutUrl);
          expect((await control(`${idOf(created.checkoutUrl)}/promo`, evidence).expect(200)).body.evidence).toMatchObject(evidence);
          await http().post(`${path}/pay`).expect(303);
          const confirm = await api('post', `/billing/orders/${created.id}/confirm`, buyer.token).send({});
          expect(confirm.status, label).toBeGreaterThanOrEqual(400);
          expect(await balance(), label).toBe(before);
          expect((await api('get', `/billing/orders/${created.id}`, buyer.token).expect(200)).body.state, label).not.toBe('paid');
        }
      } finally { await disable('FAKEMISMATCH'); }
    });

    it('one-time offers: a provider quote with another discount is refused; an undeclared or unknown duration is not a mismatch', async () => {
      const item = await pack('quote-pack');
      await promotion('FAKEQUOTE');
      try {
        await control('promotions', { providerCode: 'FAKEQUOTE', discount: usd('3.00'), duration: 'once' }).expect(200);
        const refused = await order(`pack:${item.id}:USD`);
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(refused.status).toBeLessThan(500);
        // The provider that cannot tell (null) or quotes the same discount does not block a one-time purchase.
        for (const quote of [{ discount: null }, { discount: usd('2.00'), duration: 'once' }, { discount: usd('2.00'), duration: 'forever' }])
          await control('promotions', { providerCode: 'FAKEQUOTE', ...quote }).expect(200), await order(`pack:${item.id}:USD`).expect(200);
      } finally { await disable('FAKEQUOTE'); }
    });

    it('subscription: a provider quote that is not exactly the frozen once-only discount is refused', async () => {
      const item = await plan('quote-plan', '5', 2);
      await allowPromoCodes();
      await database.model('promotions').create({ data: { alias: 'FAKEQUOTESUB', providerId: 'fake', providerCode: 'FAKEQUOTESUB', target: '*', discountType: 'percent', percentOff: 20 } });
      const withCode = () => api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`)
        .send({ offerId: `plan:${item.id}:month:USD`, providerId: 'fake', promoCode: 'fakequotesub' });
      try {
        for (const quote of [{ discount: usd('1.00'), duration: 'forever' }, { discount: usd('1.00'), duration: 'repeating' }, { discount: usd('1.50'), duration: 'once' }, { discount: null }]) {
          await control('promotions', { providerCode: 'FAKEQUOTESUB', ...quote }).expect(200);
          const refused = await withCode();
          expect(refused.status, JSON.stringify(quote)).toBeGreaterThanOrEqual(400);
          expect(refused.status, JSON.stringify(quote)).toBeLessThan(500);
        }
        await control('promotions', { providerCode: 'FAKEQUOTESUB', discount: usd('1.00'), duration: 'once' }).expect(200);
        expect((await withCode().expect(200)).body).toMatchObject({ amountDue: usd('4.00'), discount: usd('1.00') });
      } finally { await disable('FAKEQUOTESUB'); }
    });

    it('control routes validate their input', async () => {
      await control('promotions', { providerCode: 'bad code!', discount: null }).expect(400);
      await control('promotions', { providerCode: 'OK', discount: usd('1.00'), duration: 'weekly' }).expect(400);
      await control('promotions', { providerCode: 'OK', discount: usd('1.00'), extra: true }).expect(400);
      await control('promotions', { providerCode: 'OK', discount: { amount: '-1', currency: 'USD' } }).expect(400);
      await control('refunds/mode', { state: 'exploded' }).expect(400);
      await control('refunds/fakere_00000000000000000000000000000000/settle', { state: 'exploded' }).expect(400);
      await control('refunds/not-a-refund/settle', { state: 'succeeded' }).expect(404);
      await control('renew/not-a-subscription').expect(404);
      await control('fakecs_00000000000000000000000000000000/promo', { paidMoney: usd('1.00') }).expect(409).catch(() => undefined);
      await control('fakecs_00000000000000000000000000000000/promo', { unknown: 1 }).expect(400);
      const item = await pack('control-pack');
      const created = (await order(`pack:${item.id}:USD`).expect(200)).body, checkoutId = idOf(created.checkoutUrl);
      await control(`${checkoutId}/promo`, { discountReferences: ['a', 'b', 'c', 'd', 'e', 'f'] }).expect(400);
      await control(`${checkoutId}/promo`, { discountReferences: ['bad ref'] }).expect(400);
      await control(`${checkoutId}/pay?webhook=maybe`).expect(400);
      // `?webhook=skip` pays without telling the application: nothing is granted until it confirms.
      const before = await balance();
      await control(`${checkoutId}/pay?webhook=skip`).expect(303);
      expect(await balance()).toBe(before);
      await api('post', `/billing/orders/${created.id}/confirm`, buyer.token).send({}).expect(200);
      expect(await balance()).toBe(before + 100);
      // Evidence can no longer change once paid.
      await control(`${checkoutId}/promo`, { discountMoney: usd('1.00') }).expect(409);
    });

    it('subscription: first invoice discounted, renewals at the full list price', async () => {
      const item = await plan('promo-plan', '5', 7);
      await allowPromoCodes();
      await database.model('promotions').create({ data: { alias: 'FAKEFIRST20', providerId: 'fake', providerCode: 'FAKEFIRST20', target: '*', discountType: 'percent', percentOff: 20 } });
      let subscriptionId: string;
      try {
        const before = await balance();
        const created = (await api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`)
          .send({ offerId: `plan:${item.id}:month:USD`, providerId: 'fake', promoCode: 'FAKEFIRST20' }).expect(200)).body;
        expect(created).toMatchObject({ money: usd('5.00'), amountDue: usd('4.00'), discount: usd('1.00') });
        expect((await http().get(pathOf(created.checkoutUrl)).expect(200)).text).toContain('(first period)');
        await http().post(`${pathOf(created.checkoutUrl)}/pay`).expect(303);
        expect(await balance()).toBe(before + 7);
        subscriptionId = fakes.ledger.retrieve(idOf(created.checkoutUrl)).subscriptionId!;
      } finally { await disable('FAKEFIRST20'); }
      for (const round of [1, 2]) {
        const renewed = (await control(`renew/${subscriptionId}`).expect(200)).body;
        expect(renewed.period.paidMoney).toEqual(usd('5.00'));
        expect(renewed.webhook.delivered).toBe(true);
        expect(await balance(), `after renewal ${round}`).toBeGreaterThan(0);
      }
      const cycles = await pool.query(`SELECT "paidMoney"->>'amount' AS amount, initial FROM "${schema}".billing_subscription_cycles
        WHERE "ownerId" = $1 AND "subscriptionId" = $2 ORDER BY "paidAt", "cycleKey"`, [buyer.id, subscriptionId]);
      expect(cycles.rows.map(row => [row.amount, row.initial])).toEqual([['4.00', true], ['5.00', false], ['5.00', false]]);
    });
  });

  describe('refunds', () => {
    async function paidPack(slug: string) {
      const item = await pack(slug), created = (await order(`pack:${item.id}:USD`).expect(200)).body;
      await http().post(`${pathOf(created.checkoutUrl)}/pay`).expect(303);
      return { orderId: created.id as string, checkoutId: idOf(created.checkoutUrl) };
    }

    it('a pending refund settles through the signed refund webhook, once, and a replay is inert', async () => {
      const { orderId, checkoutId } = await paidPack('refund-pending');
      const funded = await balance();
      await control('refunds/mode', { state: 'pending' }).expect(200);
      const requested = (await refund(orderId, '4.00').expect(200)).body;
      expect(requested.state).not.toBe('succeeded');
      // The credits to recover (4.00 of 10.00 = 40 of 100) are held while the provider has not decided.
      const held = await balance();
      expect(held).toBe(funded - 40);
      const [pending] = fakes.ledger.refundsFor(payRef(checkoutId));
      expect(pending).toMatchObject({ state: 'pending', money: usd('4.00') });
      const settled = (await control(`refunds/${pending!.refundId}/settle`, { state: 'succeeded' }).expect(200)).body;
      expect(settled.refund.state).toBe('succeeded');
      expect(settled.webhook.delivered).toBe(true);
      const recovered = await balance();
      expect(recovered).toBe(held);
      // Replay of the same signed webhook, and a second settle call, change nothing.
      await http().post('/api/billing/webhooks/fake').set(settled.webhook.request.headers).send(settled.webhook.request.body).expect(200);
      expect(await balance()).toBe(recovered);
      await control(`refunds/${pending!.refundId}/settle`, { state: 'failed' }).expect(409);
      expect(await balance()).toBe(recovered);
      // A forged refund webhook (state flipped, old signature) is refused.
      await http().post('/api/billing/webhooks/fake').set(settled.webhook.request.headers)
        .send(settled.webhook.request.body.replace('succeeded', 'failed')).expect(400);
    });

    it('a failed refund (immediately or on settlement) keeps the credits and can be requested again', async () => {
      const { orderId, checkoutId } = await paidPack('refund-failed');
      const funded = await balance();
      await control('refunds/mode', { state: 'failed' }).expect(200);
      const immediate = await refund(orderId, '3.00');
      if (immediate.status < 400) expect(immediate.body.state).not.toBe('succeeded');
      expect(await balance()).toBe(funded);
      await control('refunds/mode', { state: 'pending' }).expect(200);
      const requested = await refund(orderId, '3.00');
      expect(requested.status).toBeLessThan(500);
      const pending = fakes.ledger.refundsFor(payRef(checkoutId)).find(row => row.state === 'pending')!;
      expect(pending).toBeTruthy();
      expect(await balance()).toBe(funded - 30);
      const settled = (await control(`refunds/${pending.refundId}/settle`, { state: 'failed' }).expect(200)).body;
      expect(settled).toMatchObject({ refund: { state: 'failed' }, webhook: { delivered: true } });
      // The hold is released: the buyer has every credit again.
      expect(await balance()).toBe(funded);
      // The money is still refundable: a new succeeded refund recovers the credits.
      await control('refunds/mode', { state: 'succeeded' }).expect(200);
      await refund(orderId, '3.00').expect(200);
      expect(await balance()).toBeLessThan(funded);
    });
  });

  describe('subscription cancel modes', () => {
    async function subscribe(slug: string) {
      const item = await plan(slug, '5', 3), created = (await order(`plan:${item.id}:month:USD`).expect(200)).body;
      await http().post(`${pathOf(created.checkoutUrl)}/pay`).expect(303);
      const providerId = fakes.ledger.retrieve(idOf(created.checkoutUrl)).subscriptionId!;
      const list = (await api('get', '/billing/subscriptions', buyer.token).expect(200)).body;
      const rows = (list.data ?? list.items ?? list) as Array<{ id: string; providerSubscriptionId?: string }>;
      const mine = rows.find(row => row.providerSubscriptionId === providerId) ?? rows[0]!;
      return { providerId, id: mine.id };
    }

    it('period_end keeps the subscription active until the period ends and stops renewals', async () => {
      const { providerId, id } = await subscribe('cancel-period-end');
      const response = await api('post', `/billing/subscriptions/${id}/cancel`, buyer.token).send({ mode: 'period_end' }).expect(200);
      expect(response.body).toMatchObject({ cancelMode: 'period_end' });
      expect(fakes.ledger.subscriptionDetails(providerId)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
      await control(`renew/${providerId}`).expect(409);
      await api('post', `/billing/subscriptions/${id}/cancel`, buyer.token).send({ mode: 'period_end' }).expect(200); // idempotent
    });

    it('immediate cancels at once, and an unknown mode is refused', async () => {
      const { providerId, id } = await subscribe('cancel-immediate');
      await api('post', `/billing/subscriptions/${id}/cancel`, buyer.token).send({ mode: 'later' }).expect(400);
      await api('post', `/billing/subscriptions/${id}/cancel`, buyer.token).send({}).expect(400);
      const response = await api('post', `/billing/subscriptions/${id}/cancel`, buyer.token).send({ mode: 'immediate' }).expect(200);
      expect(response.body).toMatchObject({ cancelMode: 'immediate' });
      expect(fakes.ledger.subscriptionDetails(providerId)).toMatchObject({ status: 'canceled' });
      await control(`renew/${providerId}`).expect(409);
    });
  });

  describe('hosted page', () => {
    it('sends a strict CSP whose style hash matches the page, no script, and escapes every dynamic value', async () => {
      const item = await pack('hostile-pack', '10.00', 100, HOSTILE);
      const created = (await order(`pack:${item.id}:USD`).expect(200)).body;
      const page = await http().get(pathOf(created.checkoutUrl)).expect(200);
      const csp = page.headers['content-security-policy'] as string;
      expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; form-action 'self' http:\/\/localhost:4202; frame-ancestors 'none'; base-uri 'none'$/);
      const style = /<style>([\s\S]*?)<\/style>/.exec(page.text)![1]!;
      expect(csp).toContain(`'sha256-${createHash('sha256').update(style).digest('base64')}'`);
      expect(csp).not.toMatch(/script-src|unsafe-inline|unsafe-eval|\*/);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.text).not.toMatch(/<script|<img|<\/script/i);
      expect(page.text).toContain('&#60;script&#62;alert(1)&#60;/script&#62; &#34;quoted&#34; &#38; &#39;single&#39;');
      // The only markup that remains is the page's own: no attribute or tag can come from the title.
      expect((page.text.match(/<[a-z!][^>]*>/gi) ?? []).every(tag => !/onerror|<img|<script/i.test(tag))).toBe(true);
      expect(page.text).not.toContain('fulfillment'); expect(page.text).not.toContain('"credits"');
      // Form actions are relative and the checkout id is encoded.
      expect(page.text).toMatch(/<form method="post" action="fakecs_[0-9a-f]{32}\/pay">/);
    });

    it('unknown and malformed checkout ids are 404 and never echoed', async () => {
      for (const id of ['fakecs_00000000000000000000000000000000', 'fakecs_%3Cscript%3E', 'x', 'fakecs_' + 'f'.repeat(31)]) {
        const response = await http().get(`/api/billing/test-checkout/${id}`).expect(404);
        expect(response.text).not.toContain('<script');
      }
      await http().post('/api/billing/test-checkout/fakecs_00000000000000000000000000000000/pay').expect(404);
      await http().post('/api/billing/test-checkout/fakecs_00000000000000000000000000000000/cancel').expect(404);
    });
  });
});
