import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule, type VerifiedOAuthIdentity } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { MailService } from '@zucker-framework/notification';
import { DurableTaskRetryScheduledError } from '@zucker-framework/task';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { AccountService } from '../src/accounts/account.service';
import { AccountOnboarding, WELCOME_CREDITS_JOB } from '../src/accounts/account-onboarding';
import { ACCOUNT_POLICIES } from '../src/accounts/account.policy';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_SETTINGS, type OAuthProvider, type OAuthSettings } from '../src/oauth/oauth.config';
import { OAUTH_PROVIDER_CLIENT, type OAuthProviderClient } from '../src/oauth/oauth-provider';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { BILLING_RECEIPT_JOB, BillingReceiptMail } from '../src/mail/billing-receipt.runtime';
import { TransactionalMail } from '@zucker-framework/back-office/mail';
import { ACCOUNT_MAIL_TEMPLATES } from '@zucker-framework/back-office/mail';
import { CHECKOUT_FULFILLED_OUTBOX_KIND } from '../src/billing/checkout-persistence';

/**
 * WP 1.2 test-engineer coverage: first-time OAuth sign-up under the account policy, the welcome-credit
 * retry job, the known crash gap, receipt-mail wake, stored subject override, template href escaping
 * and the register response contract. PostgreSQL + a loopback SMTP stub; no network, synthetic data.
 */
function smtpStub(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer(socket => {
    let buffer = '', data = false;
    socket.write('220 stub ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 queued\r\n'); continue; }
        const line = buffer.indexOf('\r\n'); if (line < 0) return;
        const command = buffer.slice(0, line); buffer = buffer.slice(line + 2);
        const verb = command.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') socket.write('250-stub\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as AddressInfo).port, messages })));
}
/** Decodes RFC 2047 subjects and quoted-printable bodies enough to search them. */
function decoded(raw: string): string {
  const qp = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const words = [...raw.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi)].map(match => Buffer.from(match[1]!, 'base64').toString('utf8'));
  return [...words, Buffer.from(qp, 'latin1').toString('utf8')].join('\n');
}
const headerBlock = (raw: string) => raw.split('\r\n\r\n')[0]!;

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_acctextra_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticExtras9!';
const settings: OAuthSettings = { webOrigin: origin, secureCookies: false, google: { clientId: 'synthetic-google', clientSecret: 'synthetic-only', code: true, oneTap: false },
  github: { clientId: '', clientSecret: '', code: false } };

run('account policy extras: OAuth sign-up, welcome retry, receipts, subjects (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, policies: PolicyService, smtp: Awaited<ReturnType<typeof smtpStub>>;
  let jobs: JobsService, host: JobsHost, onboarding: AccountOnboarding;
  const identities = new Map<string, VerifiedOAuthIdentity>();
  const post = (path: string, body: object = {}) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).set('X-Forwarded-For', '198.51.100.20').send(body);
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const setPolicy = async (values: Record<string, unknown>) => { const current = await policies.view('account'); await policies.save('synthetic-operator', 'account', { expectedRevision: current.revision, values }); };
  const resetPolicy = () => setPolicy({ registrationOpen: null, requireEmailVerification: null, initialRoleId: null, welcomeCreditsEnabled: null, welcomeCreditsAmount: null, welcomeCreditsValidDays: null });
  const lots = (userId: string) => q('SELECT source, amount, "sourceId", "expiresAt" FROM "S".credit_lots WHERE "userId" = $1 ORDER BY "createdAt"', [userId]);
  const cookie = (response: { headers: Record<string, unknown> }) => ((response.headers['set-cookie'] as string[] | undefined) ?? []).map(value => value.split(';')[0]).join('; ');
  const tasks = (userId: string) => q(`SELECT id, status, payload, "userId" FROM "S".async_jobs WHERE kind = $1 AND "userId" = $2`, [WELCOME_CREDITS_JOB, userId]);
  const failLotInserts = async (work: () => Promise<void>) => {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_lot_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic lot failure'; END; $$`);
    try {
      await pool.query(`CREATE TRIGGER synthetic_lot_failure BEFORE INSERT ON "${schema}".credit_lots FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_lot_failure()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER synthetic_lot_failure ON "${schema}".credit_lots`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_lot_failure()`); }
  };
  async function oauthSignIn(subject: string, email?: string) {
    const code = `code-${randomUUID()}`;
    identities.set(code, { provider: 'google', subject, email, emailVerified: Boolean(email), displayName: 'Synthetic member' });
    const start = await post('oauth/google/start', { mode: 'code', locale: 'en', returnPath: '/account' }).expect(200);
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!, flowCookie = cookie(start);
    const callback = await request(app.getHttpServer()).get('/api/authorize/oauth/google/callback').query({ state, code }).set('Cookie', flowCookie).expect(302);
    const proof = new URLSearchParams(new URL(callback.headers.location).hash.slice(1)).get('ticket')!;
    return post('oauth/google/complete', { proof }).set('Cookie', [flowCookie, cookie(callback)].filter(Boolean).join('; '));
  }
  async function owner(username: string, extra: Record<string, unknown> = {}) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, "createTime", locale) VALUES ($1,$2,$2,'member',$3,$4,$5,$6,$7)`,
      [id, username, extra.email ?? `${username}@example.invalid`, extra.verified ?? true, extra.status ?? true, extra.createdAt ?? new Date(), extra.locale ?? 'en']);
    return id;
  }

  beforeAll(async () => {
    smtp = await smtpStub();
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, SITE_NAME: 'Extras Site', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'sender@example.invalid',
      JWT_SECRET: 'synthetic-account-extras-jwt-at-least-32-chars', CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-extras-only' };
    @Global() @Module({ providers: [JobsService], exports: [JobsService] }) class TestJobs {}
    const limits = { points: 100_000, duration: 60 };
    const providerClient: OAuthProviderClient = { async code(provider, input) {
      const found = identities.get(input.code); if (!found || found.provider !== provider) throw new Error('synthetic-private-provider-error'); return found; },
      oneTap: async () => { throw new Error('unused'); } };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), TestJobs, AccountModule, OAuthModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(OAUTH_SETTINGS).useValue(settings).overrideProvider(OAUTH_PROVIDER_CLIENT).useValue(providerClient).compile();
    app = module.createNestApplication(); app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    policies = app.get(PolicyService); jobs = app.get(JobsService); onboarding = app.get(AccountOnboarding);
    host = new JobsHost(jobs, { isConfigured: () => false, runOnce: async () => {}, close: async () => {} } as never,
      { enabled: false, workerId: 'synthetic-extras', concurrency: 1, scanIntervalMs: 1000, leaseMs: 5000, heartbeatMs: 500, shutdownWaitMs: 2000 });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await host?.stop(); await app?.close(); await database?.disconnect(); smtp?.server.close(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  // ── OAuth under the account policy ─────────────────────────────────────
  it('applies initial role, welcome credits and acquisition data to a first-time OAuth sign-up exactly once', async () => {
    const role = (await q(`INSERT INTO "S".roles (id, name) VALUES ('role_oauth_plus', 'oauth-plus') RETURNING id`))[0];
    await setPolicy({ initialRoleId: role.id, welcomeCreditsEnabled: true, welcomeCreditsAmount: 20, welcomeCreditsValidDays: 7 });
    const signedIn = await oauthSignIn('oauth-open-subject', 'oauthopen@example.invalid').then(response => { expect(response.status).toBe(200); return response; });
    const userId = signedIn.body.userId as string;
    expect(userId).toBeTruthy();
    expect(await q('SELECT "roleId" FROM "S".user_roles WHERE "userId" = $1', [userId])).toEqual([{ roleId: role.id }]);
    expect(await q('SELECT "signupMethod", "signupIp", "signupUtmSource" FROM "S".user_acquisition WHERE "userId" = $1', [userId]))
      .toEqual([{ signupMethod: 'oauth:google', signupIp: '198.51.100.20', signupUtmSource: null }]);
    const granted = await lots(userId);
    expect(granted).toEqual([expect.objectContaining({ source: 'welcome', amount: 20, sourceId: `welcome:${userId}` })]);
    const created = (await q('SELECT "createTime" FROM "S".users WHERE id = $1', [userId]))[0].createTime as Date;
    expect((granted[0].expiresAt as Date).getTime() - created.getTime()).toBe(7 * 86_400_000);
    // Signing in again (same provider identity) is a login, not a second sign-up.
    const again = await oauthSignIn('oauth-open-subject', 'oauthopen@example.invalid');
    expect(again.status).toBe(200); expect(again.body.userId).toBe(userId);
    expect(await lots(userId)).toHaveLength(1);
    expect(await q('SELECT 1 FROM "S".user_acquisition WHERE "userId" = $1', [userId])).toHaveLength(1);
    expect(await q('SELECT 1 FROM "S".user_roles WHERE "userId" = $1', [userId])).toHaveLength(1);
  });

  it('never grants superadmin or a disabled/unknown role as the initial role at OAuth sign-up', async () => {
    const superadmin = (await q(`INSERT INTO "S".roles (id, name) VALUES ('role_oauth_super', 'superadmin') RETURNING id`))[0];
    await setPolicy({ initialRoleId: superadmin.id, welcomeCreditsEnabled: false });
    const first = await oauthSignIn('oauth-super-subject').then(response => { expect(response.status).toBe(200); return response; });
    expect(await q('SELECT 1 FROM "S".user_roles WHERE "userId" = $1', [first.body.userId])).toEqual([]);
    const disabled = (await q(`INSERT INTO "S".roles (id, name, status) VALUES ('role_oauth_off', 'oauth-off', false) RETURNING id`))[0];
    await setPolicy({ initialRoleId: disabled.id });
    const second = await oauthSignIn('oauth-disabled-subject'); expect(second.status).toBe(200);
    expect(await q('SELECT 1 FROM "S".user_roles WHERE "userId" = $1', [second.body.userId])).toEqual([]);
    await setPolicy({ initialRoleId: 'no-such-role' });
    const third = await oauthSignIn('oauth-unknown-subject'); expect(third.status).toBe(200);
    expect(await q('SELECT 1 FROM "S".user_roles WHERE "userId" = $1', [third.body.userId])).toEqual([]);
    await resetPolicy();
  });

  it('refuses a first-time OAuth sign-up while registration is closed and creates nothing, but existing accounts still sign in', async () => {
    const existing = await oauthSignIn('oauth-existing-subject', 'oauthexisting@example.invalid'); expect(existing.status).toBe(200);
    await setPolicy({ registrationOpen: false, welcomeCreditsEnabled: true, welcomeCreditsAmount: 5 });
    const users = (await q('SELECT count(*)::int AS n FROM "S".users'))[0].n, acquisitions = (await q('SELECT count(*)::int AS n FROM "S".user_acquisition'))[0].n;
    const lotCount = (await q('SELECT count(*)::int AS n FROM "S".credit_lots'))[0].n;
    const closed = await oauthSignIn('oauth-closed-subject', 'oauthclosed@example.invalid');
    expect(closed.status).toBe(403);
    expect((await q('SELECT count(*)::int AS n FROM "S".users'))[0].n).toBe(users);
    expect((await q('SELECT count(*)::int AS n FROM "S".user_acquisition'))[0].n).toBe(acquisitions);
    expect((await q('SELECT count(*)::int AS n FROM "S".credit_lots'))[0].n).toBe(lotCount);
    expect(await q(`SELECT 1 FROM "S".third_party_binds WHERE "providerAccountId" = 'oauth-closed-subject'`)).toEqual([]);
    const returning = await oauthSignIn('oauth-existing-subject', 'oauthexisting@example.invalid');
    expect(returning.status).toBe(200); expect(returning.body.userId).toBe(existing.body.userId);
    // Reopening admits the very same identity as a new account.
    await setPolicy({ registrationOpen: true });
    expect((await oauthSignIn('oauth-closed-subject', 'oauthclosed@example.invalid')).status).toBe(200);
    await resetPolicy();
  });

  // ── Register response contract ─────────────────────────────────────────
  it('returns exactly {verificationRequired:true} when verification is on and rejects unknown or non-string fields', async () => {
    await resetPolicy();
    const on = await post('register', { username: 'contract_on', email: 'contracton@example.invalid', password }).expect(201);
    expect(on.body).toEqual({ verificationRequired: true });
    expect(on.headers['set-cookie']).toBeUndefined();
    await post('register', { username: 'contract_bad', email: 'contractbad@example.invalid', password, role: 'admin' }).expect(400);
    await post('register', { username: 'contract_bad2', email: 'contractbad2@example.invalid', password, utm: 5 }).expect(400);
    await post('register', { username: 'contract_bad3', email: 'contractbad3@example.invalid', password, utm: 'x'.repeat(3000) }).expect(400);
    expect(await q(`SELECT 1 FROM "S".users WHERE username LIKE 'contract_bad%'`)).toEqual([]);
  });
  it('returns a signed-in session when verification is off and never includes secrets beyond the bearer pair', async () => {
    await setPolicy({ requireEmailVerification: false });
    const off = await post('register', { username: 'contract_off', email: 'contractoff@example.invalid', password }).expect(201);
    expect(Object.keys(off.body).sort()).toEqual(['expires', 'token', 'userId', 'verificationRequired']);
    expect(off.body.verificationRequired).toBe(false);
    expect(JSON.stringify(off.body)).not.toMatch(/password|refreshToken|hash/i);
    expect(String(off.headers['set-cookie'])).toMatch(/HttpOnly/);
    await resetPolicy();
  });
  it('is accepted by the web register page (the page must handle verificationRequired:false)', () => {
    // The server returns {verificationRequired:false, token...} and a session cookie when verification is off.
    // A page that throws on anything but `true` shows "registration failed" for an account that was created.
    const source = readFileSync(resolve('../web/src/app/[locale]/register/page.tsx'), 'utf8');
    // The page classifies the response with account-flow's registerOutcome (unit-tested in
    // templates/web/register-outcome.test.mjs) and completes sign-in for the `false` branch.
    expect(source).toContain('registerOutcome(');
    expect(source).toMatch(/establishSession\(outcome\.token\)/);
    const flow = readFileSync(resolve('../web/src/app/[locale]/account/_components/account-flow.ts'), 'utf8');
    expect(flow).toMatch(/verificationRequired === false/);
    const throwsOnFalse = /verificationRequired\s*!==\s*true\s*\)\s*throw/.test(source + flow);
    expect(throwsOnFalse, 'templates/web register page rejects verificationRequired:false as an unexpected response').toBe(false);
  });

  // ── Welcome credit retry job ───────────────────────────────────────────
  it('keeps sign-up successful when the inline grant fails, queues one retry with the frozen snapshot, and grants once when it runs', async () => {
    await setPolicy({ requireEmailVerification: false, welcomeCreditsEnabled: true, welcomeCreditsAmount: 30, welcomeCreditsValidDays: 0 });
    let userId = '';
    await failLotInserts(async () => {
      const registered = await post('register', { username: 'retry_user', email: 'retryuser@example.invalid', password }).expect(201);
      userId = registered.body.userId;
    });
    expect(await lots(userId)).toEqual([]);
    const queued = await tasks(userId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'QUEUED', userId, payload: { ownerId: userId, snapshot: { amount: 30, validDays: 0 } } });
    // A later policy change must not alter (or conflict with) the pending retry.
    await setPolicy({ welcomeCreditsAmount: 999 });
    await expect(host.runTask(queued[0].id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await lots(userId)).toEqual([expect.objectContaining({ source: 'welcome', amount: 30, sourceId: `welcome:${userId}` })]);
    expect((await q('SELECT balance FROM "S".credit_account WHERE "userId" = $1', [userId]))[0].balance).toBe(30);
    // Replays (a second run, a direct grant, a duplicate submission) never grant again.
    expect(await onboarding.grantWelcomeCredits(userId, { amount: 30, validDays: 0 })).toBe('already-granted');
    // The same key with different parameters is a conflict, never a second (or larger) grant.
    await expect(onboarding.grantWelcomeCredits(userId, { amount: 999, validDays: 0 })).rejects.toThrow(/reused with different parameters/);
    expect(await lots(userId)).toHaveLength(1);
    expect(await tasks(userId)).toHaveLength(1);
    await resetPolicy();
  });
  it('retries the job until the grant works and keeps a failing attempt from granting twice', async () => {
    const userId = await owner('retry_flaky');
    const submitted = await jobs.submit({ kind: WELCOME_CREDITS_JOB, idempotencyKey: `welcome:${userId}`, ownerId: userId,
      resource: { type: 'account', id: userId }, payload: { ownerId: userId, snapshot: { amount: 12, validDays: 0 } } });
    expect(submitted.created).toBe(true);
    // The same account submitting again is the same task, not a second grant.
    expect((await jobs.submit({ kind: WELCOME_CREDITS_JOB, idempotencyKey: `welcome:${userId}`, ownerId: userId,
      resource: { type: 'account', id: userId }, payload: { ownerId: userId, snapshot: { amount: 12, validDays: 0 } } })).task.id).toBe(submitted.task.id);
    await failLotInserts(async () => { await expect(host.runTask(submitted.task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError); });
    expect(await lots(userId)).toEqual([]);
    expect((await tasks(userId))[0].status).toBe('QUEUED');
    await q('UPDATE "S".async_jobs SET "availableAt" = $2 WHERE id = $1', [submitted.task.id, new Date(Date.now() - 1000)]);
    await expect(host.runTask(submitted.task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await lots(userId)).toHaveLength(1);
  });
  it('rejects a retry job whose payload does not name its own account, and does not grant', async () => {
    const victim = await owner('retry_victim'), attacker = await owner('retry_attacker');
    const submitted = await jobs.submit({ kind: WELCOME_CREDITS_JOB, idempotencyKey: `forged:${attacker}`, ownerId: attacker,
      resource: { type: 'account', id: attacker }, payload: { ownerId: victim, snapshot: { amount: 500, validDays: 0 } } });
    await host.runTask(submitted.task.id).catch(() => undefined);
    expect(await lots(victim)).toEqual([]); expect(await lots(attacker)).toEqual([]);
  });
  it('does not grant to a disabled account and does not grant an already-expired lot', async () => {
    const disabled = await owner('welcome_disabled', { status: false });
    expect(await onboarding.grantWelcomeCredits(disabled, { amount: 5, validDays: 0 })).toBe('account-unavailable');
    const old = await owner('welcome_old', { createdAt: new Date(Date.now() - 3 * 86_400_000) });
    expect(await onboarding.grantWelcomeCredits(old, { amount: 5, validDays: 1 })).toBe('expired');
    expect(await onboarding.grantWelcomeCredits(old, { amount: 5, validDays: 30 })).toBe('granted');
    const [lot] = await lots(old);
    expect((lot.expiresAt as Date).getTime()).toBe((await q('SELECT "createTime" FROM "S".users WHERE id = $1', [old]))[0].createTime.getTime() + 30 * 86_400_000);
    await expect(onboarding.grantWelcomeCredits(old, { amount: 0, validDays: 0 })).rejects.toThrow(TypeError);
    await expect(onboarding.grantWelcomeCredits(old, { amount: 1.5, validDays: 0 })).rejects.toThrow(TypeError);
    await expect(onboarding.grantWelcomeCredits(old, { amount: 1_000_001, validDays: 0 })).rejects.toThrow(TypeError);
    await expect(onboarding.grantWelcomeCredits(old, { amount: 1, validDays: -1 })).rejects.toThrow(TypeError);
    expect(await lots(disabled)).toEqual([]);
  });

  // ── KNOWN GAP (wp1.2): crash between the sign-up commit and the welcome grant ─────────
  it('KNOWN GAP: a process crash after the sign-up commit still leaves a durable welcome grant (lot or queued retry)', async () => {
    await setPolicy({ requireEmailVerification: false, welcomeCreditsEnabled: true, welcomeCreditsAmount: 15, welcomeCreditsValidDays: 0 });
    // The process dies after the user transaction commits and before afterSignup runs: simulate by making it a no-op.
    vi.spyOn(onboarding, 'afterSignup').mockResolvedValue(undefined);
    const registered = await post('register', { username: 'crash_user', email: 'crashuser@example.invalid', password }).expect(201);
    const userId = registered.body.userId as string;
    vi.restoreAllMocks();
    expect(await q('SELECT 1 FROM "S".users WHERE id = $1', [userId])).toHaveLength(1);
    const durable = (await lots(userId)).length + (await tasks(userId)).length;
    expect(durable, 'welcome credits were promised by the policy but nothing durable records them').toBeGreaterThan(0);
    // After a restart the retry must lead to exactly one grant.
    for (const task of await tasks(userId)) await host.runTask(task.id).catch(() => undefined);
    expect(await lots(userId)).toHaveLength(1);
    await resetPolicy();
  });

  // ── Receipt mail wake ──────────────────────────────────────────────────
  describe('receipt mail wake source', () => {
    async function fulfilledOrder(ownerId: string, extra: { description?: string; createdAt?: Date } = {}) {
      const id = `receipt_${randomUUID().replaceAll('-', '')}`;
      await q(`INSERT INTO "S".billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
        "creationState", "captureState", state, "fulfilledAt") VALUES ($1,$2,'pack','fake','scope',$3,'https://x.invalid','https://x.invalid',$4,$5,'created','captured','fulfilled',now())`,
      [id, ownerId, JSON.stringify({ description: extra.description ?? 'Synthetic pack', money: { amount: '9.00', currency: 'USD' } }), `ck-${id}`, `cap-${id}`]);
      await q(`INSERT INTO "S".billing_fulfillments ("orderId", "ownerId", credits, policy) VALUES ($1,$2,100,'{}'::jsonb)`, [id, ownerId]);
      await q(`INSERT INTO "S".billing_outbox (id, kind, "aggregateId", payload, "createdAt") VALUES ($1,$2,$3,'{}'::jsonb,$4)`,
        [randomUUID(), CHECKOUT_FULFILLED_OUTBOX_KIND, id, extra.createdAt ?? new Date()]);
      return id;
    }
    const receiptMails = () => smtp.messages.filter(message => decoded(message).includes('Thank you for your purchase') || decoded(message).includes('感谢你的购买'));
    const receiptTask = async (orderId: string) => (await q(`SELECT id, status FROM "S".async_jobs WHERE kind = $1 AND "resourceId" = $2`, [BILLING_RECEIPT_JOB, orderId]))[0];
    let receipts: BillingReceiptMail;
    beforeAll(() => { receipts = new BillingReceiptMail(database, app.get(TransactionalMail), jobs); receipts.onModuleInit(); });

    it('registers a wake source and queues one job per recent fulfillment, skipping old ones and re-scans', async () => {
      expect(jobs.wakeSources().map(source => source.name)).toContain('billing-receipt-mail');
      const buyer = await owner('receipt_buyer'), fresh = await fulfilledOrder(buyer), stale = await fulfilledOrder(buyer, { createdAt: new Date(Date.now() - 4 * 86_400_000) });
      expect(await receipts.scheduleDue()).toBe(1);
      expect(await receiptTask(fresh)).toMatchObject({ status: 'QUEUED' });
      expect(await receiptTask(stale)).toBeUndefined();
      expect(await receipts.scheduleDue()).toBe(0);
      await app.get(AccountService).settled();
      const before = receiptMails().length;
      await expect(host.runTask((await receiptTask(fresh)).id)).resolves.toMatchObject({ status: 'COMPLETED' });
      expect(receiptMails()).toHaveLength(before + 1);
      expect(decoded(receiptMails().at(-1)!)).toContain('9.00 USD');
      expect(await receipts.scheduleDue()).toBe(0);
      expect(await q(`SELECT status FROM "S".email_logs WHERE template = 'billing.receipt' AND metadata->>'orderId' = $1`, [fresh])).toEqual([{ status: 'success' }]);
      // The billing outbox row itself is untouched (it belongs to the billing consumers).
      expect(await q(`SELECT status FROM "S".billing_outbox WHERE "aggregateId" = $1`, [fresh])).toEqual([{ status: 'pending' }]);
    });
    it('sends nothing to an unverified or disabled owner and queues nothing without a transport', async () => {
      const unverified = await owner('receipt_unverified', { verified: false }), order = await fulfilledOrder(unverified);
      expect(await receipts.scheduleDue()).toBe(1);
      await app.get(AccountService).settled();
      const before = receiptMails().length;
      await host.runTask((await receiptTask(order)).id);
      expect(receiptMails()).toHaveLength(before);
      expect(await receipts.deliver(order)).toMatchObject({ sent: false, reason: 'no-recipient' });
      const disabled = await owner('receipt_disabled', { status: false });
      expect(await receipts.deliver(await fulfilledOrder(disabled))).toMatchObject({ sent: false, reason: 'no-recipient' });
      expect(await receipts.deliver('missing-order')).toMatchObject({ sent: false, reason: 'not-fulfilled' });
      const off = new BillingReceiptMail(database, { isEnabled: () => false } as unknown as TransactionalMail, jobs);
      await fulfilledOrder(await owner('receipt_nomail'));
      expect(await off.scheduleDue()).toBe(0);
    });
    it('retries a failed delivery without losing or duplicating the receipt, and escapes order text', async () => {
      const buyer = await owner('receipt_retry'), order = await fulfilledOrder(buyer, { description: '<img src=x onerror=alert(1)>' });
      await receipts.scheduleDue();
      const mail = app.get(TransactionalMail);
      vi.spyOn(mail, 'send').mockResolvedValueOnce({ success: false, errorCode: 'synthetic' } as never);
      await app.get(AccountService).settled();
      const before = receiptMails().length;
      await expect(host.runTask((await receiptTask(order)).id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
      expect(receiptMails()).toHaveLength(before);
      vi.restoreAllMocks();
      await q('UPDATE "S".async_jobs SET "availableAt" = $2 WHERE id = $1', [(await receiptTask(order)).id, new Date(Date.now() - 1000)]);
      await expect(host.runTask((await receiptTask(order)).id)).resolves.toMatchObject({ status: 'COMPLETED' });
      expect(receiptMails()).toHaveLength(before + 1);
      const body = decoded(receiptMails().at(-1)!);
      expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(body).not.toContain('<img src=x');
      expect(await receipts.deliver(order)).toMatchObject({ sent: false, reason: 'already-sent' });
    });
  });

  // ── Stored subject override ────────────────────────────────────────────
  it('uses an active stored template subject, strips header injection, and ignores inactive or empty subjects', async () => {
    await app.get(AccountService).settled();
    const mail = app.get(TransactionalMail);
    const store = (key: string, subject: string | null, isActive = true) => q(`INSERT INTO "S".email_templates (id, key, name, subject, "htmlContentEn", "isActive") VALUES ($1,$2,$2,$3,'<p><a href="{{link}}">go</a></p>',$4)
      ON CONFLICT (key) DO UPDATE SET subject = EXCLUDED.subject, "isActive" = EXCLUDED."isActive"`, [randomUUID(), key, subject, isActive]);
    const sendVerify = async () => { const before = smtp.messages.length; await mail.send('account.verify', { to: 'subject@example.invalid', locale: 'en', data: { link: 'https://x.invalid/v' } });
      expect(smtp.messages).toHaveLength(before + 1); return smtp.messages.at(-1)!; };
    expect(decoded(headerBlock(await sendVerify()))).toContain('Verify your email');
    await store('account.verify', 'Custom subject for everyone');
    expect(decoded(headerBlock(await sendVerify()))).toContain('Custom subject for everyone');
    await store('account.verify', 'Hello\r\nBcc: attacker@example.invalid\r\nX-Evil: 1');
    const injected = await sendVerify();
    expect(headerBlock(injected)).not.toMatch(/^Bcc:/im); expect(headerBlock(injected)).not.toMatch(/^X-Evil:/im);
    expect(decoded(headerBlock(injected))).toMatch(/Subject: Hello\s+Bcc: attacker@example\.invalid\s+X-Evil: 1/);
    await store('account.verify', 'Disabled subject', false);
    expect(decoded(headerBlock(await sendVerify()))).toContain('Verify your email');
    await store('account.verify', '   ');
    expect(decoded(headerBlock(await sendVerify()))).toContain('Verify your email');
    // A stored subject is single-language: a Chinese recipient gets it too, while an empty one falls back per locale.
    await store('account.verify', null);
    const zh = decoded(headerBlock(await (async () => { const before = smtp.messages.length; await mail.send('account.verify', { to: 'subject@example.invalid', locale: 'zh-CN', data: { link: 'https://x.invalid/v' } }); return smtp.messages[before]!; })()));
    expect(zh).toContain('验证你的邮箱');
    await q(`DELETE FROM "S".email_templates WHERE key = 'account.verify'`);
  });

  // ── Template href escaping ─────────────────────────────────────────────
  it('restricts every URL variable of every built-in template to http(s) and escapes text variables', () => {
    const templates = app.get(MailService).templates;
    const hostile = { siteName: '<b>Site</b>', name: '<img src=x onerror=alert(1)>', link: 'javascript:alert(1)', description: '"><script>alert(1)</script>', orderId: "'; DROP TABLE x;--",
      amount: '<1>', currency: '"', credits: '<2>', paidAt: '<3>' };
    for (const template of ACCOUNT_MAIL_TEMPLATES) for (const [locale, html] of Object.entries(template.contents)) {
      const rendered = templates.interpolate(html!, hostile);
      // The visible fallback copy of the link is escaped text; what matters is that no href can carry a script scheme.
      for (const href of [...rendered.matchAll(/href="([^"]*)"/gi)].map(match => match[1]!))
        expect(href, `${template.key}/${locale}`).toMatch(/^(?:https?:\/\/|mailto:|#|$)/i);
      expect(rendered, `${template.key}/${locale}`).not.toMatch(/<script/i);
      expect(rendered, `${template.key}/${locale}`).not.toContain('<img src=x');
      expect(rendered, `${template.key}/${locale}`).not.toMatch(/href="\s*(?:data|vbscript|file):/i);
    }
    for (const bad of ['JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', '//evil.invalid', 'vbscript:x'])
      expect(templates.interpolate('<a href="{{link}}">x</a>', { link: bad }), bad).not.toMatch(/href="\s*(?:javascript|vbscript|data|\/\/)/i);
    expect(templates.interpolate('<a href="{{link}}">x</a>', { link: 'https://app.example.invalid/a?b=1&c="2"' })).toContain('href="https://app.example.invalid/a?b=1&amp;c=&quot;2&quot;"');
  });
});
