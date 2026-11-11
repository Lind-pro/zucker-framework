import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ApiKeyService, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ZuckerStorageModule } from '@zucker-framework/storage';
import { FAKE_PNG_BASE64, FakeCallbackVerifier, FakeMediaProvider } from '@zucker-framework/ai/testing';
import { NativeAIClient } from '@zucker-framework/ai';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { AccountApiKeysModule } from '../src/api-keys/api-keys.module';
import { ACCOUNT_KEY_SCOPES } from '../src/api-keys/api-keys.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { JobsHost } from '../src/jobs/jobs.host';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { createCreditLedger } from '../src/billing/ledger';
import { AI_CONNECTION_ENVIRONMENT } from '../src/ai-connections/ai-connections.module';
import { AI_MEDIA_PROVIDERS, type AIMediaProviderEntry } from '../src/ai-connections/ai-media-providers';
import { AITasksModule } from '../src/ai-tasks/ai-tasks.module';
import { AI_TASKS_OPTIONS } from '../src/ai-tasks/ai-tasks.service';
import { AI_POLICIES } from '../src/ai-tasks/ai.policy';
import { AI_TASK_RATE_LIMITERS } from '../src/ai-tasks/ai-tasks.controller';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_ai_tasks_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-ai-tasks-jwt-secret-of-32-characters',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt',
  POLICY_AI_CATALOG_IMAGE: JSON.stringify([{ providerId: 'fake-media', model: 'fake-image', label: 'Fake' }]),
  POLICY_AI_PRICING_IMAGE: JSON.stringify({ default: 2, byModel: { 'fake-image': 3 } }) };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

run('AI tasks HTTP + PostgreSQL contract (fake media provider)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, directory: string, host: JobsHost;
  let owner: { id: string; token: string }, other: { id: string; token: string }, admin: { id: string; token: string };
  const media = new FakeMediaProvider({ defaultStep: { mode: 'async', pollsUntilDone: 1 } });
  const verifier = new FakeCallbackVerifier();
  const providers: AIMediaProviderEntry[] = [{ providerId: 'fake-media', name: 'Fake', kinds: ['image', 'video', 'audio'], provider: media,
    config: { apiKey: 'SYNTHETIC-MEDIA-KEY' }, verifier }];
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const server = () => app.getHttpServer();
  const submit = (body: object, user = owner, key = randomUUID()) => request(server()).post('/api/ai/tasks')
    .set('Authorization', `Bearer ${user.token}`).set('Origin', origin).set('Idempotency-Key', key).send(body);
  const get = (path: string, user = owner) => request(server()).get(`/api/${path}`).set('Authorization', `Bearer ${user.token}`);
  const image = (prompt = 'A synthetic lighthouse') => ({ kind: 'image', providerId: 'fake-media', model: 'fake-image', prompt });
  const balance = async (id: string) => (await database.transaction(tx => tx.query<{ balance: number; frozenBalance: number }>(
    'SELECT balance, "frozenBalance" FROM credit_account WHERE "userId"=$1', [id]))).rows[0] ?? { balance: 0, frozenBalance: 0 };
  const grant = (id: string, amount: number) => database.transaction(tx => createCreditLedger(database).grant(tx, {
    accountId: id, amount, source: 'synthetic', sourceId: randomUUID(), transactionData: { type: 'GRANT', description: 'Synthetic grant' } }));
  async function drive(id: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await host.runTask(id).catch(() => undefined);
      const row = (await database.transaction(tx => tx.query<{ status: string }>('SELECT status::text FROM async_jobs WHERE id=$1', [id]))).rows[0];
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
      await sleep(15);
    }
    throw new Error('AI task did not finish');
  }
  async function member(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`, password = 'SyntheticAITask9!';
    const send = (path: string, body: object) => request(server()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: login.body.userId as string, token: login.body.token as string };
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-ai-tasks-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
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
      ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits,
        'api-default': limits, 'api-key': { points: 3000, duration: 60, blockDuration: 0 }, ...AI_TASK_RATE_LIMITERS } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...AI_POLICIES] }),
      AccountModule, AccountApiKeysModule, AITasksModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(AI_CONNECTION_ENVIRONMENT).useValue(Object.freeze({ ...env }))
      .overrideProvider(AI_MEDIA_PROVIDERS).useValue(providers)
      // Chat is not under test here; media tasks never use the native chat client.
      .overrideProvider(NativeAIClient).useValue({})
      .overrideProvider(AI_TASKS_OPTIONS).useValue({ polling: { initialDelayMs: 5, maxDelayMs: 20, earlyPollMinIntervalMs: 5 } })
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'ai-tasks', concurrency: 1, scanIntervalMs: 100, leaseMs: 5000, heartbeatMs: 500, shutdownWaitMs: 2000 })
      .compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    host = app.get(JobsHost);
    await database.model('permissions').create({ data: { id: 'ai-tasks:query', name: 'ai-tasks:query' } });
    owner = await member('aiowner'); other = await member('aiother'); admin = await member('aiadmin', ['ai-tasks:query']);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
      if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it('serves the public catalog with prices and availability', async () => {
    const catalog = (await request(server()).get('/api/ai/catalog').expect(200)).body;
    expect(catalog.image).toEqual([{ providerId: 'fake-media', model: 'fake-image', label: 'Fake', cost: 3, available: true }]);
    expect(catalog.chatPricing).toEqual({ per1kInputTokens: 0.5, per1kOutputTokens: 1.5, minimum: 1 });
    expect(JSON.stringify(catalog)).not.toContain('SYNTHETIC-MEDIA-KEY');
  });

  it('submits, holds, polls, completes, confirms and downloads through a file ticket; other owners get 404', async () => {
    await grant(owner.id, 10);
    const key = randomUUID();
    const created = await submit({ ...image(), cost: 3 }, owner, key).expect(202);
    expect(created.body).toMatchObject({ kind: 'image', model: 'fake-image', cost: 3, charge: 'HELD', status: 'QUEUED' });
    expect(await balance(owner.id)).toEqual({ balance: 7, frozenBalance: 3 });
    expect((await submit({ ...image(), cost: 3 }, owner, key).expect(202)).body.id).toBe(created.body.id);
    await submit(image('changed'), owner, key).expect(409);
    expect(await balance(owner.id)).toEqual({ balance: 7, frozenBalance: 3 });
    const id = created.body.id as string;
    await get(`ai/tasks/${id}`, other).expect(404);
    expect(await drive(id)).toBe('COMPLETED');
    const done = (await get(`ai/tasks/${id}`).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED', outputs: [{ index: 0, contentType: 'image/png' }] });
    expect(await balance(owner.id)).toEqual({ balance: 7, frozenBalance: 0 });
    expect(media.calls.every(call => !JSON.stringify(call).includes('SYNTHETIC-MEDIA-KEY'))).toBe(true);
    await get(`ai/tasks/${id}/outputs/0`, other).expect(404);
    await get(`ai/tasks/${id}/outputs/1`).expect(404);
    const ticket = (await get(`ai/tasks/${id}/outputs/0`).expect(200)).body;
    expect(ticket).toMatchObject({ contentType: 'image/png', url: expect.stringMatching(/^\/api\/files\/[0-9a-f-]{36}\/download\?token=/) });
    const file = await request(server()).get(ticket.url).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((file.body as Buffer).equals(Buffer.from(FAKE_PNG_BASE64, 'base64'))).toBe(true);
    const list = (await get('ai/tasks?limit=5').expect(200)).body;
    expect(list.items.map((task: { id: string }) => task.id)).toContain(id);
    expect((await get('ai/tasks', other).expect(200)).body.items).toEqual([]);
    await request(server()).post(`/api/ai/tasks/${id}/cancel`).set('Authorization', `Bearer ${other.token}`).set('Origin', origin).expect(404);
  });

  it('releases the hold when the provider fails', async () => {
    const before = await balance(owner.id);
    media.enqueue({ outcome: 'failure', error: 'synthetic failure' });
    const created = await submit(image('fails')).expect(202);
    expect(await drive(created.body.id)).toBe('FAILED');
    const failed = (await get(`ai/tasks/${created.body.id}`).expect(200)).body;
    expect(failed).toMatchObject({ status: 'FAILED', charge: 'RELEASED', outputs: [] });
    expect(JSON.stringify(failed)).not.toContain('synthetic failure');
    expect(await balance(owner.id)).toEqual(before);
  });

  it('refuses insufficient credits with 402 and writes no task', async () => {
    await grant(other.id, 1);
    const refused = await submit(image(), other).expect(402);
    expect(refused.body).toMatchObject({ code: 'AI_TASK_INSUFFICIENT_CREDITS', result: { details: { required: 3 } } });
    const rows = await database.transaction(tx => tx.query<{ count: number }>(
      'SELECT (SELECT COUNT(*)::int FROM ai_tasks WHERE "ownerId"=$1) + (SELECT COUNT(*)::int FROM async_jobs WHERE "userId"=$1) AS count', [other.id]));
    expect(rows.rows[0].count).toBe(0);
    expect(await balance(other.id)).toEqual({ balance: 1, frozenBalance: 0 });
  });

  it('validates origin, catalog models, options and references', async () => {
    await request(server()).post('/api/ai/tasks').set('Authorization', `Bearer ${owner.token}`).set('Idempotency-Key', randomUUID()).send(image()).expect(403);
    await submit({ ...image(), model: 'gpt-image-unlisted' }).expect(400);
    await submit({ ...image(), options: { apiKey: 'x' } }).expect(400);
    await submit({ ...image(), options: { width: 10_000 } }).expect(400);
    await submit({ ...image(), references: [randomUUID()] }).expect(400);
    await submit({ ...image(), ownerId: other.id }).expect(400);
    await request(server()).post('/api/ai/tasks').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).send(image()).expect(400);
  });

  it('requires API key scope ai:generate on /v1/ai/tasks', async () => {
    const key = (await request(server()).post('/api/authorize/api-keys').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin)
      .send({ name: 'no ai scope' }).expect(201)).body.secretKey as string;
    await request(server()).post('/api/v1/ai/tasks').set('X-API-Key', key).set('Idempotency-Key', randomUUID()).send(image()).expect(403);
    // Integration adds ai:generate to ACCOUNT_KEY_SCOPES; simulate that wiring here to prove the route itself.
    (ACCOUNT_KEY_SCOPES as unknown as string[]).push('ai:generate');
    try {
      const scoped = await app.get(ApiKeyService).createApiKey({ userId: owner.id, name: 'ai', scopes: ['ai:generate'], expiresAt: new Date(Date.now() + 86_400_000) });
      const created = await request(server()).post('/api/v1/ai/tasks').set('X-API-Key', scoped.secretKey).set('Idempotency-Key', randomUUID()).send(image('api key')).expect(202);
      await request(server()).get(`/api/v1/ai/tasks/${created.body.id}`).set('X-API-Key', scoped.secretKey).expect(200);
      await request(server()).get(`/api/v1/ai/tasks/${created.body.id}`).set('X-API-Key', key).expect(403);
      expect(await drive(created.body.id)).toBe('COMPLETED');
    } finally { (ACCOUNT_KEY_SCOPES as unknown as string[]).pop(); }
  });

  it('only verified callbacks are accepted; forged ones change nothing', async () => {
    await request(server()).post('/api/ai/tasks/callbacks/unknown-provider').send({ taskId: 'x' }).expect(404);
    const forged = await request(server()).post('/api/ai/tasks/callbacks/fake-media').set('x-fake-signature', 'forged')
      .set('Content-Type', 'application/json').send(JSON.stringify({ taskId: 'fake-media-task-1', status: 'COMPLETED' })).expect(400);
    expect(forged.body).toMatchObject({ code: 'AI_CALLBACK_UNVERIFIED' });
    await request(server()).post('/api/ai/tasks/callbacks/fake-media').set('x-fake-signature', 'valid')
      .set('Content-Type', 'application/json').send(JSON.stringify({ taskId: 'unknown-task' })).expect(200);
  });

  it('exposes the read-only management projection to ai-tasks:query only', async () => {
    await get('management/ai-tasks', owner).expect(403);
    const page = (await get('management/ai-tasks?page=1&pageSize=50&status=COMPLETED', admin).expect(200)).body;
    expect(page).toMatchObject({ page: 1, pageSize: 50 });
    expect(page.total).toBeGreaterThanOrEqual(1);
    const row = page.data[0];
    expect(Object.keys(row).sort()).toEqual(['completedAt', 'cost', 'createdAt', 'errorCode', 'id', 'kind', 'model', 'outputCount', 'ownerId', 'prompt', 'providerId', 'status'].sort());
    expect((await get(`management/ai-tasks/${row.id}`, admin).expect(200)).body).toMatchObject({ id: row.id, outputCount: 1 });
    expect((await get('management/ai-tasks?status=FAILED', admin).expect(200)).body.data[0]).toMatchObject({ status: 'FAILED', errorCode: expect.any(String) });
    await get('management/ai-tasks?unknown=1', admin).expect(400);
  });

  it('rate-limits submits per user with 429', async () => {
    const limited = await member('ailimited');
    const statuses: number[] = [];
    for (let index = 0; index < 22; index += 1) statuses.push((await submit({ kind: 'image' }, limited)).status);
    expect(statuses.slice(0, 20).every(status => status === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});
