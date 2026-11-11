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
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '../src/policy/policy.service';
import { REFERRAL_POLICIES, type ReferralPolicyValues } from '../src/referrals/referral.policy';
import { REFERRAL_NOTIFIER, REFERRAL_OPTIONS, type ReferralRewardNotice } from '../src/referrals/referral.tokens';
import { ReferralsController, ReferralsManagementController, REFERRAL_RATE_LIMITERS } from '../src/referrals/referrals.controller';
import { ReferralsService } from '../src/referrals/referrals.service';
import { ReferralRewards } from '../src/referrals/referral-rewards';
import { referralDeletionContributor } from '../src/referrals/referral-deletion';

/**
 * Proof of the WP 3.5a contract on PostgreSQL + HTTP (implementer smoke; the full matrix is written
 * separately): claim rules, one binding under concurrent claims, one reward and one grant per key under
 * racing scanners, delay with an injected clock, refund skip, cap, external-affiliate switch, deletion.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_referrals_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt' };
const DAY = 86_400_000;

run('referral programme PostgreSQL and HTTP contract', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase;
  let clock = new Date();
  const notices: ReferralRewardNotice[] = [];
  const deliveries = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const q = (sql: string, values: unknown[] = []) => database.transaction(tx => tx.query<Record<string, unknown>>(sql, values));
  async function account(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`, password = 'SyntheticReferral9!';
    const action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username, email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: logged.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: logged.body.userId as string, token: logged.body.token as string };
  }
  const api = (method: 'get' | 'post' | 'patch', path: string, token: string) =>
    request(app.getHttpServer())[method](`/api${path}`).set('Authorization', `Bearer ${token}`).set('Origin', origin);
  async function enable(values: Partial<ReferralPolicyValues>) {
    const policies = app.get(PolicyService), view = await policies.view('referral') as { revision: number };
    await policies.save('system', 'referral', { expectedRevision: view.revision, values });
  }
  async function order(ownerId: string, fulfilledAt: Date) {
    const id = `order-${randomUUID()}`;
    await q(`INSERT INTO billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
      "creationState", "captureState", state, "paymentId", "paymentKind", "fulfilledAt") VALUES ($1, $2, 'pack', 'fake', 'default', '{}'::jsonb, '/s', '/c', $1 || ':c', $1 || ':k',
      'created', 'captured', 'paid', $1 || ':pay', 'payment-intent', $3)`, [id, ownerId, fulfilledAt]);
    return id;
  }
  const balance = async (userId: string) => Number((await q('SELECT COALESCE(SUM(balance),0)::int AS b FROM credit_account WHERE "userId" = $1', [userId])).rows[0].b);

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const limits = { points: 3000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits, ...REFERRAL_RATE_LIMITERS, 'referral-claim': { points: 16, duration: 3600 } } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...REFERRAL_POLICIES] }), AccountModule],
    controllers: [ReferralsController, ReferralsManagementController],
    providers: [ReferralsService, ReferralRewards,
      { provide: REFERRAL_OPTIONS, useValue: { webOrigin: origin, now: () => clock } },
      { provide: REFERRAL_NOTIFIER, useValue: { notifyReward: async (_tx: unknown, notice: ReferralRewardNotice) => { notices.push(notice); } } },
      { provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    for (const id of ['referrals:query', 'referrals:update']) await database.model('permissions').create({ data: { id, name: id } });
  }, 60_000);
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('is off by default, then binds once under concurrent claims and refuses every rule violation uniformly', async () => {
    clock = new Date();
    const referrer = await account('refowner'), referee = await account('refguest'), other = await account('refother');
    expect((await api('get', '/referrals/me', referrer.token).expect(200)).body).toEqual({ enabled: false, reason: 'disabled' });
    await enable({ enabled: true, referrerCredits: 100, refereeCredits: 50 });
    const me = (await api('get', '/referrals/me', referrer.token).expect(200)).body;
    expect(me).toMatchObject({ enabled: true, codeActive: true, stats: { invited: 0, rewarded: 0, creditsEarned: 0 }, recent: [] });
    expect(me.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/); expect(me.link).toBe(`${origin}/?ref=${me.code}`);
    const ownCode = (await api('get', '/referrals/me', referee.token).expect(200)).body.code as string;

    await api('post', '/referrals/claim', referee.token).set('Origin', 'https://foreign.invalid').send({ code: me.code }).expect(403);
    for (const body of [{ code: ownCode }, { code: 'ZZZZZZZZ' }, { code: '<script>' }, { code: me.code, extra: 1 }, {}]) {
      const refused = await api('post', '/referrals/claim', referee.token).send(body).expect(400);
      expect(refused.body.code ?? refused.body.error?.code ?? JSON.stringify(refused.body)).toContain('REFERRAL_NOT_APPLICABLE');
    }
    const results = await Promise.all(Array.from({ length: 10 }, () => api('post', '/referrals/claim', referee.token).send({ code: me.code.toLowerCase() })));
    expect(results.map(result => `${result.status}:${result.status === 200 ? "" : JSON.stringify(result.body)}`)).toEqual(Array(10).fill("200:"));
    expect((await q('SELECT COUNT(*)::int AS n FROM referral_bindings WHERE "refereeId" = $1', [referee.id])).rows[0].n).toBe(1);
    // 16 claims spent (budget overridden to 16 here; production fragment is 5 per hour per user).
    expect(REFERRAL_RATE_LIMITERS['referral-claim']).toEqual({ points: 5, duration: 3600 });
    await api('post', '/referrals/claim', referee.token).send({ code: me.code }).expect(429);
    // Mutual referral (the referrer claims the referee's code) is refused.
    await api('post', '/referrals/claim', referrer.token).send({ code: ownCode }).expect(400);
    // Outside the claim window.
    await q(`UPDATE users SET "createTime" = $2 WHERE id = $1`, [other.id, new Date(clock.getTime() - 8 * DAY)]);
    await api('post', '/referrals/claim', other.token).send({ code: me.code }).expect(400);
  });

  it('rewards once after the delay under racing scanners, skips refunds, honours the cap and the affiliate switch', async () => {
    const rewards = app.get(ReferralRewards);
    const referrer = await account('capowner'), a = await account('capa'), b = await account('capb'), c = await account('capc');
    clock = new Date();
    const code = (await api('get', '/referrals/me', referrer.token).expect(200)).body.code as string;
    for (const user of [a, b, c]) await api('post', '/referrals/claim', user.token).send({ code }).expect(200);
    const orderA = await order(a.id, new Date(clock.getTime() + 1000));
    const orderB = await order(b.id, new Date(clock.getTime() + 2000));
    await q(`INSERT INTO billing_refund_payments (id, "ownerId", "orderId", "providerId", "accountScope", "paymentKind", "paymentId", "sourceKind", "sourceId",
      title, "paidMoney", "paidMinor", "minorScale", "totalCredits", "refundedMinor", "observedAt") VALUES ('rp-b', $1, $2, 'fake', 'default', 'payment-intent', $2 || ':pay',
      'payment-intent', $2 || ':pay', 'Pack', '{"amount":"10.00","currency":"USD"}'::jsonb, '1000', 2, 100, '1000', now())`, [b.id, orderB]);
    const orderC = await order(c.id, new Date(clock.getTime() + 3000));

    // Not due before the 7-day delay.
    clock = new Date(clock.getTime() + 6 * DAY);
    expect(await rewards.processDue(clock)).toEqual([]);
    await enable({ maxRewardsPerReferrer: 1, referrerCredits: 70 }); // grant-time values are used
    clock = new Date(clock.getTime() + 2 * DAY);
    const before = { referrer: await balance(referrer.id), a: await balance(a.id) };
    const raced = (await Promise.all([rewards.processDue(clock), rewards.processDue(clock), rewards.processDue(clock)])).flat();
    expect(raced.filter(outcome => outcome.status === 'granted')).toEqual([{ status: 'granted', orderId: orderA, referrerCredits: 70, refereeCredits: 50 }]);
    const decided = await q('SELECT "orderId", status, "skipReason" FROM referral_rewards WHERE "referrerId" = $1 ORDER BY "orderId"', [referrer.id]);
    expect(Object.fromEntries(decided.rows.map(row => [row.orderId, [row.status, row.skipReason]]))).toEqual({
      [orderA]: ['granted', null], [orderB]: ['skipped', 'refunded'], [orderC]: ['skipped', 'cap-reached'] });
    expect(await balance(referrer.id) - before.referrer).toBe(70); expect(await balance(a.id) - before.a).toBe(50);
    expect((await q(`SELECT COUNT(*)::int AS n FROM credit_operation_receipts WHERE "idempotencyKey" LIKE 'referral:%'`)).rows[0].n).toBe(2);
    expect(notices.map(notice => notice.eventKey).sort()).toEqual([`referral:${orderA}:referee`, `referral:${orderA}:referrer`]);
    expect(await rewards.processDue(clock)).toEqual([]);
    const stats = (await api('get', '/referrals/me', referrer.token).expect(200)).body;
    expect(stats.stats).toEqual({ invited: 3, rewarded: 1, creditsEarned: 70 });
    expect(JSON.stringify(stats)).not.toContain(a.id);

    // External affiliate tool on: claims and the scanner idle.
    const settings = (app.get(ReferralsService) as unknown as { settings: { publicIntegrations: () => Promise<unknown> } }).settings;
    const original = settings.publicIntegrations.bind(settings);
    settings.publicIntegrations = async () => ({ connections: { enabled: true, affonso: { enabled: true } } });
    try { expect((await api('get', '/referrals/me', referrer.token).expect(200)).body).toEqual({ enabled: false, reason: 'external-affiliate' }); }
    finally { settings.publicIntegrations = original; }
  });

  it('management list and audited code disable require their permissions; deletion removes the referee side', async () => {
    const admin = await account('refadmin', ['referrals:query', 'referrals:update']), viewer = await account('refviewer', ['referrals:query']);
    const target = await account('reftarget');
    const listed = await api('get', '/management/referrals?status=granted', viewer.token).expect(200);
    expect(listed.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    await api('patch', `/management/referrals/codes/${target.id}`, viewer.token).send({ disabled: true }).expect(403);
    const disabled = await api('patch', `/management/referrals/codes/${target.id}`, admin.token).send({ disabled: true }).expect(200);
    expect(disabled.body).toMatchObject({ userId: target.id, disabled: true });
    expect(await database.model('operationLogs').findMany({ where: { module: 'referrals', targetId: target.id } })).toHaveLength(1);
    expect((await api('get', '/referrals/me', target.token).expect(200)).body).toMatchObject({ codeActive: false, link: null });

    const bound = (await q('SELECT "refereeId" FROM referral_bindings LIMIT 1')).rows[0].refereeId as string;
    await database.transaction(tx => referralDeletionContributor.erase(tx, bound));
    expect((await q('SELECT 1 FROM referral_bindings WHERE "refereeId" = $1', [bound])).rows).toHaveLength(0);
  });
});
