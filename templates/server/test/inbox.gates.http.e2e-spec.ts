/**
 * Inbox (WP 3.2) HTTP gates on PostgreSQL: anonymous 401, cross-user 404 indistinguishable from "missing",
 * Origin on every write, recipient-scoped read-all and counts, archive semantics, paging without overlap,
 * concurrent reads, and a projection that never carries recipient id, event key or archive flag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { InboxModule, InboxService } from '../src/inbox';
import { createIsolatedSchema, type IsolatedSchema } from './helpers/phase3-schema';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:4202';
type User = { id: string; token: string };

run('inbox HTTP gates (PostgreSQL)', () => {
  let app: INestApplication, iso: IsolatedSchema, database: ApplicationDatabase, directory: string, inbox: InboxService, a: User, b: User;
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const http = () => request(app.getHttpServer());
  const get = (path: string, user: User) => http().get(`/api${path}`).set('Authorization', `Bearer ${user.token}`);
  const post = (path: string, user: User) => http().post(`/api${path}`).set('Authorization', `Bearer ${user.token}`).set('Origin', origin);
  const rows = async (sql: string, values: unknown[] = []) => database.transaction(async tx => (await tx.query<Record<string, unknown>>(sql, values)).rows);
  async function member(username: string): Promise<User> {
    const email = `${username}@example.invalid`, password = 'SyntheticInbox9!';
    const send = (path: string, body: object) => http().post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    return { id: login.body.userId, token: login.body.token };
  }
  const emit = (user: User, key: string, credits = 1) => inbox.emit(undefined, { userId: user.id, eventKey: key, type: 'order.paid', params: { credits }, href: '/billing/orders' });

  beforeAll(async () => {
    iso = await createIsolatedSchema('zucker_inboxg', databaseUrl!);
    directory = mkdtempSync(join(tmpdir(), 'zucker-inbox-gates-'));
    database = new ApplicationDatabase(iso.url.href);
    process.env.ACCOUNT_ORIGINS = origin;
    const limiter = { points: 5000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-inbox-gates-secret-only-for-tests', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limiter, 'session-refresh': limiter, 'session-refresh-network': limiter, 'session-read': limiter, 'api-default': limiter, 'inbox-read': limiter } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, JobsModule, InboxModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: 'inbox-gates', concurrency: 1, scanIntervalMs: 100, leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 }).compile();
    inbox = module.get(InboxService);
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    a = await member('ibxa'); b = await member('ibxb');
  }, 60_000);
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); } finally { try { await iso?.drop(); } finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  it('gate 1: every route requires a session', async () => {
    for (const path of ['/inbox', '/inbox/unread-count']) await http().get(`/api${path}`).expect(401);
    for (const path of ['/inbox/read-all', '/inbox/00000000-0000-4000-8000-000000000000/read', '/inbox/00000000-0000-4000-8000-000000000000/archive'])
      await http().post(`/api${path}`).set('Origin', origin).expect(401);
    await http().get('/api/inbox').set('Authorization', 'Bearer not-a-token').expect(401);
  });

  it('gate 1: another user\'s id answers exactly like a missing id (no enumeration), and nothing changes', async () => {
    await emit(b, 'gate:b1');
    const foreign = (await get('/inbox', b).expect(200)).body.data[0].id as string;
    const missing = '11111111-2222-4333-8444-555555555555';
    for (const action of ['read', 'archive'] as const) {
      const cross = await post(`/inbox/${foreign}/${action}`, a), absent = await post(`/inbox/${missing}/${action}`, a);
      expect([cross.status, absent.status]).toEqual([404, 404]);
      const { timestamp: _a, ...crossBody } = cross.body, { timestamp: _b, ...absentBody } = absent.body;
      expect(crossBody).toEqual(absentBody);
    }
    for (const hostile of ["' OR '1'='1", '1; DROP TABLE users', '../x', '%00', 'null', 'undefined'])
      expect((await post(`/inbox/${encodeURIComponent(hostile)}/read`, a)).status, hostile).toBe(404);
    expect(await rows(`SELECT 1 FROM inbox_notifications WHERE id=$1 AND "isRead"=false AND "isArchived"=false`, [foreign])).toHaveLength(1);
  });

  it('gate 6: every write needs a trusted Origin; reads do not', async () => {
    await emit(a, 'gate:a1');
    const id = (await get('/inbox', a).expect(200)).body.data[0].id as string;
    for (const path of [`/inbox/${id}/read`, `/inbox/${id}/archive`, '/inbox/read-all']) {
      await http().post(`/api${path}`).set('Authorization', `Bearer ${a.token}`).expect(403);
      await http().post(`/api${path}`).set('Authorization', `Bearer ${a.token}`).set('Origin', 'https://evil.example').expect(403);
      await http().post(`/api${path}`).set('Authorization', `Bearer ${a.token}`).set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').expect(403);
    }
    expect(await rows(`SELECT 1 FROM inbox_notifications WHERE id=$1 AND "isRead"=false`, [id])).toHaveLength(1);
    await get('/inbox', a).set('Origin', 'https://evil.example').expect(200);
  });

  it('writes accept no body, and malformed ids or queries are 4xx', async () => {
    const id = (await get('/inbox', a).expect(200)).body.data[0].id as string;
    for (const body of [{ isRead: false }, { userId: b.id }, [1], 'text']) expect((await post(`/inbox/${id}/read`, a).send(body)).status, JSON.stringify(body)).toBe(400);
    await post('/inbox/read-all', a).send({ userId: b.id }).expect(400);
    for (const query of ['?page=0', '?pageSize=0', '?pageSize=51', '?page=1.5', '?page=-1', '?unread=maybe', '?userId=x', '?page=10001', '?pageSize=abc'])
      expect((await get(`/inbox${query}`, a)).status, query).toBe(400);
    expect((await get('/inbox?pageSize=50&unread=true', a)).status).toBe(200);
    await post('/inbox/not-a-uuid/read', a).expect(404);
  });

  it('read-all, read and counts are scoped to the caller; archived rows leave the list, total and unread count', async () => {
    const c = await member('ibxc'), d = await member('ibxd');
    for (const key of ['s1', 's2', 's3']) await emit(c, key);
    await emit(d, 's1');
    expect((await get('/inbox/unread-count', c).expect(200)).body).toEqual({ unreadCount: 3 });
    const list = (await get('/inbox', c).expect(200)).body;
    const archiveId = list.data[0].id as string, readId = list.data[1].id as string;
    expect((await post(`/inbox/${archiveId}/archive`, c).expect(200)).body).toEqual({ archived: true });
    expect((await post(`/inbox/${archiveId}/archive`, c)).status).toBeLessThan(500);
    const after = (await get('/inbox', c).expect(200)).body;
    expect(after).toMatchObject({ total: 2, unreadCount: 2 });
    expect(after.data.map((row: { id: string }) => row.id)).not.toContain(archiveId);
    const first = (await post(`/inbox/${readId}/read`, c).expect(200)).body;
    await new Promise(resolve => setTimeout(resolve, 15));
    expect((await post(`/inbox/${readId}/read`, c).expect(200)).body.readAt).toBe(first.readAt);
    expect((await get('/inbox?unread=1', c).expect(200)).body).toMatchObject({ total: 1, unreadCount: 1 });
    expect((await post('/inbox/read-all', c).expect(200)).body).toEqual({ updated: 2 }); // includes the archived unread row
    expect((await post('/inbox/read-all', c).expect(200)).body).toEqual({ updated: 0 });
    expect((await get('/inbox/unread-count', d).expect(200)).body).toEqual({ unreadCount: 1 });
    expect((await get('/inbox', d).expect(200)).body.total).toBe(1);
  });

  it('gate 6: concurrent read, read-all and archive of one row never double-count, error out or touch other users', async () => {
    const e = await member('ibxe'), f = await member('ibxf');
    await emit(e, 'race:1'); await emit(f, 'race:1');
    const id = (await get('/inbox', e).expect(200)).body.data[0].id as string;
    const responses = await Promise.all([...Array(6)].map(() => post(`/inbox/${id}/read`, e)));
    expect(responses.map(response => response.status)).toEqual(Array(6).fill(200));
    const mixed = await Promise.all([post('/inbox/read-all', e), post('/inbox/read-all', e), post(`/inbox/${id}/archive`, e), post(`/inbox/${id}/read`, e)]);
    expect(mixed.every(response => response.status === 200)).toBe(true);
    expect((await get('/inbox/unread-count', f).expect(200)).body).toEqual({ unreadCount: 1 });
  });

  it('concurrent first reads of one row agree on a single readAt (documented: a read notification keeps its first readAt)', async () => {
    const i = await member('ibxi');
    await emit(i, 'race:2');
    const id = (await get('/inbox', i).expect(200)).body.data[0].id as string;
    const responses = await Promise.all([...Array(6)].map(() => post(`/inbox/${id}/read`, i)));
    expect(new Set(responses.map(response => response.body.readAt)).size, 'each concurrent first read overwrites readAt').toBe(1);
  });

  it('paging is stable and disjoint when many rows share one timestamp; the total is the full count', async () => {
    const g = await member('ibxg');
    await database.transaction(tx => tx.query(`INSERT INTO inbox_notifications (id, "userId", "eventKey", type, params, "createdAt")
      SELECT gen_random_uuid()::text, $1, 'page:' || n, 'feedback.replied', '{}'::jsonb, '2026-01-01T00:00:00Z' FROM generate_series(1, 23) n`, [g.id]));
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const body = (await get(`/inbox?page=${page}&pageSize=10`, g).expect(200)).body;
      expect(body.total).toBe(23);
      seen.push(...body.data.map((row: { id: string }) => row.id));
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect((await get('/inbox?page=4&pageSize=10', g).expect(200)).body.data).toEqual([]);
  });

  it('gate 5: the projection never carries recipient id, event key, archive flag or another user\'s data; responses are not cacheable', async () => {
    const h = await member('ibxh');
    await emit(h, 'secret:event-key-value', 42);
    const response = await get('/inbox', h).expect(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(Object.keys(response.body.data[0]).sort()).toEqual(['createdAt', 'href', 'id', 'isRead', 'params', 'readAt', 'type']);
    for (const word of ['secret:event-key-value', 'eventKey', 'userId', 'isArchived', h.id, h.token, a.id, b.id]) expect(JSON.stringify(response.body), word).not.toContain(word);
    for (const path of ['/inbox/unread-count']) expect((await get(path, h).expect(200)).headers['cache-control']).toContain('no-store');
  });
});
