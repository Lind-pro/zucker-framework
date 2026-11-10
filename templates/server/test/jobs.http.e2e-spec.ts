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
import { DurableTaskAbortedError } from '@zucker-framework/task';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { DELIVERY_OPTIONS } from '../src/delivery/delivery.config';
import { DeliveryService } from '../src/delivery/delivery.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { JobsModule } from '../src/jobs/jobs.module';
import { JobsHost } from '../src/jobs/jobs.host';
import { JobsService } from '../src/jobs/jobs.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_jobs_http_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

run('durable jobs HTTP contract and actual Nest lifecycle', () => {
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
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-job-http-objects-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const disconnect = database.disconnect.bind(database);
    vi.spyOn(database, 'disconnect').mockImplementation(async () => { shutdownEvents.push('database-close-start'); await disconnect(); });
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-runtime-http-secret-only', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'session-refresh': { points: 2000, duration: 60 }, 'session-refresh-network': { points: 2000, duration: 60 }, 'session-read': { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, JobsModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer)
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

  it('requires account authentication and an allowed mutation origin', async () => {
    await request(app!.getHttpServer()).get('/api/jobs').expect(401);
    await post({ kind: 'record', input: { value: 'origin' } }).set('Origin', 'https://foreign.invalid').expect(403);
    await post({ kind: 'record', input: { value: 'origin' } }).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await post({ kind: 'record', input: { value: 'key' } }).unset('Idempotency-Key').expect(400);
    expect((await get('jobs').expect(200)).body).toEqual([]);
  });
  it('uses only registered public inputs and never accepts a caller-selected owner', async () => {
    await post({ kind: 'shutdown-probe', input: {} }).expect(400);
    await post({ kind: 'record', input: { value: 'x' }, ownerId: other.id }).expect(400);
    await post({ kind: 'record', input: { value: 'x', ownerId: other.id } }).expect(400);
    await post({ kind: 'unknown', input: {} }).expect(400);
  });
  it('accepts one owned job, exposes status and result, and delivers its transactionally created notification', async () => {
    const key = randomUUID(), body = { kind: 'record', input: { value: 'HTTP record', notify: true } };
    const created = await post(body, key).expect(202), duplicate = await post(body, key).expect(202);
    const id = created.body.id; expect(duplicate.body.id).toBe(id);
    await post({ kind: 'record', input: { value: 'changed', notify: true } }, key).expect(409);
    await get(`jobs/${id}`, other.token).expect(404); await get(`jobs/${id}/record`, other.token).expect(404);
    await host.runTask(id);
    expect((await get(`jobs/${id}`).expect(200)).body).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect((await get(`jobs/${id}/record`).expect(200)).body).toMatchObject({ value: 'HTTP record' });
    const mail = await get(`deliveries/for-task/${id}`).expect(200);
    expect(mail.body).toMatchObject({ status: 'PENDING' }); expect(mail.body).not.toHaveProperty('recipient'); expect(mail.body).not.toHaveProperty('text');
    await get(`deliveries/${mail.body.id}`, other.token).expect(404);
    expect(await delivery.runOnce('http-mail')).toMatchObject({ kind: 'delivered' });
    expect((await get(`deliveries/${mail.body.id}`).expect(200)).body).toMatchObject({ status: 'DELIVERED' });
  });
  it('cancels only an owned queued job and prevents its execution', async () => {
    const created = await post({ kind: 'record', input: { value: 'cancelled' } }).expect(202), id = created.body.id;
    const cancel = (token: string) => request(app!.getHttpServer()).post(`/api/jobs/${id}/cancel`).set('Authorization', `Bearer ${token}`).set('Origin', origin);
    await cancel(other.token).expect(404); expect((await cancel(owner.token).expect(200)).body).toMatchObject({ status: 'CANCELLED' });
    await expect(host.runTask(id)).resolves.toMatchObject({ status: 'CANCELLED' }); await get(`jobs/${id}/record`).expect(404);
  });
  it('drains attempts before the real Nest database lifecycle disconnects and closes mail once', async () => {
    const submitted = await jobs.submit({ kind: 'shutdown-probe', ownerId: owner.id, idempotencyKey: randomUUID(), resource: { type: 'probe', id: 'shutdown' }, payload: {} });
    const attempt = host.runTask(submitted.task.id).catch(error => error); await blockingStarted.promise;
    const closing = app!; app = undefined; await closing.close();
    expect(await attempt).toBeInstanceOf(DurableTaskAbortedError);
    expect(shutdownEvents).toContain('attempt-drained'); expect(shutdownEvents).toContain('database-close-start');
    expect(shutdownEvents.indexOf('attempt-drained')).toBeLessThan(shutdownEvents.indexOf('database-close-start'));
    expect(provider.close).toHaveBeenCalledTimes(1);
  });
});
