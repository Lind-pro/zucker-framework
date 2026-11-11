import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { JobsModule } from '../src/jobs/jobs.module';
import { InboxModule, InboxService, INBOX_EMITTER } from '../src/inbox';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_inbox_http_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';

run('inbox HTTP contract (WP 3.2)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, directory: string, inbox: InboxService;
  let owner: { id: string; token: string }, other: { id: string; token: string };
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const http = () => request(app.getHttpServer());
  async function member(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticInbox9!';
    const send = (path: string, body: object) => http().post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200); return { id: login.body.userId, token: login.body.token };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-inbox-http-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const limiter = { points: 2000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-inbox-http-secret-only-for-tests', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limiter, 'session-refresh': limiter, 'session-refresh-network': limiter,
        'session-read': limiter, 'api-default': limiter, 'inbox-read': { points: 3, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, JobsModule, InboxModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'inbox-http', concurrency: 1, scanIntervalMs: 100,
        leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 }).compile();
    inbox = module.get(INBOX_EMITTER);
    expect(inbox).toBe(module.get(InboxService));
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    owner = await member('inboxowner'); other = await member('inboxother');
  });
  afterAll(async () => {
    try { await app?.close(); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  it('lists, reads, archives with recipient scope, Origin checks and the unread limiter', async () => {
    await http().get('/api/inbox').expect(401);
    await inbox.emit(undefined, { userId: owner.id, eventKey: 'order:x', type: 'order.paid', params: { credits: 7 }, href: '/billing/orders' });
    await inbox.emit(undefined, { userId: other.id, eventKey: 'order:y', type: 'order.paid', params: { credits: 1 } });
    const list = await http().get('/api/inbox').set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(list.headers['cache-control']).toContain('no-store');
    expect(list.body).toMatchObject({ total: 1, unreadCount: 1, data: [{ type: 'order.paid', params: { credits: 7 }, href: '/billing/orders', isRead: false }] });
    const id = list.body.data[0].id as string;
    const foreign = (await http().get('/api/inbox').set('Authorization', `Bearer ${other.token}`).expect(200)).body.data[0].id as string;
    await http().post(`/api/inbox/${id}/read`).set('Authorization', `Bearer ${owner.token}`).set('Origin', 'https://foreign.invalid').expect(403);
    await http().post(`/api/inbox/${foreign}/read`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).expect(404);
    await http().post(`/api/inbox/${foreign}/archive`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).expect(404);
    await http().post(`/api/inbox/${id}/read`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).send({ x: 1 }).expect(400);
    expect((await http().post(`/api/inbox/${id}/read`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).expect(200)).body)
      .toMatchObject({ id, isRead: true });
    const count = () => http().get('/api/inbox/unread-count').set('Authorization', `Bearer ${owner.token}`);
    expect((await count().expect(200)).body).toEqual({ unreadCount: 0 });
    expect((await http().post('/api/inbox/read-all').set('Authorization', `Bearer ${other.token}`).set('Origin', origin).expect(200)).body).toEqual({ updated: 1 });
    expect((await http().post(`/api/inbox/${id}/archive`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).expect(200)).body).toEqual({ archived: true });
    await count().expect(200); await count().expect(200);
    await count().expect(429);
  });
});
