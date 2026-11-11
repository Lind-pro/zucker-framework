import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerAuthModule, PermissionsGuard, UserService } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { AccountController } from '../src/accounts/account.controller';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../src/accounts/account.service';
import { ApplicationDatabase } from '../src/database';
import { createAdministrator } from '../src/accounts/create-administrator';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:4202';
const password = 'SyntheticUser9!';
const schema = `zucker_accounts_${randomUUID().replaceAll('-', '')}`;
const run = databaseUrl ? describe : describe.skip;

run('persistent template accounts over HTTP', () => {
  let pool: Pool;
  let app: INestApplication;
  let scopedUrl: string;
  const deliveries: Array<{ email: string; purpose: string; ticket: string }> = [];
  let mailAvailable = true;
  const mailer: AccountMailer = {
    assertConfigured() { if (!mailAvailable) throw new ServiceUnavailableException('Synthetic mail unavailable'); },
    async send(email, purpose, ticket) { deliveries.push({ email, purpose, ticket }); },
  };

  async function start() {
    const db = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({
      imports: [
        ZuckerCrudModule.forRootAsync({ useFactory: () => db }),
        ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-account-test-secret-only', registerControllers: false }),
        ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 500, duration: 60 }, 'session-refresh': { points: 500, duration: 60 }, 'session-refresh-network': { points: 500, duration: 60 }, 'session-read': { points: 500, duration: 60 }, 'api-default': { points: 500, duration: 60 } } }),
      ],
      controllers: [AccountController],
      providers: [AccountService, AccountGuard, { provide: ACCOUNT_MAILER, useValue: mailer },
        { provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }],
    }).compile();
    const instance = module.createNestApplication();
    instance.setGlobalPrefix('api');
    instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init();
    return instance;
  }
  const post = (path: string, body: object = {}) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
  const cookie = (response: { headers: Record<string, unknown> }) => (response.headers['set-cookie'] as string[])[0].split(';')[0];
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  async function verifiedUser(username: string) {
    const email = `${username}@example.invalid`;
    const registered = await post('register', { username, email, password });
    expect(registered.status).toBe(201);
    const ticket = deliveries.findLast(delivery => delivery.email === email && delivery.purpose === 'verify-email')!.ticket;
    await post('verify-email', { ticket }).expect(200);
    return { email, ticket, login: await post('login', { username, password }).expect(200) };
  }

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(parsed.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: parsed.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const sql = readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8')
          .replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    parsed.searchParams.set('schema', schema);
    scopedUrl = parsed.href;
    app = await start();
  });

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (pool) {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  });

  it('requires verification, rejects privilege fields and consumes hashed email tickets once', async () => {
    await post('register', { username: 'injected', email: 'injected@example.invalid', password, typeId: 'administrator' }).expect(400);
    await post('register', { username: 'unverified', email: 'unverified@example.invalid', password }).expect(201);
    await post('login', { username: 'unverified', password }).expect(401);
    const ticket = deliveries.at(-1)!.ticket;
    const rows = await pool.query(`SELECT "tokenHash" FROM "${schema}"."account_tickets"`);
    expect(rows.rows.every(row => row.tokenHash.length === 64 && row.tokenHash !== ticket)).toBe(true);
    await post('verify-email', { ticket }).expect(200);
    await post('verify-email', { ticket }).expect(400);
    const login = await post('login', { username: 'unverified', password }).expect(200);
    expect(JSON.stringify(login.body)).not.toContain('refresh');
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    await post('register', { username: 'othername', email: 'UNVERIFIED@example.invalid', password }).expect(409);
  });

  it('enforces origin and token purpose, and allows one concurrent refresh across independent services', async () => {
    const { login } = await verifiedUser('paralleluser');
    const refreshCookie = cookie(login);
    await request(app.getHttpServer()).post('/api/authorize/refresh').set('Cookie', refreshCookie).expect(403);
    await post('refresh').set('Origin', 'https://foreign.invalid').set('Cookie', refreshCookie).expect(403);
    await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(refreshCookie.split('=')[1])).expect(401);
    const concurrentApp = await start();
    try {
      const results = await Promise.all([
        post('refresh').set('Cookie', refreshCookie),
        request(concurrentApp.getHttpServer()).post('/api/authorize/refresh').set('Origin', origin).set('Cookie', refreshCookie).send({}),
      ]);
      expect(results.map(result => result.status).sort()).toEqual([200, 401]);
      await post('refresh').set('Cookie', refreshCookie).expect(401);
    } finally { await concurrentApp.close(); }
  });

  it('survives application restart and durably revokes access and refresh on logout', async () => {
    const { login } = await verifiedUser('restartuser');
    await app.close();
    app = await start();
    await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(login.body.token)).expect(200);
    const refreshed = await post('refresh').set('Cookie', cookie(login)).expect(200);
    await post('logout').set(bearer(refreshed.body.access_token)).expect(200);
    await app.close();
    app = await start();
    await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(refreshed.body.access_token)).expect(401);
    await post('refresh').set('Cookie', cookie(refreshed)).expect(401);
  });

  it('isolates session ownership and rolls back a failed password reset before revoking all older credentials', async () => {
    const a = await verifiedUser('ownerone');
    const b = await verifiedUser('ownertwo');
    const bSessions = await request(app.getHttpServer()).get('/api/authorize/sessions').set(bearer(b.login.body.token)).expect(200);
    expect(JSON.stringify(bSessions.body)).not.toContain('refreshJti');
    await request(app.getHttpServer()).delete(`/api/authorize/sessions/${bSessions.body[0].id}`)
      .set('Origin', origin).set(bearer(a.login.body.token)).expect(403);
    await post('forgot-password', { email: a.email }).expect(200);
    await app.get(AccountService).settled();
    const ticket = deliveries.at(-1)!.ticket;
    await post('reset-password', { ticket, password: 'short' }).expect(400);
    const nextPassword = 'NewSynthetic9!';
    await post('reset-password', { ticket, password: nextPassword }).expect(200);
    await post('reset-password', { ticket, password: nextPassword }).expect(400);
    await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(a.login.body.token)).expect(401);
    await post('refresh').set('Cookie', cookie(a.login)).expect(401);
    await post('login', { username: 'ownerone', password }).expect(401);
    await post('login', { username: 'ownerone', password: nextPassword }).expect(200);
    await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(b.login.body.token)).expect(200);
  });

  it('does not create an account while mail is unavailable, and never creates a default administrator', async () => {
    mailAvailable = false;
    try { await post('register', { username: 'nomailer', email: 'nomailer@example.invalid', password }).expect(503); }
    finally { mailAvailable = true; }
    const { rows } = await pool.query(`SELECT username FROM "${schema}"."users" WHERE username IN ('admin', 'nomailer')`);
    expect(rows).toEqual([]);
  });

  it('updates only allowed profile fields and invalidates all devices and older tickets on password change', async () => {
    const user = await verifiedUser('profileuser');
    await post('profile', { name: 'Updated name', locale: 'zh' }).set(bearer(user.login.body.token)).expect(200);
    await post('profile', { emailVerified: true }).set(bearer(user.login.body.token)).expect(400);
    await post('forgot-password', { email: user.email }).expect(200);
    await app.get(AccountService).settled();
    const oldTicket = deliveries.at(-1)!.ticket;
    await post('password', { currentPassword: 'Incorrect9', password: 'ChangedUser9!' }).set(bearer(user.login.body.token)).expect(401);
    await post('password', { currentPassword: password, password: 'ChangedUser9!' }).set(bearer(user.login.body.token)).expect(200);
    await post('refresh').set('Cookie', cookie(user.login)).expect(401);
    await post('reset-password', { ticket: oldTicket, password: 'AnotherUser9!' }).expect(400);
    const login = await post('login', { username: 'profileuser', password: 'ChangedUser9!' }).expect(200);
    const me = await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(login.body.token)).expect(200);
    expect(me.body.name).toBe('Updated name');
    expect(me.body.password).toBeUndefined();
  });

  it('wires the same account contract into the full Server composition without automatic administrator creation', async () => {
    await verifiedUser('fullmember');
    const saved = { DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: process.env.JWT_SECRET };
    process.env.DATABASE_URL = scopedUrl;
    process.env.JWT_SECRET = 'synthetic-full-template-secret-for-tests';
    let full: INestApplication | undefined;
    try {
      const { AppModule } = await import('../src/app.module');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
      full = module.createNestApplication();
      full.setGlobalPrefix('api');
      full.useGlobalFilters(new HttpExceptionFilter());
      await full.init();
      await request(full.getHttpServer()).get('/api/authorize/me').expect(401);
      const login = await request(full.getHttpServer()).post('/api/authorize/login').set('Origin', origin)
        .send({ username: 'fullmember', password }).expect(200);
      await request(full.getHttpServer()).post('/api/roles/_query').set(bearer(login.body.token)).send({}).expect(403);
      await request(full.getHttpServer()).put(`/api/users/${login.body.userId}/roles`).set(bearer(login.body.token))
        .send({ roleIds: ['synthetic-superadmin'] }).expect(403);
      await request(full.getHttpServer()).put(`/api/users/${login.body.userId}`).set(bearer(login.body.token))
        .send({ password: 'ForgedPassword9!' }).expect(403);
      await request(full.getHttpServer()).get('/api/menu/all').set(bearer(login.body.token)).expect(403);
      await request(full.getHttpServer()).post('/api/menu').set(bearer(login.body.token)).send({ name: 'Forged menu' }).expect(403);
      const database = full.get<ApplicationDatabase>('DATABASE_ADAPTER');
      await createAdministrator(database, { username: 'admin', email: 'owner@example.invalid', password });
      await expect(createAdministrator(database, { username: 'admin', email: 'replacement@example.invalid', password })).rejects.toThrow('already exists');
      const admin = await request(full.getHttpServer()).post('/api/authorize/login').set('Origin', origin)
        .send({ username: 'admin', password }).expect(200);
      const me = await request(full.getHttpServer()).get('/api/authorize/me').set(bearer(admin.body.token)).expect(200);
      expect(me.body.permissions).toContainEqual({ id: '*', actions: ['*'] });
      await request(full.getHttpServer()).post('/api/roles/_query').set(bearer(admin.body.token)).send({}).expect(200);
      const menus = await request(full.getHttpServer()).get('/api/menu/tree').set(bearer(admin.body.token)).expect(200);
      expect(menus.body.length).toBeGreaterThan(0);
    } finally {
      await full?.close();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('invalidates sessions and tickets for password writes through the shared user-management service', async () => {
    const user = await verifiedUser('managedpassword');
    await post('forgot-password', { email: user.email }).expect(200);
    await app.get(AccountService).settled();
    const ticket = deliveries.at(-1)!.ticket;
    await app.get(UserService).updateUser(user.login.body.userId, { password: 'ManagerChanged9!' });
    await request(app.getHttpServer()).get('/api/authorize/me').set(bearer(user.login.body.token)).expect(401);
    await post('refresh').set('Cookie', cookie(user.login)).expect(401);
    await post('reset-password', { ticket, password: 'StaleTicket9!' }).expect(400);
    await post('login', { username: 'managedpassword', password: 'ManagerChanged9!' }).expect(200);
  });
});
