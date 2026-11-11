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
import { BcryptEncoder, PermissionsGuard, ZuckerAuthModule, generateTotpCode } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../src/accounts/account.service';
import { ACCOUNT_POLICIES } from '../src/accounts/account.policy';
import { ACCOUNT_SECURITY_CLOCK } from '../src/accounts/security/account-security.clock';
import { ACCOUNT_SECURITY_RATE_LIMITERS } from '../src/accounts/security/account-security.limits';
import { FAILED_DELETION_RETRY_MS } from '../src/accounts/deletion';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';

/**
 * WP 3.Z account-security hardening: recovery codes share the TOTP lockout, the `two-factor` limiter
 * bounds second-factor guesses, enrolled sign-in fails closed (503) without CONFIG_ENCRYPTION_KEY, and
 * the staff 2FA reset (permission, recent authentication, Origin, superadmin guard, audit, sessions,
 * owner notice). PostgreSQL, stub mailer, injected clock; synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_2fah_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticHardening9!';
const baseEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-hardening-jwt-at-least-32-chars-long' };

run('account security hardening (PostgreSQL)', () => {
  let app: INestApplication, keyless: INestApplication, pool: Pool, database: ApplicationDatabase;
  let now = new Date('2026-11-10T10:00:00.000Z');
  const resets: Array<{ email: string; userId: string }> = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send() {},
    async twoFactorReset(email, _locale, userId) { resets.push({ email, userId }); } };
  const call = (target: INestApplication, path: string, body: object = {}, token?: string, withOrigin = true) => {
    let req = request(target.getHttpServer()).post(`/api/${path}`);
    if (withOrigin) req = req.set('Origin', origin);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
  };
  const post = (path: string, body: object = {}, token?: string) => call(app, `authorize/${path}`, body, token);
  const me = (token: string) => request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${token}`);
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const code = (secret: string, at = now) => generateTotpCode({ secret, time: at.getTime() });
  const tick = () => { now = new Date(now.getTime() + 30_000); };
  async function member(username: string, roleName?: string, permissionCodes: string[] = []) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, password) VALUES ($1,$2,$2,'member',$3,true,true,$4)`,
      [id, username, `${username}@example.invalid`, await new BcryptEncoder().encode(password)]);
    if (roleName) {
      const roleId = randomUUID();
      await q('INSERT INTO "S".roles (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [roleId, roleName]);
      const role = (await q('SELECT id FROM "S".roles WHERE name = $1', [roleName]))[0].id as string;
      for (const permission of permissionCodes) {
        await q('INSERT INTO "S".permissions (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [permission]);
        await q('INSERT INTO "S".role_permissions (id, "roleId", "permissionId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [randomUUID(), role, permission]);
      }
      await q('INSERT INTO "S".user_roles (id, "userId", "roleId") VALUES ($1,$2,$3)', [randomUUID(), id, role]);
    }
    return id;
  }
  const login = (username: string) => post('login', { username, password });
  async function enrolled(username: string, roleName?: string, permissionCodes?: string[]) {
    const userId = await member(username, roleName, permissionCodes);
    const token = (await login(username).expect(200)).body.token as string;
    const { secret } = (await post('two-factor/enrol', { password }, token).expect(200)).body as { secret: string };
    tick();
    const { recoveryCodes } = (await post('two-factor/confirm', { code: code(secret) }, token).expect(200)).body as { recoveryCodes: string[] };
    tick();
    return { userId, token, secret, recoveryCodes };
  }
  async function signIn(username: string, secret: string) {
    const step = (await login(username).expect(200)).body as { challenge: string };
    tick();
    return (await post('login/two-factor', { challenge: step.challenge, code: code(secret) }).expect(200)).body.token as string;
  }

  async function boot(env: NodeJS.ProcessEnv) {
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, login: limits, 'login-account': limits, 'session-refresh': limits,
        'session-refresh-network': limits, 'session-read': limits, 'api-default': limits,
        ...ACCOUNT_SECURITY_RATE_LIMITERS, 'two-factor': { points: 6, duration: 900 } } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), AccountModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(ACCOUNT_SECURITY_CLOCK).useValue(() => now).compile();
    const nest = module.createNestApplication(); nest.setGlobalPrefix('api'); nest.useGlobalFilters(new HttpExceptionFilter()); await nest.init();
    return nest;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    pool = new Pool({ connectionString: url.href }); const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    app = await boot({ ...baseEnv, CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-hardening-only' });
    keyless = await boot({ ...baseEnv });
  });
  afterAll(async () => {
    try { await app?.close(); await keyless?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('exports the failed-deletion retry delay', () => {
    expect(FAILED_DELETION_RETRY_MS).toBe(60 * 60_000);
  });

  it('counts wrong recovery codes toward the TOTP lockout and bounds guesses with the two-factor limiter', async () => {
    const { secret, recoveryCodes } = await enrolled('harden_lock');
    const challenge = (await login('harden_lock').expect(200)).body.challenge as string;
    for (let i = 0; i < 5; i++) {
      expect((await post('login/two-factor', { challenge, recoveryCode: `zzzzz-zzzz${'23456'[i]}` }).expect(401)).body.code).toBe('TWO_FACTOR_CODE_INVALID');
    }
    // Locked: neither a fresh authenticator code nor a genuine recovery code passes now.
    tick();
    await post('login/two-factor', { challenge, code: code(secret) }).expect(401);
    // Seventh guess on this account: the shared two-factor budget (6 per 15 minutes here) refuses before checking.
    await post('login/two-factor', { challenge, recoveryCode: recoveryCodes[0] }).expect(429);
    expect((await q('SELECT count(*)::int AS n FROM "S".account_recovery_codes rc JOIN "S".users u ON u.id = rc."userId" WHERE u.username = $1 AND rc."usedAt" IS NULL',
      ['harden_lock']))[0].n).toBe(10);
  });

  it('fails closed with 503 TWO_FACTOR_UNAVAILABLE for an enrolled sign-in on a server without CONFIG_ENCRYPTION_KEY', async () => {
    await enrolled('harden_keyless');
    const refused = await call(keyless, 'authorize/login', { username: 'harden_keyless', password }).expect(503);
    expect(refused.body.code).toBe('TWO_FACTOR_UNAVAILABLE');
    expect(refused.headers['set-cookie']).toBeUndefined();
    // Accounts without two-factor still sign in there.
    await member('harden_keyless_plain');
    expect((await call(keyless, 'authorize/login', { username: 'harden_keyless_plain', password }).expect(200)).body.token).toBeTruthy();
  });

  it('lets staff with users:update reset another account\'s two-factor (recent auth, Origin, audit, sessions, notice)', async () => {
    const target = await enrolled('harden_target');
    const targetSession = await signIn('harden_target', target.secret);
    await member('harden_staff', 'harden-support', ['users:update']);
    await member('harden_viewer', 'harden-viewer', ['users:query']);
    const staff = (await login('harden_staff').expect(200)).body.token as string;
    const viewer = (await login('harden_viewer').expect(200)).body.token as string;
    const path = `management/users/${target.userId}/two-factor/reset`;

    await call(app, path, { password }, viewer).expect(403);
    await call(app, path, { password }, staff, false).expect(403);
    expect((await call(app, path, {}, staff).expect(403)).body.code).toBe('RECENT_AUTHENTICATION_REQUIRED');
    expect((await call(app, path, { password: 'wrong' }, staff).expect(403)).body.code).toBe('RECENT_AUTHENTICATION_FAILED');
    await call(app, path, { password, extra: 'x' }, staff).expect(400);
    const staffId = (await q('SELECT id FROM "S".users WHERE username = $1', ['harden_staff']))[0].id as string;
    expect((await call(app, `management/users/${staffId}/two-factor/reset`, { password }, staff).expect(400)).body.code).toBe('TWO_FACTOR_RESET_SELF');
    await call(app, 'management/users/not%20an%20id/two-factor/reset', { password }, staff).expect(404);
    expect(await q('SELECT 1 FROM "S".account_two_factor WHERE "userId" = $1', [target.userId])).toHaveLength(1);

    resets.length = 0;
    expect((await call(app, path, { password }, staff).expect(200)).body).toEqual({ reset: true });
    await app.get(AccountService).settled();
    expect(await q('SELECT 1 FROM "S".account_two_factor WHERE "userId" = $1', [target.userId])).toEqual([]);
    expect(await q('SELECT 1 FROM "S".account_recovery_codes WHERE "userId" = $1', [target.userId])).toEqual([]);
    await me(targetSession).expect(401);
    await me(target.token).expect(401);
    const audit = await q(`SELECT "userId", "targetId", metadata FROM "S".operation_logs WHERE module = 'account-security' AND action = 'two-factor-reset'`);
    expect(audit).toEqual([{ userId: staffId, targetId: target.userId, metadata: { previousStatus: 'active', recoveryCodesRemoved: 10 } }]);
    expect(JSON.stringify(audit)).not.toContain(target.secret);
    expect(resets).toEqual([{ email: 'harden_target@example.invalid', userId: target.userId }]);
    expect((await call(app, path, { password }, staff).expect(409)).body.code).toBe('TWO_FACTOR_NOT_ENABLED');
    // The owner signs in with the password alone and can enrol again.
    expect((await login('harden_target').expect(200)).body.token).toBeTruthy();
  });

  it('refuses a superadmin target unless the acting staff member is a superadmin', async () => {
    const admin = await enrolled('harden_superadmin', 'superadmin');
    await member('harden_staff2', 'harden-support', ['users:update']);
    const staff = (await login('harden_staff2').expect(200)).body.token as string;
    const path = `management/users/${admin.userId}/two-factor/reset`;
    expect((await call(app, path, { password }, staff).expect(403)).body.code).toBe('TWO_FACTOR_RESET_FORBIDDEN');
    expect(await q('SELECT 1 FROM "S".account_two_factor WHERE "userId" = $1', [admin.userId])).toHaveLength(1);
    const peer = await enrolled('harden_superadmin_peer', 'superadmin');
    const peerToken = await signIn('harden_superadmin_peer', peer.secret);
    await call(app, path, { password }, peerToken).expect(200);
    expect(await q('SELECT 1 FROM "S".account_two_factor WHERE "userId" = $1', [admin.userId])).toEqual([]);
  });
});
