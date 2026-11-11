import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { Logger, type INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import type { FileManager } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_CONNECTION, type OAuthConnection } from '../src/oauth/oauth.config';
import { FilesModule, HotFileManager, PrivateStorageModule, FILES_STORAGE, type FilesStorage } from '../src/files/files.module';
import { ConnectionsService } from '../src/management/connections.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';
import { HotProvider, liveArrayView, liveObjectView } from '@zucker-framework/back-office/settings';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';

/**
 * WP 4.1b: lifecycle guarantees of hot-applied providers (exactly-once close after the last holder, failed
 * builds, close failures, per-request pinning, live views) and, over HTTP, OAuth rotation and the D14
 * storage-location guard matrix. `identity-github` (GITHUB_CLIENT_ID) is the revision discriminator;
 * providers are in-memory fakes. Synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_hot_lifecycle_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticLife9!';
const env = (): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-lifecycle-tests',
  JWT_SECRET: 'synthetic-hot-lifecycle-jwt-at-least-32-characters', FILES_STORAGE_PROVIDER: 's3', FILES_S3_BUCKET: 'synthetic-bucket-a', FILES_S3_ENDPOINT: 'http://127.0.0.1:9',
  FILES_S3_ACCESS_KEY_ID: 'SYNTHETIC-ACCESS-A', FILES_S3_SECRET_ACCESS_KEY: 'SYNTHETIC-PRIVATE-STORAGE-A' });
const tick = (ms = 15) => new Promise(done => setTimeout(done, ms));
const gate = () => { let open!: () => void; const wait = new Promise<void>(done => { open = done; }); return { wait, open }; };

interface Instance { id: string; closed: number }

run('hot-applied providers: lifecycle, failure and HTTP guard matrix', () => {
  let pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService, logs: string[];
  const saveNext = async (client: string) =>
    settings.save('synthetic-operator', 'identity-github', { expectedRevision: await settings.currentRevision('identity-github'), values: { GITHUB_CLIENT_ID: client } });
  const provider = (options: { dispose?: (instance: Instance) => void | Promise<void>; build?: (environment: NodeJS.ProcessEnv) => Instance } = {}) => {
    const builds: string[] = [];
    const hot = HotProvider.create<Instance>(settings, undefined, { name: 'Synthetic lifecycle provider', profiles: ['identity-github'],
      build: options.build ?? (environment => { builds.push(environment.GITHUB_CLIENT_ID ?? 'none'); return { id: environment.GITHUB_CLIENT_ID ?? 'none', closed: 0 }; }),
      dispose: options.dispose ?? (instance => { instance.closed += 1; }) });
    return { hot, builds };
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
  });
  afterAll(async () => { await database?.disconnect(); await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool?.end(); });

  describe('provider lifecycle', () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
      await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
      settings = new ConnectionSettingsService(database, env()); logs = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('in-flight work finishes on its own instance and each replaced instance is closed exactly once, after its last holder', async () => {
      await saveNext('v1');
      const { hot } = provider(); await hot.ready();
      const g1 = gate(), g2 = gate(), g3 = gate();
      const seen: Instance[] = [];
      const first = hot.use(async instance => { seen.push(instance); await g1.wait; return instance; });
      const firstAgain = hot.use(async instance => { seen.push(instance); await g3.wait; return instance; });
      await tick(); await saveNext('v2');
      const second = hot.use(async instance => { seen.push(instance); await g2.wait; return instance; });
      await tick(); await saveNext('v3');
      expect((await hot.current()).id).toBe('v3');
      expect(seen.map(row => row.id)).toEqual(['v1', 'v1', 'v2']);
      const [v1, v2] = [seen[0], seen[2]];
      expect([v1.closed, v2.closed]).toEqual([0, 0]);
      g2.open(); expect((await second)).toBe(v2); await tick();
      expect(v2.closed).toBe(1); expect(v1.closed).toBe(0);
      g1.open(); await first; await tick();
      expect(v1.closed).toBe(0); // a second holder remains
      g3.open(); await firstAgain; await tick();
      expect(v1.closed).toBe(1);
      const live = await hot.current(); expect(live.closed).toBe(0);
      await hot.close(); await hot.close();
      expect([v1.closed, v2.closed, live.closed]).toEqual([1, 1, 1]);
    });

    it('overlapping requests are each pinned to their own revision until their response closes', async () => {
      await saveNext('r1');
      const { hot } = provider(); await hot.ready();
      const responses = [new EventEmitter(), new EventEmitter()], pinned: Instance[] = [], inside: string[][] = [[], []];
      const run = (index: number) => new Promise<void>(done => hot.middleware()({}, responses[index], () => {
        pinned.push(hot.now()); inside[index].push(hot.now().id);
        void tick(40).then(() => { inside[index].push(hot.now().id); done(); });
      }));
      const a = run(0); await tick(); await saveNext('r2'); await hot.current();
      const b = run(1); await Promise.all([a, b]);
      expect(inside).toEqual([['r1', 'r1'], ['r2', 'r2']]);
      expect(pinned[0].closed).toBe(0);
      responses[1].emit('close'); await tick(); expect(pinned[0].closed).toBe(0);
      responses[0].emit('close'); await tick(); expect(pinned[0].closed).toBe(1); expect(pinned[1].closed).toBe(0);
      await hot.close(); expect(pinned[1].closed).toBe(1);
    });

    it('a close failure of a replaced instance does not stop serving, is logged without its message, and happens once', async () => {
      await saveNext('c1');
      let attempts = 0;
      const { hot } = provider({ dispose: instance => { instance.closed += 1; attempts += 1; throw new Error('SYNTHETIC-SECRET-IN-CLOSE-ERROR'); } });
      const first = await hot.current(); await saveNext('c2');
      expect((await hot.current()).id).toBe('c2'); await tick();
      await saveNext('c3'); expect((await hot.current()).id).toBe('c3'); await tick();
      expect(first.closed).toBe(1);
      expect(attempts).toBe(2);
      expect(logs.join('\n')).not.toContain('SYNTHETIC-SECRET');
      // The live instance fails to close: close() reports it once and never retries the same instance.
      await expect(hot.close()).rejects.toThrow();
      await expect(hot.close()).resolves.toBeUndefined();
      expect(attempts).toBe(3);
    });

    it('a failed build keeps the previous instance serving for every concurrent reader, reports the revision once, and recovers on the next save', async () => {
      await saveNext('ok-1');
      const built: string[] = [];
      const { hot } = provider({ build: environment => {
        built.push(environment.GITHUB_CLIENT_ID ?? '');
        if (environment.GITHUB_CLIENT_ID === 'broken') throw new Error('SYNTHETIC-SECRET-IN-BUILD-ERROR');
        return { id: environment.GITHUB_CLIENT_ID ?? '', closed: 0 };
      } });
      const original = await hot.current();
      await saveNext('broken'); const stored = await settings.currentRevision('identity-github');
      const readers = await Promise.all(Array.from({ length: 25 }, () => hot.current()));
      expect(readers.every(instance => instance === original)).toBe(true);
      expect(original.closed).toBe(0);
      for (let index = 0; index < 5; index++) await hot.use(async instance => { expect(instance).toBe(original); });
      expect(built.filter(id => id === 'broken').length).toBeLessThanOrEqual(2);
      const row = (await new ConnectionsService({}, undefined, undefined, settings).inspect()).connections.find(entry => entry.id === 'identity-github');
      expect(row).toMatchObject({ applyMode: 'hot', storedRevision: stored, appliedRevision: stored - 1, applyError: { revision: stored, reason: 'provider_assembly_failed' } });
      expect(JSON.stringify(row)).not.toContain('SYNTHETIC-SECRET');
      expect(logs.join('\n')).not.toContain('SYNTHETIC-SECRET');
      await saveNext('ok-2');
      const next = await hot.current(); expect(next.id).toBe('ok-2'); await tick();
      expect(original.closed).toBe(1);
      expect((await new ConnectionsService({}, undefined, undefined, settings).inspect()).connections.find(entry => entry.id === 'identity-github')).not.toHaveProperty('applyError');
      await hot.close();
    });

    it('with no instance at all (first build failed) reads fail with 503 and a request gets 503, never a broken instance', async () => {
      await saveNext('broken');
      const { hot } = provider({ build: environment => { if (environment.GITHUB_CLIENT_ID === 'broken') throw new Error('SYNTHETIC-SECRET-IN-BUILD-ERROR'); return { id: 'x', closed: 0 }; } });
      await expect(hot.current()).rejects.toMatchObject({ status: 503 });
      expect(() => hot.now()).toThrow(/not ready/);
      const error = await new Promise<unknown>(done => hot.middleware()({}, new EventEmitter(), done));
      expect(error).toMatchObject({ status: 503 });
      expect(JSON.stringify(error)).not.toContain('SYNTHETIC-SECRET');
      await saveNext('fixed');
      expect((await hot.current()).id).toBe('x');
      await hot.close();
    });

    it('live object and array views follow the newest instance through spread, keys, JSON, in and toMatchObject and stay read-only', async () => {
      await saveNext('o1');
      const { hot } = provider({ build: environment => ({ id: environment.GITHUB_CLIENT_ID ?? '', closed: 0, list: [environment.GITHUB_CLIENT_ID ?? ''] } as Instance & { list: string[] }) });
      await hot.ready();
      const view = liveObjectView(() => hot.now()) as Instance & { list: string[] }, list = liveArrayView(() => (hot.now() as Instance & { list: string[] }).list);
      expect({ ...view }).toEqual({ id: 'o1', closed: 0, list: ['o1'] });
      expect(view).toMatchObject({ id: 'o1' }); expect(Object.keys(view)).toEqual(['id', 'closed', 'list']); expect('id' in view).toBe(true); expect(JSON.parse(JSON.stringify(view)).id).toBe('o1');
      expect(list.map(value => value)).toEqual(['o1']); expect(list).toHaveLength(1);
      expect(() => { (view as { id: string }).id = 'hacked'; }).toThrow(); expect(() => { delete (view as Partial<Instance>).id; }).toThrow();
      await saveNext('o2'); await hot.current();
      expect({ ...view }.id).toBe('o2'); expect(view).toMatchObject({ id: 'o2' }); expect([...list]).toEqual(['o2']);
      await hot.close();
    });

    // liveArrayView is documented as a read-only view, but array methods are bound to the live array, so mutators (push, splice, sort)
    // change the provider's own instance.
    it('liveArrayView does not let a consumer mutate the provider instance through array methods', () => {
      const source = ['a']; const view = liveArrayView(() => source);
      try { (view as string[]).push('x'); } catch { /* refusing is the desired behaviour */ }
      expect(source).toEqual(['a']);
    });

    it('uploads and downloads that began before a storage swap finish on the old client, new calls use the new one, and the old client closes after its stream ends', async () => {
      await saveNext('s1');
      const destroyed: string[] = [], calls: string[] = [];
      const manager = (id: string): FileManager => {
        const body = new Readable({ read() {} });
        return { providerType: 's3', isConfigured: () => true,
          async upload(_buffer: Buffer, key: string) { calls.push(`${id}:upload:${key}`); await tick(40); return { key, url: key } as never; },
          async uploadStream() { throw new Error('unused'); },
          async download(key: string) { calls.push(`${id}:download:${key}`); setTimeout(() => body.push('data'), 5); return { stream: body, size: 4 }; },
          async delete() {}, async exists() { return true; }, async getPublicUrl() { return id; }, async getDownloadUrl() { return id; }, async list() { return []; },
          onModuleDestroy() { destroyed.push(id); } } as unknown as FileManager;
      };
      const storage: FilesStorage = HotProvider.create<FileManager>(settings, undefined, { name: 'Synthetic storage', profiles: ['identity-github'],
        build: environment => manager(environment.GITHUB_CLIENT_ID ?? ''), dispose: instance => (instance as unknown as { onModuleDestroy(): void }).onModuleDestroy() });
      await storage.ready();
      const files = new HotFileManager(storage);
      const downloading = await files.download('private/a'); const uploading = files.upload(Buffer.from('x'), 'private/b');
      await tick(5); await saveNext('s2'); await storage.current();
      await files.upload(Buffer.from('y'), 'private/c');
      expect(calls).toEqual(['s1:download:private/a', 's1:upload:private/b', 's2:upload:private/c']);
      await uploading; await tick();
      expect(destroyed).toEqual([]); // the download stream still holds the old client
      downloading.stream.destroy(); await tick();
      expect(destroyed).toEqual(['s1']);
      await storage.close(); await tick(); expect(destroyed).toEqual(['s1', 's2']);
    });
  });

  describe('over HTTP (OAuth rotation, D14 guard)', () => {
    let app: INestApplication, admin: { id: string; token: string }, member: { id: string; token: string };
    const deliveries = new Map<string, string>();
    const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    const put = (id: string, body: object, token = admin.token) => request(app.getHttpServer()).put(`/api/management/connection-settings/${id}`)
      .set('Authorization', `Bearer ${token}`).set('Origin', origin).send(body);
    const revision = async () => (await request(app.getHttpServer()).get('/api/management/connection-settings/private-files').set('Authorization', `Bearer ${admin.token}`).expect(200)).body.storedRevision as number;
    const user = async (name: string, permissions: string[]) => {
      const username = `${name}${randomUUID().replaceAll('-', '').slice(0, 8)}`, email = `${username}@example.invalid`;
      await post('register', { username, email, password }).expect(201);
      await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
      const login = await post('login', { username, password }).expect(200);
      for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
      return { id: login.body.userId as string, token: login.body.token as string };
    };
    const audit = () => database.model('operationLogs').findMany({ where: { module: 'files', action: 'acknowledge-data-location-change' } }) as Promise<Array<{ metadata: Record<string, unknown> }>>;
    const rows = (table: 'fileAssets' | 'publicAssets') => database.model(table).deleteMany({});
    const addFile = () => database.model('fileAssets').create({ data: { id: `file_${randomUUID()}`, ownerId: admin.id, idempotencyKey: randomUUID(), objectKey: `private-assets/${randomUUID()}`,
      fileName: 'a.txt', sha256: 'a'.repeat(64), size: 1, mimeType: 'text/plain', state: 'pending' } });

    beforeAll(async () => {
      await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
      await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
      for (const id of ['config:query', 'config:update']) await database.model('permissions').create({ data: { id, name: id } }).catch(() => undefined);
      const limits = { points: 3000, duration: 60 };
      const module = await Test.createTestingModule({ imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
        ZuckerAuthModule.forRoot({ jwtSecret: env().JWT_SECRET!, registerControllers: false }), ZuckerConfigModule.forRoot(),
        ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
        RuntimeSettingsModule, AccountModule, OAuthModule, PrivateStorageModule, FilesModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
        .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env()).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
      app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
      settings = app.get(ConnectionSettingsService);
      admin = await user('lifeadmin', ['config:query', 'config:update']); member = await user('lifemember', []);
    });
    afterAll(async () => { await app?.close(); });

    it('a sign-in started before a client change keeps its leased client; the next start uses the new client id', async () => {
      const oauth = app.get<OAuthConnection>(OAUTH_CONNECTION);
      const saveGoogle = async (clientId: string) => settings.save('synthetic-operator', 'identity-google', { expectedRevision: await settings.currentRevision('identity-google'),
        values: { GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: clientId }, secrets: { GOOGLE_CLIENT_SECRET: { action: 'replace', value: `SYNTHETIC-SECRET-${clientId}` } } });
      const start = async () => new URL((await post('oauth/google/start', { mode: 'code', locale: 'en', returnPath: '/account' }).expect(200)).body.authorizationUrl);
      await saveGoogle('client-a');
      expect((await start()).searchParams.get('client_id')).toBe('client-a');
      const held = gate(), inFlight = oauth.use(async current => { await held.wait; return current.settings.google.clientId; });
      await tick(); await saveGoogle('client-b');
      const after = await start();
      expect(after.searchParams.get('client_id')).toBe('client-b');
      expect(after.toString()).not.toContain('SYNTHETIC-SECRET');
      held.open(); expect(await inFlight).toBe('client-a');
      // Disabling the provider closes new starts at once; an unknown provider stays 404.
      await settings.save('synthetic-operator', 'identity-google', { expectedRevision: await settings.currentRevision('identity-google'), values: { GOOGLE_OAUTH_ENABLED: 'false' } });
      await post('oauth/google/start', { mode: 'code', locale: 'en', returnPath: '/account' }).expect(404);
      await post('oauth/nope/start', {}).expect(404);
    });

    it('D14: provider, endpoint and bucket changes with files need acknowledgement; credential-only, no-op and file-less saves do not', async () => {
      await rows('fileAssets'); await rows('publicAssets');
      await put('private-files', { expectedRevision: await revision(), values: { FILES_S3_BUCKET: 'bucket-1' } }).expect(200); // no rows yet
      await addFile();
      const cases: Array<[string, Record<string, string | null>]> = [['bucket', { FILES_S3_BUCKET: 'bucket-2' }], ['endpoint', { FILES_S3_ENDPOINT: 'http://127.0.0.1:11' }],
        ['bucket cleared', { FILES_S3_BUCKET: null }], ['bucket whitespace-only change', { FILES_S3_BUCKET: ' bucket-3 ' }]];
      for (const [, values] of cases) {
        const refused = await put('private-files', { expectedRevision: await revision(), values }).expect(409);
        expect(JSON.stringify(refused.body)).toContain('acknowledgeDataLocationChange');
        await put('private-files', { expectedRevision: await revision(), values, acknowledgeDataLocationChange: false }).expect(409);
      }
      expect(await audit()).toEqual([]);
      // Same value again, region and credential changes: no location change.
      await put('private-files', { expectedRevision: await revision(), values: { FILES_S3_BUCKET: 'bucket-1' } }).expect(200);
      await put('private-files', { expectedRevision: await revision(), values: { FILES_S3_BUCKET: ' bucket-1 ' } }).expect(200);
      await put('private-files', { expectedRevision: await revision(), values: { FILES_S3_REGION: 'eu-west-1' } }).expect(200);
      expect(await audit()).toEqual([]);
      // Public asset rows alone also count as existing data.
      await rows('fileAssets');
      await put('private-files', { expectedRevision: await revision(), values: { FILES_S3_BUCKET: 'bucket-2' } }).expect(200);
      await database.model('publicAssets').create({ data: { id: `pub_${randomUUID()}`, ownerId: admin.id, objectKey: `public-assets/${randomUUID()}`, fileName: 'a.png', sha256: 'b'.repeat(64),
        size: 1, mimeType: 'image/png', state: 'active' } } as never).then(() => undefined, () => undefined);
      await rows('publicAssets');
    });

    it('D14: an acknowledged change is audited with the save, a failed or stale save leaves no audit row, and the flag is ignored for other profiles', async () => {
      await rows('fileAssets'); await rows('publicAssets'); await addFile();
      const before = (await audit()).length;
      // Stale expectedRevision with the flag: the save's own compare-and-swap decides (409), nothing audited.
      await put('private-files', { expectedRevision: (await revision()) - 1, values: { FILES_S3_BUCKET: 'bucket-9' }, acknowledgeDataLocationChange: true }).expect(409);
      // An invalid value with the flag: rejected, nothing audited, nothing saved.
      const stored = await revision();
      await put('private-files', { expectedRevision: stored, values: { FILES_S3_ENDPOINT: 'ftp://invalid.example' }, acknowledgeDataLocationChange: true }).expect(r => { if (r.status < 400) throw new Error(`expected an error, got ${r.status}`); });
      expect(await revision()).toBe(stored); expect((await audit()).length).toBe(before);
      // The flag must be a boolean and means nothing on another profile.
      await put('private-files', { expectedRevision: stored, values: { FILES_S3_BUCKET: 'bucket-9' }, acknowledgeDataLocationChange: 1 }).expect(400);
      await put('identity-github', { expectedRevision: await settings.currentRevision('identity-github'), values: { GITHUB_CLIENT_ID: 'x' }, acknowledgeDataLocationChange: true }).expect(r => { if (r.status < 400) throw new Error('flag accepted on another profile'); });
      const accepted = await put('private-files', { expectedRevision: stored, values: { FILES_S3_BUCKET: 'bucket-9' }, acknowledgeDataLocationChange: true }).expect(200);
      expect(accepted.body.storedRevision).toBe(stored + 1);
      const log = await audit(); expect(log.length).toBe(before + 1);
      expect(log.at(-1)!.metadata).toEqual({ revision: stored + 1, changedFields: ['FILES_S3_BUCKET'], objectsMoved: false });
      expect(JSON.stringify(log)).not.toMatch(/SYNTHETIC-(PRIVATE|ACCESS)/);
      expect(JSON.stringify(accepted.body)).not.toMatch(/SYNTHETIC-(PRIVATE|ACCESS)/);
    });

    it('D14 and saves stay behind authentication and the config permissions', async () => {
      await rows('fileAssets'); await addFile();
      const body = { expectedRevision: await revision(), values: { FILES_S3_BUCKET: 'bucket-denied' }, acknowledgeDataLocationChange: true };
      await request(app.getHttpServer()).put('/api/management/connection-settings/private-files').set('Origin', origin).send(body).expect(401);
      await put('private-files', body, member.token).expect(403);
      await put('private-files', body).set('Origin', 'https://evil.invalid').expect(403);
      expect(await revision()).toBe(body.expectedRevision);
    });
  });
});
