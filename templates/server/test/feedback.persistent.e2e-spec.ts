/**
 * Feedback (WP 3.1) over HTTP + PostgreSQL: submit with Idempotency-Key, owner isolation and
 * projection, staff list/reply with revision CAS and audit, permission gate, submit limiter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { FEEDBACK_POLICIES, FEEDBACK_RATE_LIMITERS, FeedbackModule, feedbackDeletionContributor, isSafePagePath, type FeedbackNotifier } from '../src/feedback';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_feedback_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-feedback-jwt-secret-of-32-chars-min',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt' };

run('feedback (HTTP + PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase;
  let owner: { id: string; token: string }, other: { id: string; token: string }, staff: { id: string; token: string }, viewer: { id: string; token: string };
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const notified: Array<{ userId: string; feedbackId: string }> = [];
  const notifier: FeedbackNotifier = { async notifyReply(_tx, event) { notified.push(event); } };
  const server = () => app.getHttpServer();
  const as = (req: request.Test, user: { token: string }) => req.set('Authorization', `Bearer ${user.token}`).set('Origin', origin);
  const submit = (user: { token: string }, key: string, body: object) => as(request(server()).post('/api/feedback'), user).set('Idempotency-Key', key).send(body);
  async function member(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`, password = 'SyntheticFeedback9!';
    const send = (path: string, body: object) => request(server()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await send('register', { username, email, password }).expect(201);
    await send('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await send('login', { username, password }).expect(200);
    for (const permission of permissions) await database.model('userPermissions').create({ data: { userId: login.body.userId, permissionId: permission, grantType: 'grant' } });
    return { id: login.body.userId as string, token: login.body.token as string };
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
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
        'session-read': limits, 'api-default': limits, ...FEEDBACK_RATE_LIMITERS } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...FEEDBACK_POLICIES] }),
      AccountModule, FeedbackModule.forRoot({ notifier: { useFactory: () => notifier } }),
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    for (const id of ['feedback:query', 'feedback:update']) await database.model('permissions').create({ data: { id, name: id } });
    owner = await member('fbowner'); other = await member('fbother');
    staff = await member('fbstaff', ['feedback:query', 'feedback:update']); viewer = await member('fbviewer', ['feedback:query']);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('submit → replay → staff reply → owner sees reply; staff-only fields stay private', async () => {
    const body = { type: 'bug', message: '  The export button does nothing  ', pagePath: '/account/files', locale: 'en' };
    const created = await submit(owner, 'fb-key-0001', body).expect(201);
    expect(created.body).toEqual({ id: expect.any(String), type: 'bug', message: 'The export button does nothing', status: 'open', reply: null, repliedAt: null, createdAt: expect.any(String) });
    const replay = await submit(owner, 'fb-key-0001', body).expect(201);
    expect(replay.body.id).toBe(created.body.id);
    await submit(owner, 'fb-key-0001', { ...body, message: 'different' }).expect(409);

    const list = await as(request(server()).get('/api/management/feedback?status=open'), staff).expect(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    const row = list.body.data[0];
    expect(row).toMatchObject({ id: created.body.id, ownerId: owner.id, pagePath: '/account/files', locale: 'en', revision: 0 });
    expect(row.requestKey).toBeUndefined();

    await as(request(server()).patch(`/api/management/feedback/${row.id}`), viewer).send({ expectedRevision: 0, reply: 'x' }).expect(403);
    const patched = await as(request(server()).patch(`/api/management/feedback/${row.id}`), staff)
      .send({ expectedRevision: 0, status: 'resolved', reply: 'Fixed in the next release', staffNote: 'SENTINEL-STAFF-NOTE' }).expect(200);
    expect(patched.body).toMatchObject({ revision: 1, status: 'resolved', handledBy: staff.id, staffNote: 'SENTINEL-STAFF-NOTE' });
    expect(notified).toEqual([{ userId: owner.id, feedbackId: row.id }]);
    await as(request(server()).patch(`/api/management/feedback/${row.id}`), staff).send({ expectedRevision: 0, status: 'closed' }).expect(409);
    const audit = await database.transaction(tx => tx.query<{ metadata: { changedFields: string[] } }>(
      `SELECT metadata FROM operation_logs WHERE module='feedback' AND "targetId"=$1`, [row.id]));
    expect(audit.rows.map(entry => entry.metadata.changedFields)).toEqual([['status', 'reply', 'staffNote']]);
    expect(JSON.stringify(audit.rows)).not.toContain('SENTINEL');

    const mine = await as(request(server()).get('/api/feedback/mine'), owner).expect(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.data[0]).toMatchObject({ id: row.id, status: 'resolved', reply: 'Fixed in the next release' });
    expect(JSON.stringify(mine.body)).not.toMatch(/SENTINEL|staffNote|handledBy/);
    expect((await as(request(server()).get('/api/feedback/mine'), other).expect(200)).body).toEqual({ data: [], total: 0 });
  });

  it('rejects unsafe page paths and untrusted origins', async () => {
    for (const pagePath of ['//evil.example', 'https://evil.example/', '/a\\b', '/a?token=1', 'relative', '/a\u0000b', '/a b', '/x#y'])
      expect(isSafePagePath(pagePath)).toBe(false);
    expect(isSafePagePath('/zh/account/feedback')).toBe(true);
    // The submit limiter (5/h) counts refused requests too, so only two go over HTTP.
    for (const pagePath of ['//evil.example', '/a?token=1'])
      await submit(other, `fb-path-${randomUUID().slice(0, 8)}`, { type: 'idea', message: 'hi', pagePath }).expect(400);
    await request(server()).post('/api/feedback').set('Authorization', `Bearer ${other.token}`).set('Origin', 'https://evil.example')
      .set('Idempotency-Key', 'fb-origin-01').send({ type: 'idea', message: 'hi' }).expect(403);
  });

  it('limits submissions to five per hour per user', async () => {
    const user = await member('fblimit');
    for (let index = 0; index < 5; index += 1) await submit(user, `fb-limit-${index}-key`, { type: 'other', message: `m${index}` }).expect(201);
    await submit(user, 'fb-limit-6-key', { type: 'other', message: 'm6' }).expect(429);
  });

  it('deletion contributor removes only the owner rows', async () => {
    await database.transaction(tx => feedbackDeletionContributor.erase(tx, owner.id));
    const left = await database.transaction(tx => tx.query<{ ownerId: string }>('SELECT "ownerId" FROM feedback'));
    expect(left.rows.some(entry => entry.ownerId === owner.id)).toBe(false);
    expect(left.rows.length).toBeGreaterThan(0);
  });
});
