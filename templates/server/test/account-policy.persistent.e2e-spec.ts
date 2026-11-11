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
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { AccountOnboarding, sanitizeSignupIp, sanitizeUtmSource } from '../src/accounts/account-onboarding';
import { ACCOUNT_POLICIES } from '../src/accounts/account.policy';
import { AssignRoleError, assignRoleByEmail, parseAssignRoleArguments } from '../src/accounts/assign-role';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '@zucker-framework/back-office/settings';

/**
 * WP 1.2 implementer proof: account policy over HTTP with real PostgreSQL and NO mail transport
 * configured (the real MailService-backed mailer is used, not a fake).
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_acctpolicy_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticPolicy9!';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-account-policy-jwt-at-least-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-which-is-never-a-jwt' };

run('account policy, acquisition and welcome credits', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, policies: PolicyService;
  const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).set('X-Forwarded-For', '203.0.113.9').send(body);
  const setPolicy = async (values: Record<string, unknown>) => {
    const current = await policies.view('account');
    await policies.save('synthetic-operator', 'account', { expectedRevision: current.revision, values });
  };
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const limits = { points: 3000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), AccountModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).compile();
    app = module.createNestApplication(); app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    policies = app.get(PolicyService);
  });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('keeps today\'s behaviour by default: verification required and 503 without a mail transport', async () => {
    expect((await request(app.getHttpServer()).get('/api/site/public/config').expect(200)).body.policies.account.values)
      .toEqual({ registrationOpen: true, requireEmailVerification: true, twoFactorEnabled: true, magicLinkEnabled: false, deletionEnabled: true, deletionGraceDays: 7 });
    await post('register', { username: 'defaultuser', email: 'defaultuser@example.invalid', password }).expect(503);
  });

  it('signs in at registration when verification is off, records sanitised acquisition data and grants welcome credits once', async () => {
    const role = (await q('INSERT INTO "S".roles (id, name) VALUES ($1, $2) RETURNING id', ['role_member_plus', 'member-plus']))[0];
    await setPolicy({ requireEmailVerification: false, welcomeCreditsEnabled: true, welcomeCreditsAmount: 50, welcomeCreditsValidDays: 30, initialRoleId: role.id });
    const registered = await post('register', { username: 'openuser', email: 'openuser@example.invalid', password, utm: 'news<script>letter_2026.v1' }).expect(201);
    expect(registered.body).toMatchObject({ verificationRequired: false, userId: expect.any(String), token: expect.any(String) });
    expect(String(registered.headers['set-cookie'])).toContain('HttpOnly');
    const userId = registered.body.userId as string;
    await request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${registered.body.token}`).expect(200);
    await post('login', { username: 'openuser', password }).expect(200);
    expect(await q('SELECT "signupMethod", "signupIp", "signupUtmSource" FROM "S".user_acquisition WHERE "userId" = $1', [userId]))
      .toEqual([{ signupMethod: 'password', signupIp: '203.0.113.9', signupUtmSource: 'newsscriptletter_2026.v1' }]);
    expect(await q('SELECT "roleId" FROM "S".user_roles WHERE "userId" = $1', [userId])).toEqual([{ roleId: role.id }]);
    const onboarding = app.get(AccountOnboarding);
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => onboarding.grantWelcomeCredits(userId, { amount: 50, validDays: 30 })));
    expect(outcomes.every(outcome => outcome === 'already-granted')).toBe(true);
    const lots = await q('SELECT amount, source, "sourceId", "expiresAt" FROM "S".credit_lots WHERE "userId" = $1', [userId]);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ amount: 50, source: 'welcome', sourceId: `welcome:${userId}` });
    expect((await q('SELECT balance FROM "S".credit_account WHERE "userId" = $1', [userId]))[0].balance).toBe(50);
  });

  it('grants exactly once under 10 concurrent first triggers', async () => {
    const userId = (await q(`INSERT INTO "S".users (id, username, name, "typeId", "createTime") VALUES ($1, $1, $1, 'member', now()) RETURNING id`, ['concurrent_member']))[0].id;
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => app.get(AccountOnboarding).grantWelcomeCredits(userId, { amount: 7, validDays: 0 })));
    expect(outcomes.filter(outcome => outcome === 'granted')).toHaveLength(1);
    expect(await q('SELECT amount, "expiresAt" FROM "S".credit_lots WHERE "userId" = $1', [userId])).toEqual([{ amount: 7, expiresAt: null }]);
  });

  it('never assigns superadmin as the initial role and rejects sign-up while registration is closed', async () => {
    const superadmin = (await q(`INSERT INTO "S".roles (id, name) VALUES ('role_super', 'superadmin') RETURNING id`))[0];
    await setPolicy({ initialRoleId: superadmin.id, welcomeCreditsEnabled: false });
    const registered = await post('register', { username: 'plainuser', email: 'plainuser@example.invalid', password }).expect(201);
    expect(await q('SELECT 1 FROM "S".user_roles WHERE "userId" = $1', [registered.body.userId])).toEqual([]);
    await setPolicy({ registrationOpen: false });
    await post('register', { username: 'closeduser', email: 'closeduser@example.invalid', password }).expect(403);
    await post('login', { username: 'plainuser', password }).expect(200);
    await setPolicy({ registrationOpen: null, requireEmailVerification: null });
    // Verification back on: the unverified account can no longer sign in.
    await post('login', { username: 'plainuser', password }).expect(401);
  });

  it('assigns an existing role by e-mail and refuses unknown roles and accounts', async () => {
    await expect(assignRoleByEmail(database, { email: 'plainuser@example.invalid', role: 'no-such-role' })).rejects.toBeInstanceOf(AssignRoleError);
    await expect(assignRoleByEmail(database, { email: 'nobody@example.invalid', role: 'member-plus' })).rejects.toBeInstanceOf(AssignRoleError);
    expect(await assignRoleByEmail(database, { email: 'PlainUser@example.invalid', role: 'member-plus' })).toMatchObject({ assigned: true, roleName: 'member-plus' });
    expect(await assignRoleByEmail(database, { email: 'plainuser@example.invalid', role: 'member-plus' })).toMatchObject({ assigned: false });
    expect(parseAssignRoleArguments(['--', '--email', 'a@example.invalid', '--role=admin'])).toEqual({ email: 'a@example.invalid', role: 'admin' });
    expect(() => parseAssignRoleArguments(['--email', 'a@example.invalid'])).toThrow(AssignRoleError);
  });

  it('sanitises acquisition values', () => {
    expect(sanitizeUtmSource('a'.repeat(100))).toHaveLength(64);
    expect(sanitizeUtmSource('<>"')).toBeNull();
    expect(sanitizeSignupIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(sanitizeSignupIp('not-an-ip')).toBeNull();
  });
});
