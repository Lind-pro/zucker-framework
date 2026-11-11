import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { Logger, type INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ConnectionProfileStore, parseConnectionUpdate } from '@zucker-framework/config/connections';
import { SecretCipher } from '@zucker-framework/core';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { BillingModule } from '../src/billing/billing.module';
import { OAuthModule } from '../src/oauth/oauth.module';
import { DeliveryModule } from '../src/delivery/delivery.module';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { CONNECTION_PROFILE_DEFINITIONS } from '../src/runtime-settings/connection-settings.descriptors';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';

// WP 4.1a (Sonnet): secrets never leave the server, archive rows share the live envelope, concurrent
// saves have one winner and one archive row per revision, failed validation writes nothing.
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_conn_archive_sec_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const key = 'synthetic-config-encryption-key-which-is-never-a-jwt';
const ENV_SENTINEL = 'SYNTHETIC-ARCHIVE-ENV-SENTINEL';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: key, JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters',
  CREEM_WEBHOOK_SECRET: `${ENV_SENTINEL}-WEBHOOK`, BILLING_CREEM_ENABLED: 'false', STRIPE_SECRET_KEY: `${ENV_SENTINEL}-STRIPE`, FILES_STORAGE_PROVIDER: 'local' };
const creem = (secret: string, expectedRevision: number, scope = 'synthetic-account') => ({ expectedRevision,
  values: { BILLING_CREEM_ENABLED: 'true', BILLING_CREEM_MODE: 'test', BILLING_CREEM_ACCOUNT_SCOPE: scope }, secrets: { CREEM_API_KEY: { action: 'replace', value: secret } } });
const sentinel = (n: number | string) => `SYNTHETIC-ARCHIVE-SECRET-${n}`;

run('connection archive: secrecy, envelope, concurrency, failed validation (PostgreSQL + HTTP)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService, admin: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const cipher = new SecretCipher({ masterKey: key });
  const get = (id = '') => request(app.getHttpServer()).get(`/api/management/connection-settings${id ? `/${id}` : ''}`).set('Authorization', `Bearer ${admin.token}`);
  const put = (id: string, body: object) => request(app.getHttpServer()).put(`/api/management/connection-settings/${id}`).set('Authorization', `Bearer ${admin.token}`).set('Origin', origin).send(body);
  const archiveRows = async (profileId = 'payment-creem') =>
    (await pool.query(`SELECT "revision", "ciphertext", "createdBy" FROM "${schema}"."connection_profile_revisions" WHERE "profileId" = $1 ORDER BY "revision"`, [profileId])).rows as Array<{ revision: number; ciphertext: string; createdBy: string | null }>;
  const liveRow = async (profileId = 'payment-creem') =>
    (await pool.query(`SELECT "value" FROM "${schema}"."config" WHERE "scope" = $1 AND "key" = $2`, [CONNECTION_SETTINGS_SCOPE, profileId])).rows[0] as { value: string } | undefined;
  const auditCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."operation_logs" WHERE "module" = 'runtime-settings'`)).rows[0].n as number;
  async function account(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticSettings9!';
    const action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username, email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200);
    for (const permission of ['config:query', 'config:update']) await database.model('userPermissions').create({ data: { userId: logged.body.userId, permissionId: permission, grantType: 'grant' } });
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
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }), ZuckerConfigModule.forRoot(), ZuckerAdminModule.forRoot({ features: ['config'] }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 3000, duration: 60 }, 'session-refresh': { points: 3000, duration: 60 }, 'session-refresh-network': { points: 3000, duration: 60 }, 'session-read': { points: 3000, duration: 60 }, 'api-default': { points: 3000, duration: 60 } } }), RuntimeSettingsModule, AccountModule, BillingModule, OAuthModule, DeliveryModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    settings = app.get(ConnectionSettingsService);
    for (const id of ['config:query', 'config:update']) await database.model('permissions').create({ data: { id, name: id } });
    admin = await account('archiveadmin');
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
    await pool.query(`DELETE FROM "${schema}"."operation_logs" WHERE "module" = 'runtime-settings'`);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('never returns a secret, ciphertext or environment value in any HTTP response, log line or error message', async () => {
    const output: string[] = [];
    const capture = (chunk: unknown) => { output.push(String(chunk)); return true; };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never); vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')); });
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')); });
    const bodies: string[] = [];
    const record = (res: request.Response) => { bodies.push(JSON.stringify([res.status, res.headers, res.body, res.text])); return res; };
    const errors: string[] = [];
    // Two saves, so an older archived revision exists.
    record(await put('payment-creem', creem(sentinel(1), 0)).expect(200));
    record(await put('payment-creem', creem(sentinel(2), 1, 'synthetic-account-two')).expect(200));
    record(await get().expect(200)); record(await get('payment-creem').expect(200)); record(await get('payment-stripe').expect(200));
    // Error paths. A stale revision (409), and bodies that put the sentinel where a value is not allowed (400).
    record(await put('payment-creem', creem(sentinel('STALE'), 0)).expect(409));
    record(await put('payment-creem', { expectedRevision: 2, values: { CREEM_API_KEY: sentinel('PLAINTEXT-FIELD') } }).expect(400));
    record(await put('payment-creem', { expectedRevision: 2, values: { JWT_SECRET: sentinel('JWT') } }).expect(400));
    record(await put('payment-creem', { expectedRevision: 2, secrets: { CREEM_API_KEY: { action: 'clear', value: sentinel('CLEAR') } } }).expect(400));
    record(await put('unknown-profile', creem(sentinel('UNKNOWN'), 0)).expect(400));
    // An unreadable archive row (another key) is a 503 with a fixed message.
    await pool.query(`UPDATE "${schema}"."connection_profile_revisions" SET "ciphertext" = $1 WHERE "profileId" = 'payment-creem' AND "revision" = 1`,
      [new SecretCipher({ masterKey: 'another-synthetic-key-of-at-least-32-chars' }).encrypt(JSON.stringify({ revision: 1, values: { CREEM_API_KEY: sentinel('FOREIGN') } }))]);
    const failure = await new ConnectionSettingsService(database, env).environmentAt('payment-creem', 1).catch(caught => caught);
    errors.push(String(failure?.message), String(failure?.stack ?? ''), JSON.stringify(failure));
    const noKey = await new ConnectionSettingsService(database, { ...env, CONFIG_ENCRYPTION_KEY: undefined }).save('synthetic-operator', 'payment-creem', creem(sentinel('NOKEY'), 2)).catch(caught => caught);
    errors.push(String(noKey?.message), String(noKey?.stack ?? ''));
    const rows = await archiveRows(), live = await liveRow();
    const everything = [...bodies, ...output, ...errors].join('\n');
    const secrets = [1, 2, 'STALE', 'PLAINTEXT-FIELD', 'JWT', 'CLEAR', 'UNKNOWN', 'FOREIGN', 'NOKEY'].map(sentinel);
    for (const value of [...secrets, ENV_SENTINEL, live!.value, ...rows.map(row => row.ciphertext), ...rows.map(row => row.ciphertext.slice(0, 24)), live!.value.slice(0, 24)])
      expect(everything, `leaked ${value.slice(0, 30)}`).not.toContain(value);
    expect(everything).not.toMatch(/\bv2\.[A-Za-z0-9_-]{16,}/);
    // The metadata endpoints report only a count of retained revisions.
    expect(JSON.parse(bodies[2])[2].profiles.find((row: { id: string }) => row.id === 'payment-creem')).toMatchObject({ storedRevision: 2, retainedRevisions: 2 });
    expect(JSON.parse(bodies[2])[2].profiles.find((row: { id: string }) => row.id === 'payment-creem')).not.toHaveProperty('revisions');
    // Audit rows carry changed field names only.
    const audit = JSON.stringify((await pool.query(`SELECT * FROM "${schema}"."operation_logs" WHERE "module" = 'runtime-settings'`)).rows);
    for (const value of secrets) expect(audit).not.toContain(value);
  });

  it('encrypts every archive row with the same envelope as the live value and round-trips to the saved values', async () => {
    await put('payment-creem', creem(sentinel('E1'), 0)).expect(200);
    await put('payment-creem', creem(sentinel('E2'), 1, 'synthetic-account-two')).expect(200);
    const rows = await archiveRows(), live = (await liveRow())!;
    expect(rows.map(row => row.revision)).toEqual([1, 2]);
    // The archive table holds no plaintext anywhere.
    const raw = JSON.stringify((await pool.query(`SELECT * FROM "${schema}"."connection_profile_revisions"`)).rows);
    expect(raw).not.toContain('SYNTHETIC'); expect(raw).not.toContain('synthetic-account');
    const lead = (value: string) => value.split('.')[0];
    for (const row of rows) {
      expect(lead(row.ciphertext)).toBe(lead(live.value)); expect(row.ciphertext).toMatch(/^v2\./);
      const payload = JSON.parse(cipher.decrypt(row.ciphertext)) as { revision: number; values: Record<string, string> };
      expect(Object.keys(payload).sort()).toEqual(['revision', 'values']); expect(payload.revision).toBe(row.revision);
      expect(payload.values.CREEM_API_KEY).toBe(sentinel(`E${row.revision}`));
      // A different key cannot read it.
      expect(() => new SecretCipher({ masterKey: 'another-synthetic-key-of-at-least-32-chars' }).decrypt(row.ciphertext)).toThrow();
    }
    // The newest archive row is the live value (same plaintext, distinct nonce so distinct ciphertext).
    expect(JSON.parse(cipher.decrypt(live.value))).toEqual(JSON.parse(cipher.decrypt(rows[1].ciphertext)));
    expect(rows[0].ciphertext).not.toBe(rows[1].ciphertext);
  });

  it('lets exactly one of many concurrent HTTP saves win and writes exactly one archive row per revision', async () => {
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => put('payment-creem', creem(sentinel(`R1-${i}`), 0))));
    const winners = first.filter(res => res.status === 200), losers = first.filter(res => res.status !== 200);
    expect(winners).toHaveLength(1); expect(losers).toHaveLength(9); for (const loser of losers) expect(loser.status).toBe(409);
    expect(await auditCount()).toBe(1);
    let rows = await archiveRows(); expect(rows.map(row => row.revision)).toEqual([1]);
    const winnerIndex = first.indexOf(winners[0]);
    expect((await settings.environmentAt('payment-creem', 1))?.CREEM_API_KEY).toBe(sentinel(`R1-${winnerIndex}`));
    // Second round against revision 1, from two service instances (two replicas) plus HTTP.
    const replicas = [new ConnectionSettingsService(database, env), new ConnectionSettingsService(database, env)];
    const second = await Promise.allSettled([
      ...Array.from({ length: 4 }, (_, i) => replicas[i % 2].save('synthetic-operator', 'payment-creem', creem(sentinel(`R2-${i}`), 1, 'synthetic-account-two'))),
      ...Array.from({ length: 4 }, (_, i) => put('payment-creem', creem(sentinel(`R2-http-${i}`), 1, 'synthetic-account-three')).then(res => { if (res.status !== 200) throw new Error(String(res.status)); return res; })),
    ]);
    expect(second.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    rows = await archiveRows(); expect(rows.map(row => row.revision)).toEqual([1, 2]);
    expect(await auditCount()).toBe(2);
    expect(await settings.currentRevision('payment-creem')).toBe(2);
    expect(JSON.parse(cipher.decrypt((await liveRow())!.value)).revision).toBe(2);
  });

  it('writes nothing when validation fails (live value, archive row, audit)', async () => {
    // Enabling a payment provider without any credential fails local assembly.
    const bare = { expectedRevision: 0, values: { BILLING_CREEM_ENABLED: 'true', BILLING_CREEM_MODE: 'test', BILLING_CREEM_ACCOUNT_SCOPE: 'synthetic-account' } };
    const failed = await put('payment-creem', bare);
    expect(failed.status).toBe(400);
    expect(await liveRow()).toBeUndefined(); expect(await archiveRows()).toHaveLength(0); expect(await auditCount()).toBe(0);
    // Same after a successful first revision: a failing second save leaves revision 1 and one archive row.
    await put('payment-creem', creem(sentinel('V1'), 0)).expect(200);
    const before = (await liveRow())!.value;
    await put('payment-creem', { expectedRevision: 1, values: { BILLING_CREEM_MODE: 'not-a-mode' } }).expect(400);
    await put('payment-creem', { expectedRevision: 1, secrets: { CREEM_API_KEY: { action: 'clear' } } }).then(res => expect([200, 400]).toContain(res.status));
    const cleared = await settings.currentRevision('payment-creem');
    if (cleared === 1) { expect(await archiveRows()).toHaveLength(1); expect((await liveRow())!.value).toBe(before); expect(await auditCount()).toBe(1); }
    // A verify failure at the store level rolls everything back too.
    const definition = CONNECTION_PROFILE_DEFINITIONS.find(row => row.profile.id === 'payment-stripe')!;
    const store = new ConnectionProfileStore({ scope: CONNECTION_SETTINGS_SCOPE, definitions: CONNECTION_PROFILE_DEFINITIONS, cipher });
    const update = parseConnectionUpdate(definition.profile, { expectedRevision: 0, values: { BILLING_STRIPE_ENABLED: 'false' }, secrets: { STRIPE_SECRET_KEY: { action: 'replace', value: sentinel('S') } } });
    await expect(database.transaction(tx => store.save(tx, definition, update, 'synthetic-operator', { verify: () => { throw new Error('synthetic verify failure'); } }))).rejects.toThrow('synthetic verify failure');
    expect(await liveRow('payment-stripe')).toBeUndefined(); expect(await archiveRows('payment-stripe')).toHaveLength(0);
  });

  it('deleteRevisions never deletes the current revision, returns what it deleted and is idempotent', async () => {
    for (let revision = 0; revision < 3; revision += 1) await put('payment-creem', creem(sentinel(`D${revision}`), revision, `synthetic-account-${revision}`)).expect(200);
    const store = settings.runtime.store;
    const deleted = await database.transaction(tx => store.deleteRevisions(tx, 'payment-creem', [3, 1, 1, 0, -1, 99, 1.5]));
    expect(deleted).toEqual([1]);
    expect((await archiveRows()).map(row => row.revision)).toEqual([2, 3]);
    expect(await database.transaction(tx => store.deleteRevisions(tx, 'payment-creem', [1, 3]))).toEqual([]);
    expect(await settings.currentRevision('payment-creem')).toBe(3);
    expect(await settings.environmentAt('payment-creem', 1)).toBeUndefined();
    expect((await settings.environmentAt('payment-creem', 3))?.CREEM_API_KEY).toBe(sentinel('D2'));
    // Deleting archives of another profile id does not touch this one.
    expect(await database.transaction(tx => store.deleteRevisions(tx, 'payment-stripe', [2, 3]))).toEqual([]);
    expect((await archiveRows()).map(row => row.revision)).toEqual([2, 3]);
  });

  it('retains archived revisions after a live row is deleted out of band (4.1c: never discard)', async () => {
    await put('payment-creem', creem(sentinel('K1'), 0)).expect(200);
    await put('payment-creem', creem(sentinel('K2'), 1, 'synthetic-account-two')).expect(200);
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    // Deleting the live row must not delete archives.
    expect((await archiveRows()).map(row => row.revision)).toEqual([1, 2]);
    const fresh = new ConnectionSettingsService(database, env);
    await fresh.environment();
    expect((await archiveRows()).map(row => row.revision)).toEqual([1, 2]);
    expect((await fresh.environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(sentinel('K2'));
    // Re-creating the profile continues above the highest archived revision and keeps the old rows.
    await fresh.save('synthetic-operator', 'payment-creem', creem(sentinel('K3'), 0, 'synthetic-account-three'));
    const revisions = (await archiveRows()).map(row => row.revision);
    expect(revisions.slice(0, 2)).toEqual([1, 2]); expect(revisions).toHaveLength(3); expect(revisions[2]).toBeGreaterThan(2);
    expect((await fresh.environmentAt('payment-creem', 2))?.CREEM_API_KEY).toBe(sentinel('K2'));
  });
});
