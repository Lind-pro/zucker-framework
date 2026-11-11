import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { PolicyService, POLICY_SCOPE } from '../src/policy/policy.service';
import { definePolicy } from '../src/policy/policy.registry';

/**
 * Smoke contract of the policy store (WP 0.1). The full precedence/concurrency/audit-rollback suite
 * is written separately; this file only proves the HTTP + PostgreSQL path end to end.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_policy_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters',
  POLICY_SYNTHETIC_PINNED_LIMIT: '7', POLICY_PRECEDENCE_PINNED: '9', POLICY_LEAK_HIDDEN: 'SENTINEL-POLICY-PRIVATE-PIN',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt', STRIPE_SECRET_KEY: 'SENTINEL-STRIPE-SECRET', FILES_S3_SECRET_ACCESS_KEY: 'SENTINEL-STORAGE-SECRET' };
const SECRET_SENTINELS = [env.JWT_SECRET!, env.CONFIG_ENCRYPTION_KEY!, env.STRIPE_SECRET_KEY!, env.FILES_S3_SECRET_ACCESS_KEY!];
const PRECEDENCE = definePolicy({ id: 'precedence', fields: [
  { key: 'pinned', type: 'number', default: 1, integer: true, public: true },
  { key: 'saved', type: 'number', default: 2, integer: true, public: true },
  { key: 'plain', type: 'text', default: 'dflt', public: true },
] });
const RACE = definePolicy({ id: 'race', fields: [{ key: 'n', type: 'number', default: 0, integer: true, public: true }] });
const AUDITED = definePolicy({ id: 'audited', fields: [{ key: 'v', type: 'number', default: 0, integer: true }] });
const CROSS = definePolicy({ id: 'cross', fields: [{ key: 'lo', type: 'number', default: 1 }, { key: 'hi', type: 'number', default: 5 }],
  validate(values) { if ((values.lo as number) > (values.hi as number)) throw new Error('lo must not exceed hi'); } });
const LEAK = definePolicy({ id: 'leak', fields: [
  { key: 'banner', type: 'text', default: 'hello', public: true },
  { key: 'note', type: 'text', default: 'SENTINEL-POLICY-PRIVATE-DEFAULT' },
  { key: 'hidden', type: 'text', default: 'x' },
  { key: 'blob', type: 'json', default: { k: 'v' } },
] });
const PRIVATE_ONLY = definePolicy({ id: 'privateonly', fields: [{ key: 'x', type: 'number', default: 1 }] });
const SYNTHETIC = definePolicy({ id: 'synthetic', name: 'Synthetic', fields: [
  { key: 'signUpOpen', type: 'boolean', default: true, public: true },
  { key: 'welcomeCredits', type: 'number', default: 0, integer: true, min: 0, max: 1000 },
  { key: 'pinnedLimit', type: 'number', default: 1, integer: true, min: 0, max: 10 },
  { key: 'tier', type: 'select', default: 'free', options: ['free', 'pro'], public: true },
] });

run('policy store PostgreSQL and HTTP contract', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase;
  let admin: { id: string; token: string }, reader: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const put = (body: object, token = admin.token) => request(app.getHttpServer()).put('/api/management/policies/synthetic').set('Authorization', `Bearer ${token}`).set('Origin', origin).send(body);
  async function account(username: string, permissions: string[]) {
    const email = `${username}@example.invalid`, password = 'SyntheticPolicy9!';
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
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const limits = { points: 3000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [SYNTHETIC, PRECEDENCE, RACE, AUDITED, CROSS, LEAK, PRIVATE_ONLY] }), AccountModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    for (const id of ['config:query', 'config:update']) await database.model('permissions').create({ data: { id, name: id } });
    admin = await account('policyadmin', ['config:query', 'config:update']); reader = await account('policyreader', ['config:query']);
  });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('saves with CAS and audit, applies on the next read, pins from the environment and projects only public fields', async () => {
    const policies = app.get(PolicyService);
    expect(await policies.get('synthetic')).toEqual({ signUpOpen: true, welcomeCredits: 0, pinnedLimit: 7, tier: 'free' });
    const view = await request(app.getHttpServer()).get('/api/management/policies/synthetic').set('Authorization', `Bearer ${reader.token}`).expect(200);
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.body).toMatchObject({ revision: 0, applyMode: 'hot' });
    expect(view.body.fields.find((row: { key: string }) => row.key === 'pinnedLimit')).toMatchObject({ value: 7, source: 'environment', pinnedByEnvironment: true });

    await put({ expectedRevision: 0, values: { welcomeCredits: 5 } }, reader.token).expect(403);
    await put({ expectedRevision: 0, values: { welcomeCredits: 5 } }).set('Origin', 'https://foreign.invalid').expect(403);
    for (const body of [{ expectedRevision: 0, values: { unknown: 1 } }, { expectedRevision: 0, values: { pinnedLimit: 3 } },
      { expectedRevision: 0, values: { welcomeCredits: 5000 } }, { expectedRevision: 0, values: { tier: 'enterprise' } }, { expectedRevision: 0, values: {}, extra: 1 }])
      await put(body).expect(400);

    const saved = await put({ expectedRevision: 0, values: { welcomeCredits: 5, signUpOpen: false, tier: 'pro' } }).expect(200);
    expect(saved.body.revision).toBe(1);
    await put({ expectedRevision: 0, values: { welcomeCredits: 6 } }).expect(409);
    expect(await policies.get('synthetic')).toEqual({ signUpOpen: false, welcomeCredits: 5, pinnedLimit: 7, tier: 'pro' });

    const audit = await database.model('operationLogs').findMany({ where: { module: 'policy' } }) as Array<{ metadata: unknown; userId: string }>;
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ userId: admin.id, metadata: { revision: 1, changedFields: ['signUpOpen', 'tier', 'welcomeCredits'] } });

    const publicConfig = await request(app.getHttpServer()).get('/api/site/public/config').expect(200);
    expect(publicConfig.body.policies.synthetic).toEqual({ revision: 1, values: { signUpOpen: false, tier: 'pro' } });

    await put({ expectedRevision: 1, values: { welcomeCredits: null } }).expect(200);
    expect((await policies.get('synthetic')).welcomeCredits).toBe(0);
  });
  const api = (method: 'get' | 'put', path: string, token?: string) => { const r = request(app.getHttpServer())[method](`/api${path}`); return token ? r.set('Authorization', `Bearer ${token}`) : r; };
  const save = (id: string, body: object, token = admin.token) => api('put', `/management/policies/${id}`, token).set('Origin', origin).send(body);
  const auditRows = (id: string) => database.model('operationLogs').findMany({ where: { module: 'policy', targetId: id } }) as Promise<Array<{ metadata: { revision: number; changedFields: string[] }; status: string; userId: string }>>;

  it('resolves env pin > saved > default per field, reports the source, and null resets to the default', async () => {
    const policies = app.get(PolicyService);
    expect(await policies.get(PRECEDENCE)).toEqual({ pinned: 9, saved: 2, plain: 'dflt' });
    const first = await save('precedence', { expectedRevision: 0, values: { saved: 20, plain: 'mine' } }).expect(200);
    const source = (body: { fields: Array<{ key: string; source: string }> }, key: string) => body.fields.find(row => row.key === key)!.source;
    expect(source(first.body, 'pinned')).toBe('environment'); expect(source(first.body, 'saved')).toBe('saved'); expect(source(first.body, 'plain')).toBe('saved');
    expect(await policies.get(PRECEDENCE)).toEqual({ pinned: 9, saved: 20, plain: 'mine' });
    // A pinned field cannot be saved, not even to its current value, and the failed request changes nothing.
    await save('precedence', { expectedRevision: 1, values: { pinned: 9 } }).expect(400);
    await save('precedence', { expectedRevision: 1, values: { pinned: null } }).expect(400);
    expect((await api('get', '/management/policies/precedence', admin.token).expect(200)).body.revision).toBe(1);
    const reset = await save('precedence', { expectedRevision: 1, values: { saved: null } }).expect(200);
    expect(reset.body.revision).toBe(2); expect(source(reset.body, 'saved')).toBe('default');
    expect(await policies.get(PRECEDENCE)).toEqual({ pinned: 9, saved: 2, plain: 'mine' });
    // Resetting an already-default field is a no-op: no revision bump and no audit row.
    const noop = await save('precedence', { expectedRevision: 2, values: { saved: null } }).expect(200);
    expect(noop.body.revision).toBe(2);
    const rows = await auditRows('precedence'); expect(rows.map(row => row.metadata.revision)).toEqual([1, 2]);
    expect(rows[1]!.metadata.changedFields).toEqual(['saved']);
    // Values are frozen for consumers.
    expect(Object.isFrozen(await policies.get(PRECEDENCE))).toBe(true);
  });

  it('rejects stale and malformed updates and leaves the stored revision untouched', async () => {
    await save('race', { expectedRevision: 5, values: { n: 1 } }).expect(409);
    for (const body of [{ values: { n: 1 } }, { expectedRevision: -1, values: {} }, { expectedRevision: 0.5, values: {} }, { expectedRevision: '0', values: {} },
      { expectedRevision: 0, values: [] }, { expectedRevision: 0, values: { n: 'x' } }, { expectedRevision: 0, values: { n: 1.5 } }, { expectedRevision: 0, values: { n: null, unknown: 1 } }, 'text'])
      await save('race', body as object).expect(400);
    await save('nonexistent', { expectedRevision: 0, values: {} }).expect(404);
    await api('get', '/management/policies/nonexistent', admin.token).expect(404);
    expect((await api('get', '/management/policies/race', admin.token).expect(200)).body.revision).toBe(0);
  });

  it('lets exactly one of 10 concurrent saves at the same revision win', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => save('race', { expectedRevision: 0, values: { n: index + 1 } })));
    const statuses = results.map(row => row.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    const winner = results.find(row => row.status === 200)!;
    expect(winner.body.revision).toBe(1);
    const stored = await api('get', '/management/policies/race', admin.token).expect(200);
    expect(stored.body.revision).toBe(1); expect(stored.body.fields[0].value).toBe(winner.body.fields[0].value);
    expect(await app.get(PolicyService).get(RACE)).toEqual({ n: winner.body.fields[0].value });
    const rows = await auditRows('race'); expect(rows).toHaveLength(1); expect(rows[0]!.metadata.revision).toBe(1);
    // Sequential chain afterwards: each save must present the latest revision.
    for (let revision = 1; revision <= 3; revision++) await save('race', { expectedRevision: revision, values: { n: 100 + revision } }).expect(200);
    await save('race', { expectedRevision: 3, values: { n: 1 } }).expect(409);
  });

  it('rolls the policy value back when the same-transaction audit insert fails', async () => {
    const qualified = `"${schema}"`;
    await pool.query(`CREATE FUNCTION ${qualified}.zf_fail_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
    await pool.query(`CREATE TRIGGER zf_fail_policy_audit BEFORE INSERT ON ${qualified}.operation_logs FOR EACH ROW WHEN (NEW."targetId" = 'audited') EXECUTE FUNCTION ${qualified}.zf_fail_policy_audit()`);
    try {
      const failed = await save('audited', { expectedRevision: 0, values: { v: 5 } });
      expect(failed.status).toBe(503); expect(JSON.stringify(failed.body)).not.toContain('synthetic audit failure');
      const view = await api('get', '/management/policies/audited', admin.token).expect(200);
      expect(view.body.revision).toBe(0); expect(view.body.fields[0]).toMatchObject({ value: 0, source: 'default' });
      expect(await app.get(PolicyService).get(AUDITED)).toEqual({ v: 0 });
      expect(await auditRows('audited')).toHaveLength(0);
      const stored = await pool.query(`SELECT count(*)::int AS n FROM ${qualified}.config_properties p JOIN ${qualified}.config_scopes c ON c.id = p."scopeId" WHERE c.name = $1 AND p.key = $2`, [POLICY_SCOPE, 'audited']);
      expect(stored.rows[0].n).toBe(0);
    } finally { await pool.query(`DROP TRIGGER zf_fail_policy_audit ON ${qualified}.operation_logs`); }
    // The failed attempt left no lock or half-written revision behind: the same save now succeeds as revision 1.
    const retry = await save('audited', { expectedRevision: 0, values: { v: 5 } }).expect(200);
    expect(retry.body.revision).toBe(1); expect(await auditRows('audited')).toHaveLength(1);
  });

  it('runs the cross-field validate() on the merged values and rejects without audit or revision change', async () => {
    const bad = await save('cross', { expectedRevision: 0, values: { lo: 9 } }).expect(400);
    expect(JSON.stringify(bad.body)).toContain('lo must not exceed hi');
    await save('cross', { expectedRevision: 0, values: { lo: 9, hi: 10 } }).expect(200);
    await save('cross', { expectedRevision: 1, values: { hi: 3 } }).expect(400);
    expect((await api('get', '/management/policies/cross', admin.token)).body.revision).toBe(1);
    expect(await auditRows('cross')).toHaveLength(1);
  });

  it('caches reads for the TTL, invalidates the saving instance at once and bounds a second instance by the TTL', async () => {
    const first = app.get(PolicyService), second = new PolicyService(database, [SYNTHETIC, PRECEDENCE, RACE, AUDITED, CROSS, LEAK, PRIVATE_ONLY], env, { cacheTtlMs: 300 });
    const stable = new PolicyService(database, [RACE], env, { cacheTtlMs: 3_600_000 });
    const current = (await first.get(RACE)).n as number, revision = (await api('get', '/management/policies/race', admin.token)).body.revision as number;
    expect(await second.get(RACE)).toEqual({ n: current }); expect(await stable.get(RACE)).toEqual({ n: current });
    await save('race', { expectedRevision: revision, values: { n: 777 } }).expect(200);
    // Saving instance: visible on the very next read (invalidated on commit).
    expect(await first.get(RACE)).toEqual({ n: 777 });
    // Other instance: stale inside the TTL, fresh after it. A long-TTL instance stays stale (documented per-process cache).
    expect(await second.get(RACE)).toEqual({ n: current }); expect(await stable.get(RACE)).toEqual({ n: current });
    await sleep(400);
    expect(await second.get(RACE)).toEqual({ n: 777 }); expect(await stable.get(RACE)).toEqual({ n: current });
    // Concurrent readers share one in-flight load.
    const [a, b] = await Promise.all([second.get(RACE), second.get(RACE)]); expect(a).toBe(b);
    // The admin list/view bypass the cache, so an editor always sees the current revision.
    expect((await stable.view('race')).revision).toBe(revision + 1);
    expect((await stable.list()).policies.find(row => row.id === 'race')!.revision).toBe(revision + 1);
  });

  it('keeps viewers and members out: 403 on PUT for config:query only, 403/401 on reads without the permission', async () => {
    const member = await account('policymember', []);
    await save('race', { expectedRevision: 0, values: { n: 1 } }, reader.token).expect(403);
    await save('race', { expectedRevision: 0, values: { n: 1 } }, member.token).expect(403);
    await api('put', '/management/policies/race').set('Origin', origin).send({ expectedRevision: 0, values: {} }).expect(401);
    await api('get', '/management/policies', member.token).expect(403);
    await api('get', '/management/policies/race', member.token).expect(403);
    await api('get', '/management/policies').expect(401);
    await api('get', '/management/policies/race').expect(401);
    await api('get', '/management/policies', reader.token).expect(200);
  });

  it('requires a trusted Origin on PUT', async () => {
    const body = { expectedRevision: 0, values: { n: 1 } }, put = () => api('put', '/management/policies/race', admin.token).send(body);
    await put().expect(403); // missing Origin
    await put().set('Origin', 'https://foreign.invalid').expect(403);
    await put().set('Origin', 'null').expect(403);
    await put().set('Origin', `${origin}.evil.invalid`).expect(403);
    await put().set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').expect(403);
    // A trusted origin passes the check and reaches the CAS (stale revision => 409, not 403).
    await put().set('Origin', origin).set('Sec-Fetch-Site', 'same-site').expect(409);
    await put().set('Origin', 'http://localhost:4201').expect(409);
    // Reads need no Origin and carry the no-store header.
    const read = await api('get', '/management/policies/race', admin.token).expect(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
  });

  it('projects only public fields (and only policies that have any) on /site/public/config', async () => {
    await save('leak', { expectedRevision: 0, values: { banner: 'welcome', note: 'SENTINEL-POLICY-PRIVATE-SAVED', blob: { token: 'SENTINEL-POLICY-PRIVATE-BLOB' } } }).expect(200);
    for (const query of ['', '?policy=leak', '?fields=note,blob,hidden', '?includePrivate=true']) {
      const response = await api('get', `/site/public/config${query}`).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.policies.leak).toEqual({ revision: 1, values: { banner: 'welcome' } });
      expect(response.body.policies).not.toHaveProperty('privateonly'); expect(response.body.policies).not.toHaveProperty('audited');
      expect(response.body.policies.precedence.values).toEqual({ pinned: 9, saved: 2, plain: 'mine' });
      const text = JSON.stringify(response.body);
      for (const forbidden of ['SENTINEL-POLICY-PRIVATE', 'note', 'hidden', 'blob', 'token']) expect(text).not.toContain(forbidden);
    }
    // Public config is unauthenticated, and a token does not widen it.
    const withToken = await api('get', '/site/public/config', admin.token).expect(200);
    expect(withToken.body.policies.leak.values).toEqual({ banner: 'welcome' });
    // The administrator view does show private values and which of them come from the environment.
    const view = await api('get', '/management/policies/leak', admin.token).expect(200);
    expect(view.body.fields.find((row: { key: string }) => row.key === 'hidden')).toMatchObject({ value: 'SENTINEL-POLICY-PRIVATE-PIN', pinnedByEnvironment: true, public: false });
  });

  it('never leaks environment or connection secrets through /management/policies or /site/public/*', async () => {
    const responses = [await api('get', '/management/policies', admin.token).expect(200), await api('get', '/management/policies/synthetic', admin.token).expect(200),
      await api('get', '/management/policies/leak', admin.token).expect(200), await api('get', '/site/public/config').expect(200),
      await api('get', '/site/public/integrations').expect(200)];
    // A saved connection-profile secret must stay out of every policy/public surface as well.
    const connection = await api('put', '/management/connection-settings/web-analytics', admin.token).set('Origin', origin)
      .send({ expectedRevision: 0, values: { SITE_ANALYTICS_ENABLED: 'true', CLARITY_PROJECT_ID: 'SENTINEL-CLARITY-DISABLED-PRIVATE' } });
    expect(connection.status).toBe(200);
    responses.push(await api('get', '/management/policies', admin.token).expect(200), await api('get', '/site/public/config').expect(200), await api('get', '/site/public/integrations').expect(200));
    for (const response of responses) {
      const text = JSON.stringify(response.body) + JSON.stringify(response.headers);
      for (const sentinel of [...SECRET_SENTINELS, 'SENTINEL-CLARITY-DISABLED-PRIVATE']) expect(text).not.toContain(sentinel);
    }
    // Policy definitions have no secret type, so the list response has none either.
    const list = (await api('get', '/management/policies', admin.token)).body;
    expect(list.externalRequests).toBe(false);
    for (const policy of list.policies) for (const field of policy.fields) expect(field.type).not.toBe('secret');
  });

  it('applies a hot web-analytics profile save to /site/public/integrations without a restart, and again when changed back', async () => {
    const integrations = () => api('get', '/site/public/integrations').expect(200);
    const putAnalytics = (expectedRevision: number, values: object) => api('put', '/management/connection-settings/web-analytics', admin.token).set('Origin', origin).send({ expectedRevision, values });
    const before = (await integrations()).body.revisions.analytics as number;
    const on = await putAnalytics(before, { SITE_ANALYTICS_ENABLED: 'true', PLAUSIBLE_ENABLED: 'true', PLAUSIBLE_SCRIPT_URL: '/analytics/hot.js' }).expect(200);
    expect(on.body).toMatchObject({ applyMode: 'hot', appliesOn: 'next-request', pendingRestart: false });
    const live = await integrations();
    expect(live.body.analytics).toMatchObject({ enabled: true, plausible: { enabled: true, scriptUrl: '/analytics/hot.js' } });
    expect(live.body.revisions.analytics).toBe(before + 1);
    await putAnalytics(before + 1, { SITE_ANALYTICS_ENABLED: 'false' }).expect(200);
    expect((await integrations()).body.analytics).toEqual({ enabled: false });
    const listed = await api('get', '/management/connection-settings', admin.token).expect(200);
    expect(listed.body.profiles.find((row: { id: string }) => row.id === 'web-analytics')).toMatchObject({ applyMode: 'hot', pendingRestart: false });
    // Public site profiles and (since WP 4.1b) sign-in, mail, AI and storage profiles are hot.
    expect(listed.body.profiles.filter((row: { applyMode: string }) => row.applyMode === 'hot').map((row: { id: string }) => row.id))
      .toEqual(expect.arrayContaining(['web-analytics', 'web-connections', 'identity-google', 'identity-github', 'account-email', 'durable-email', 'private-files', 'ai-openai']));
  });
});
