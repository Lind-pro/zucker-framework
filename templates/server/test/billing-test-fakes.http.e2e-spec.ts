import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { createAdministrator } from '../src/accounts/create-administrator';
import { BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { BillingModule } from '../src/billing/billing.module';
import { BILLING_POLICIES } from '../src/billing/billing.policy';
import { SubscriptionsModule } from '../src/subscriptions/subscriptions.module';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { applicationCorsOptions } from '../src/http-options';
import { createBillingTestFakes, FakeCheckoutController } from '../src/billing/test-fakes';
import { PromotionsModule } from '../src/promotions';
import { ManagementService } from '../src/management/management.service';
import type { CreditsService } from '../src/credits/credits.service';

/**
 * The fake payment provider end to end over HTTP + PostgreSQL: hosted page → pay → signed webhook →
 * credits once; webhook replay inert; forged webhook refused; refund; subscription renewal grants one cycle.
 * Until the integration WP registers the controller in BillingModule, this spec mounts it at the root.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_fakepay_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticFakePay9!';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-fake-payments-jwt-at-least-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-for-fake-pay' };

run('fake payment provider over HTTP (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, admin: string, buyer: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const fakes = createBillingTestFakes(env);
  const options: BillingOptions = { providers: [fakes.checkout], subscriptionProviders: [fakes.subscription], refundProviders: [fakes.refund], webUrl: origin, catalogJson: '[]' };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const http = () => request(app.getHttpServer());
  const api = (method: 'get' | 'post', path: string, token = admin) => http()[method](`/api${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`);
  const balance = async () => (await api('get', '/billing/balance', buyer.token).expect(200)).body.balance as number;
  const checkoutPath = (url: string) => new URL(url).pathname;

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
    await createAdministrator(database, { username: 'fakepayadmin', email: 'fakepayadmin@example.invalid', password });
    admin = (await http().post('/api/authorize/login').set('Origin', origin).send({ username: 'fakepayadmin', password }).expect(200)).body.token;
    const email = 'fakepaybuyer@example.invalid', action = (path: string, body: object) => http().post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username: 'fakepaybuyer', email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username: 'fakepaybuyer', password }).expect(200);
    buyer = { id: logged.body.userId, token: logged.body.token };
  });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('pays a credit pack on the hosted page, grants credits once, ignores replays, refuses forgeries and refunds', async () => {
    const pack = (await api('post', '/management/credit-packs').send({ slug: 'fake-pack', title: 'Fake pack', credits: 100, expiresInDays: 30, status: true,
      prices: [{ currency: 'USD', amount: '10.00', providerRefs: { fake: 'fake-pack-usd' } }] }).expect(201)).body;
    const created = (await api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`)
      .send({ offerId: `pack:${pack.id}:USD`, providerId: 'fake' }).expect(200)).body;
    expect(created.checkoutUrl).toMatch(/^http:\/\/localhost:4202\/api\/billing\/test-checkout\/fakecs_[0-9a-f]{32}$/);
    const path = checkoutPath(created.checkoutUrl);
    const page = await http().get(path).expect(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.text).toContain('Fake pack'); expect(page.text).toContain('10.00 USD'); expect(page.text).not.toContain('<script');
    const paid = await http().post(`${path}/pay`).expect(303);
    expect(paid.headers.location).toBe(`${origin}/billing/return?order=${created.id}`);
    expect(await balance()).toBe(100);
    expect((await api('post', `/billing/orders/${created.id}/confirm`, buyer.token).send({}).expect(200)).body).toMatchObject({ state: 'paid' });
    expect(await balance()).toBe(100);
    // Replay of the provider's own signed webhook through the public route is inert.
    const resent = (await http().post(`${path}/webhook`).expect(200)).body;
    expect(resent.delivered).toBe(true);
    await http().post('/api/billing/webhooks/fake').set(resent.request.headers).send(resent.request.body).expect(200);
    expect(await balance()).toBe(100);
    // A forged body with the old signature is refused before anything is read.
    await http().post('/api/billing/webhooks/fake').set(resent.request.headers).send(resent.request.body.replace('checkout.completed', 'refund.updated')).expect(400);
    // Refund through the application's own refund command: cash and credits recovered.
    await api('post', '/billing/refunds').set('Idempotency-Key', randomUUID()).send({ targetType: 'order', targetId: created.id, amount: '10.00' }).expect(200);
    expect(await balance()).toBe(0);
    // Cancel redirects to the stored cancel URL.
    const second = (await api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`)
      .send({ offerId: `pack:${pack.id}:USD`, providerId: 'fake' }).expect(200)).body;
    expect((await http().post(`${checkoutPath(second.checkoutUrl)}/cancel`).expect(303)).headers.location).toBe(`${origin}/billing/return?order=${second.id}&canceled=1`);
    await http().get('/api/billing/test-checkout/fakecs_00000000000000000000000000000000').expect(404);
  });

  it('refunds a discounted order against the amount actually paid (promotion payable, not list price)', async () => {
    const pack = (await api('post', '/management/credit-packs').send({ slug: 'fake-promo-pack', title: 'Promo pack', credits: 50, expiresInDays: 30, status: true,
      prices: [{ currency: 'USD', amount: '10.00', providerRefs: { fake: 'fake-promo-pack-usd' } }] }).expect(201)).body;
    // Automatic (alias-less) 20 % promotion for this pack: payable 8.00, discount 2.00.
    await api('post', '/management/promotions').send({ alias: null, providerId: 'fake', providerCode: 'fake_auto_20', target: `pack:${pack.id}`,
      currency: null, discountType: 'percent', percentOff: 20, amountOff: null, maxRedemptions: null, status: 'active', startsAt: null, endsAt: null, note: null }).expect(201);
    const before = await balance();
    const created = (await api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`)
      .send({ offerId: `pack:${pack.id}:USD`, providerId: 'fake' }).expect(200)).body;
    expect(created).toMatchObject({ money: { amount: '10.00', currency: 'USD' }, amountDue: { amount: '8.00', currency: 'USD' }, discount: { amount: '2.00', currency: 'USD' } });
    await http().post(`${checkoutPath(created.checkoutUrl)}/pay`).expect(303);
    expect(await balance()).toBe(before + 50);
    // The back-office ledger shows the charged amount with list price and discount.
    const ledger = (await new ManagementService(database, {} as CreditsService).list('orders', { id: created.id })).data[0];
    expect(ledger).toMatchObject({ money: { amount: '8.00', currency: 'USD' }, listMoney: { amount: '10.00', currency: 'USD' }, discount: { amount: '2.00', currency: 'USD' } });
    // More than was paid is refused; exactly the paid amount refunds cash and recovers the credits.
    await api('post', '/billing/refunds').set('Idempotency-Key', randomUUID()).send({ targetType: 'order', targetId: created.id, amount: '8.01' }).expect(res => expect(res.status).toBeGreaterThanOrEqual(400));
    await api('post', '/billing/refunds').set('Idempotency-Key', randomUUID()).send({ targetType: 'order', targetId: created.id, amount: '8.00' }).expect(200);
    expect(await balance()).toBe(before);
  });

  it('subscribes to a monthly plan and a renewal grants exactly one more cycle', async () => {
    const plan = (await api('post', '/management/plans').send({ slug: 'fake-plan', name: 'Fake plan', status: true,
      prices: [{ interval: 'month', currency: 'USD', amount: '5', credits: 7, creditExpiry: 'period', providerRefs: { fake: 'fake-plan-month' } }] }).expect(201)).body;
    const before = await balance();
    const created = (await api('post', '/billing/orders', buyer.token).set('Idempotency-Key', `fake-${randomUUID()}`)
      .send({ offerId: `plan:${plan.id}:month:USD`, providerId: 'fake' }).expect(200)).body;
    await http().post(`${checkoutPath(created.checkoutUrl)}/pay`).expect(303);
    expect(await balance()).toBe(before + 7);
    const subscriptionId = fakes.ledger.retrieve(created.checkoutUrl.split('/').pop()).subscriptionId!;
    const renewed = (await http().post(`/api/billing/test-checkout/renew/${subscriptionId}`).expect(200)).body;
    expect(renewed.webhook.delivered).toBe(true);
    expect(await balance()).toBe(before + 14);
    await http().post('/api/billing/webhooks/fake').set(renewed.webhook.request.headers).send(renewed.webhook.request.body).expect(200);
    expect(await balance()).toBe(before + 14);
    const cycles = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".billing_subscription_cycles WHERE "ownerId" = $1`, [buyer.id]);
    expect(cycles.rows[0].n).toBe(2);
  });
});
