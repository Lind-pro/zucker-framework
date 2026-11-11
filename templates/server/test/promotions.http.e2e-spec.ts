import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import type { HostedCheckoutAdapter, HostedCheckoutOrder } from '@zucker-framework/payment';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { PromotionsModule } from '../src/promotions';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_promotions_http_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202';

/** Wiring: PromotionsModule registers with BillingService; HTTP never accepts a provider code or price. */
run('promotions over HTTP (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, member: { id: string; token: string };
  const created: HostedCheckoutOrder[] = [];
  const deliveries = new Map<string, string>();
  const provider: HostedCheckoutAdapter = {
    id: 'stripe', accountScope: 'synthetic-promotions-http', modes: ['payment'], promotions: { modes: ['payment'] }, validate() {},
    async create(order) {
      created.push(structuredClone(order));
      return { checkoutId: `cs-${order.id}`, reference: order.id, catalogReference: order.offer.catalogReference, mode: 'payment', quantity: 1,
        state: 'pending', dueMoney: order.offer.promotion?.payable ?? order.offer.money, url: `https://synthetic.invalid/pay/${order.id}` };
    },
    async retrieve() { throw new Error('not used'); },
    async verifyWebhook() { return null; },
  };
  const options: BillingOptions = { providers: [provider], webUrl: origin, catalogJson: JSON.stringify([{ id: 'credits', title: 'Synthetic credits',
    version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'price_synthetic' } }]) };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const order = (body: object, token = member.token) => request(app.getHttpServer()).post('/api/billing/orders').set('Origin', origin)
    .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID().replaceAll('-', '')).send(body);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`); await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema);
    database = new ApplicationDatabase(url.href);
    const limits = { points: 2000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-promotions-http-secret-long', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits, billing: limits } }),
      AccountModule, PromotionsModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(BILLING_OPTIONS).useValue(options).compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    const username = 'promobuyer', email = `${username}@example.invalid`, password = 'SyntheticUser9!';
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200);
    member = { id: login.body.userId, token: login.body.token };
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('applies an automatic promotion server-side and never exposes the provider code', async () => {
    await database.model('promotions').create({ data: { alias: null, providerId: 'stripe', providerCode: 'promo_auto', target: 'offer:credits',
      discountType: 'percent', percentOff: 15 } });
    const response = await order({ offerId: 'credits', providerId: 'stripe' }).expect(200);
    expect(response.body).toMatchObject({ money: { amount: '10.00' }, amountDue: { amount: '8.50', currency: 'USD' }, discount: { amount: '1.50' } });
    expect(JSON.stringify(response.body)).not.toContain('promo_auto');
    expect(created.at(-1)!.offer.promotion).toMatchObject({ providerCode: 'promo_auto', payable: { amount: '8.50' } });
  });

  it('refuses provider codes, prices and (policy off) aliases in the body before provider IO', async () => {
    const before = created.length;
    for (const injected of [{ providerCode: 'promo_auto' }, { promotion: { payable: { amount: '0.01', currency: 'USD' } } }, { discount: '9.99' }])
      await order({ offerId: 'credits', providerId: 'stripe', ...injected }).expect(400);
    const refused = await order({ offerId: 'credits', providerId: 'stripe', promoCode: 'SPRING20' }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('PROMO_INVALID');
    expect(created).toHaveLength(before);
  });

  it('requires promotions permissions for management', async () => {
    await request(app.getHttpServer()).get('/api/management/promotions').set('Authorization', `Bearer ${member.token}`).expect(403);
    await request(app.getHttpServer()).post('/api/management/promotions').set('Origin', origin).set('Authorization', `Bearer ${member.token}`).send({}).expect(403);
    await request(app.getHttpServer()).get('/api/management/promotions').expect(401);
  });
});
