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
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { PromotionsModule } from '../src/promotions';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_promotions_mgmt_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202';

/** Management permission matrix over HTTP: each action needs exactly its own promotions:* permission. */
run('promotions management over HTTP (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase;
  const deliveries = new Map<string, string>();
  const users: Record<string, { id: string; token: string }> = {};
  const provider: HostedCheckoutAdapter = {
    id: 'stripe', accountScope: 'synthetic-promotions-mgmt', modes: ['payment'], promotions: { modes: ['payment'] }, validate() {},
    async create() { throw new Error('not used'); }, async retrieve() { throw new Error('not used'); }, async verifyWebhook() { return null; },
  };
  const options: BillingOptions = { providers: [provider], webUrl: origin, catalogJson: JSON.stringify([{ id: 'credits', title: 'Synthetic credits',
    version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'price_synthetic' } }]) };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, who: string | null, body?: object, headers: Record<string, string> = { Origin: origin }) => {
    let req = request(app.getHttpServer())[method](`/api/management/promotions${path}`);
    for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
    if (who) req = req.set('Authorization', `Bearer ${users[who].token}`);
    return body ? req.send(body) : req;
  };
  const payload = (alias: string) => ({ alias, providerId: 'stripe', providerCode: 'promo_synthetic', target: '*', currency: null, discountType: 'percent',
    percentOff: 10, amountOff: null, maxRedemptions: null, status: 'active', startsAt: null, endsAt: null, note: null });

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
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-promotions-mgmt-secret-long', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits, billing: limits } }),
      AccountModule, PromotionsModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(BILLING_OPTIONS).useValue(options).compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    const grants: Record<string, string[]> = {
      plain: [], query: ['promotions:query'], create: ['promotions:query', 'promotions:create'], update: ['promotions:query', 'promotions:update'],
      remove: ['promotions:query', 'promotions:delete'], createOnly: ['promotions:create'],
    };
    for (const id of new Set(Object.values(grants).flat())) await database.model('permissions').upsert({ where: { id }, create: { id, name: id }, update: {} });
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    for (const [name, permissions] of Object.entries(grants)) {
      const email = `${name.toLowerCase()}@example.invalid`, password = 'SyntheticUser9!';
      await post('register', { username: `promo${name.toLowerCase()}`, email, password }).expect(201);
      await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
      const login = await post('login', { username: `promo${name.toLowerCase()}`, password }).expect(200);
      users[name] = { id: login.body.userId, token: login.body.token };
      for (const permissionId of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId, grantType: 'grant' } });
    }
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('each action needs its own permission; a bare create permission cannot even list', async () => {
    const seeded = await call('post', '', 'create', payload('MATRIX1')).expect(201);
    const id = seeded.body.id as string;
    const edit = { ...payload('MATRIX1'), percentOff: 15, expectedRevision: seeded.body.revision };
    const status = { status: 'disabled', expectedRevision: seeded.body.revision };
    const cases: Array<[string, string, string | null, number, object?]> = [
      ['get', '', null, 401], ['get', '', 'plain', 403], ['get', '', 'createOnly', 403], ['get', '', 'query', 200], ['get', `/${id}`, 'query', 200], ['get', `/${id}/redemptions`, 'query', 200],
      ['post', '', 'query', 403, payload('MATRIX2')], ['post', '', 'update', 403, payload('MATRIX2')], ['post', '', 'remove', 403, payload('MATRIX2')],
      ['put', `/${id}`, 'query', 403, edit], ['put', `/${id}`, 'create', 403, edit], ['put', `/${id}`, 'remove', 403, edit],
      ['post', `/${id}/status`, 'query', 403, status], ['post', `/${id}/status`, 'create', 403, status],
      ['delete', `/${id}?expectedRevision=${seeded.body.revision}`, 'query', 403], ['delete', `/${id}?expectedRevision=${seeded.body.revision}`, 'update', 403],
      ['delete', `/${id}?expectedRevision=${seeded.body.revision}`, 'create', 403],
    ];
    for (const [method, path, who, expected, body] of cases)
      await call(method as 'get', path, who, body).expect(expected);
    // Nothing above changed the promotion.
    expect((await call('get', `/${id}`, 'query').expect(200)).body).toMatchObject({ percentOff: 10, status: 'active', revision: seeded.body.revision });
    const updated = await call('put', `/${id}`, 'update', edit).expect(200);
    expect(updated.body).toMatchObject({ percentOff: 15, revision: seeded.body.revision + 1 });
    // Stale revision: 409. The deleter needs the current revision.
    await call('put', `/${id}`, 'update', edit).expect(409);
    await call('delete', `/${id}?expectedRevision=${seeded.body.revision}`, 'remove').expect(409);
    await call('delete', `/${id}?expectedRevision=${updated.body.revision}`, 'remove').expect(200);
    await call('get', `/${id}`, 'query').expect(404);
  });

  it('a used promotion cannot be deleted (409), only disabled; the audit row names the token user, not the body', async () => {
    const created = await call('post', '', 'create', payload('USEDONE')).expect(201);
    await database.model('promotionRedemptions').create({ data: { orderId: 'o-1', promotionId: created.body.id, ownerId: users.plain.id, providerId: 'stripe',
      status: 'reserved', discountAmount: '1.00', payableAmount: '9.00', currency: 'USD', expiresAt: new Date(Date.now() + 3_600_000) } });
    await call('delete', `/${created.body.id}?expectedRevision=${created.body.revision}`, 'remove').expect(409);
    await call('post', `/${created.body.id}/status`, 'update', { status: 'disabled', expectedRevision: created.body.revision }).expect(200);
    const log = await database.model('operationLogs').findMany({ where: { module: 'promotions', targetId: created.body.id } }) as Array<{ userId: string }>;
    expect(log.map(row => row.userId).sort()).toEqual([users.create.id, users.update.id].sort());
    // Identity fields in the body are refused rather than trusted.
    await call('post', '', 'create', { ...payload('SPOOF1'), creatorId: users.plain.id, actorId: users.plain.id }).expect(400);
  });

  it('refuses untrusted origins and malformed bodies/queries on writes and lists', async () => {
    await call('post', '', 'create', payload('ORIGIN1'), { Origin: 'https://evil.example' }).expect(403);
    await call('post', '', 'create', payload('ORIGIN2'), {}).expect(403);
    for (const bad of [{ ...payload('BAD1'), percentOff: 100 }, { ...payload('BAD2'), discountType: 'free' }, { ...payload('BAD3'), providerCode: 'a b' },
      { ...payload('BAD4'), target: 'plan:' }, { ...payload('BAD5'), target: 'pack:missing' }, { ...payload('BAD6'), status: 'deleted' }, {}])
      await call('post', '', 'create', bad).expect(400);
    for (const query of ['?page=0', '?page=abc', '?pageSize=101', '?status=deleted', '?q=' + 'x'.repeat(65)])
      await call('get', query, 'query').expect(400);
    await call('delete', '/missing?expectedRevision=abc', 'remove').expect(400);
  });
});
