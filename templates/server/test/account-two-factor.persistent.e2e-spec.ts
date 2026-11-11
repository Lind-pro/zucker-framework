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
import { AccountTwoFactorService } from '../src/accounts/security/two-factor.service';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '../src/policy/policy.service';

/**
 * WP 3.3b implementer checks (Sonnet extends): TOTP enrolment, login step-up with code and recovery
 * code, replay, challenge purpose confusion, magic link, fail-closed without the encryption key.
 * PostgreSQL, stub mailer, injected clock; synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_2fa_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticTwoFactor9!';

run('account two-factor and magic link (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, policies: PolicyService;
  let now = new Date('2026-11-10T10:00:00.000Z');
  const mail: Array<{ email: string; purpose: string; ticket: string }> = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, purpose, ticket) { mail.push({ email, purpose, ticket }); } };
  const post = (path: string, body: object = {}, token?: string) => {
    const call = request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin);
    return (token ? call.set('Authorization', `Bearer ${token}`) : call).send(body);
  };
  const me = (token: string) => request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${token}`);
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const code = (secret: string, at = now) => generateTotpCode({ secret, time: at.getTime() });
  const setPolicy = async (values: Record<string, unknown>) => {
    const current = await policies.view('account'); await policies.save('synthetic-operator', 'account', { expectedRevision: current.revision, values });
  };
  async function member(username: string) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, password) VALUES ($1,$2,$2,'member',$3,true,true,$4)`,
      [id, username, `${username}@example.invalid`, await new BcryptEncoder().encode(password)]);
    return id;
  }
  const login = (username: string) => post('login', { username, password });

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
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-two-factor-jwt-at-least-32-chars',
      CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-two-factor-only' };
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, login: limits, 'login-account': limits, 'session-refresh': limits,
        'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), AccountModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(ACCOUNT_SECURITY_CLOCK).useValue(() => now).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    policies = app.get(PolicyService);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('enrols with recent authentication, ends other sessions, and requires a code at the next sign-in', async () => {
    const userId = await member('totp_owner');
    const other = (await login('totp_owner').expect(200)).body.token as string;
    const current = (await login('totp_owner').expect(200)).body.token as string;
    expect((await post('two-factor/enrol', {}, current).expect(403)).body.code).toBe('RECENT_AUTHENTICATION_REQUIRED');
    expect((await post('two-factor/enrol', { password: 'wrong' }, current).expect(403)).body.code).toBe('RECENT_AUTHENTICATION_FAILED');
    const enrolled = (await post('two-factor/enrol', { password }, current).expect(200)).body as { secret: string; otpauthUri: string };
    expect(enrolled.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await q('SELECT status, "secretCiphertext" FROM "S".account_two_factor WHERE "userId" = $1', [userId]))[0])
      .toEqual({ status: 'pending', secretCiphertext: expect.stringMatching(/^v2\./) });
    expect((await post('two-factor/confirm', { code: '000000' }, current).expect(400)).body.code).toBe('TWO_FACTOR_CODE_INVALID');
    const confirmed = await post('two-factor/confirm', { code: code(enrolled.secret) }, current).expect(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    await me(current).expect(200);
    await me(other).expect(401);
    expect(JSON.stringify(confirmed.body)).not.toContain(enrolled.secret);

    // Password login now returns a challenge and no cookie.
    now = new Date(now.getTime() + 30_000);
    const step = await login('totp_owner').expect(200);
    expect(step.body).toEqual({ twoFactorRequired: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(step.headers['set-cookie']).toBeUndefined();
    // Purpose confusion: the challenge is refused elsewhere and stays usable.
    await post('verify-email', { ticket: step.body.challenge }).expect(400);
    // A wrong code does not burn the challenge.
    expect((await post('login/two-factor', { challenge: step.body.challenge, code: '123456' }).expect(401)).body.code).toBe('TWO_FACTOR_CODE_INVALID');
    const good = code(enrolled.secret);
    const signedIn = await post('login/two-factor', { challenge: step.body.challenge, code: good }).expect(200);
    expect(signedIn.body.token).toBeTruthy(); expect(signedIn.headers['set-cookie']).toBeDefined();
    await post('login/two-factor', { challenge: step.body.challenge, code: good }).expect(400);
    // The same step cannot be replayed with a fresh challenge.
    const again = (await login('totp_owner').expect(200)).body.challenge as string;
    await post('login/two-factor', { challenge: again, code: good }).expect(401);

    // A recovery code works exactly once, even under concurrent attempts.
    const recovery = (confirmed.body.recoveryCodes as string[])[0]!;
    const challenges = await Promise.all(Array.from({ length: 10 }, async () => (await login('totp_owner')).body.challenge as string));
    const results = await Promise.all(challenges.map(challenge => post('login/two-factor', { challenge, recoveryCode: recovery })));
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect((await q('SELECT count(*)::int AS n FROM "S".account_recovery_codes WHERE "userId" = $1 AND "usedAt" IS NULL', [userId]))[0].n).toBe(9);
  });

  it('turns two-factor off only with recent authentication and a valid factor', async () => {
    await member('totp_off');
    const token = (await login('totp_off').expect(200)).body.token as string;
    const { secret } = (await post('two-factor/enrol', { password }, token).expect(200)).body as { secret: string };
    now = new Date(now.getTime() + 30_000);
    await post('two-factor/confirm', { code: code(secret) }, token).expect(200);
    await post('two-factor/disable', { password, code: '000000' }, token).expect(400);
    now = new Date(now.getTime() + 30_000);
    await post('two-factor/disable', { password, code: code(secret) }, token).expect(200);
    expect((await login('totp_off').expect(200)).body.token).toBeTruthy();
  });

  it('fails closed without an encryption key and writes nothing', async () => {
    const userId = await member('totp_nokey');
    const service = new AccountTwoFactorService(database, () => now, { JWT_SECRET: 'x' });
    await expect(service.enrol({ id: userId, username: 'totp_nokey' })).rejects.toMatchObject({ status: 503 });
    expect(await q('SELECT 1 FROM "S".account_two_factor WHERE "userId" = $1', [userId])).toEqual([]);
  });

  it('signs in by magic link only for existing accounts and asks for the code when two-factor is on', async () => {
    await post('magic-link', { email: 'nobody@example.invalid' }).expect(403);
    await setPolicy({ magicLinkEnabled: true });
    await member('link_member');
    mail.length = 0;
    expect((await post('magic-link', { email: 'nobody@example.invalid' }).expect(200)).body).toEqual({ accepted: true });
    expect((await post('magic-link', { email: 'link_member@example.invalid' }).expect(200)).body).toEqual({ accepted: true });
    await app.get(AccountService).settled();
    expect(mail.map(entry => [entry.email, entry.purpose])).toEqual([['link_member@example.invalid', 'magic-link']]);
    const session = await post('magic-link/consume', { ticket: mail[0]!.ticket }).expect(200);
    expect(session.body.token).toBeTruthy();
    await me(session.body.token).expect(200);
    await post('magic-link/consume', { ticket: mail[0]!.ticket }).expect(400);

    mail.length = 0;
    await post('magic-link', { email: 'totp_owner@example.invalid' }).expect(200);
    await app.get(AccountService).settled();
    const stepped = await post('magic-link/consume', { ticket: mail[0]!.ticket }).expect(200);
    expect(stepped.body).toEqual({ twoFactorRequired: true, challenge: expect.any(String) });
    await setPolicy({ magicLinkEnabled: null });
  });
});
