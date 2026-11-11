/**
 * Operations insights (WP 3.5b) over HTTP + PostgreSQL: known fixtures produce the expected summary
 * and daily series in a non-UTC zone across a DST change (zero days, two currencies, promotion
 * payable, subscription cycles without double counting), parameter validation, the permission gate,
 * per-parameter caching and missing-table tolerance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { InsightsModule, InsightsService, sumDecimal } from '../src/insights';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_insights_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-insights-jwt-secret-of-32-chars-min',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt' };
/** 2026-03-08 is the US DST change: New York local days are 03-08 (23 h), 03-09, 03-10. */
const AS_OF = new Date('2026-03-10T16:00:00.000Z'), NY = 'America/New_York';

run('insights (HTTP + PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase;
  let analyst: { token: string }, viewer: { token: string };
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const server = () => app.getHttpServer();
  const get = (path: string, user: { token: string } = analyst) => request(server()).get(`/api${path}`).set('Authorization', `Bearer ${user.token}`);
  const sql = (text: string, values: unknown[] = []) => database.transaction(tx => tx.query(text, values));
  async function member(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`, password = 'SyntheticInsights9!';
    const send = (path: string, body: object) => request(server()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
    return { token: login.body.token as string };
  }

  async function seed() {
    for (const [id, at] of [['ins-u1', '2026-03-09T03:30:00Z'], ['ins-u2', '2026-03-09T04:30:00Z'], ['ins-u3', '2026-03-08T04:59:00Z']])
      await sql(`INSERT INTO users (id, username, name, "typeId", "createTime") VALUES ($1, $1, $1, 'user', $2::timestamptz)`, [id, at]);
    const order = (id: string, owner: string, offer: object, state: string, fulfilledAt: string | null, extra: { subscriptionId?: string; paymentId?: string } = {}) =>
      sql(`INSERT INTO billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
          "creationState", "captureState", state, "paymentId", "paymentKind", "subscriptionId", "fulfilledAt")
        VALUES ($1, $2, 'offer', 'fake', 'default', $3::jsonb, '/ok', '/cancel', $1 || ':c', $1 || ':k', 'created', 'captured', $4, $5, 'payment', $6, $7::timestamptz)`,
      [id, owner, JSON.stringify(offer), state, extra.paymentId ?? `pay-${id}`, extra.subscriptionId ?? null, fulfilledAt]);
    const money = (amount: string, currency: string) => ({ amount, currency });
    await order('ins-o1', 'ins-u1', { mode: 'payment', money: money('10.00', 'USD') }, 'paid', '2026-03-09T15:00:00Z');
    // Promotion: the payable amount is revenue, not the list price. 03:59Z on 03-10 is 23:59 on 03-09 in New York (EDT).
    await order('ins-o2', 'ins-u2', { mode: 'payment', money: money('10.00', 'EUR'), promotion: { id: 'p', providerCode: 'X', payable: money('8.50', 'EUR'), discount: money('1.50', 'EUR') } },
      'paid', '2026-03-10T03:59:00Z');
    await order('ins-o4', 'ins-u2', { mode: 'payment', money: money('5.00', 'USD') }, 'pending', null);
    await order('ins-o5', 'ins-u3', { mode: 'payment', money: money('99.00', 'USD') }, 'paid', '2026-03-08T04:00:00Z'); // 03-07 23:00 EST
    const subscriptionOffer = { mode: 'subscription', money: money('20.00', 'USD'), catalogReference: 'plan-pro', version: 'v1', fulfillmentData: { credits: 10 } };
    await order('ins-o3', 'ins-u1', subscriptionOffer, 'paid', '2026-03-09T12:00:00Z', { subscriptionId: 'sub-1', paymentId: 'pay-init' });
    await sql(`INSERT INTO billing_subscriptions (id, "ownerId", "initialOrderId", "providerId", "accountScope", "providerSubscriptionId", "catalogReference",
        offer, "grantBasis", "initialPaymentId", "initialPaymentKind", status)
      VALUES ('ins-o3', 'ins-u1', 'ins-o3', 'fake', 'default', 'sub-1', 'plan-pro', $1::jsonb, 'payment', 'pay-init', 'payment', 'active')`, [JSON.stringify(subscriptionOffer)]);
    for (const [id, paymentId, paidAt] of [['ins-c1', 'pay-init', '2026-03-09T12:00:00Z'], ['ins-c2', 'pay-renew', '2026-03-10T10:00:00Z']])
      await sql(`INSERT INTO billing_subscription_cycles (id, "cycleKey", "bindingId", "ownerId", "providerId", "accountScope", "subscriptionId", "catalogReference",
          basis, "paymentId", "paymentKind", "recordId", "paidMoney", "paidAt", "policyVersion", policy, initial, "fulfilledAt")
        VALUES ($1, $1, 'ins-o3', 'ins-u1', 'fake', 'default', 'sub-1', 'plan-pro', 'payment', $2, 'payment', $1, '{"amount":"20.00","currency":"USD"}', $3::timestamptz,
          'v1', '{"credits":10}', $4, $3::timestamptz)`, [id, paymentId, paidAt, paymentId === 'pay-init']);
    await sql(`INSERT INTO billing_refund_payments (id, "ownerId", "orderId", "providerId", "accountScope", "paymentKind", "paymentId", "sourceKind", "sourceId",
        title, "paidMoney", "paidMinor", "minorScale", "totalCredits", "observedAt")
      VALUES ('ins-rp1', 'ins-u1', 'ins-o1', 'fake', 'default', 'payment', 'pay-ins-o1', 'order', 'ins-o1', 'Pack', '{"amount":"10.00","currency":"USD"}', '1000', 2, 10, now())`);
    for (const [refundId, state, at] of [['r1', 'succeeded', '2026-03-10T14:00:00Z'], ['r2', 'pending', '2026-03-10T14:00:00Z']])
      await sql(`INSERT INTO billing_refund_receipts ("providerId", "accountScope", "refundId", "targetId", "sourceKind", "sourceId", state, money, "amountMinor", "occurredAt")
        VALUES ('fake', 'default', $1, 'ins-rp1', 'order', 'ins-o1', $2, '{"amount":"4.00","currency":"USD"}', '400', $3::timestamptz)`, [refundId, state, at]);
    for (const [amount, at] of [[100, '2026-03-09T12:00:00Z'], [50, '2026-03-10T12:00:00Z']])
      await sql(`INSERT INTO credit_lots (id, "userId", source, amount, "remainingAmount", "createdAt") VALUES ($1, 'ins-u1', 'purchase', $2, $2, $3::timestamptz)`, [randomUUID(), amount, at]);
    await sql(`INSERT INTO credit_consumptions (id, "userId", amount, "transactionId", "resourceType", "createdAt") VALUES ('ins-cc1', 'ins-u1', 30, 'ins-tx1', 'ai', '2026-03-10T13:00:00Z')`);
    for (const [id, kind, status, at] of [['ins-t1', 'image', 'COMPLETED', '2026-03-09T12:00:00Z'], ['ins-t2', 'video', 'FAILED', '2026-03-10T12:00:00Z'], ['ins-t3', 'image', 'QUEUED', '2026-03-10T12:30:00Z']]) {
      await sql(`INSERT INTO async_jobs (id, kind, "resourceType", "resourceId", status, "maxAttempts", "idempotencyKey", "idempotencyFingerprint", "handlerVersion", payload)
        VALUES ($1, 'ai.task', 'ai_task', $1, $2::async_job_status, 3, $1, 'f', 'v1', '{}')`, [id, status]);
      await sql(`INSERT INTO ai_tasks (id, "ownerId", kind, "providerId", model, cost, "holdState", "deadlineAt", "createdAt", "updatedAt")
        VALUES ($1, 'ins-u1', $2, 'fake', 'm', 1, 'NONE', $3::timestamptz, $3::timestamptz, $3::timestamptz)`, [id, kind, at]);
    }
    await sql(`INSERT INTO chats (id, "ownerId", title, "providerId", model) VALUES ('ins-chat', 'ins-u1', 'Chat', 'fake', 'm')`);
    for (const [seq, role, at] of [[0, 'user', '2026-03-09T12:00:00Z'], [1, 'assistant', '2026-03-09T12:00:05Z'], [2, 'user', '2026-03-10T12:00:00Z']])
      await sql(`INSERT INTO chat_messages (id, "chatId", "ownerId", seq, role, parts, status, "createdAt") VALUES ($1, 'ins-chat', 'ins-u1', $2, $3, '[]', 'COMPLETE', $4::timestamptz)`,
        [`ins-m${seq}`, seq, role, at]);
    for (const [userId, source, at] of [['ins-u1', 'google', '2026-03-09T03:30:00Z'], ['ins-u2', 'google', '2026-03-09T04:30:00Z'], ['ins-u3', 'x', '2026-03-08T04:59:00Z'],
      ['ins-u5', 'news', '2026-03-10T12:00:00Z'], ['ins-u6', null, '2026-03-10T12:00:00Z']])
      await sql(`INSERT INTO user_acquisition ("userId", "signupMethod", "signupUtmSource", "signupIp", "createdAt") VALUES ($1, 'password', $2, '192.0.2.1', $3::timestamptz)`, [userId, source, at]);
    await sql(`INSERT INTO subscription_plans (id, slug, name) VALUES ('ins-plan', 'pro', 'Pro')`);
    await sql(`INSERT INTO user_subscriptions (id, "userId", "planId", status, "billingCycle", "startDate", "endDate") VALUES
      ('ins-s1', 'ins-u1', 'ins-plan', 'ACTIVE', 'MONTHLY', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
      ('ins-s2', 'ins-u2', 'ins-plan', 'ACTIVE', 'MONTHLY', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z')`);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    process.env.ACCOUNT_ORIGINS = origin;
    const limits = { points: 3000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [
      EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits,
        'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), AccountModule, InsightsModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(InsightsService).useFactory({ factory: (db: ApplicationDatabase) => new InsightsService(db, () => AS_OF), inject: [DATABASE_ADAPTER] })
      .compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    await database.model('permissions').create({ data: { id: 'insights:query', name: 'insights:query' } });
    analyst = await member('insanalyst', ['insights:query']); viewer = await member('insviewer');
    await seed();
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('summary aggregates the local-day window without PII', async () => {
    const response = await get(`/management/insights/summary?days=3&tz=${encodeURIComponent(NY)}`).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const { range, metrics } = response.body;
    expect(range).toEqual({ days: 3, tz: NY, from: '2026-03-08', to: '2026-03-10', asOf: AS_OF.toISOString() });
    expect(metrics.revenue).toEqual({ available: true, totals: [{ currency: 'EUR', amount: '8.50' }, { currency: 'USD', amount: '50.00' }] });
    expect(metrics.refunds).toEqual({ available: true, totals: [{ currency: 'USD', amount: '4.00' }] });
    expect(metrics['new-users']).toEqual({ available: true, value: 2 });
    expect(metrics['paying-users']).toEqual({ available: true, value: 2 });
    expect(metrics['active-subscriptions']).toEqual({ available: true, value: 1, provider: 1 });
    expect(metrics['credits-granted']).toEqual({ available: true, value: 150 });
    expect(metrics['credits-consumed']).toEqual({ available: true, value: 30 });
    expect(metrics['ai-tasks']).toEqual({ available: true, value: 3, breakdown: [
      { kind: 'image', status: 'completed', count: 1 }, { kind: 'image', status: 'in_progress', count: 1 }, { kind: 'video', status: 'failed', count: 1 }] });
    expect(metrics['chat-messages']).toEqual({ available: true, value: 2 });
    expect(metrics['signups-by-source']).toEqual({ available: true, items: [{ source: 'google', count: 2 }, { source: 'news', count: 1 }], attributed: 3, unattributed: 1 });
    expect(JSON.stringify(response.body)).not.toMatch(/ins-u\d|@example|192\.0\.2/);
  });

  it('daily series fill zero days and keep currencies apart', async () => {
    const revenue = (await get(`/management/insights/series?metric=revenue&days=3&tz=${encodeURIComponent(NY)}`).expect(200)).body;
    expect(revenue).toMatchObject({ metric: 'revenue', unit: 'money', available: true, kind: 'daily' });
    expect(revenue.series).toEqual([
      { key: 'EUR', total: '8.50', points: [{ date: '2026-03-08', value: '0' }, { date: '2026-03-09', value: '8.50' }, { date: '2026-03-10', value: '0' }] },
      { key: 'USD', total: '50.00', points: [{ date: '2026-03-08', value: '0' }, { date: '2026-03-09', value: '30.00' }, { date: '2026-03-10', value: '20.00' }] },
    ]);
    const payers = (await get(`/management/insights/series?metric=paying-users&days=3&tz=${encodeURIComponent(NY)}`).expect(200)).body;
    expect(payers.series).toEqual([{ key: 'total', points: [{ date: '2026-03-08', value: 0 }, { date: '2026-03-09', value: 2 }, { date: '2026-03-10', value: 1 }] }]);
    const tasks = (await get(`/management/insights/series?metric=ai-tasks&days=3&tz=${encodeURIComponent(NY)}`).expect(200)).body;
    expect(tasks.series.map((entry: { key: string; total: number }) => [entry.key, entry.total]))
      .toEqual([['completed', 1], ['failed', 1], ['cancelled', 0], ['in_progress', 1]]);
    const sources = (await get(`/management/insights/series?metric=signups-by-source&days=3&tz=${encodeURIComponent(NY)}`).expect(200)).body;
    expect(sources).toMatchObject({ kind: 'ranking', items: [{ key: 'google', value: 2 }, { key: 'news', value: 1 }], unattributed: 1 });
    const active = (await get('/management/insights/series?metric=active-subscriptions').expect(200)).body;
    expect(active).toMatchObject({ kind: 'point', value: 1, provider: 1 });
  });

  it('day boundaries follow the zone and the cache never crosses parameters', async () => {
    const day = async (tz: string) => (await get(`/management/insights/series?metric=new-users&days=3&tz=${encodeURIComponent(tz)}`).expect(200))
      .body.series[0].points.map((point: { date: string; value: number }) => `${point.date}=${point.value}`);
    expect(await day(NY)).toEqual(['2026-03-08=1', '2026-03-09=1', '2026-03-10=0']);
    // In UTC ins-u3 (04:59Z on 03-08) is inside the window and ins-u1/ins-u2 both fall on 03-09.
    expect(await day('UTC')).toEqual(['2026-03-08=1', '2026-03-09=2', '2026-03-10=0']);
    const one = (await get('/management/insights/series?metric=new-users&days=1&tz=UTC').expect(200)).body;
    expect(one.series[0].points).toEqual([{ date: '2026-03-10', value: 0 }]);
  });

  it('rejects bad parameters and callers without insights:query', async () => {
    for (const query of ['days=0', 'days=367', 'days=1.5', 'days=-1', 'tz=Mars%2FBase', "tz=UTC'%3B--", 'days=3&extra=1', 'days=3&days=4'])
      expect((await get(`/management/insights/summary?${query}`).expect(400)).body.code ?? 'INSIGHTS_INVALID').toBe('INSIGHTS_INVALID');
    await get('/management/insights/series?metric=users').expect(400);
    await get('/management/insights/series').expect(400);
    await get('/management/insights/summary', viewer).expect(403);
    await get('/management/insights/series?metric=revenue', viewer).expect(403);
    await request(server()).get('/api/management/insights/summary').expect(401);
  });

  it('reports a missing feature table as unavailable', async () => {
    await sql('ALTER TABLE chat_messages RENAME TO chat_messages_hidden');
    try {
      app.get(InsightsService).clearCache();
      const summary = (await get('/management/insights/summary?days=3').expect(200)).body;
      expect(summary.metrics['chat-messages']).toEqual({ available: false });
      expect(summary.metrics['new-users'].available).toBe(true);
      expect((await get('/management/insights/series?metric=chat-messages&days=3').expect(200)).body).toMatchObject({ available: false, metric: 'chat-messages' });
    } finally { await sql('ALTER TABLE chat_messages_hidden RENAME TO chat_messages'); app.get(InsightsService).clearCache(); }
  });

  it('sumDecimal adds exactly at the widest scale', () => {
    expect(sumDecimal(['0', '0.10', '0.2', '19.99'])).toBe('20.29');
    expect(sumDecimal(['0', '0'])).toBe('0');
    expect(sumDecimal(['0.001', '0.009'])).toBe('0.010');
  });
});
