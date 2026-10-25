import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ZuckerStorageModule } from '@zucker-framework/storage';
import type { MailProvider } from '@zucker-framework/notification';
import { createCreditLedger } from '../src/billing/ledger';
import { CreditsModule } from '../src/credits/credits.module';
import { QUOTA_OPTIONS } from '../src/credits/quota.config';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { DELIVERY_OPTIONS } from '../src/delivery/delivery.config';
import { DeliveryService } from '../src/delivery/delivery.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { JobsHost } from '../src/jobs/jobs.host';
import { JobsService } from '../src/jobs/jobs.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_credits_http_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

run('owned credit and quota HTTP contracts', () => {
  let app: INestApplication | undefined, pool: Pool, database: ApplicationDatabase, directory: string, jobs: JobsService, host: JobsHost, delivery: DeliveryService;
  let owner: { id: string; token: string }, other: { id: string; token: string };
  const tickets = new Map<string, string>(), shutdownEvents: string[] = [], blockingStarted = deferred();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const provider: MailProvider = { name: 'synthetic', supportsIdempotency: true, isConfigured: () => true,
    deliver: vi.fn(async () => ({ success: true, messageId: 'synthetic-delivery' })), close: vi.fn(async () => {}) };
  const post = (body: object, key = randomUUID(), token = owner.token) => request(app!.getHttpServer()).post('/api/jobs')
    .set('Authorization', `Bearer ${token}`).set('Origin', origin).set('Idempotency-Key', key).send(body);
  const get = (path: string, token = owner.token) => request(app!.getHttpServer()).get(`/api/${path}`).set('Authorization', `Bearer ${token}`);
  async function member(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticRuntime9!';
    const send = (path: string, body: object) => request(app!.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200); return { id: login.body.userId, token: login.body.token };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (url.pathname !== '/cnipa_dev') throw new Error('Requires approved development database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-job-http-objects-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const disconnect = database.onModuleDestroy.bind(database);
    vi.spyOn(database, 'onModuleDestroy').mockImplementation(async () => { shutdownEvents.push('database-close-start'); await disconnect(); });
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-runtime-http-secret-only', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, CreditsModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(QUOTA_OPTIONS).useValue({ recordLimit: 1, period: 'daily', reservationTtlMs: 900000 })
      .overrideProvider(DELIVERY_OPTIONS).useValue({ provider, accountScope: 'synthetic', leaseMs: 2000, heartbeatMs: 500 })
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'http', concurrency: 1, scanIntervalMs: 100,
        leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 }).compile();
    jobs = module.get(JobsService); host = module.get(JobsHost); delivery = module.get(DeliveryService);
    jobs.registerHandler({ kind: 'shutdown-probe', version: '1', handler: { execute: async context => {
      blockingStarted.resolve(); await new Promise<void>(done => context.signal.addEventListener('abort', () => done(), { once: true })); return {};
    }, cleanup: async () => { await database.transaction(tx => tx.query('SELECT 1')); shutdownEvents.push('attempt-drained'); } } });
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    owner = await member('runtimeowner'); other = await member('runtimeother');
  });
  afterAll(async () => {
    try { await app?.close(); }
    finally { vi.restoreAllMocks(); try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  it('requires authentication, bounds pagination and rejects a caller-selected account', async () => {
    await request(app!.getHttpServer()).get('/api/credits/balance').expect(401);
    await request(app!.getHttpServer()).get('/api/quota/record').expect(401);
    await get(`credits/transactions?userId=${other.id}`).expect(400);
    await get('credits/transactions?page=-1').expect(400);
    await get('credits/lots?pageSize=101').expect(400);
    await get('credits/transactions?type=untrusted').expect(400);
  });
  it('returns only the authenticated account’s balances, journal and batches', async () => {
    const ledger = createCreditLedger(database);
    for (const value of [10, 4]) await database.transaction(tx => ledger.grant(tx, { accountId: owner.id, amount: value, source: 'checkout',
      sourceId: randomUUID(), transactionData: { type: 'GRANT', metadata: { source: 'checkout', privateValue: 'private-synthetic' } } }));
    expect((await get('credits/balance').expect(200)).body).toMatchObject({ available: 14, frozen: 0, expired: 0, bookBalance: 14 });
    const page = (await get('credits/transactions?pageSize=1&type=GRANT').expect(200)).body;
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 1 }); expect(page.data).toHaveLength(1);
    expect(page.data[0]).not.toHaveProperty('metadata'); expect(page.data[0].references).toEqual({ source: 'checkout' });
    expect((await get('credits/lots').expect(200)).body).toMatchObject({ total: 2 });
    expect((await get('credits/balance', other.token).expect(200)).body).toMatchObject({ available: 0 });
    expect((await get('credits/transactions', other.token).expect(200)).body.data).toEqual([]);
  });
  it('reserves through the real record entry, releases cancellation and confirms only on durable completion', async () => {
    const created = await post({ kind: 'record', input: { value: 'cancel quota' } }).expect(202), id = created.body.id;
    expect(created.body.canCancel).toBe(true);
    expect((await get('quota/record').expect(200)).body).toMatchObject({ configured: true, used: 0, reserved: 1, remaining: 0 });
    await get(`quota/reservations/${id}`, other.token).expect(404);
    await request(app!.getHttpServer()).post(`/api/quota/reservations/${id}/confirm`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).send({}).expect(404);
    await post({ kind: 'record', input: { value: 'over limit' } }).expect(409);
    await request(app!.getHttpServer()).post(`/api/jobs/${id}/cancel`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).expect(200);
    expect((await get(`quota/reservations/${id}`).expect(200)).body).toMatchObject({ status: 'RELEASED' });
    const next = await post({ kind: 'record', input: { value: 'completed quota' } }).expect(202); await host.runTask(next.body.id);
    expect((await get('quota/record').expect(200)).body).toMatchObject({ used: 1, reserved: 0, remaining: 0 });
    expect((await get(`quota/reservations/${next.body.id}`).expect(200)).body).toMatchObject({ status: 'CONFIRMED' });
    expect((await get(`jobs/${next.body.id}`).expect(200)).body).toMatchObject({ canCancel: false });
  });
  it('exposes canCancel=false and rejects cancellation of internal maintenance jobs', async () => {
    const submitted = await jobs.submit({ kind: 'shutdown-probe', ownerId: owner.id, idempotencyKey: randomUUID(), resource: { type: 'probe', id: 'owned' }, payload: {} });
    expect((await get(`jobs/${submitted.task.id}`).expect(200)).body).toMatchObject({ canCancel: false, status: 'QUEUED' });
    await request(app!.getHttpServer()).post(`/api/jobs/${submitted.task.id}/cancel`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).expect(400);
    expect((await get('jobs').expect(200)).body.find((task: { id: string }) => task.id === submitted.task.id)).toMatchObject({ canCancel: false, status: 'QUEUED' });
  });
  it('explicitly refuses legacy unallocated frozen projections while retaining audit access', async () => {
    const legacy = await member('legacycreditowner'), ledger = createCreditLedger(database);
    await database.transaction(tx => ledger.grant(tx, { accountId: legacy.id, amount: 10, source: 'purchase', sourceId: randomUUID(), transactionData: { type: 'GRANT' } }));
    await database.model('creditAccount').update({ where: { userId: legacy.id }, data: { balance: 7, frozenBalance: 3 } });
    const failed = await get('credits/balance', legacy.token).expect(503);
    expect(failed.body.message).toContain('require reconciliation');
    await get('credits/lots', legacy.token).expect(503);
    expect((await get('credits/transactions', legacy.token).expect(200)).body.total).toBe(1);
  });
});
