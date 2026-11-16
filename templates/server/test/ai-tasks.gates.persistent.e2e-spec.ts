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
import { FilesService } from '../src/files/files.service';
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
const schema = `zucker_ai_gates_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-ai-tasks-jwt-secret-of-32-characters',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt',
  POLICY_AI_CATALOG_IMAGE: JSON.stringify([{ providerId: 'fake-media', model: 'fake-image', label: 'Fake' }]),
  POLICY_AI_PRICING_IMAGE: JSON.stringify({ default: 2, byModel: { 'fake-image': 3 } }),
  POLICY_AI_CATALOG_VIDEO: JSON.stringify([{ providerId: 'fake-media', model: 'fake-video', label: 'Fake video' }]),
  POLICY_AI_PRICING_VIDEO: JSON.stringify({ default: 4, byModel: {} }),
  POLICY_AI_CATALOG_AUDIO: JSON.stringify([{ providerId: 'fake-media', model: 'fake-audio', label: 'Fake audio' }]),
  POLICY_AI_PRICING_AUDIO: JSON.stringify({ default: 2, byModel: {} }) };
const SENTINEL_KEY = 'SYNTHETIC-MEDIA-KEY-GATES', SENTINEL_RAW = 'SENTINEL-RAW-PROVIDER-TEXT';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16, 1)]);
/** Fake provider whose video/audio outputs are real container headers so the sniffing re-host accepts them. */
class ContainerMediaProvider extends FakeMediaProvider {
  override async getTaskStatus(taskId: string, config: Parameters<FakeMediaProvider['getTaskStatus']>[1]) {
    const result = await super.getTaskStatus(taskId, config);
    const bytes = (type: string | undefined) => (type === 'VIDEO' ? MP4 : type === 'AUDIO' ? MP3 : undefined);
    const patch = <T extends { mediaType?: string; base64?: string }>(output: T): T => {
      const body = bytes(output.mediaType);
      return body ? { ...output, base64: body.toString('base64') } : output;
    };
    return { ...result, ...(result.result ? { result: patch(result.result) } : {}), ...(result.outputs ? { outputs: result.outputs.map(patch) } : {}) };
  }
}
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));


run('AI tasks launch gates (HTTP + PostgreSQL, fake media provider)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, directory: string, host: JobsHost;
  let owner: { id: string; token: string }, other: { id: string; token: string }, admin: { id: string; token: string };
  const media = new ContainerMediaProvider({ defaultStep: { mode: 'async', pollsUntilDone: 1 } });
  const verifier = new FakeCallbackVerifier();
  const providers: AIMediaProviderEntry[] = [{ providerId: 'fake-media', name: 'Fake', kinds: ['image', 'video', 'audio'], provider: media,
    config: { apiKey: SENTINEL_KEY }, verifier }];
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const server = () => app.getHttpServer();
  const submit = (body: object, user = owner, key = randomUUID()) => request(server()).post('/api/ai/tasks')
    .set('Authorization', `Bearer ${user.token}`).set('Origin', origin).set('Idempotency-Key', key).send(body);
  const get = (path: string, user = owner) => request(server()).get(`/api/${path}`).set('Authorization', `Bearer ${user.token}`);
  const cancel = (id: string, user = owner) => request(server()).post(`/api/ai/tasks/${id}/cancel`).set('Authorization', `Bearer ${user.token}`).set('Origin', origin);
  const image = (prompt = 'A synthetic lighthouse') => ({ kind: 'image', providerId: 'fake-media', model: 'fake-image', prompt });
  const balance = async (id: string) => (await database.transaction(tx => tx.query<{ balance: number; frozenBalance: number }>(
    'SELECT balance, "frozenBalance" FROM credit_account WHERE "userId"=$1', [id]))).rows[0] ?? { balance: 0, frozenBalance: 0 };
  const journal = async (taskId: string) => (await database.transaction(tx => tx.query<{ type: string }>(
    `SELECT type FROM credit_transaction WHERE metadata->>'resourceId'=$1 ORDER BY type`, [taskId]))).rows.map(row => row.type);
  const grant = (id: string, amount: number) => database.transaction(tx => createCreditLedger(database).grant(tx, {
    accountId: id, amount, source: 'synthetic', sourceId: randomUUID(), transactionData: { type: 'GRANT', description: 'Synthetic grant' } }));
  async function drive(id: string) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
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
    directory = mkdtempSync(join(tmpdir(), 'zucker-ai-gates-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
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
        'api-default': limits, 'api-key': { points: 3000, duration: 60, blockDuration: 0 }, ...AI_TASK_RATE_LIMITERS, 'ai-submit': limits, 'ai-callback': limits } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...AI_POLICIES] }),
      AccountModule, AccountApiKeysModule, AITasksModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(AI_CONNECTION_ENVIRONMENT).useValue(Object.freeze({ ...env }))
      .overrideProvider(AI_MEDIA_PROVIDERS).useValue(providers)
      .overrideProvider(NativeAIClient).useValue({})
      .overrideProvider(AI_TASKS_OPTIONS).useValue({ polling: { initialDelayMs: 5, maxDelayMs: 20, earlyPollMinIntervalMs: 5 } })
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'ai-gates', concurrency: 1, scanIntervalMs: 100, leaseMs: 5000, heartbeatMs: 500, shutdownWaitMs: 2000 })
      .compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    host = app.get(JobsHost);
    await database.model('permissions').create({ data: { id: 'ai-tasks:query', name: 'ai-tasks:query' } });
    owner = await member('gateowner'); other = await member('gateother'); admin = await member('gateadmin', ['ai-tasks:query']);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
      if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it('gate 1: every task route answers 404 (never 200/403) for another user, and anonymous callers are refused', async () => {
    await grant(owner.id, 30);
    const created = (await submit(image('cross user'), owner).expect(202)).body.id as string;
    expect(await drive(created)).toBe('COMPLETED');
    const waiting = (await submit(image('cross user waiting'), owner).expect(202)).body.id as string;
    for (const id of [created, waiting]) {
      await get(`ai/tasks/${id}`, other).expect(404);
      await cancel(id, other).expect(404);
      await get(`ai/tasks/${id}/outputs/0`, other).expect(404);
    }
    await get(`ai/tasks/${randomUUID()}`, other).expect(404);
    await get('ai/tasks/not-an-id/outputs/0', other).expect(404);
    expect((await get('ai/tasks?limit=50', other).expect(200)).body.items).toEqual([]);
    // The foreign attempts changed nothing for the owner.
    expect((await get(`ai/tasks/${created}`).expect(200)).body).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED' });
    expect((await get(`ai/tasks/${waiting}`).expect(200)).body).toMatchObject({ charge: 'HELD', canCancel: true });
    await request(server()).get(`/api/ai/tasks/${created}`).expect(401);
    await request(server()).get(`/api/ai/tasks/${created}/outputs/0`).expect(401);
    await request(server()).post(`/api/ai/tasks/${waiting}/cancel`).set('Origin', origin).expect(401);
    // The owner's own cancel works and returns the hold.
    const before = await balance(owner.id);
    expect((await cancel(waiting).expect(201).catch(() => cancel(waiting).expect(200))).body).toMatchObject({ status: 'CANCELLED', charge: 'RELEASED' });
    expect((await balance(owner.id)).balance).toBe(before.balance + 3);
  });

  it('gate 6: 10 concurrent submits with one Idempotency-Key create one task and one hold', async () => {
    await grant(owner.id, 20);
    const key = randomUUID(), before = await balance(owner.id);
    const responses = await Promise.all(Array.from({ length: 10 }, () => submit(image('same key'), owner, key)));
    expect(responses.map(response => response.status)).toEqual(Array(10).fill(202));
    const ids = new Set(responses.map(response => response.body.id as string));
    expect(ids.size).toBe(1);
    expect(await balance(owner.id)).toEqual({ balance: before.balance - 3, frozenBalance: before.frozenBalance + 3 });
    expect(await journal([...ids][0])).toEqual(['FREEZE']);
    const rows = await database.transaction(tx => tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM ai_tasks WHERE id=$1', [[...ids][0]]));
    expect(rows.rows[0].n).toBe(1);
    expect(await drive([...ids][0])).toBe('COMPLETED');
  });

  it('gate 6: concurrent different keys with credit for only some succeed exactly as often as affordable and never overdraw', async () => {
    const buyer = await member('gatebuyer');
    await grant(buyer.id, 7); // image costs 3: two tasks fit, ten submissions race
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => submit(image(`race ${index}`), buyer)));
    const statuses = responses.map(response => response.status).sort();
    expect(statuses.filter(status => status === 202)).toHaveLength(2);
    expect(statuses.filter(status => status === 402)).toHaveLength(8);
    expect(responses.filter(response => response.status === 402).every(response => response.body.code === 'AI_TASK_INSUFFICIENT_CREDITS')).toBe(true);
    expect(await balance(buyer.id)).toEqual({ balance: 1, frozenBalance: 6 });
    const count = await database.transaction(tx => tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM ai_tasks WHERE "ownerId"=$1', [buyer.id]));
    expect(count.rows[0].n).toBe(2);
    for (const response of responses.filter(entry => entry.status === 202)) expect(await drive(response.body.id)).toBe('COMPLETED');
    expect(await balance(buyer.id)).toEqual({ balance: 1, frozenBalance: 0 });
  });

  it('gate 2: unsigned, forged and replayed callbacks change nothing', async () => {
    await grant(owner.id, 10);
    const created = (await submit(image('callback target')).expect(202)).body.id as string;
    await host.runTask(created).catch(() => undefined);
    const providerTaskId = (await database.transaction(tx => tx.query<{ providerTaskId: string }>('SELECT "providerTaskId" FROM ai_tasks WHERE id=$1', [created]))).rows[0].providerTaskId;
    expect(providerTaskId).toBeTruthy();
    const snapshot = async () => (await database.transaction(tx => tx.query('SELECT "callbackOutcome","holdState","providerTaskId" FROM ai_tasks WHERE id=$1', [created]))).rows[0];
    const before = await snapshot();
    const callback = (headers: Record<string, string>, body: string) => request(server()).post('/api/ai/tasks/callbacks/fake-media')
      .set('Content-Type', 'application/json').set(headers).send(body);
    const claim = JSON.stringify({ taskId: providerTaskId, status: 'COMPLETED', outputs: [{ url: 'https://evil.example.test/x.png' }] });
    // Missing signature, wrong signature, malformed body: 400 and nothing recorded.
    for (const [headers, body] of [[{}, claim], [{ 'x-fake-signature': 'forged' }, claim], [{ 'x-fake-signature': 'valid' }, 'not-json'], [{}, '{}']] as const)
      expect((await callback({ ...headers }, body)).status).toBeGreaterThanOrEqual(400);
    expect(await snapshot()).toEqual(before);
    expect((await get(`ai/tasks/${created}`).expect(200)).body).toMatchObject({ charge: 'HELD', outputs: [] });
    expect(await journal(created)).toEqual(['FREEZE']);
    expect(await drive(created)).toBe('COMPLETED');
    const settled = await journal(created), done = (await get(`ai/tasks/${created}`).expect(200)).body;
    // Replay of both the forged and the signed callback after settlement is inert.
    await callback({ 'x-fake-signature': 'forged' }, claim);
    await callback({ 'x-fake-signature': 'valid' }, claim);
    await callback({ 'x-fake-signature': 'valid' }, claim);
    expect(await host.runTask(created).catch(() => 'rejected')).toBeDefined();
    expect(await journal(created)).toEqual(settled);
    expect(settled).toEqual(['CONSUME', 'FREEZE', 'UNFREEZE'].filter(type => settled.includes(type)));
    expect(settled.filter(type => type === 'CONSUME')).toHaveLength(1);
    expect((await get(`ai/tasks/${created}`).expect(200)).body).toEqual(JSON.parse(JSON.stringify(done)));
  });

  it('cancel racing completion settles exactly once (CONFIRMED xor RELEASED), never both', async () => {
    const racer = await member('gateracer');
    await grant(racer.id, 300);
    const outcomes: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      const id = (await submit(image(`race ${round}`), racer).expect(202)).body.id as string;
      const [cancelled] = await Promise.all([
        sleep(round * 4).then(() => cancel(id, racer)),
        host.runTask(id).catch(() => undefined).then(() => host.runTask(id).catch(() => undefined)),
      ]);
      expect([200, 201]).toContain(cancelled.status);
      const status = await drive(id);
      outcomes.push(status);
      const entries = await journal(id), view = (await get(`ai/tasks/${id}`, racer).expect(200)).body;
      expect(entries.filter(type => type === 'FREEZE')).toHaveLength(1);
      if (status === 'COMPLETED') {
        expect(view).toMatchObject({ charge: 'CONFIRMED' });
        expect(entries.filter(type => type === 'CONSUME')).toHaveLength(1);
        expect(entries.filter(type => type === 'UNFREEZE')).toHaveLength(0);
      } else {
        expect(status).toBe('CANCELLED');
        expect(view).toMatchObject({ charge: 'RELEASED', outputs: [] });
        expect(entries.filter(type => type === 'CONSUME')).toHaveLength(0);
        expect(entries.filter(type => type === 'UNFREEZE')).toHaveLength(1);
      }
    }
    const wallet = await balance(racer.id);
    expect(wallet.frozenBalance).toBe(0);
    expect(wallet.balance).toBe(300 - outcomes.filter(status => status === 'COMPLETED').length * 3);
  });

  it('references: a foreign file id is refused, an own ready PNG reaches the provider as inline bytes only', async () => {
    await grant(owner.id, 10);
    const files = app.get(FilesService);
    const foreign = await files.upload(other.id, 'foreign-ref-000001', { originalname: 'ref.png', buffer: Buffer.from(FAKE_PNG_BASE64, 'base64') });
    const own = await files.upload(owner.id, 'own-ref-00000001', { originalname: 'ref.png', buffer: Buffer.from(FAKE_PNG_BASE64, 'base64') });
    const refused = await submit({ ...image(), references: [foreign.id] }).expect(400);
    expect(refused.body).toMatchObject({ code: 'AI_TASK_REFERENCE_INVALID' });
    expect(JSON.stringify(refused.body)).not.toContain(foreign.id);
    const before = await balance(owner.id);
    expect(before.frozenBalance).toBeGreaterThanOrEqual(0);
    const created = (await submit({ ...image('with reference'), references: [own.id] }).expect(202)).body;
    expect(await drive(created.id)).toBe('COMPLETED');
    const call = media.calls.filter(entry => entry.method === 'generate').at(-1)!;
    expect(String((call.config as { referenceImageUrls?: string[] }).referenceImageUrls?.[0])).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(created)).not.toContain(own.id);
  });

  it('video and audio complete through the same pipeline, are priced per kind and download as their own type', async () => {
    const maker = await member('gatemaker');
    await grant(maker.id, 10);
    const video = (await submit({ kind: 'video', providerId: 'fake-media', model: 'fake-video', prompt: 'a moving lighthouse', options: { duration: 4 } }, maker).expect(202)).body;
    const audio = (await submit({ kind: 'audio', providerId: 'fake-media', model: 'fake-audio', prompt: 'calm waves', options: { duration: 5, instrumental: true } }, maker).expect(202)).body;
    expect(video).toMatchObject({ kind: 'video', cost: 4, charge: 'HELD' });
    expect(audio).toMatchObject({ kind: 'audio', cost: 2, charge: 'HELD' });
    expect(await balance(maker.id)).toEqual({ balance: 4, frozenBalance: 6 });
    expect(await drive(video.id)).toBe('COMPLETED');
    expect(await drive(audio.id)).toBe('COMPLETED');
    expect(await balance(maker.id)).toEqual({ balance: 4, frozenBalance: 0 });
    const catalog = (await request(server()).get('/api/ai/catalog').expect(200)).body;
    expect(catalog.video[0]).toMatchObject({ model: 'fake-video', cost: 4 });
    expect(catalog.audio[0]).toMatchObject({ model: 'fake-audio', cost: 2 });
    for (const [task, contentType, bytes] of [[video, 'video/mp4', MP4], [audio, 'audio/mpeg', MP3]] as const) {
      const ticket = (await get(`ai/tasks/${task.id}/outputs/0`, maker).expect(200)).body;
      expect(ticket).toMatchObject({ contentType, bytes: bytes.length });
      await get(`ai/tasks/${task.id}/outputs/0`, other).expect(404);
      const file = await request(server()).get(ticket.url).buffer(true).parse((res, done) => {
        const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
      }).expect(200);
      expect((file.body as Buffer).equals(bytes)).toBe(true);
    }
    // Options of one kind are refused on another.
    await submit({ kind: 'audio', providerId: 'fake-media', model: 'fake-audio', prompt: 'x', options: { width: 512 } }, maker).expect(400);
    await submit({ kind: 'audio', providerId: 'fake-media', model: 'fake-audio', prompt: 'x', references: [randomUUID()] }, maker).expect(400);
    // A non-media body sniffed from a provider (fake bytes without a container header) fails and refunds.
    const plain = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 0 } });
    const entry = providers[0], original = entry.provider;
    (entry as { provider: unknown }).provider = plain;
    try {
      await grant(maker.id, 4);
      const before = await balance(maker.id);
      const bad = (await submit({ kind: 'video', providerId: 'fake-media', model: 'fake-video', prompt: 'unsniffable output' }, maker).expect(202)).body;
      expect(await drive(bad.id)).toBe('FAILED');
      expect((await get(`ai/tasks/${bad.id}`, maker).expect(200)).body).toMatchObject({ status: 'FAILED', charge: 'RELEASED', outputs: [] });
      expect(await balance(maker.id)).toEqual(before);
    } finally { (entry as { provider: unknown }).provider = original; }
  });

  it('management projections truncate prompts and carry no provider payloads, ids or secrets', async () => {
    await grant(owner.id, 20);
    const long = `${'x'.repeat(260)}TAIL-MARKER`;
    media.enqueue({ outcome: 'failure', error: SENTINEL_RAW });
    const failed = (await submit(image(long)).expect(202)).body.id as string;
    expect(await drive(failed)).toBe('FAILED');
    const ok = (await submit(image('projection ok')).expect(202)).body.id as string;
    expect(await drive(ok)).toBe('COMPLETED');
    const providerIds = (await database.transaction(tx => tx.query<{ providerTaskId: string | null; holdId: string | null }>('SELECT "providerTaskId","holdId" FROM ai_tasks'))).rows
      .flatMap(row => [row.providerTaskId, row.holdId]).filter((value): value is string => Boolean(value));
    const keys = (await database.transaction(tx => tx.query<{ storageKey: string }>('SELECT "storageKey" FROM ai_task_outputs'))).rows.map(row => row.storageKey);
    const surfaces: string[] = [];
    const page = (await get('management/ai-tasks?page=1&pageSize=100', admin).expect(200)).body;
    surfaces.push(JSON.stringify(page));
    const row = page.data.find((entry: { id: string }) => entry.id === failed);
    expect(row.prompt.length).toBeLessThanOrEqual(201);
    expect(row.prompt).not.toContain('TAIL-MARKER');
    surfaces.push(JSON.stringify((await get(`management/ai-tasks/${failed}`, admin).expect(200)).body));
    surfaces.push(JSON.stringify((await get(`ai/tasks/${failed}`).expect(200)).body));
    surfaces.push(JSON.stringify((await get(`ai/tasks/${ok}`).expect(200)).body));
    surfaces.push(JSON.stringify((await get('ai/tasks?limit=50').expect(200)).body));
    surfaces.push(JSON.stringify((await request(server()).get('/api/ai/catalog').expect(200)).body));
    expect(surfaces.length).toBe(6);
    for (const text of surfaces) {
      expect(text).not.toContain(SENTINEL_KEY);
      expect(text).not.toContain(SENTINEL_RAW);
      expect(text).not.toMatch(/fake-media-task-|storageKey|providerTaskId|holdId|callbackOutcome|"apiKey"/);
      for (const secret of [...providerIds, ...keys]) expect(text).not.toContain(secret);
    }
    // Management is read-only: every write verb is refused for the admin as well.
    await request(server()).post('/api/management/ai-tasks').set('Authorization', `Bearer ${admin.token}`).set('Origin', origin).send({}).expect(res => { if (res.status < 400) throw new Error(`unexpected ${res.status}`); });
    await request(server()).delete(`/api/management/ai-tasks/${ok}`).set('Authorization', `Bearer ${admin.token}`).set('Origin', origin).expect(res => { if (res.status < 400) throw new Error(`unexpected ${res.status}`); });
    expect(media.calls.every(call => !JSON.stringify(call).includes(SENTINEL_KEY))).toBe(true);
  });
});
