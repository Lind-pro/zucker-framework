import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOrder } from '@zucker-framework/payment';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { BillingModule } from '../src/billing/billing.module';
import { BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { readBillingCatalog } from '../src/billing/catalog';
import { applicationCorsOptions } from '../src/http-options';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_billing_http_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202';
const password = 'SyntheticUser9!';

/** Provider IO is synthetic; HTTP, guards, sessions, catalog and fulfillment use the real consumer. */
run('billing HTTP contract with PostgreSQL', () => {
  let app: INestApplication, pool: Pool, scopedUrl: string;
  let owner: { id: string; token: string }, other: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const observations = new Map<string, HostedCheckoutObservation>();
  const creations: HostedCheckoutOrder[] = [];
  const captures: string[] = [];
  const lost = new Set<string>();
  let receivedBytes: Buffer | undefined;
  const provider: HostedCheckoutAdapter = {
    id: 'paypal', accountScope: 'synthetic-paypal-sandbox', modes: ['payment'], validate() {},
    async create(order) {
      creations.push(structuredClone(order));
      const fact: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id,
        mode: order.offer.mode, quantity: 1, catalogReference: order.offer.catalogReference,
        state: 'requires_capture', dueMoney: order.offer.money, url: `https://synthetic.invalid/pay/${order.id}` };
      observations.set(fact.checkoutId, fact);
      if (lost.has(order.id)) throw new Error('SYNTHETIC_PRIVATE_PROVIDER_SECRET');
      return structuredClone(fact);
    },
    async retrieve(id) {
      const value = observations.get(id); if (!value) throw new Error('SYNTHETIC_PRIVATE_PROVIDER_SECRET');
      return structuredClone(value);
    },
    async capture(id) {
      captures.push(id);
      const fact = observations.get(id)!;
      const paid = { ...fact, state: 'paid' as const, paidMoney: fact.dueMoney,
        paymentId: `payment-${id}`, paymentKind: 'capture' as const };
      observations.set(id, paid); return structuredClone(paid);
    },
    async verifyWebhook(input) {
      receivedBytes = Buffer.from(input.rawBody);
      if (input.headers['x-synthetic-signature'] !== 'verified') return null;
      return JSON.parse(receivedBytes.toString('utf8')) as { eventId: string; checkoutId: string; reference: string };
    },
  };
  const options: BillingOptions = { providers: [provider], webUrl: origin,
    catalogJson: JSON.stringify([{ id: 'credits', title: 'Synthetic credits', version: 'v1', mode: 'payment',
      amount: '12.00', currency: 'USD', credits: 100, expiresInDays: 30, providers: { paypal: 'synthetic-catalog' } }]) };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };

  async function startApp() {
    const db = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => db }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-billing-http-secret-only-long', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'session-refresh': { points: 2000, duration: 60 }, 'session-refresh-network': { points: 2000, duration: 60 }, 'session-read': { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 }, billing: { points: 2000, duration: 60 } } }),
      AccountModule, BillingModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(BILLING_OPTIONS).useValue(options).compile();
    const instance = module.createNestApplication({ rawBody: true });
    instance.enableCors(applicationCorsOptions({ ACCOUNT_ORIGINS: origin }));
    instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init(); return instance;
  }
  async function member(username: string) {
    const email = `${username}@example.invalid`;
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200);
    return { id: login.body.userId as string, token: login.body.token as string };
  }
  const post = (path: string, body: object = {}, token = owner.token) => request(app.getHttpServer())
    .post(`/api/billing/${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send(body);
  const get = (path: string, token = owner.token) => request(app.getHttpServer()).get(`/api/billing/${path}`).set('Authorization', `Bearer ${token}`);
  const create = (key = randomUUID()) => post('orders', { offerId: 'credits', providerId: 'paypal' }).set('Idempotency-Key', key);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href;
    app = await startApp(); owner = await member('billingowner'); other = await member('billingother');
  });
  afterAll(async () => {
    try { await app?.close(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('permits the actual browser idempotency preflight and authenticates all private reads', async () => {
    const recurring = JSON.parse(options.catalogJson!) as Array<{ mode: string }>;
    recurring[0].mode = 'subscription';
    expect(() => readBillingCatalog(JSON.stringify(recurring))).toThrow('explicit payment-receipt grant basis');
    expect(creations).toHaveLength(0);
    const preflight = await request(app.getHttpServer()).options('/api/billing/orders').set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key').expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-headers'].toLowerCase()).toContain('idempotency-key');
    for (const path of ['orders', 'orders/missing', 'balance']) await request(app.getHttpServer()).get(`/api/billing/${path}`).expect(401);
    const catalog = await request(app.getHttpServer()).get('/api/billing/catalog').expect(200);
    expect(catalog.body).toEqual([expect.objectContaining({ id: 'credits', providers: [{ id: 'paypal', requiresCapture: true, referralProviders: [] }] })]);
    expect(JSON.stringify(catalog.body)).not.toMatch(/accountScope|catalogReference|fulfillmentData/);
  });

  it('rejects cross-site mutation, injected amounts/owners and absent idempotency before provider IO', async () => {
    const before = creations.length;
    await create().set('Origin', 'https://foreign.invalid').expect(403);
    await create().set('Sec-Fetch-Site', 'cross-site').expect(403);
    await post('orders', { offerId: 'credits', providerId: 'paypal' }).expect(400);
    for (const injected of [{ amount: '0.01' }, { ownerId: other.id }, { successUrl: 'https://foreign.invalid' }, { providerMetadata: { bypass: 'true' } }]) {
      await post('orders', { offerId: 'credits', providerId: 'paypal', ...injected }).set('Idempotency-Key', randomUUID()).expect(400);
    }
    expect(creations).toHaveLength(before);
  });

  it('uses one owner-scoped order for duplicate requests and exposes no internal policy or dispatch keys', async () => {
    const key = randomUUID(), before = creations.length;
    const responses = await Promise.all([create(key), create(key)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(responses[0].body.id).toBe(responses[1].body.id); expect(creations).toHaveLength(before + 1);
    expect(JSON.stringify(responses[0].body)).not.toMatch(/accountScope|createKey|captureKey|providerMetadata|fulfillmentData/);
    expect(creations.at(-1)!.offer.fulfillmentData).toBeUndefined();
    const separatelyOwned = await post('orders', { offerId: 'credits', providerId: 'paypal' }, other.token).set('Idempotency-Key', key).expect(200);
    expect(separatelyOwned.body.id).not.toBe(responses[0].body.id);
    await post('orders', { offerId: 'changed', providerId: 'paypal' }).set('Idempotency-Key', key).expect(409);
  });

  it('scopes list/get/confirm/capture and returns the actual page contract', async () => {
    const created = await create().expect(200), id = created.body.id;
    await get(`orders/${id}`, other.token).expect(403);
    await post(`orders/${id}/confirm`, {}, other.token).expect(403);
    await post(`orders/${id}/capture`, { approved: true }, other.token).expect(403);
    const page = await get('orders').expect(200);
    expect(page.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(page.body.total).toBeGreaterThan(0); expect(page.body.data.some((row: { id: string }) => row.id === id)).toBe(true);
    const otherPage = await get('orders', other.token).expect(200);
    expect(otherPage.body.data.some((row: { id: string }) => row.id === id)).toBe(false);
    await get('orders?page=0').expect(400); await get('orders?page=1.5').expect(400);
  });

  it('read-only confirmation never captures; explicit capture and concurrent webhooks grant once', async () => {
    const created = await create().expect(200), id = created.body.id, before = captures.length;
    await get(`orders/${id}`).expect(200);
    const confirmed = await post(`orders/${id}/confirm`).expect(200);
    expect(confirmed.body.state).toBe('requires_capture'); expect(captures).toHaveLength(before);
    await post(`orders/${id}/capture`).expect(400);
    await post(`orders/${id}/capture`, { approved: true, amount: '0.01' }).expect(400);
    const captured = await post(`orders/${id}/capture`, { approved: true }).expect(200);
    expect(captured.body.fulfilledAt).toBeTruthy(); expect(captured.body.checkoutUrl).toBeNull();
    await post(`orders/${id}/capture`, { approved: true }).expect(200); expect(captures).toHaveLength(before + 1);
    const body = `{ "eventId": "synthetic-event", "checkoutId": "checkout-${id}", "reference": "${id}" }\n`;
    const webhook = () => request(app.getHttpServer()).post('/api/billing/webhooks/paypal').set('Content-Type', 'application/json')
      .set('X-Synthetic-Signature', 'verified').send(body);
    const outcomes = await Promise.all([webhook(), webhook(), post(`orders/${id}/confirm`)]);
    expect(outcomes.map(response => response.status)).toEqual([200, 200, 200]); expect(receivedBytes?.toString('utf8')).toBe(body);
    const facts = await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}".credit_lots WHERE "sourceId" = $1`, [id]);
    expect(facts.rows[0].count).toBe(1);
    const balance = await get('balance').expect(200); expect(balance.body.balance).toBe(100);
    expect((await get('balance', other.token).expect(200)).body.balance).toBe(0);
  });

  it('keeps unknown dispatch durable, redacts provider errors and recovers through an authenticated notification after restart', async () => {
    const key = randomUUID();
    // Resolve only the stable request identity; no private client-supplied amount or provider state.
    const id = createHash('sha256').update(JSON.stringify(['checkout', owner.id, key])).digest('hex');
    lost.add(id); const before = creations.length;
    const failed = await create(key).expect(503); expect(JSON.stringify(failed.body)).not.toContain('SYNTHETIC_PRIVATE');
    const retry = await create(key).expect(200);
    expect(retry.body.creationState).toBe('submitting'); expect(creations).toHaveLength(before + 1);
    await app.close(); app = await startApp();
    expect((await get(`orders/${id}`).expect(200)).body.creationState).toBe('submitting');
    const fact = observations.get(`checkout-${id}`)!;
    observations.set(fact.checkoutId, { ...fact, state: 'paid', paidMoney: fact.dueMoney, paymentId: `payment-${id}`, paymentKind: 'capture' });
    const body = JSON.stringify({ eventId: `event-${id}`, checkoutId: fact.checkoutId, reference: id });
    await request(app.getHttpServer()).post('/api/billing/webhooks/paypal').set('Content-Type', 'application/json').send(body).expect(200);
    expect((await get(`orders/${id}`).expect(200)).body.fulfilledAt).toBeNull();
    await request(app.getHttpServer()).post('/api/billing/webhooks/paypal').set('Content-Type', 'application/json')
      .set('X-Synthetic-Signature', 'verified').send(body).expect(200);
    expect((await get(`orders/${id}`).expect(200)).body.fulfilledAt).toBeTruthy();
    expect(creations).toHaveLength(before + 1);
  });

  it('uses an owner-bound return hint only after provider revalidation, without replaying an unknown creation', async () => {
    const key = randomUUID(), id = createHash('sha256').update(JSON.stringify(['checkout', owner.id, key])).digest('hex');
    lost.add(id); const before = creations.length;
    await create(key).expect(503);
    await post(`orders/${id}/confirm`, { checkoutId: 123 }).expect(400);
    await post(`orders/${id}/confirm`, { checkoutId: 'valid-looking', paid: true }).expect(400);
    await post(`orders/${id}/confirm`, { checkoutId: 'checkout-foreign' }, other.token).expect(403);
    const fact = observations.get(`checkout-${id}`)!;
    observations.set('checkout-foreign', { ...fact, checkoutId: 'checkout-foreign', reference: 'foreign-order',
      state: 'paid', paidMoney: fact.dueMoney, paymentId: 'foreign-payment', paymentKind: 'capture' });
    await post(`orders/${id}/confirm`, { checkoutId: 'checkout-foreign' }).expect(409);
    expect((await get(`orders/${id}`).expect(200)).body.fulfilledAt).toBeNull();
    observations.set(fact.checkoutId, { ...fact, state: 'paid', paidMoney: fact.dueMoney, paymentId: `payment-${id}`, paymentKind: 'capture' });
    await app.close(); app = await startApp();
    const recovered = await post(`orders/${id}/confirm`, { checkoutId: fact.checkoutId }).expect(200);
    expect(recovered.body.fulfilledAt).toBeTruthy(); expect(creations).toHaveLength(before + 1);
  });
});
