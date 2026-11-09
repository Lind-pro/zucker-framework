import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule, CONFIG_CHANGED_EVENT } from '@zucker-framework/config';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { BillingModule } from '../src/billing/billing.module';
import { BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_SETTINGS, type OAuthSettings } from '../src/oauth/oauth.config';
import { DeliveryModule } from '../src/delivery/delivery.module';
import { DELIVERY_OPTIONS, type DeliveryOptions } from '../src/delivery/delivery.config';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';
import { RUNTIME_ENVIRONMENT, RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_connection_settings_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const key = 'synthetic-config-encryption-key-which-is-never-a-jwt', secret = 'SYNTHETIC-CONNECTION-PRIVATE-REPLACEMENT';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: key, JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters',
  CREEM_API_KEY: 'SYNTHETIC-CONNECTION-ENV-KEY', CREEM_WEBHOOK_SECRET: 'SYNTHETIC-CONNECTION-ENV-WEBHOOK', BILLING_CREEM_ENABLED: 'false',
  STRIPE_SECRET_KEY: 'SYNTHETIC-PRIVATE-STRIPE-SENTINEL', FILES_S3_SECRET_ACCESS_KEY: 'SYNTHETIC-PRIVATE-STORAGE-SENTINEL',
  GOOGLE_CLIENT_ID: 'synthetic-google-env-id', GOOGLE_CLIENT_SECRET: 'SYNTHETIC-GOOGLE-ENV-KEY', GOOGLE_OAUTH_ENABLED: 'false', FILES_STORAGE_PROVIDER: 'local' };
run('encrypted connection settings PostgreSQL and administrator HTTP contracts', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService, scopedUrl: string;
  let admin: { id: string; token: string }, reader: { id: string; token: string }, member: { id: string; token: string };
  const deliveries = new Map<string, string>(), events: unknown[] = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const get = (id = '', token = admin.token) => request(app.getHttpServer()).get(`/api/management/connection-settings${id ? `/${id}` : ''}`).set('Authorization', `Bearer ${token}`);
  const put = (id: string, body: object, token = admin.token) => request(app.getHttpServer()).put(`/api/management/connection-settings/${id}`).set('Authorization', `Bearer ${token}`).set('Origin', origin).send(body);
  const creem = (value = secret, expectedRevision = 0) => ({ expectedRevision, values: { BILLING_CREEM_ENABLED: 'true', BILLING_CREEM_MODE: 'test', BILLING_CREEM_ACCOUNT_SCOPE: 'synthetic-account' },
    secrets: { CREEM_API_KEY: { action: 'replace', value } } });
  const field = (body: { fields: Array<{ key: string }> }, name: string) => body.fields.find(row => row.key === name);
  async function account(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`, password = 'SyntheticSettings9!';
    const action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username, email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: logged.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: logged.body.userId as string, token: logged.body.token as string };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; database = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }), ZuckerConfigModule.forRoot(), ZuckerAdminModule.forRoot({ features: ['config'] }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 3000, duration: 60 }, 'session-refresh': { points: 3000, duration: 60 }, 'session-refresh-network': { points: 3000, duration: 60 }, 'session-read': { points: 3000, duration: 60 }, 'api-default': { points: 3000, duration: 60 } } }), RuntimeSettingsModule, AccountModule, BillingModule, OAuthModule, DeliveryModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    settings = app.get(ConnectionSettingsService); app.get(EventEmitter2).on(CONFIG_CHANGED_EVENT, payload => events.push(payload));
    for (const id of ['config:query', 'config:update']) await database.model('permissions').create({ data: { id, name: id } });
    admin = await account('settingsadmin', ['config:query', 'config:update']); reader = await account('settingsreader', ['config:query']); member = await account('settingsmember');
  });
  beforeEach(async () => {
    await database.transaction(async tx => {
      await tx.query('DELETE FROM config WHERE scope=$1', [CONNECTION_SETTINGS_SCOPE]);
      await tx.query('DELETE FROM config_history WHERE scope=$1', [CONNECTION_SETTINGS_SCOPE]);
      await tx.query("DELETE FROM operation_logs WHERE module='runtime-settings'");
    }); events.length = 0;
  });
  afterAll(async () => { try { await app?.close(); await database?.onModuleDestroy(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });
  it('separates read and write permissions and enforces trusted mutation origins', async () => {
    await request(app.getHttpServer()).get('/api/management/connection-settings').expect(401); await get('', member.token).expect(403);
    const view = await get('', reader.token).expect(200); expect(view.headers['cache-control']).toBe('private, no-store'); expect(view.body.profiles).toHaveLength(16);
    await put('payment-creem', creem(), reader.token).expect(403);
    await put('payment-creem', creem()).set('Origin', 'https://foreign.invalid').expect(403);
    await put('payment-creem', creem()).set('Sec-Fetch-Site', 'cross-site').expect(403);
    expect(await database.model('config').count({ where: { scope: CONNECTION_SETTINGS_SCOPE } })).toBe(0);
  });
  it('rejects identity injection, unknown fields and ambiguous secret edits before storage', async () => {
    const invalid = [{ ...creem(), actorId: member.id }, { ...creem(), profileId: 'payment-stripe' }, { ...creem(), expectedRevision: -1 },
      { expectedRevision: 0, values: { CREEM_API_KEY: secret } }, { expectedRevision: 0, values: { JWT_SECRET: secret } },
      { expectedRevision: 0, values: { BILLING_CREEM_ENABLED: true } }, { expectedRevision: 0, secrets: { CREEM_API_KEY: { action: 'replace', value: '' } } },
      { expectedRevision: 0, secrets: { CREEM_API_KEY: { action: 'clear', value: secret } } }, { expectedRevision: 0, secrets: { CREEM_API_KEY: { action: 'keep', value: secret } } }];
    for (const body of invalid) await put('payment-creem', body).expect(400);
    await put('unknown', creem()).expect(400);
    expect(await database.model('config').count({ where: { scope: CONNECTION_SETTINGS_SCOPE } })).toBe(0);
  });
  it('uses environment fallback without exposing secret values or mutating the startup snapshot', async () => {
    const response = await get('payment-creem').expect(200);
    expect(field(response.body, 'CREEM_API_KEY')).toMatchObject({ type: 'secret', configured: true, source: 'environment' });
    expect(field(response.body, 'CREEM_API_KEY')).not.toHaveProperty('value');
    expect(response.body).toMatchObject({ storedRevision: 0, appliedRevision: 0, pendingRestart: false });
    expect(Object.isFrozen(app.get(RUNTIME_ENVIRONMENT))).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('SYNTHETIC-CONNECTION-ENV');
  });
  it('encrypts whole profiles and commits actor audit without secret history or change events', async () => {
    const response = await put('payment-creem', creem()).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({ storedRevision: 1, appliedRevision: 0, pendingRestart: true, validation: 'local-assembly-only', externalRequests: false });
    const rows = await database.model('config').findMany({ where: { scope: CONNECTION_SETTINGS_SCOPE } }) as Array<{ value: unknown }>;
    expect(rows).toHaveLength(1); expect(rows[0].value).toMatch(/^v2\./);
    const audit = await database.model('operationLogs').findMany({ where: { module: 'runtime-settings' } });
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ userId: admin.id, targetId: 'payment-creem', metadata: { revision: 1, changedFields: expect.arrayContaining(['CREEM_API_KEY']) } });
    const history = await database.model('configHistory').findMany({ where: { scope: CONNECTION_SETTINGS_SCOPE } });
    expect(JSON.stringify([rows, audit, history, response.body, events])).not.toContain(secret); expect(events).toEqual([]);
    expect((await settings.environment()).CREEM_API_KEY).toBe(env.CREEM_API_KEY);
    const restarted = new ConnectionSettingsService(database, env); expect((await restarted.environment()).CREEM_API_KEY).toBe(secret);
    expect(await restarted.get('payment-creem')).toMatchObject({ storedRevision: 1, appliedRevision: 1, pendingRestart: false });
  });
  it('applies saved profiles to the real Billing, OAuth, delivery and account-mail factories only after restart', async () => {
    await put('payment-creem', creem()).expect(200);
    await put('identity-google', { expectedRevision: 0, values: { GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'synthetic-saved-google' } }).expect(200);
    await put('durable-email', { expectedRevision: 0, values: { DELIVERY_PROVIDER: 'smtp', DELIVERY_ACCOUNT_SCOPE: 'synthetic-saved-mail', DELIVERY_FROM: 'sender@example.invalid', DELIVERY_SMTP_HOST: 'smtp.example.invalid', DELIVERY_SMTP_USER: 'synthetic-user' },
      secrets: { DELIVERY_SMTP_PASSWORD: { action: 'replace', value: 'SYNTHETIC-SMTP-PASSWORD' } } }).expect(200);
    await put('account-email', { expectedRevision: 0, values: { SMTP_HOST: 'smtp.example.invalid', SMTP_FROM: 'account@example.invalid' } }).expect(200);
    expect(app.get<BillingOptions>(BILLING_OPTIONS).providers).toHaveLength(0);
    expect(app.get<OAuthSettings>(OAUTH_SETTINGS).google.code).toBe(false);
    expect(app.get<DeliveryOptions>(DELIVERY_OPTIONS).provider).toBeUndefined();
    const restartedDatabase = new ApplicationDatabase(scopedUrl);
    const restarted = await Test.createTestingModule({ imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => restartedDatabase }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 100, duration: 60 }, 'session-refresh': { points: 100, duration: 60 }, 'session-refresh-network': { points: 100, duration: 60 }, 'session-read': { points: 100, duration: 60 }, 'api-default': { points: 100, duration: 60 }, billing: { points: 100, duration: 60 } } }),
      RuntimeSettingsModule, BillingModule, OAuthModule, DeliveryModule, AccountModule] }).overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).compile();
    try {
      expect(restarted.get<BillingOptions>(BILLING_OPTIONS).providers.map(row => row.id)).toEqual(['creem']);
      expect(restarted.get<BillingOptions>(BILLING_OPTIONS).refundProviders?.map(row => row.accountScope)).toEqual(['synthetic-account']);
      expect(restarted.get<OAuthSettings>(OAUTH_SETTINGS).google).toMatchObject({ code: true, clientId: 'synthetic-saved-google' });
      expect(restarted.get<DeliveryOptions>(DELIVERY_OPTIONS)).toMatchObject({ accountScope: 'synthetic-saved-mail' });
      expect(restarted.get<DeliveryOptions>(DELIVERY_OPTIONS).provider?.isConfigured()).toBe(true);
      expect(() => restarted.get<AccountMailer>(ACCOUNT_MAILER).assertConfigured()).not.toThrow();
      expect(await restarted.get(ConnectionSettingsService).get('payment-creem')).toMatchObject({ storedRevision: 1, appliedRevision: 1, pendingRestart: false });
    } finally { await restarted.close(); await restartedDatabase.onModuleDestroy(); }
  });
  it('preserves keep and explicitly clears an environment secret instead of falling back after restart', async () => {
    await put('identity-google', { expectedRevision: 0, values: { GOOGLE_CLIENT_ID: 'saved-client' }, secrets: { GOOGLE_CLIENT_SECRET: { action: 'keep' } } }).expect(200);
    let restarted = new ConnectionSettingsService(database, env); expect((await restarted.environment()).GOOGLE_CLIENT_SECRET).toBe(env.GOOGLE_CLIENT_SECRET);
    await put('identity-google', { expectedRevision: 1, secrets: { GOOGLE_CLIENT_SECRET: { action: 'clear' } } }).expect(200);
    restarted = new ConnectionSettingsService(database, env); expect((await restarted.environment()).GOOGLE_CLIENT_SECRET).toBeUndefined();
    const current = await get('identity-google').expect(200); expect(field(current.body, 'GOOGLE_CLIENT_SECRET')).toMatchObject({ configured: false, source: 'cleared' });
    await put('identity-google', { expectedRevision: 2, values: { GOOGLE_CLIENT_ID: null } }).expect(200);
    expect((await new ConnectionSettingsService(database, env).environment()).GOOGLE_CLIENT_ID).toBeUndefined();
  });
  it('serializes concurrent CAS updates and leaves one revision and actor audit', async () => {
    const results = await Promise.all([put('payment-creem', creem('SYNTHETIC-CONCURRENT-A')), put('payment-creem', creem('SYNTHETIC-CONCURRENT-B'))]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect((await get('payment-creem').expect(200)).body.storedRevision).toBe(1);
    expect(await database.model('operationLogs').count({ where: { module: 'runtime-settings' } })).toBe(1);
  });
  it('rolls back both a new profile and replacement if the required actor audit fails', async () => {
    await pool.query(`ALTER TABLE "${schema}".operation_logs RENAME TO unavailable_operation_logs`);
    try { await put('payment-creem', creem()).expect(503); } finally { await pool.query(`ALTER TABLE "${schema}".unavailable_operation_logs RENAME TO operation_logs`); }
    expect((await get('payment-creem').expect(200)).body.storedRevision).toBe(0);
    await put('payment-creem', creem()).expect(200);
    await pool.query(`ALTER TABLE "${schema}".operation_logs RENAME TO unavailable_operation_logs`);
    try { await put('payment-creem', creem('SYNTHETIC-ROLLBACK-REPLACEMENT', 1)).expect(503); } finally { await pool.query(`ALTER TABLE "${schema}".unavailable_operation_logs RENAME TO operation_logs`); }
    const restarted = new ConnectionSettingsService(database, env); expect((await restarted.environment()).CREEM_API_KEY).toBe(secret);
    expect((await restarted.get('payment-creem')).storedRevision).toBe(1);
  });
  it('refuses missing, short, JWT-reused or wrong encryption keys when ciphertext exists', async () => {
    await put('payment-creem', creem()).expect(200);
    for (const encryption of [undefined, 'short', env.JWT_SECRET, 'synthetic-wrong-long-encryption-key-123456789']) {
      const broken = new ConnectionSettingsService(database, { ...env, CONFIG_ENCRYPTION_KEY: encryption });
      await expect(broken.environment()).rejects.toThrow('Saved connection configuration cannot be read');
      await expect(broken.get('payment-creem')).rejects.toThrow('Saved connection configuration cannot be read');
    }
  });
  it('allows environment-only startup without an encryption key but prevents saving', async () => {
    const unavailable = new ConnectionSettingsService(database, { ...env, CONFIG_ENCRYPTION_KEY: undefined });
    expect((await unavailable.environment()).CREEM_API_KEY).toBe(env.CREEM_API_KEY);
    expect(await unavailable.get('payment-creem')).toMatchObject({ canSave: false, saveUnavailableReason: 'encryption_key_required' });
    await expect(unavailable.save(admin.id, 'payment-creem', creem())).rejects.toThrow('Saved connection configuration cannot be read');
  });
  it('does not expose or mutate protected profiles through the generic system-config endpoint', async () => {
    await put('payment-creem', creem()).expect(200);
    const response = await request(app.getHttpServer()).get('/api/config?scope=runtime.connections').set('Authorization', `Bearer ${admin.token}`).expect(200);
    expect(response.body).toEqual({});
    await request(app.getHttpServer()).put('/api/config').set('Authorization', `Bearer ${admin.token}`).send({ 'payment-creem': 'SYNTHETIC-UNRELATED-SYSTEM-VALUE' }).expect(200);
    expect((await new ConnectionSettingsService(database, env).environment()).CREEM_API_KEY).toBe(secret);
  });
  it('rejects incomplete enabled configurations and never probes a remote provider', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests are forbidden in local validation'));
    try {
      await put('payment-creem', { expectedRevision: 0, values: { BILLING_CREEM_ENABLED: 'true' } }).expect(400);
      await put('identity-github', { expectedRevision: 0, values: { GITHUB_OAUTH_ENABLED: 'true' } }).expect(400);
      await put('account-email', { expectedRevision: 0, values: { SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '0' } }).expect(400);
      await put('private-files', { expectedRevision: 0, values: { FILES_STORAGE_PROVIDER: 's3' } }).expect(400);
      await put('payment-creem', creem()).expect(200); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('serves only default-disabled public connection configuration without authentication or private sentinel values', async () => {
    const result = await request(app.getHttpServer()).get('/api/site/public/integrations?scope=runtime.connections').expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({ analytics: { enabled: false }, connections: { enabled: false }, revisions: { analytics: 0, connections: 0 } });
    expect(JSON.stringify(result.body)).not.toContain('SYNTHETIC-PRIVATE');
    await request(app.getHttpServer()).put('/api/management/connection-settings/web-analytics').set('Origin', origin).send({ expectedRevision: 0 }).expect(401);
  });
  it('saves public profiles through the same protected CAS API and exposes them only after an actual HTTP restart', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External providers must not be called'));
    let restarted: INestApplication | undefined; let restartedDatabase: ApplicationDatabase | undefined;
    try {
      const analytics = await put('web-analytics', { expectedRevision: 0, values: { SITE_ANALYTICS_ENABLED: 'true', GOOGLE_ANALYTICS_ENABLED: 'true', GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-SYNTHETIC123',
        PLAUSIBLE_ENABLED: 'true', PLAUSIBLE_SCRIPT_URL: '/analytics/site.js?installation=synthetic', CLARITY_PROJECT_ID: 'SYNTHETIC-PRIVATE-DISABLED-CLARITY' } }).expect(200);
      expect(analytics.body).toMatchObject({ pendingRestart: true, storedRevision: 1, appliedRevision: 0 });
      await put('web-connections', { expectedRevision: 0, values: { SITE_CONNECTIONS_ENABLED: 'true', ADSENSE_ENABLED: 'true', ADSENSE_PUBLISHER_ID: 'ca-pub-1234567890123456',
        AFFONSO_ENABLED: 'true', AFFONSO_PROGRAM_ID: 'synthetic-program', AFFONSO_COOKIE_DURATION_DAYS: '30', CRISP_WEBSITE_ID: 'SYNTHETIC-PRIVATE-DISABLED-CRISP' } }).expect(200);
      const prior = await request(app.getHttpServer()).get('/api/site/public/integrations').expect(200);
      expect(prior.body).toEqual({ analytics: { enabled: false }, connections: { enabled: false }, revisions: { analytics: 0, connections: 0 } });
      await put('web-analytics', { expectedRevision: 0, values: { SITE_ANALYTICS_ENABLED: 'false' } }).expect(409);
      restartedDatabase = new ApplicationDatabase(scopedUrl);
      const module = await Test.createTestingModule({ imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => restartedDatabase! }),
        ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
        ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 100, duration: 60 }, 'session-refresh': { points: 100, duration: 60 }, 'session-refresh-network': { points: 100, duration: 60 }, 'session-read': { points: 100, duration: 60 }, 'api-default': { points: 1, duration: 60 } } }), RuntimeSettingsModule, AccountModule],
        providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
        .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
      restarted = module.createNestApplication(); restarted.setGlobalPrefix('api'); restarted.useGlobalFilters(new HttpExceptionFilter()); await restarted.listen(0, '127.0.0.1');
      const active = await request(restarted.getHttpServer()).get('/api/site/public/integrations').expect(200);
      expect(active.body).toEqual({ analytics: { enabled: true, google: { enabled: true, measurementId: 'G-SYNTHETIC123' }, clarity: { enabled: false },
        plausible: { enabled: true, scriptUrl: '/analytics/site.js?installation=synthetic' }, openPanel: { enabled: false }, vercel: { enabled: false } },
        connections: { enabled: true, adsense: { enabled: true, publisherId: 'ca-pub-1234567890123456' }, affonso: { enabled: true, programId: 'synthetic-program', cookieDurationDays: 30 },
        promoteKit: { enabled: false }, crisp: { enabled: false }, tawk: { enabled: false } }, revisions: { analytics: 1, connections: 1 } });
      await request(restarted.getHttpServer()).get('/api/site/public/integrations').expect(200);
      expect(JSON.stringify(active.body)).not.toContain('SYNTHETIC-PRIVATE'); expect(JSON.stringify(active.body)).not.toContain(key); expect(fetch).not.toHaveBeenCalled();
      await request(restarted.getHttpServer()).get('/api/management/connection-settings').expect(401);
    } finally { await restarted?.close(); await restartedDatabase?.onModuleDestroy(); fetch.mockRestore(); }
  });
  it('uses public resolvers to reject invalid enabled IDs, script paths and advertising policy while rejecting private fields', async () => {
    await put('web-analytics', { expectedRevision: 0, values: { SITE_ANALYTICS_ENABLED: 'true', GOOGLE_ANALYTICS_ENABLED: 'true', GOOGLE_ANALYTICS_MEASUREMENT_ID: 'private-not-ga4' } }).expect(400);
    await put('web-analytics', { expectedRevision: 0, values: { SITE_ANALYTICS_ENABLED: 'true', PLAUSIBLE_ENABLED: 'true', PLAUSIBLE_SCRIPT_URL: 'javascript:alert(1)' } }).expect(400);
    await put('web-analytics', { expectedRevision: 0, values: { SITE_ANALYTICS_ENABLED: 'true', VERCEL_ANALYTICS_ENABLED: 'true', VERCEL_ANALYTICS_SCRIPT_PATH: 'https://foreign.invalid/script.js' } }).expect(400);
    await put('web-connections', { expectedRevision: 0, values: { SITE_CONNECTIONS_ENABLED: 'true', ADSENSE_ENABLED: 'true', ADSENSE_PUBLISHER_ID: '1234567890123456' } }).expect(400);
    await put('web-connections', { expectedRevision: 0, values: { SITE_CONNECTIONS_ENABLED: 'true', AFFONSO_ENABLED: 'true', AFFONSO_PROGRAM_ID: 'synthetic', AFFONSO_COOKIE_DURATION_DAYS: '366' } }).expect(400);
    await put('web-analytics', { expectedRevision: 0, values: { OPENPANEL_CLIENT_SECRET: secret } }).expect(400);
    await put('web-connections', { expectedRevision: 0, secrets: { CRISP_WEBSITE_ID: { action: 'replace', value: secret } } }).expect(400);
    expect(await database.model('config').count({ where: { scope: CONNECTION_SETTINGS_SCOPE } })).toBe(0);
    const invalid = new ConnectionSettingsService(database, { ...env, SITE_ANALYTICS_ENABLED: 'true', PLAUSIBLE_ENABLED: 'true', PLAUSIBLE_SCRIPT_URL: 'javascript:alert(1)' });
    await expect(invalid.publicIntegrations()).rejects.toThrow('Invalid public analytics configuration');
  });
  it('detects authenticated-profile corruption without falling back to environment values', async () => {
    await put('payment-creem', creem()).expect(200);
    await database.model('config').update({ where: { scope_key: { scope: CONNECTION_SETTINGS_SCOPE, key: 'payment-creem' } }, data: { value: 'corrupt-synthetic-ciphertext' } });
    const response = await get('payment-creem').expect(503); expect(JSON.stringify(response.body)).not.toContain('corrupt-synthetic');
    await expect(new ConnectionSettingsService(database, env).environment()).rejects.toThrow('Saved connection configuration cannot be read');
  });
});
