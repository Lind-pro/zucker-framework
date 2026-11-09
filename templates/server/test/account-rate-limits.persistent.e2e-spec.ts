import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerAuthModule, PermissionsGuard } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { AccountController } from '../src/accounts/account.controller';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../src/accounts/account.service';
import { createAdministrator } from '../src/accounts/create-administrator';
import { ApplicationDatabase } from '../src/database';
import { APP_RATE_LIMITERS } from '../src/rate-limits';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:4202';
const password = 'SyntheticLimits9!';
const schema = `zucker_rate_limits_${randomUUID().replaceAll('-', '')}`;
const run = databaseUrl ? describe : describe.skip;

/** The application's actual rate-limit policy (src/rate-limits.ts), over real HTTP and PostgreSQL. */
run('account rate-limit policy', () => {
  let pool: Pool;
  let db: ApplicationDatabase;
  let app: INestApplication;
  const mailer: AccountMailer = { assertConfigured() {}, async send() {} };
  const budget = (name: string) => APP_RATE_LIMITERS[name]!.points;

  const post = (path: string, body: object = {}, cookie?: string) => {
    const call = request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin);
    return (cookie ? call.set('Cookie', cookie) : call).send(body);
  };
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    (response.headers['set-cookie'] as string[])[0].split(';')[0];
  /** One page load: restore the access token from the cookie, then read the account. */
  async function pageLoad(cookie: string): Promise<string> {
    const refreshed = await post('refresh', {}, cookie);
    expect(refreshed.status).toBe(200);
    await request(app.getHttpServer())
      .get('/api/authorize/me')
      .set('Authorization', `Bearer ${refreshed.body.access_token}`)
      .expect(200);
    return cookieOf(refreshed);
  }
  async function signIn(username: string): Promise<string> {
    return cookieOf(await post('login', { username, password }).expect(200));
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
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        await client.query(
          readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''),
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    parsed.searchParams.set('schema', schema);
    db = new ApplicationDatabase(parsed.href);
    for (const username of ['limitsone', 'limitstwo'])
      await createAdministrator(db, { username, email: `${username}@example.invalid`, password });
  });
  // A fresh application (and in-memory limiter state) per scenario.
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ZuckerCrudModule.forRootAsync({ useFactory: () => db }),
        ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-rate-limit-test-secret-only', registerControllers: false }),
        ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { ...APP_RATE_LIMITERS } }),
      ],
      controllers: [AccountController],
      providers: [
        AccountService,
        AccountGuard,
        { provide: ACCOUNT_MAILER, useValue: mailer },
        { provide: APP_GUARD, useClass: AccountGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  afterAll(async () => {
    try {
      await db?.onModuleDestroy();
    } finally {
      if (pool) {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    }
  });

  it('lets one session reload far more often than the credential budget without throttling', async () => {
    let cookie = await signIn('limitsone');
    // 2× the credential budget of page loads (refresh + me each) within one window.
    for (let index = 0; index < budget('accounts') * 2; index++) cookie = await pageLoad(cookie);
    // Browsing did not consume the credential budget: signing in again still works.
    await signIn('limitsone');
  });

  it('keeps login, registration, verification and password reset on the strict per-client budget', async () => {
    const cookie = await signIn('limitsone');
    for (let index = 1; index < budget('accounts'); index++)
      await post('login', { username: 'limitsone', password: 'wrong-password' }).expect(401);
    const throttled = await post('login', { username: 'limitsone', password });
    expect(throttled.status).toBe(429);
    await post('register', { username: 'limitsnew', email: 'limitsnew@example.invalid', password }).expect(429);
    await post('verification', { email: 'limitsone@example.invalid' }).expect(429);
    await post('verify-email', { ticket: 'synthetic-ticket' }).expect(429);
    await post('forgot-password', { email: 'limitsone@example.invalid' }).expect(429);
    await post('reset-password', { ticket: 'synthetic-ticket', password }).expect(429);
    // An existing session keeps browsing while credential endpoints are blocked.
    await pageLoad(cookie);
  });

  it('bounds refresh per session without affecting other sessions', async () => {
    let first = await signIn('limitsone');
    const second = await signIn('limitstwo');
    for (let index = 0; index < budget('session-refresh'); index++) {
      const response = await post('refresh', {}, first).expect(200);
      first = cookieOf(response);
    }
    await post('refresh', {}, first).expect(429);
    await pageLoad(second);
  });

  it('caps refresh attempts per client, including invalid cookies', async () => {
    for (let index = 0; index < budget('session-refresh-network'); index++)
      await post('refresh', {}, 'zucker-session=synthetic-invalid-token').expect(401);
    await post('refresh', {}, 'zucker-session=synthetic-invalid-token').expect(429);
  });

  it('still denies a replayed refresh token after rotation', async () => {
    const original = await signIn('limitsone');
    const rotated = cookieOf(await post('refresh', {}, original).expect(200));
    await post('refresh', {}, original).expect(401);
    await pageLoad(rotated);
  });
});
