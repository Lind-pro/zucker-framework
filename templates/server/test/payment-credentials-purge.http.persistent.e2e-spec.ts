import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { HostedCheckoutError, RefundProtocolError, type HostedCheckoutAdapter, type RefundAdapter } from '@zucker-framework/payment';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { BillingService } from '../src/billing/billing.service';
import { PaymentCredentialResolver } from '../src/billing/payment-credentials';
import { PaymentCredentialRetention } from '../src/billing/payment-credential-retention';
import { PaymentCredentialsController } from '../src/billing/payment-credentials.controller';
import type { PaymentProviderSet } from '../src/billing/providers';
import { FakePaymentLedger } from '../src/billing/test-fakes/fake-payment-provider';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';

/**
 * WP 4.1c, D13: the purge endpoints over real HTTP (guards, Origin, superadmin role, rate limit, audit)
 * and fail-closed behaviour (503) when an archived revision cannot be decrypted. Synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_payment_purge_http_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticPurge9!';
const baseEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-purge-http',
  JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters', BILLING_STRIPE_ENABLED: 'false' };
const catalogJson = JSON.stringify([{ id: 'credits', title: 'Synthetic 100 credits', version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD',
  credits: 100, expiresInDays: null, providers: { stripe: 'sku-credits' } }]);
const RATE_POINTS = 40, SENTINELS = ['sk_test_', 'whsec_'];

run('payment credential purge endpoints (HTTP, PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService, billing: BillingService, resolver: PaymentCredentialResolver;
  const deliveries = new Map<string, string>(), operator = 'synthetic-operator', ledgers = new Map<string, FakePaymentLedger>();
  let ownerId: string;
  const factory = (environment: NodeJS.ProcessEnv, providerId: string): PaymentProviderSet | undefined => {
    if (providerId !== 'stripe' || environment.BILLING_STRIPE_ENABLED !== 'true') return undefined;
    const scope = environment.BILLING_STRIPE_ACCOUNT_SCOPE!.trim();
    if (!ledgers.has(scope)) ledgers.set(scope, new FakePaymentLedger(`${origin}/api/billing/test-checkout`));
    const ledger = ledgers.get(scope)!;
    const checkout: HostedCheckoutAdapter = { id: 'stripe', accountScope: scope, modes: ['payment'], validate() {},
      async create(order) { return ledger.create(order); }, async retrieve(id) { return ledger.retrieve(id); },
      async verifyWebhook() { throw new HostedCheckoutError('verification_failed', 'Synthetic signature is invalid'); } };
    const refund: RefundAdapter = { id: 'stripe', accountScope: scope,
      capabilities: { paymentKinds: ['payment-intent', 'invoice'], partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: true },
      async retrievePayment(payment) { return ledger.paymentFacts(payment); }, async create(command) { return ledger.createRefund(command); },
      async retrieve(refundId) { return ledger.refund(refundId); }, async listRefunds(payment) { return { data: ledger.refundsFor(payment) }; },
      async verifyWebhook() { throw new RefundProtocolError('verification_failed', 'Synthetic signature is invalid', 'rejected'); } };
    return { checkout, refund };
  };
  const save = (expectedRevision: number, scope: string, key: string, secret: string) =>
    settings.save(operator, 'payment-stripe', { expectedRevision, values: { BILLING_STRIPE_ENABLED: 'true', BILLING_STRIPE_MODE: 'test', BILLING_STRIPE_ACCOUNT_SCOPE: scope },
      secrets: { STRIPE_SECRET_KEY: { action: 'replace', value: key }, STRIPE_WEBHOOK_SECRET: { action: 'replace', value: secret } } });
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const rows = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows as T[];
  const revisions = async () => (await settings.revisions('payment-stripe')).map(row => row.revision);
  const audit = () => rows<{ action: string; status: string; userId: string; ipAddress: string | null; metadata: Record<string, unknown> }>(
    `SELECT action, status, "userId", "ipAddress", metadata FROM "${schema}"."operation_logs" WHERE module = 'payment-credentials' ORDER BY "createdAt", id`);
  const build = (targetSettings: ConnectionSettingsService) => {
    const created = new PaymentCredentialResolver(targetSettings, { factory });
    return { resolver: created, billing: new BillingService(database, { providers: [], webUrl: origin, catalogJson, credentials: created }) };
  };
  const startApp = async (retention: PaymentCredentialRetention) => {
    const limits = { points: 3000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: baseEnv.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits,
        'api-default': { points: RATE_POINTS, duration: 60 } } }), AccountModule,
    ], controllers: [PaymentCredentialsController], providers: [{ provide: PaymentCredentialRetention, useValue: retention },
      { provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    const instance = module.createNestApplication(); instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter()); await instance.init();
    return instance;
  };
  /** A verified, logged-in user; optionally granted `config:update` and the `superadmin` role (optionally expired). */
  const user = async (name: string, options: { permission?: boolean; superadmin?: boolean | 'expired' } = {}) => {
    const username = `${name}${randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.invalid`;
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200);
    const id = login.body.userId as string;
    if (options.permission) await database.model('userPermissions').create({ data: { userId: id, permissionId: 'config:update', grantType: 'grant' } });
    if (options.superadmin) {
      const role = await database.model('roles').upsert({ where: { name: 'superadmin' }, update: {}, create: { name: 'superadmin', description: 'Administrator' } }) as { id: string };
      await database.model('userRoles').create({ data: { userId: id, roleId: role.id, ...(options.superadmin === 'expired' ? { expiresAt: new Date(Date.now() - 60_000) } : {}) } });
    }
    return { id, token: login.body.token as string };
  };
  const get = (token: string) => request(app.getHttpServer()).get('/api/management/payment-credentials/revisions').set('Authorization', `Bearer ${token}`);
  const purge = (token: string, body: unknown, headers: Record<string, string> = { Origin: origin }) =>
    request(app.getHttpServer()).post('/api/management/payment-credentials/purge').set('Authorization', `Bearer ${token}`).set(headers).send(body as object);
  const order = () => billing.create(ownerId, `synthetic-key-${randomUUID()}`, { offerId: 'credits', providerId: 'stripe' });
  const age = (days: number, where = `"profileId" = 'payment-stripe'`) => pool.query(`UPDATE "${schema}"."connection_profile_revisions" SET "createdAt" = now() - interval '${days} days' WHERE ${where}`);
  /** Revisions 1 and 2 (account A, rotated) and 3 (account B, current), all aged past retention, with one unfinished account-A order. */
  const seed = async () => {
    await save(0, 'purge-a', 'sk_test_A1', 'whsec_A1'); const unfinished = await order();
    await save(1, 'purge-a', 'sk_test_A2', 'whsec_A2'); await save(2, 'purge-b', 'sk_test_B1', 'whsec_B1');
    await age(500); return unfinished;
  };
  const finish = (orderId: string) => pool.query(`UPDATE "${schema}"."billing_orders" SET "fulfilledAt" = now() - interval '450 days', "createdAt" = now() - interval '450 days', state = 'paid' WHERE id = $1`, [orderId]);

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    await database.model('permissions').create({ data: { id: 'config:update', name: 'config:update' } });
    settings = new ConnectionSettingsService(database, baseEnv);
    ({ resolver, billing } = build(settings));
    app = await startApp(new PaymentCredentialRetention(database, billing, settings));
  });
  beforeEach(async () => {
    await pool.query(`UPDATE "${schema}"."billing_orders" SET "createdAt" = now() - interval '450 days'`);
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
    await pool.query(`DELETE FROM "${schema}"."operation_logs" WHERE module = 'payment-credentials'`);
    settings = new ConnectionSettingsService(database, baseEnv); ({ resolver, billing } = build(settings));
    await app.close(); app = await startApp(new PaymentCredentialRetention(database, billing, settings));
    ownerId = randomUUID();
    await database.model('users').create({ data: { id: ownerId, username: `buyer_${ownerId.replaceAll('-', '')}`, name: 'Synthetic buyer', typeId: 'member',
      email: `${ownerId}@example.invalid`, emailVerified: true, status: true } });
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('is closed to anonymous callers, plain members, permission-only holders and expired superadmins; nothing is deleted or audited as success', async () => {
    await seed();
    const member = await user('member'), permitted = await user('permonly', { permission: true }), expired = await user('expired', { permission: true, superadmin: 'expired' });
    await get('').expect(401); await request(app.getHttpServer()).post('/api/management/payment-credentials/purge').set('Origin', origin).send({ profileId: 'payment-stripe' }).expect(401);
    for (const caller of [member]) { await get(caller.token).expect(403); await purge(caller.token, { profileId: 'payment-stripe', dryRun: false }).expect(403); }
    // config:update alone is not enough: the real superadmin role is required (also when the role link expired).
    for (const caller of [permitted, expired]) { await get(caller.token).expect(403); await purge(caller.token, { profileId: 'payment-stripe', dryRun: false }).expect(403); }
    // The framework treats a superadmin as holding every permission, so the role alone is accepted (dry run only here).
    const roleOnly = await user('roleonly', { superadmin: true });
    await get(roleOnly.token).expect(200); await purge(roleOnly.token, { profileId: 'payment-stripe' }).expect(200);
    expect(await revisions()).toEqual([3, 2, 1]);
    expect((await audit()).map(row => row.action)).toEqual(['purge-dry-run']);
  });

  it('needs a trusted Origin and rejects cross-site purges before any work or audit', async () => {
    await seed(); const root = await user('root', { permission: true, superadmin: true });
    const body = { profileId: 'payment-stripe', dryRun: false };
    await purge(root.token, body, {}).expect(403);
    await purge(root.token, body, { Origin: 'https://evil.invalid' }).expect(403);
    await purge(root.token, body, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }).expect(403);
    await purge(root.token, body, { Origin: `${origin}.evil.invalid` }).expect(403);
    expect(await revisions()).toEqual([3, 2, 1]); expect(await audit()).toEqual([]);
    // Reading the inventory is not a state change and needs no Origin.
    expect((await get(root.token).expect(200)).headers['cache-control']).toBe('private, no-store');
  });

  it('validates the body strictly: unknown keys, bad types, unknown profiles and bad revision lists change nothing', async () => {
    await seed(); const root = await user('root', { permission: true, superadmin: true });
    const bad: unknown[] = [{}, { profileId: 5 }, { profileId: 'payment-stripe', extra: true }, { profileId: 'payment-stripe', dryRun: 'false' }, { profileId: 'payment-stripe', dryRun: 0 },
      { profileId: 'payment-stripe', revisions: [] }, { profileId: 'payment-stripe', revisions: [0] }, { profileId: 'payment-stripe', revisions: [-1] }, { profileId: 'payment-stripe', revisions: [1.5] },
      { profileId: 'payment-stripe', revisions: ['1'] }, { profileId: 'payment-stripe', revisions: 1 }, { profileId: 'payment-stripe', revisions: Array.from({ length: 1001 }, (_v, i) => i + 1) },
      [], 'payment-stripe', null];
    for (const body of bad) await purge(root.token, body).expect(400);
    await purge(root.token, { profileId: 'account-email', dryRun: false }).expect(404);
    await purge(root.token, { profileId: '__proto__', dryRun: false }).expect(404);
    expect(await revisions()).toEqual([3, 2, 1]); expect(await audit()).toEqual([]);
  });

  it('defaults to a dry run, selects only revisions past retention that nothing needs, and deletes nothing', async () => {
    const unfinished = await seed(); const root = await user('root', { permission: true, superadmin: true });
    const held = await purge(root.token, { profileId: 'payment-stripe' }).expect(200);
    expect(held.body).toMatchObject({ profileId: 'payment-stripe', dryRun: true, deleted: [], selected: [], retainedRevisions: 3 });
    await finish(unfinished.id);
    for (const body of [{ profileId: 'payment-stripe' }, { profileId: 'payment-stripe', dryRun: true }, { profileId: 'payment-stripe', dryRun: true, revisions: [1] }]) {
      const dry = await purge(root.token, body).expect(200);
      expect(dry.body).toMatchObject({ dryRun: true, deleted: [] });
      expect(dry.body.selected).toEqual(body.revisions ?? [1, 2]);
    }
    expect(await revisions()).toEqual([3, 2, 1]);
    // The current revision is never selected, however old.
    await age(900);
    expect((await purge(root.token, { profileId: 'payment-stripe' }).expect(200)).body.selected).toEqual([1, 2]);
    const inventory = (await get(root.token).expect(200)).body;
    expect(inventory.retentionDays).toBeGreaterThanOrEqual(400);
    expect(inventory.profiles.find((profile: { profileId: string }) => profile.profileId === 'payment-stripe').revisions
      .find((row: { revision: number }) => row.revision === 3)).toMatchObject({ current: true, purgeable: false, holds: ['current'] });
    expect((await audit()).map(row => row.action)).toEqual(['purge-dry-run', 'purge-dry-run', 'purge-dry-run', 'purge-dry-run', 'purge-dry-run']);
  });

  it('refuses held or current revisions with 409 PAYMENT_REVISION_HELD naming them, deleting nothing even for the purgeable ones requested alongside', async () => {
    const unfinished = await seed(); const root = await user('root', { permission: true, superadmin: true });
    const refused = await purge(root.token, { profileId: 'payment-stripe', dryRun: false, revisions: [1, 2, 3] }).expect(409);
    expect(refused.body.code ?? refused.body.message?.code ?? JSON.stringify(refused.body)).toContain('PAYMENT_REVISION_HELD');
    expect(await revisions()).toEqual([3, 2, 1]);
    await finish(unfinished.id);
    // Now 1 and 2 are purgeable, but a request that also names the current revision (or one that is not retained) is refused whole.
    for (const revisionsRequested of [[1, 3], [1, 99], [2, 3, 99]]) {
      await purge(root.token, { profileId: 'payment-stripe', dryRun: false, revisions: revisionsRequested }).expect(409);
      expect(await revisions()).toEqual([3, 2, 1]);
    }
    await purge(root.token, { profileId: 'payment-stripe', dryRun: true, revisions: [3] }).expect(409);
    const log = await audit();
    expect(log.filter(row => row.action === 'purge-refused').length).toBe(5);
    expect(log.filter(row => row.action === 'purge-refused').every(row => row.status === 'FAILED' && row.userId === root.id)).toBe(true);
    expect(log.some(row => row.action === 'purge')).toBe(false);
  });

  // 409 PAYMENT_REVISION_HELD carries the refused revisions under `result.details` (HttpExceptionFilter's client-safe details).
  it('the 409 response names the refused revisions and their hold reasons', async () => {
    await seed(); const root = await user('root', { permission: true, superadmin: true });
    const refused = await purge(root.token, { profileId: 'payment-stripe', dryRun: false, revisions: [1, 3] }).expect(409);
    const detail = refused.body.result?.details?.refused;
    expect(refused.body).toMatchObject({ code: 'PAYMENT_REVISION_HELD', result: { reason: 'PAYMENT_REVISION_HELD' } });
    expect(detail).toEqual([{ revision: 1, holds: ['unfinished-order'] }, { revision: 3, holds: ['current'] }]);
  });

  it('purges explicitly requested revisions once, audits actor and outcome, and the response and audit hold no secret', async () => {
    const unfinished = await seed(); const root = await user('root', { permission: true, superadmin: true });
    await finish(unfinished.id);
    const done = await purge(root.token, { profileId: 'payment-stripe', dryRun: false, revisions: [1, 1] }).expect(200);
    expect(done.body).toMatchObject({ dryRun: false, deleted: [1], retainedRevisions: 2 });
    expect(await revisions()).toEqual([3, 2]);
    expect(await settings.environmentAt('payment-stripe', 1)).toBeUndefined();
    // A repeated purge of the same revision is refused as not retained, not silently accepted.
    await purge(root.token, { profileId: 'payment-stripe', dryRun: false, revisions: [1] }).expect(409);
    const all = await purge(root.token, { profileId: 'payment-stripe', dryRun: false }).expect(200);
    expect(all.body).toMatchObject({ deleted: [2], retainedRevisions: 1 });
    expect(await revisions()).toEqual([3]);
    const log = await audit();
    expect(log.map(row => [row.action, row.status])).toEqual([['purge', 'SUCCESS'], ['purge-refused', 'FAILED'], ['purge', 'SUCCESS']]);
    expect(log.every(row => row.userId === root.id)).toBe(true);
    expect(log[0].metadata).toMatchObject({ dryRun: false, requested: [1], deleted: [1] });
    const inventory = JSON.stringify((await get(root.token).expect(200)).body);
    for (const text of [JSON.stringify(log), JSON.stringify(done.body), JSON.stringify(all.body), inventory]) for (const secret of SENTINELS) expect(text).not.toContain(secret);
    // The current revision still serves new orders after the purge.
    expect((await order()).id).toBeTruthy();
  });

  it('rate-limits the purge endpoints per user', async () => {
    await seed(); const root = await user('limited', { permission: true, superadmin: true }), other = await user('unlimited', { permission: true, superadmin: true });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < RATE_POINTS + 4; attempt++) statuses.push((await purge(root.token, { profileId: 'payment-stripe' })).status);
    expect(statuses.slice(0, RATE_POINTS).every(status => status === 200)).toBe(true);
    expect(statuses.slice(RATE_POINTS)).toEqual([429, 429, 429, 429]);
    // The budget is per user: another superadmin is unaffected, and the limited one cannot read either.
    await get(other.token).expect(200); await get(root.token).expect(429);
    expect(await revisions()).toEqual([3, 2, 1]);
  });

  describe('when an archived revision cannot be decrypted', () => {
    const wrongKey = () => {
      const bad = new ConnectionSettingsService(database, { ...baseEnv, CONFIG_ENCRYPTION_KEY: 'synthetic-another-encryption-key-never-used-to-save' });
      return { ...build(bad), settings: bad };
    };

    it('purge and inventory answer 503 and delete nothing; a held revision is never missed', async () => {
      await seed();
      const broken = wrongKey(); const retention = new PaymentCredentialRetention(database, broken.billing, broken.settings);
      const second = await startApp(retention);
      try {
        const root = await user('root', { permission: true, superadmin: true });
        const send = (path: string, body?: object) => body
          ? request(second.getHttpServer()).post(`/api${path}`).set('Authorization', `Bearer ${root.token}`).set('Origin', origin).send(body)
          : request(second.getHttpServer()).get(`/api${path}`).set('Authorization', `Bearer ${root.token}`);
        const refused = [await send('/management/payment-credentials/revisions'),
          await send('/management/payment-credentials/purge', { profileId: 'payment-stripe', dryRun: false }),
          await send('/management/payment-credentials/purge', { profileId: 'payment-stripe', dryRun: false, revisions: [1] })];
        expect(refused.map(response => response.status)).toEqual([503, 503, 503]);
        for (const response of refused) for (const secret of [...SENTINELS, 'synthetic-another']) expect(JSON.stringify(response.body)).not.toContain(secret);
      } finally { await second.close(); }
      expect(await revisions()).toEqual([3, 2, 1]);
      expect((await audit()).some(row => row.action === 'purge')).toBe(false);
    });

    it('old orders fail with 503 (not a forged-revision verdict) and nothing is settled or called; it recovers with the right key', async () => {
      await save(0, 'purge-a', 'sk_test_A1', 'whsec_A1');
      const created = await order(); const { checkoutId } = (await rows<{ checkoutId: string }>(`SELECT "checkoutId" FROM "${schema}"."billing_orders" WHERE id = $1`, [created.id]))[0];
      await save(1, 'purge-b', 'sk_test_B1', 'whsec_B1');
      ledgers.get('purge-a')!.pay(checkoutId);
      const broken = wrongKey();
      // The current revision's secrets cannot be read either: new orders and webhooks fail closed.
      await expect(broken.billing.confirm(created.id, ownerId)).rejects.toMatchObject({ status: 503 });
      await expect(broken.billing.webhook('stripe', { rawBody: '{}', headers: {} })).rejects.toMatchObject({ status: 503 });
      expect((await rows(`SELECT 1 FROM "${schema}"."billing_orders" WHERE id = $1 AND "fulfilledAt" IS NULL`, [created.id])).length).toBe(1);
      // Not cached: the correct key serves the same order immediately.
      await billing.confirm(created.id, ownerId);
      expect((await rows(`SELECT 1 FROM "${schema}"."billing_orders" WHERE id = $1 AND "fulfilledAt" IS NOT NULL`, [created.id])).length).toBe(1);
    });
  });
});
