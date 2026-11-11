import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
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
import { NativeAIClient, ZuckerAIModule, type NativeModelFactory } from '@zucker-framework/ai';
import { FakeChatModel } from '@zucker-framework/ai/testing';
import { FILE_MANAGER, S3Storage, type FileManager } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { AccountService } from '../src/accounts/account.service';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_SETTINGS, type OAuthSettings } from '../src/oauth/oauth.config';
import { DeliveryModule } from '../src/delivery/delivery.module';
import { MAIL_CONNECTION, type MailConnection } from '../src/mail/smtp-transport';
import { DELIVERY_OPTIONS, type DeliveryOptions } from '../src/delivery/delivery.config';
import { FilesModule, FILES_STORAGE, PrivateStorageModule, type FilesStorage } from '../src/files/files.module';
import { AI_CONNECTION_RUNTIME, AIConnectionRuntimeModule, type AIConnectionRuntime } from '../src/ai-connections/ai-connection-runtime';
import { AIConnectionsModule, AI_CONNECTION_ENVIRONMENT, AI_NATIVE_MODEL_FACTORY } from '../src/ai-connections/ai-connections.module';
import { aiModuleOptionsFromRuntime } from '../src/ai-connections/runtime-ai-config.source';
import { ConnectionsService } from '../src/management/connections.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { ConnectionSettingsService } from '../src/runtime-settings/connection-settings.service';
import { HotProvider } from '../src/runtime-settings/hot-apply';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';

/** Loopback SMTP catcher (no AUTH) recording raw DATA. */
function smtpStub(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer(socket => {
    let buffer = '', data = false;
    socket.write('220 stub ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return;
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 queued\r\n'); continue;
        }
        const line = buffer.indexOf('\r\n'); if (line < 0) return;
        const command = buffer.slice(0, line); buffer = buffer.slice(line + 2);
        const verb = command.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') socket.write('250-stub\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as AddressInfo).port, messages })));
}

/** Undoes quoted-printable soft breaks and escapes enough to read a link. */
const decoded = (raw: string) => raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_hot_apply_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticHot9!';

run('hot-applied non-financial connection profiles (mail, delivery, OAuth, AI, storage)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService;
  let first: Awaited<ReturnType<typeof smtpStub>>, second: Awaited<ReturnType<typeof smtpStub>>;
  let admin: { id: string; token: string };
  const keys: string[] = [];
  const fake = new FakeChatModel({ defaultStep: { delayMs: 40, chunks: ['a ', 'b ', 'c'] } });
  const recording: NativeModelFactory = async config => { keys.push(config.apiKey); return fake.factory(config); };
  const env = (): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt',
    JWT_SECRET: 'synthetic-hot-apply-jwt-at-least-32-characters', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(first.port), SMTP_FROM: 'sender@example.invalid',
    FILES_STORAGE_PROVIDER: 's3', FILES_S3_BUCKET: 'synthetic-bucket-a', FILES_S3_ENDPOINT: 'http://127.0.0.1:9', FILES_S3_ACCESS_KEY_ID: 'SYNTHETIC-ACCESS-A',
    FILES_S3_SECRET_ACCESS_KEY: 'SYNTHETIC-PRIVATE-STORAGE-A', AI_OPENAI_ENABLED: 'true', AI_OPENAI_API_KEY: 'SYNTHETIC-AI-KEY-A', AI_OPENAI_MODEL_ID: 'synthetic-model' });
  const save = async (id: string, update: { values?: Record<string, string | null>; secrets?: Record<string, unknown> }) =>
    settings.save('synthetic-operator', id, { expectedRevision: await settings.currentRevision(id), ...update });
  const put = (id: string, body: object) => request(app.getHttpServer()).put(`/api/management/connection-settings/${id}`)
    .set('Authorization', `Bearer ${admin.token}`).set('Origin', origin).send(body);
  const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);

  beforeAll(async () => {
    first = await smtpStub(); second = await smtpStub();
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
      ZuckerAuthModule.forRoot({ jwtSecret: env().JWT_SECRET!, registerControllers: false }), ZuckerConfigModule.forRoot(),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, AccountModule, OAuthModule, DeliveryModule, PrivateStorageModule, FilesModule,
      ZuckerAIModule.forRootAsync({ imports: [AIConnectionRuntimeModule], inject: [AI_CONNECTION_RUNTIME], useFactory: runtime => aiModuleOptionsFromRuntime(runtime as AIConnectionRuntime) }),
      AIConnectionsModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env()).overrideProvider(AI_NATIVE_MODEL_FACTORY).useValue(recording).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    settings = app.get(ConnectionSettingsService);
    for (const id of ['config:query', 'config:update']) await database.model('permissions').create({ data: { id, name: id } });
    await post('register', { username: 'hotadmin', email: 'hotadmin@example.invalid', password }).expect(201);
    const ticket = /verify-email#ticket=([A-Za-z0-9_-]{43})/.exec(decoded(first.messages.join('\n')))?.[1];
    await post('verify-email', { ticket }).expect(200);
    const logged = await post('login', { username: 'hotadmin', password }).expect(200);
    for (const permission of ['config:query', 'config:update']) await database.model('userPermissions').create({ data: { userId: logged.body.userId, permissionId: permission, grantType: 'grant' } });
    admin = { id: logged.body.userId, token: logged.body.token };
    await app.get(AccountService).settled();
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); first?.server.close(); second?.server.close(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('sends the next account mail through the newly saved SMTP server without a restart', async () => {
    const before = first.messages.length;
    await save('account-email', { values: { SMTP_PORT: String(second.port) } });
    await post('register', { username: 'hotsecond', email: 'hotsecond@example.invalid', password }).expect(201);
    expect(second.messages).toHaveLength(1);
    expect(first.messages).toHaveLength(before);
    const status = (await new ConnectionsService({}, undefined, undefined, settings).inspect()).connections.find(row => row.id === 'account-email');
    expect(status).toMatchObject({ applyMode: 'hot', pendingRestart: false, appliedRevision: 1, storedRevision: 1 });
    expect(status).not.toHaveProperty('applyError');
    // The mail profile is pinned on every route (catch-all middleware), so any request refreshes it.
    await save('account-email', { values: { SMTP_FROM: 'second@example.invalid' } });
    await request(app.getHttpServer()).get('/api/synthetic-unknown-route').expect(404);
    expect(app.get<MailConnection>(MAIL_CONNECTION).state().revisions?.get('account-email')).toBe(2);
  });

  it('applies sign-in and durable delivery profiles to the next request', async () => {
    expect(app.get<OAuthSettings>(OAUTH_SETTINGS).google.code).toBe(false);
    await save('identity-google', { values: { GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'synthetic-google' }, secrets: { GOOGLE_CLIENT_SECRET: { action: 'replace', value: 'SYNTHETIC-GOOGLE' } } });
    // The first request after the save is pinned to the new revision (OAuth request middleware).
    const providers = await request(app.getHttpServer()).get('/api/authorize/oauth/providers').expect(200);
    expect(providers.body.providers).toEqual([{ id: 'google', code: true }]);
    await save('durable-email', { values: { DELIVERY_PROVIDER: 'smtp', DELIVERY_ACCOUNT_SCOPE: 'synthetic-scope', DELIVERY_FROM: 'jobs@example.invalid',
      DELIVERY_SMTP_HOST: '127.0.0.1', DELIVERY_SMTP_PORT: String(second.port), DELIVERY_SMTP_USER: 'synthetic' }, secrets: { DELIVERY_SMTP_PASSWORD: { action: 'replace', value: 'SYNTHETIC-PW' } } });
    const options = app.get<DeliveryOptions>(DELIVERY_OPTIONS);
    options.accountScope; // a background read schedules the refresh outside a request
    await new Promise(done => setTimeout(done, 50));
    expect(options).toMatchObject({ accountScope: 'synthetic-scope' });
    expect(options.provider?.isConfigured()).toBe(true);
  });

  it('uses a newly saved AI key for the next call while an in-flight stream finishes on the old one', async () => {
    const client = app.get(NativeAIClient), runtime = app.get<AIConnectionRuntime>(AI_CONNECTION_RUNTIME);
    keys.length = 0;
    let saved!: Promise<unknown>;
    const streaming = client.stream('connection.openai', { messages: [{ role: 'user', content: 'synthetic' }] }, {
      onChunk: () => { saved ??= save('ai-openai', { secrets: { AI_OPENAI_API_KEY: { action: 'replace', value: 'SYNTHETIC-AI-KEY-B' } } }); },
    });
    const result = await streaming; await saved;
    expect(result.content).toBe('a b c');
    expect(keys).toEqual(['SYNTHETIC-AI-KEY-A']);
    await client.chat('connection.openai', { messages: [{ role: 'user', content: 'again' }] });
    expect(keys).toEqual(['SYNTHETIC-AI-KEY-A', 'SYNTHETIC-AI-KEY-B']);
    // AI request middleware pins (and therefore refreshes) the runtime on /chat*, even for unknown routes.
    await save('ai-openai', { values: { AI_OPENAI_MODEL_ID: 'synthetic-model-2' } });
    await request(app.getHttpServer()).get('/api/chat/unknown-route').expect(404);
    expect(runtime.state().revisions?.get('ai-openai')).toBe(2);
    expect(app.get<Readonly<NodeJS.ProcessEnv>>(AI_CONNECTION_ENVIRONMENT).AI_OPENAI_MODEL_ID).toBe('synthetic-model-2');
  });

  it('swaps the storage client on a credential save and destroys the old one after its last lease', async () => {
    const storage = app.get<FilesStorage>(FILES_STORAGE), manager = app.get<FileManager>(FILE_MANAGER);
    const old = await storage.current();
    expect(old).toBeInstanceOf(S3Storage);
    let destroyed = 0; const destroy = (old as unknown as { onModuleDestroy(): void }).onModuleDestroy.bind(old);
    (old as unknown as { onModuleDestroy(): void }).onModuleDestroy = () => { destroyed += 1; destroy(); };
    let release!: () => void;
    const held = storage.use(instance => new Promise<FileManager>(done => { release = () => done(instance); }));
    await new Promise(done => setTimeout(done, 10));
    await save('private-files', { secrets: { FILES_S3_ACCESS_KEY_ID: { action: 'replace', value: 'SYNTHETIC-ACCESS-B' } } });
    const next = await storage.current();
    expect(next).not.toBe(old); expect(manager.providerType).toBe('s3');
    expect(destroyed).toBe(0);
    release(); expect(await held).toBe(old);
    await new Promise(done => setTimeout(done, 10));
    expect(destroyed).toBe(1);
  });

  it('refuses a storage location change while files exist unless it is acknowledged, and audits the acknowledgement', async () => {
    const current = async () => (await request(app.getHttpServer()).get('/api/management/connection-settings/private-files').set('Authorization', `Bearer ${admin.token}`).expect(200)).body.storedRevision as number;
    // No file rows yet: a bucket change needs no flag.
    await put('private-files', { expectedRevision: await current(), values: { FILES_S3_BUCKET: 'synthetic-bucket-b' } }).expect(200);
    await database.model('fileAssets').create({ data: { id: `file_${randomUUID()}`, ownerId: admin.id, idempotencyKey: randomUUID(), objectKey: `private-assets/${randomUUID()}`,
      fileName: 'a.txt', sha256: 'a'.repeat(64), size: 1, mimeType: 'text/plain', state: 'pending' } });
    const refused = await put('private-files', { expectedRevision: await current(), values: { FILES_S3_BUCKET: 'synthetic-bucket-c' } }).expect(409);
    expect(refused.body.message).toContain('acknowledgeDataLocationChange');
    await put('private-files', { expectedRevision: await current(), values: { FILES_S3_ENDPOINT: 'http://127.0.0.1:10' },
      secrets: { FILES_S3_ACCESS_KEY_ID: { action: 'replace', value: 'SYNTHETIC-ACCESS-C' }, FILES_S3_SECRET_ACCESS_KEY: { action: 'replace', value: 'SYNTHETIC-PRIVATE-C' } } }).expect(409);
    await put('private-files', { expectedRevision: await current(), values: { FILES_S3_BUCKET: 'synthetic-bucket-c' }, acknowledgeDataLocationChange: 'yes' }).expect(400);
    // Credential-only changes need no acknowledgement.
    await put('private-files', { expectedRevision: await current(), secrets: { FILES_S3_SECRET_ACCESS_KEY: { action: 'replace', value: 'SYNTHETIC-PRIVATE-D' } } }).expect(200);
    const revision = await current();
    const accepted = await put('private-files', { expectedRevision: revision, values: { FILES_S3_BUCKET: 'synthetic-bucket-c' }, acknowledgeDataLocationChange: true }).expect(200);
    expect(accepted.body.storedRevision).toBe(revision + 1);
    const audit = await database.model('operationLogs').findMany({ where: { module: 'files', action: 'acknowledge-data-location-change' } });
    expect(audit).toEqual([expect.objectContaining({ userId: admin.id, targetId: 'private-files', metadata: { revision: revision + 1, changedFields: ['FILES_S3_BUCKET'], objectsMoved: false } })]);
    expect(JSON.stringify(audit)).not.toContain('SYNTHETIC-PRIVATE');
  });

  it('keeps serving the previous instance when a new revision cannot be assembled and reports it to management', async () => {
    const hot = HotProvider.create<string>(settings, undefined, { name: 'Synthetic failing provider', profiles: ['durable-email'],
      build: environment => { if (environment.DELIVERY_FROM === 'broken@example.invalid') throw new Error('SYNTHETIC-SECRET-IN-MESSAGE'); return environment.DELIVERY_FROM ?? ''; } });
    expect(await hot.current()).toBe('jobs@example.invalid');
    await save('durable-email', { values: { DELIVERY_FROM: 'broken@example.invalid' } });
    expect(await hot.current()).toBe('jobs@example.invalid');
    const stored = await settings.currentRevision('durable-email');
    const status = (await new ConnectionsService({}, undefined, undefined, settings).inspect()).connections.find(row => row.id === 'durable-email');
    expect(status).toMatchObject({ applyMode: 'hot', storedRevision: stored, appliedRevision: stored - 1, applyError: { revision: stored, reason: 'provider_assembly_failed' } });
    await save('durable-email', { values: { DELIVERY_FROM: 'fixed@example.invalid' } });
    expect(await hot.current()).toBe('fixed@example.invalid');
    const fixed = (await new ConnectionsService({}, undefined, undefined, settings).inspect()).connections.find(row => row.id === 'durable-email');
    expect(fixed).not.toHaveProperty('applyError');
    await hot.close();
  });

  it('pins one revision per request and releases the old instance only when the response closes', async () => {
    const disposed: string[] = [];
    const hot = await HotProvider.create<string>(settings, undefined, { name: 'Synthetic pinned provider', profiles: ['identity-github'],
      build: environment => environment.GITHUB_CLIENT_ID ?? 'none', dispose: value => { disposed.push(value); } }).ready();
    const response = new EventEmitter();
    const seen = await new Promise<string[]>((done, fail) => hot.middleware()({}, response, () => {
      void (async () => {
        const values = [hot.now()];
        await save('identity-github', { values: { GITHUB_CLIENT_ID: 'synthetic-github-b' } });
        values.push(hot.now(), await hot.current());
        return values;
      })().then(done, fail);
    }));
    expect(seen).toEqual(['none', 'none', 'none']);
    expect(await hot.current()).toBe('synthetic-github-b');
    expect(disposed).toEqual([]);
    response.emit('close'); await new Promise(done => setTimeout(done, 10));
    expect(disposed).toEqual(['none']);
    await hot.close();
  });
});
