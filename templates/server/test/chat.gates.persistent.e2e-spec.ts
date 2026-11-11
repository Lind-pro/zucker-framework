import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { CHAT_OPTIONS, ChatService, chatCost } from '../src/chat/chat.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_chat_gates_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const PRICE = { per1kInputTokens: 1, per1kOutputTokens: 2, minimum: 1 };
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-chat-jwt-secret-of-at-least-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt',
  AI_OPENAI_ENABLED: 'true', AI_OPENAI_API_KEY: 'SYNTHETIC-CHAT-KEY-GATES', AI_OPENAI_MODEL_ID: 'fake-chat',
  POLICY_AI_PRICING_CHAT: JSON.stringify(PRICE) };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
interface SseEvent { event: string; data: Record<string, unknown> }
function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').filter(Boolean).map(block => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message', data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}

run('chat launch gates (HTTP + PostgreSQL, fake chat model)', () => {
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
    directory = mkdtempSync(join(tmpdir(), 'zucker-chat-gates-'));
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
      .overrideProvider(CHAT_OPTIONS).useValue({ maxOutputTokens: 4096, staleAfterMs: 200 })
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'chat', concurrency: 1, scanIntervalMs: 100, leaseMs: 5000, heartbeatMs: 500, shutdownWaitMs: 2000 })
      .compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    await database.model('permissions').create({ data: { id: 'chats:query', name: 'chats:query' } });
    owner = await member('gchatowner'); other = await member('gchatother'); admin = await member('gchatadmin', ['chats:query']);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
      if (directory) rmSync(directory, { recursive: true, force: true }); }
  });


  // Unconsumed scripted steps (e.g. refused concurrent turns) must not leak into the next test.
  beforeEach(() => { (model as unknown as { queue: unknown[] }).queue.length = 0; });
  const hold = async (messageId: string) => (await journal(messageId)).map(entry => entry.type);
  const view = async (chatId: string, user = owner) => (await request(server()).get(`/api/chat/${chatId}`).set('Authorization', `Bearer ${user.token}`).expect(200)).body;
  const openStream = (chatId: string, content: string, user = owner) => {
    const { port } = (app.getHttpServer().address() as AddressInfo);
    let req!: http.ClientRequest, raw = '';
    const firstDelta = new Promise<void>((done, fail) => {
      req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/chat/${chatId}/messages`,
        headers: { Authorization: `Bearer ${user.token}`, Origin: origin, 'Content-Type': 'application/json' } }, res => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { raw += chunk; if (chunk.includes('event: delta')) done(); });
        res.on('end', () => done());
      });
      req.on('error', () => undefined);
      setTimeout(() => fail(new Error('No delta arrived')), 8000);
      req.end(JSON.stringify({ content }));
    });
    return { req, firstDelta, raw: () => raw };
  };

  it('gate 1: every chat route answers 404 for another user and changes nothing', async () => {
    const chat = await newChat();
    await grant(owner.id, 10);
    model.enqueue({ chunks: ['private ', 'answer'], usage: { input: 10, output: 10, total: 20 } });
    await say(chat.id, { content: 'owner secret question' }).expect(200);
    const before = await view(chat.id), wallet0 = await wallet(other.id);
    const bearer = (req: request.Test) => req.set('Authorization', `Bearer ${other.token}`).set('Origin', origin);
    await bearer(request(server()).get(`/api/chat/${chat.id}`)).expect(404);
    await bearer(request(server()).delete(`/api/chat/${chat.id}`)).expect(404);
    await bearer(request(server()).post(`/api/chat/${chat.id}/messages`)).send({ content: 'hijack' }).expect(404);
    await bearer(request(server()).get('/api/chat/not-a-uuid')).expect(404);
    await bearer(request(server()).get(`/api/chat/${randomUUID()}`)).expect(404);
    const list = (await bearer(request(server()).get('/api/chat?limit=100')).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(chat.id);
    await request(server()).get(`/api/chat/${chat.id}`).expect(401);
    await request(server()).delete(`/api/chat/${chat.id}`).set('Origin', origin).expect(401);
    expect(await view(chat.id)).toEqual(JSON.parse(JSON.stringify(before)));
    expect(await wallet(other.id)).toEqual(wallet0);
  });

  it('gate 6: concurrent turns on one chat run one turn and one hold; the rest get 409 AI_CHAT_BUSY', async () => {
    await grant(owner.id, 30);
    const chat = await newChat(), before = await wallet(owner.id);
    model.enqueue({ chunks: Array.from({ length: 6 }, (_, i) => `slow${i} `), delayMs: 120 });
    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => say(chat.id, { content: `concurrent ${i}` })));
    const statuses = responses.map(response => response.status).sort();
    expect(statuses.filter(status => status === 200)).toHaveLength(1);
    expect(statuses.filter(status => status === 409)).toHaveLength(4);
    for (const rejected of responses.filter(response => response.status === 409)) expect(JSON.parse(rejected.body as string)).toMatchObject({ code: 'AI_CHAT_BUSY' });
    const messages = (await view(chat.id)).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ status: 'COMPLETE' });
    expect(await hold(messages[1].id)).toEqual(['FREEZE', 'UNFREEZE', 'CONSUME']);
    expect(await wallet(owner.id)).toEqual({ balance: before.balance - messages[1].cost, frozenBalance: 0 });
  });

  it('gate 6: concurrent turns on different chats with credit for only some are admitted exactly as often as affordable', async () => {
    const buyer = await member('gchatbuyer');
    await grant(buyer.id, 2); // minimum hold is 1 credit
    const chats = await Promise.all(Array.from({ length: 6 }, () => newChat(buyer)));
    model.enqueue(...Array.from({ length: 6 }, () => ({ chunks: ['a ', 'b ', 'c '], delayMs: 150, usage: { input: 1, output: 1, total: 2 } })));
    const responses = await Promise.all(chats.map(chat => say(chat.id, { content: 'race' }, buyer)));
    const ok = responses.filter(response => response.status === 200), refused = responses.filter(response => response.status === 402);
    expect(ok.length + refused.length).toBe(6);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeLessThanOrEqual(2);
    const wallet1 = await wallet(buyer.id);
    expect(wallet1.balance).toBeGreaterThanOrEqual(0);
    expect(wallet1.frozenBalance).toBe(0);
    expect(wallet1.balance).toBe(2 - ok.length * 1);
    for (const response of refused) expect(JSON.parse(response.body as string)).toMatchObject({ code: 'AI_TASK_INSUFFICIENT_CREDITS' });
  });

  it('gate 6: a cost above the hold is capped to what the wallet can pay and never goes negative', async () => {
    const poor = await member('gchatpoor');
    await grant(poor.id, 4);
    const chat = await newChat(poor);
    // Metered usage worth 11 credits (1000 in x1 + 5000 out x2 per 1k) against 4 spendable.
    model.enqueue({ chunks: ['expensive ', 'answer'], usage: { input: 1000, output: 5000, total: 6000 } });
    const response = await say(chat.id, { content: 'cost more than I have' }, poor).expect(200);
    const events = parseSse(response.body as string);
    expect(events.at(-1)?.event).toBe('done');
    const charged = events.at(-1)!.data.cost as number;
    expect(charged).toBeLessThanOrEqual(4);
    expect(charged).toBeGreaterThan(0);
    expect(await wallet(poor.id)).toEqual({ balance: 4 - charged, frozenBalance: 0 });
    // The model was told to stay within what the wallet can pay.
    expect(model.calls.at(-1)?.request?.maxTokens).toBeLessThanOrEqual(4096);
    const messageId = events[0].data.messageId as string;
    const entries = await journal(messageId);
    expect(entries.filter(entry => entry.type === 'CONSUME').reduce((sum, entry) => sum - entry.amount, 0)).toBe(charged);
    expect((await view(chat.id, poor)).messages[1]).toMatchObject({ status: 'COMPLETE', cost: charged });
    // With nothing left the next turn is refused instead of going negative.
    const empty = await say(chat.id, { content: 'again' }, poor);
    expect(empty.status).toBe(402);
    expect((await wallet(poor.id)).balance).toBeGreaterThanOrEqual(0);
  });

  it('gate 6: a wallet drained between the hold and the settlement still settles once without a negative balance', async () => {
    const drained = await member('gchatdrained');
    await grant(drained.id, 5);
    const chat = await newChat(drained);
    model.enqueue({ chunks: Array.from({ length: 8 }, (_, i) => `part${i} `), delayMs: 100, usage: { input: 1000, output: 8000, total: 9000 } });
    const turn = openStream(chat.id, 'drain me', drained);
    await turn.firstDelta;
    // Another spend takes everything that is left while the answer is still streaming.
    const rest = (await wallet(drained.id)).balance;
    if (rest > 0) await database.transaction(tx => createCreditLedger(database).consume(tx, { accountId: drained.id, amount: rest,
      transactionData: { type: 'CONSUME', description: 'Synthetic competing spend' }, consumptionData: { resourceType: 'synthetic', resourceId: randomUUID() } }));
    for (let attempt = 0; attempt < 100 && !turn.raw().includes('event: done'); attempt += 1) await sleep(50);
    expect(turn.raw()).toContain('event: done');
    const state = await wallet(drained.id);
    expect(state.balance).toBeGreaterThanOrEqual(0);
    expect(state.frozenBalance).toBe(0);
    const message = (await view(chat.id, drained)).messages[1];
    expect(message.status).toBe('COMPLETE');
    const entries = await journal(message.id);
    expect(entries.filter(entry => entry.type === 'UNFREEZE')).toHaveLength(1);
    expect(entries.filter(entry => entry.type === 'CONSUME').reduce((sum, entry) => sum - entry.amount, 0)).toBe(message.cost);
  });

  it('a mid-stream provider failure charges what was delivered once and ends with an error event', async () => {
    await grant(owner.id, 20);
    const chat = await newChat(), before = await wallet(owner.id);
    model.enqueue({ chunks: ['one ', 'two ', 'three ', 'four '], failAfterChunks: 2, error: 500 });
    const response = await say(chat.id, { content: 'fail midway' }).expect(200);
    const events = parseSse(response.body as string);
    expect(events.map(event => event.event)).toEqual(['start', 'delta', 'delta', 'error']);
    expect(events.at(-1)!.data).toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    const message = (await view(chat.id)).messages[1];
    expect(message).toMatchObject({ status: 'FAILED', content: 'one two ', errorCode: 'AI_PROVIDER_FAILED' });
    expect(message.cost).toBeGreaterThanOrEqual(PRICE.minimum);
    expect(await hold(message.id)).toEqual(['FREEZE', 'UNFREEZE', 'CONSUME']);
    expect(await wallet(owner.id)).toEqual({ balance: before.balance - message.cost, frozenBalance: 0 });
  });

  it('a disconnect before any token releases the whole hold and a disconnect mid-stream settles exactly once', async () => {
    await grant(owner.id, 20);
    const chat = await newChat(), before = await wallet(owner.id);
    // Slow first token, client leaves before it: nothing delivered, nothing charged.
    model.enqueue({ chunks: ['late '], delayMs: 600 });
    const { port } = (app.getHttpServer().address() as AddressInfo);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/chat/${chat.id}/messages`,
      headers: { Authorization: `Bearer ${owner.token}`, Origin: origin, 'Content-Type': 'application/json' } });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ content: 'leave early' }));
    await sleep(250); req.destroy();
    let message = (await view(chat.id)).messages[1] as { id: string; status: string; cost: number } | undefined;
    for (let attempt = 0; attempt < 100 && (!message || message.status === 'STREAMING'); attempt += 1) { await sleep(40); message = (await view(chat.id)).messages[1]; }
    expect(message).toMatchObject({ status: 'ABORTED', cost: 0 });
    expect(await wallet(owner.id)).toEqual(before);
    expect(await hold(message!.id)).toEqual(['FREEZE', 'UNFREEZE']);
    // Mid-stream disconnect, repeated: always exactly one UNFREEZE and at most one CONSUME.
    for (let round = 0; round < 3; round += 1) {
      const next = await newChat();
      model.enqueue({ chunks: Array.from({ length: 30 }, (_, i) => `w${i} `), delayMs: 30 });
      const turn = openStream(next.id, `long ${round}`);
      await turn.firstDelta; await sleep(round * 40); turn.req.destroy();
      let settled = (await view(next.id)).messages[1] as { id: string; status: string; cost: number };
      for (let attempt = 0; attempt < 100 && settled.status === 'STREAMING'; attempt += 1) { await sleep(40); settled = (await view(next.id)).messages[1]; }
      await sleep(200);
      const entries = await hold(settled.id);
      expect(settled.status).toBe('ABORTED');
      expect(entries.filter(type => type === 'UNFREEZE')).toHaveLength(1);
      expect(entries.filter(type => type === 'CONSUME')).toHaveLength(settled.cost > 0 ? 1 : 0);
    }
    expect((await wallet(owner.id)).frozenBalance).toBe(0);
  });

  it('delete during a running turn is refused with 409 and succeeds after it settles', async () => {
    await grant(owner.id, 10);
    const chat = await newChat();
    model.enqueue({ chunks: Array.from({ length: 10 }, (_, i) => `d${i} `), delayMs: 80 });
    const turn = openStream(chat.id, 'delete me later');
    await turn.firstDelta;
    const refused = await auth(request(server()).delete(`/api/chat/${chat.id}`)).expect(409);
    expect(refused.body).toMatchObject({ code: 'AI_CHAT_BUSY' });
    await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${owner.token}`).expect(200);
    for (let attempt = 0; attempt < 100 && !turn.raw().includes('event: done'); attempt += 1) await sleep(50);
    await auth(request(server()).delete(`/api/chat/${chat.id}`)).expect(200);
    await request(server()).get(`/api/chat/${chat.id}`).set('Authorization', `Bearer ${owner.token}`).expect(404);
    expect((await wallet(owner.id)).frozenBalance).toBe(0);
  });

  it('the stale-turn reconciler returns the hold once; the late live settlement does not charge again', async () => {
    const stale = await member('gchatstale');
    await grant(stale.id, 10);
    const chat = await newChat(stale);
    model.enqueue({ chunks: Array.from({ length: 20 }, (_, i) => `s${i} `), delayMs: 100 });
    const turn = openStream(chat.id, 'stuck turn', stale);
    await turn.firstDelta;
    expect(await wallet(stale.id)).toEqual({ balance: 9, frozenBalance: 1 });
    await sleep(300); // staleAfterMs is 200 in this module
    const chats = app.get(ChatService);
    expect(await chats.settleStale()).toBe(1);
    expect(await chats.settleStale()).toBe(0);
    const message = (await view(chat.id, stale)).messages[1];
    expect(message).toMatchObject({ status: 'FAILED', errorCode: 'AI_CHAT_INTERRUPTED', cost: 0 });
    expect(await wallet(stale.id)).toEqual({ balance: 10, frozenBalance: 0 });
    // The original process is still writing; its late settlement is a no-op.
    turn.req.destroy();
    await sleep(500);
    expect((await view(chat.id, stale)).messages[1]).toMatchObject({ status: 'FAILED', errorCode: 'AI_CHAT_INTERRUPTED', cost: 0 });
    expect(await hold(message.id)).toEqual(['FREEZE', 'UNFREEZE']);
    expect(await wallet(stale.id)).toEqual({ balance: 10, frozenBalance: 0 });
  });

  it('lists chats with stable cursors, owner-scoped, and refuses malformed cursors', async () => {
    const reader = await member('gchatreader');
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) { ids.push((await newChat(reader)).id); await sleep(5); }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const query: string = `/api/chat?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
      const body = (await request(server()).get(query).set('Authorization', `Bearer ${reader.token}`).expect(200)).body as { items: Array<{ id: string }>; next: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map(item => item.id));
      cursor = body.next;
      if (!cursor) break;
    }
    expect(seen).toEqual([...ids].reverse());
    expect(cursor).toBeNull();
    const forged = Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: ids[0] })).toString('base64url');
    // Another user presenting the same cursor sees only their own chats.
    const foreign = (await request(server()).get(`/api/chat?before=${forged}`).set('Authorization', `Bearer ${other.token}`).expect(200)).body.items as Array<{ id: string }>;
    expect(foreign.some(item => ids.includes(item.id))).toBe(false);
    await request(server()).get('/api/chat?before=garbage').set('Authorization', `Bearer ${reader.token}`).expect(400);
    await request(server()).get('/api/chat?limit=0').set('Authorization', `Bearer ${reader.token}`).expect(400);
    await request(server()).get('/api/chat?limit=101').set('Authorization', `Bearer ${reader.token}`).expect(400);
  });

  it('chat surfaces never contain provider secrets, raw payloads or the full content in management projections', async () => {
    await grant(owner.id, 10);
    const chat = await newChat();
    model.enqueue({ chunks: ['harmless'], usage: { input: 5, output: 5, total: 10 } });
    await say(chat.id, { content: `${'q'.repeat(70)}CONTENT-SENTINEL-DO-NOT-LEAK` }).expect(200);
    model.enqueue({ error: new Error('upstream said SYNTHETIC-CHAT-KEY-GATES and RAW-UPSTREAM-BODY') });
    const failed = await say(chat.id, { content: 'trigger failure' }).expect(502);
    const surfaces = [failed.body as string, JSON.stringify(await view(chat.id)), JSON.stringify((await request(server()).get('/api/chat').set('Authorization', `Bearer ${owner.token}`).expect(200)).body),
      JSON.stringify((await request(server()).get(`/api/management/chats?ownerId=${owner.id}`).set('Authorization', `Bearer ${admin.token}`).expect(200)).body),
      JSON.stringify((await request(server()).get(`/api/management/chats/${chat.id}`).set('Authorization', `Bearer ${admin.token}`).expect(200)).body),
      JSON.stringify((await request(server()).get('/api/ai/catalog').expect(200)).body)];
    for (const text of surfaces) {
      expect(text).not.toContain('SYNTHETIC-CHAT-KEY-GATES');
      expect(text).not.toContain('RAW-UPSTREAM-BODY');
    }
    for (const text of surfaces.slice(3, 5)) expect(text).not.toContain('CONTENT-SENTINEL-DO-NOT-LEAK');
    await request(server()).post('/api/management/chats').set('Authorization', `Bearer ${admin.token}`).set('Origin', origin).send({}).expect(res => { if (res.status < 400) throw new Error(`unexpected ${res.status}`); });
  });
});
