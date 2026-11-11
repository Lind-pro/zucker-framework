import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ZuckerStorageModule } from '@zucker-framework/storage';
import { AICallWrapper, NativeAIClient, type AIConfigService } from '@zucker-framework/ai';
import { FakeChatModel } from '@zucker-framework/ai/testing';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { createCreditLedger } from '../src/billing/ledger';
import { AI_CONNECTION_ENVIRONMENT } from '../src/ai-connections/ai-connections.module';
import { AI_MEDIA_PROVIDERS } from '../src/ai-connections/ai-media-providers';
import { AI_POLICIES } from '../src/ai-tasks/ai.policy';
import { AI_TASK_RATE_LIMITERS } from '../src/ai-tasks/ai-tasks.controller';
import { ChatModule } from '../src/chat/chat.module';
import { CHAT_RATE_LIMITERS } from '../src/chat/chat.controller';
import { chatCost } from '../src/chat/chat.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_chat_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const PRICE = { per1kInputTokens: 1, per1kOutputTokens: 2, minimum: 1 };
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-chat-jwt-secret-of-at-least-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt',
  AI_OPENAI_ENABLED: 'true', AI_OPENAI_API_KEY: 'SYNTHETIC-CHAT-KEY', AI_OPENAI_MODEL_ID: 'fake-chat',
  POLICY_AI_PRICING_CHAT: JSON.stringify(PRICE) };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
interface SseEvent { event: string; data: Record<string, unknown> }
function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').filter(Boolean).map(block => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message', data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}

run('chat HTTP + PostgreSQL contract (fake chat model)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, directory: string;
  let owner: { id: string; token: string }, other: { id: string; token: string }, admin: { id: string; token: string };
  const model = new FakeChatModel({ model: 'fake-chat' });
  const configs = { getScenarioConfig: async () => ({ apiKey: 'SYNTHETIC-CHAT-KEY', modelId: 'fake-chat', providerId: 'openai', timeoutMs: 10_000 }) } as unknown as AIConfigService;
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const server = () => app.getHttpServer();
  const auth = (req: request.Test, user = owner) => req.set('Authorization', `Bearer ${user.token}`).set('Origin', origin);
  const text = (req: request.Test) => req.buffer(true).parse((res, done) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { body += chunk; }); res.on('end', () => done(null, body));
  });
  const say = (chatId: string, body: object, user = owner) => text(auth(request(server()).post(`/api/chat/${chatId}/messages`), user).send(body));
  const wallet = async (id: string) => (await database.transaction(tx => tx.query<{ balance: number; frozenBalance: number }>(
    'SELECT balance, "frozenBalance" FROM credit_account WHERE "userId"=$1', [id]))).rows[0] ?? { balance: 0, frozenBalance: 0 };
  const journal = async (messageId: string) => (await database.transaction(tx => tx.query<{ type: string; amount: number }>(
    `SELECT type, amount FROM credit_transaction WHERE metadata->>'resourceId'=$1 ORDER BY "createdAt", id`, [messageId]))).rows;
  const grant = (id: string, amount: number) => database.transaction(tx => createCreditLedger(database).grant(tx, {
    accountId: id, amount, source: 'synthetic', sourceId: randomUUID(), transactionData: { type: 'GRANT' } }));
  const newChat = async (user = owner) => (await auth(request(server()).post('/api/chat'), user).send({}).expect(201)).body as { id: string; providerId: string; model: string };
  async function member(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`, password = 'SyntheticChat9!';
    const send = (path: string, body: object) => request(server()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: login.body.userId as string, token: login.body.token as string };
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-chat-'));
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
        'session-read': limits, 'api-default': limits, ...AI_TASK_RATE_LIMITERS, ...CHAT_RATE_LIMITERS } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...AI_POLICIES] }),
      AccountModule, ChatModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(AI_CONNECTION_ENVIRONMENT).useValue(Object.freeze({ ...env }))
      .overrideProvider(AI_MEDIA_PROVIDERS).useValue([])
      .overrideProvider(NativeAIClient).useValue(new NativeAIClient(configs, new AICallWrapper(), model.factory))
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'chat', concurrency: 1, scanIntervalMs: 100, leaseMs: 5000, heartbeatMs: 500, shutdownWaitMs: 2000 })
      .compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    await database.model('permissions').create({ data: { id: 'chats:query', name: 'chats:query' } });
    owner = await member('chatowner'); other = await member('chatother'); admin = await member('chatadmin', ['chats:query']);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
      if (directory) rmSync(directory, { recursive: true, force: true }); }
  });

  it('creates owner-scoped chats with the default enabled connection; others get 404', async () => {
    const chat = await newChat();
    expect(chat).toMatchObject({ providerId: 'ai-openai', model: 'fake-chat', messageCount: 0, cost: 0 });
    await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${other.token}`).expect(404);
    await auth(request(server()).delete(`/api/chat/${chat.id}`), other).expect(404);
    await say(chat.id, { content: 'hi' }, other).expect(404);
    await auth(request(server()).post('/api/chat'), owner).send({ providerId: 'ai-openai', model: 'not-offered' }).expect(400);
    await request(server()).post('/api/chat').set('Authorization', `Bearer ${owner.token}`).send({}).expect(403);
    expect((await request(server()).get('/api/chat').set('Authorization', `Bearer ${other.token}`).expect(200)).body.items).toEqual([]);
  });

  it('streams a turn and charges exactly the metered usage (hold minimum, release, consume actual)', async () => {
    await grant(owner.id, 20);
    const chat = await newChat();
    const usage = { input: 1000, output: 2000, total: 3000 };
    model.enqueue({ chunks: ['Hello ', 'world'], reasoning: 'thinking', usage });
    const response = await say(chat.id, { content: 'Say hello' }).expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(response.body as string);
    expect(events.map(event => event.event)).toEqual(['start', 'reasoning', 'delta', 'delta', 'done']);
    const expected = chatCost(PRICE, usage);
    expect(expected).toBe(5);
    expect(events[0].data).toMatchObject({ chatId: chat.id, held: 1, model: 'fake-chat' });
    expect(events[4].data).toMatchObject({ usage: { input: 1000, output: 2000 }, cost: expected });
    expect(await wallet(owner.id)).toEqual({ balance: 15, frozenBalance: 0 });
    const messageId = events[0].data.messageId as string;
    expect(await journal(messageId)).toEqual([{ type: 'FREEZE', amount: -1 }, { type: 'UNFREEZE', amount: 1 }, { type: 'CONSUME', amount: -5 }]);
    const view = (await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${owner.token}`).expect(200)).body;
    expect(view).toMatchObject({ title: 'Say hello', messageCount: 2, cost: 5 });
    expect(view.messages).toMatchObject([{ role: 'user', content: 'Say hello', status: 'COMPLETE' },
      { role: 'assistant', content: 'Hello world', reasoning: 'thinking', status: 'COMPLETE', cost: 5, usage: { input: 1000, output: 2000 } }]);
    // The model received the history and a token budget, never the reasoning as answer text.
    expect(model.calls.at(-1)?.request?.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
  });

  it('returns the whole hold when the provider fails before the first token', async () => {
    const chat = await newChat(), before = await wallet(owner.id);
    model.enqueue({ error: 500 });
    const failed = await say(chat.id, { content: 'fail please' }).expect(502);
    expect(JSON.parse(failed.body as string)).toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    expect(await wallet(owner.id)).toEqual(before);
    const view = (await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${owner.token}`).expect(200)).body;
    expect(view.messages[1]).toMatchObject({ role: 'assistant', status: 'FAILED', cost: 0, errorCode: 'AI_PROVIDER_FAILED' });
  });

  it('aborts the provider call on client disconnect and settles the partial answer once', async () => {
    const chat = await newChat(), before = await wallet(owner.id);
    const callsBefore = model.calls.length;
    model.enqueue({ chunks: Array.from({ length: 50 }, (_, index) => `word${index} `), delayMs: 40 });
    const { port } = (app.getHttpServer().address() as AddressInfo);
    await new Promise<void>((done, fail) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/chat/${chat.id}/messages`,
        headers: { Authorization: `Bearer ${owner.token}`, Origin: origin, 'Content-Type': 'application/json' } }, res => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { if (chunk.includes('event: delta')) { req.destroy(); done(); } });
      });
      req.on('error', () => undefined);
      setTimeout(() => fail(new Error('No delta arrived')), 5000);
      req.end(JSON.stringify({ content: 'long answer please' }));
    });
    let message: { status: string; cost: number; id: string; content: string } | undefined;
    for (let attempt = 0; attempt < 100 && (!message || message.status === 'STREAMING'); attempt += 1) {
      await sleep(30);
      message = (await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${owner.token}`).expect(200)).body.messages[1];
    }
    expect(message).toMatchObject({ status: 'ABORTED', errorCode: 'AI_CHAT_ABORTED' });
    expect(model.calls.length).toBe(callsBefore + 1);
    expect(message!.content.length).toBeGreaterThan(0);
    expect(message!.content.split(' ').length).toBeLessThan(50);
    expect(message!.cost).toBeGreaterThanOrEqual(PRICE.minimum);
    await sleep(200);
    const entries = await journal(message!.id);
    expect(entries.filter(entry => entry.type === 'UNFREEZE')).toHaveLength(1);
    expect(entries.filter(entry => entry.type === 'CONSUME')).toEqual([{ type: 'CONSUME', amount: -message!.cost }]);
    expect(await wallet(owner.id)).toEqual({ balance: before.balance - message!.cost, frozenBalance: 0 });
  });

  it('refuses a turn without credits (402), web search (400) and an untrusted origin (403)', async () => {
    const chat = await newChat(other);
    const refused = await say(chat.id, { content: 'no credits' }, other).expect(402);
    expect(JSON.parse(refused.body as string)).toMatchObject({ code: 'AI_TASK_INSUFFICIENT_CREDITS', result: { details: { required: 1, available: 0 } } });
    expect((await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${other.token}`).expect(200)).body.messages).toEqual([]);
    await say(chat.id, { content: 'search', webSearch: true }, other).expect(400);
    await request(server()).post(`/api/chat/${chat.id}/messages`).set('Authorization', `Bearer ${other.token}`).send({ content: 'x' }).expect(403);
  });

  it('deletes an owned chat and lists sessions in the management projection without content', async () => {
    await request(server()).get('/api/management/chats').set('Authorization', `Bearer ${owner.token}`).expect(403);
    const page = (await request(server()).get(`/api/management/chats?ownerId=${owner.id}`).set('Authorization', `Bearer ${admin.token}`).expect(200)).body;
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(Object.keys(page.data[0]).sort()).toEqual(['cost', 'createdAt', 'id', 'messageCount', 'model', 'ownerId', 'providerId', 'title', 'updatedAt']);
    const chat = await newChat();
    await auth(request(server()).delete(`/api/chat/${chat.id}`)).expect(200);
    await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${owner.token}`).expect(404);
    expect((await request(server()).get(`/api/management/chats/${chat.id}`).set('Authorization', `Bearer ${admin.token}`).expect(200)).body).toEqual({});
  });

  it('rate-limits turns per user with 429', async () => {
    const limited = await member('chatlimited'), chat = await newChat(limited);
    const statuses: number[] = [];
    for (let index = 0; index < 32; index += 1) statuses.push((await say(chat.id, { content: '' }, limited)).status);
    expect(statuses.slice(0, 30).every(status => status === 400)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });
});
