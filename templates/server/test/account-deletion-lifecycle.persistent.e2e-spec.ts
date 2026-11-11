import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { BcryptEncoder, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../src/accounts/account.service';
import { ACCOUNT_POLICIES } from '../src/accounts/account.policy';
import { ACCOUNT_SECURITY_CLOCK } from '../src/accounts/security/account-security.clock';
import {
  AccountDeletionModule, AccountDeletionService, type AccountDeletionContributor,
} from '../src/accounts/deletion';
import { ACCOUNT_DELETION_JOB, FAILED_DELETION_RETRY_MS } from '../src/accounts/deletion/account-deletion.service';
import { DeliveryService } from '../src/delivery/delivery.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { JobsService } from '../src/jobs/jobs.service';
import { OAuthModule } from '../src/oauth/oauth.module';
import { OAUTH_SETTINGS, type OAuthSettings } from '../src/oauth/oauth.config';
import { OAUTH_PROVIDER_CLIENT, type OAuthProviderClient } from '../src/oauth/oauth-provider';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { createIsolatedSchema, dropIsolatedSchema } from './helpers/account-security-fixture';

/**
 * WP 3.3b Sonnet checks for account deletion: refusals, grace, cancel, the durable job and its wake
 * retry, ordering and single invocation of contributors, anonymisation that keeps financial rows,
 * revoked sessions on every path, OAuth/magic-link refusal while pending. PostgreSQL, stub mailer,
 * offset clock; synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_dellife_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticLifecycle9!';
const DAY = 86_400_000;
const settings: OAuthSettings = { webOrigin: origin, secureCookies: false, google: { clientId: '', clientSecret: '', code: false, oneTap: false }, github: { clientId: 'synthetic-github-client', clientSecret: 'synthetic-only', code: true } };

run('account deletion lifecycle (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, deletions: AccountDeletionService, policies: PolicyService;
  let jobs: JobsService, host: JobsHost;
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const scheduledMail: Array<{ email: string; ticket: string; executeAfter: Date }> = [];
  const completedMail: string[] = [];
  const magicMail: Array<{ email: string; purpose: string; ticket: string }> = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, purpose, ticket) { magicMail.push({ email, purpose, ticket }); },
    async deletionScheduled(email, _locale, _userId, notice) { scheduledMail.push({ email, ticket: notice.ticket, executeAfter: notice.executeAfter }); },
    async deletionCompleted(email) { completedMail.push(email); } };
  const identities = new Map<string, import('@zucker-framework/auth').VerifiedOAuthIdentity>();
  const providerClient: OAuthProviderClient = {
    async code(provider, input) { const identity = identities.get(input.code); if (!identity || identity.provider !== provider) throw new Error('synthetic'); return identity; },
    oneTap: async () => { throw new Error('not used'); },
  };

  // Recording contributors: sequence of lifecycle calls, with controllable failure.
  const calls: string[] = [];
  const behaviour = { failErase: 0, failAfterCommit: false };
  const recorder = (name: string, order: number): AccountDeletionContributor => ({ name, order,
    async onScheduled(_tx, userId) { calls.push(`${name}:scheduled:${userId}`); },
    async erase(_tx, userId) {
      calls.push(`${name}:erase:${userId}`);
      if (name === 'synthetic-late' && behaviour.failErase > 0) { behaviour.failErase--; throw new Error('synthetic contributor failure'); }
    },
    async afterCommit(userId) {
      calls.push(`${name}:after:${userId}`);
      if (behaviour.failAfterCommit) throw new Error('synthetic cleanup failure');
    } });

  const server = () => app.getHttpServer();
  const post = (path: string, body: object = {}, token?: string) => {
    const call = request(server()).post(`/api/authorize/${path}`).set('Origin', origin);
    return (token ? call.set('Authorization', `Bearer ${token}`) : call).send(body);
  };
  const me = (token: string) => request(server()).get('/api/authorize/me').set('Authorization', `Bearer ${token}`);
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const setPolicy = async (values: Record<string, unknown>) => {
    const current = await policies.view('account'); await policies.save('synthetic-operator', 'account', { expectedRevision: current.revision, values });
  };
  const login = (username: string) => post('login', { username, password });
  const cookie = (response: { headers: Record<string, unknown> }) => ((response.headers['set-cookie'] as string[] | undefined) ?? []).map(value => value.split(';')[0]).join('; ');
  async function member(username: string, extra: { ip?: string } = {}) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, password, "lastLoginIp") VALUES ($1,$2,$2,'member',$3,true,true,$4,$5)`,
      [id, username, `${username}@example.invalid`, await new BcryptEncoder().encode(password), extra.ip ?? null]);
    return id;
  }
  async function order(userId: string) {
    const id = randomUUID();
    await q(`INSERT INTO "S".billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
      "creationState", "captureState", state) VALUES ($1, $2, 'offer', 'fake', 'acct', '{}', 'https://x.invalid/s', 'https://x.invalid/c', $3, $4, 'created', 'captured', 'fulfilled')`,
      [id, userId, randomUUID(), randomUUID()]);
    return id;
  }
  async function subscription(userId: string, extra: { status?: string; cancelAtPeriodEnd?: boolean | null; canceledAt?: Date | null } = {}) {
    const id = randomUUID(), orderId = randomUUID(), providerSubscriptionId = `sub_${id}`, paymentId = `pay_${id}`;
    const offer = JSON.stringify({ mode: 'subscription', catalogReference: 'plan' });
    await q(`INSERT INTO "S".billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
      "creationState", "captureState", state, "subscriptionId", "paymentId", "paymentKind", "fulfilledAt")
      VALUES ($1, $2, 'offer', 'fake', 'acct', $3::jsonb, 'https://x.invalid/s', 'https://x.invalid/c', $4, $5, 'created', 'captured', 'paid', $6, $7, 'payment', now())`,
    [orderId, userId, offer, randomUUID(), randomUUID(), providerSubscriptionId, paymentId]);
    await q(`INSERT INTO "S".billing_subscriptions (id, "ownerId", "initialOrderId", "providerId", "accountScope", "providerSubscriptionId", "catalogReference", offer,
      "grantBasis", "initialPaymentId", "initialPaymentKind", status, "cancelAtPeriodEnd", "canceledAt")
      VALUES ($1,$2,$3,'fake','acct',$4,'plan',$7::jsonb,'period',$5,'payment',$6,$8,$9)`,
    [id, userId, orderId, providerSubscriptionId, paymentId, extra.status ?? 'active', offer, extra.cancelAtPeriodEnd ?? null, extra.canceledAt ?? null]);
    return { id, orderId };
  }
  /** Statements on tables with search_path-dependent triggers (async_jobs). */
  async function scoped(sql: string, values: unknown[] = []) {
    const client = await pool.connect();
    try { await client.query(`SET search_path TO "${schema}"`); return (await client.query(sql, values)).rows; } finally { client.release(); }
  }
  async function refund(userId: string, state: string) {
    const orderId = await order(userId), targetId = randomUUID();
    await q(`INSERT INTO "S".billing_refund_payments (id, "ownerId", "orderId", "providerId", "accountScope", "paymentKind", "paymentId", "sourceKind", "sourceId",
      title, "paidMoney", "paidMinor", "minorScale", "totalCredits", "refundedMinor", "observedAt") VALUES ($1, $2, $3, 'fake', 'acct', 'payment-intent', $3 || ':pay',
      'payment-intent', $3 || ':pay', 'Pack', '{"amount":"10.00","currency":"USD"}'::jsonb, '1000', 2, 100, '0', now())`, [targetId, userId, orderId]);
    await q(`INSERT INTO "S".billing_refund_requests (id, "actorId", "beforeRefundedMinor", "clientKey", "commandKey", "creditAmount", "expectedRefundedMinor", money,
      "ownerId", "requestedMinor", "targetId", state) VALUES ($1,$2,'0',$3,$4,0,'1','{}',$2,'1',$5,$6)`, [randomUUID(), userId, randomUUID(), randomUUID(), targetId, state]);
  }
  const deletionRow = async (userId: string) => (await q('SELECT status, "executeAfter", "completedAt", "cancelledAt", reason FROM "S".account_deletions WHERE "userId" = $1', [userId]))[0];
  const dueTask = async (userId: string) => (await q(`SELECT id, status FROM "S".async_jobs WHERE kind = $1 AND "resourceId" = $2 ORDER BY "createdAt"`, [ACCOUNT_DELETION_JOB, userId])) as Array<{ id: string; status: string }>;

  beforeAll(async () => {
    const created = await createIsolatedSchema(databaseUrl!, schema);
    pool = created.pool; database = created.database;
    jobs = new JobsService(database);
    host = new JobsHost(jobs, new DeliveryService(database, { provider: undefined, accountScope: '', leaseMs: 2000, heartbeatMs: 500 }),
      { enabled: false, workerId: 'synthetic-deletion', concurrency: 1, scanIntervalMs: 50, leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 });
    @Global() @Module({ providers: [{ provide: JobsService, useValue: jobs }], exports: [JobsService] }) class JobsTestModule {}
    const jwtSecret = 'synthetic-deletion-lifecycle-jwt-at-least-32-chars';
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: jwtSecret };
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, login: limits, 'login-account': limits, 'session-refresh': limits,
        'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      JobsTestModule, RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), AccountModule, OAuthModule,
      AccountDeletionModule.forRoot({ contributors: [recorder('synthetic-early', 50), recorder('synthetic-late', 950)] })],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(OAUTH_SETTINGS).useValue(settings).overrideProvider(OAUTH_PROVIDER_CLIENT).useValue(providerClient)
      .overrideProvider(ACCOUNT_SECURITY_CLOCK).useValue(clock).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    deletions = app.get(AccountDeletionService); policies = app.get(PolicyService);
  });
  afterAll(async () => {
    try { await app?.close(); await host?.stop(); await database?.disconnect(); } finally { await dropIsolatedSchema(pool, schema); }
  });

  it('refuses scheduling for an active subscription or an open refund without side effects, and allows the harmless states', async () => {
    const userId = await member('dl_refuse');
    const token = (await login('dl_refuse').expect(200)).body.token as string;
    const sub = await subscription(userId);
    const sessionsBefore = (await q('SELECT count(*)::int AS n FROM "S".account_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL', [userId]))[0].n;
    const versionBefore = (await q('SELECT "credentialVersion" AS v FROM "S".users WHERE id = $1', [userId]))[0].v;
    const attempt = () => post('deletion', { confirm: 'dl_refuse', password }, token);
    calls.length = 0;
    expect((await attempt().expect(409)).body.code).toBe('ACCOUNT_HAS_ACTIVE_SUBSCRIPTION');
    // Nothing happened: no row, same credential version, sessions alive, contributors untouched, no mail.
    expect(await deletionRow(userId)).toBeUndefined();
    expect((await q('SELECT "credentialVersion" AS v FROM "S".users WHERE id = $1', [userId]))[0].v).toBe(versionBefore);
    expect((await q('SELECT count(*)::int AS n FROM "S".account_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL', [userId]))[0].n).toBe(sessionsBefore);
    expect(calls).toEqual([]); await me(token).expect(200);
    expect(scheduledMail.filter(entry => entry.email === 'dl_refuse@example.invalid')).toEqual([]);

    // Set to end at the period end, or already cancelled: allowed on the subscription side. Open refund still refuses.
    await q(`UPDATE "S".billing_subscriptions SET "cancelAtPeriodEnd" = true, revision = revision + 1 WHERE id = $1`, [sub.id]);
    await refund(userId, 'pending');
    expect((await attempt().expect(409)).body.code).toBe('ACCOUNT_HAS_OPEN_REFUND');
    for (const open of ['prepared', 'submitting', 'requires_action', 'unknown', 'attention']) {
      await q(`UPDATE "S".billing_refund_requests SET state = $2, revision = revision + 1 WHERE "ownerId" = $1`, [userId, open]);
      expect((await attempt().expect(409)).body.code, open).toBe('ACCOUNT_HAS_OPEN_REFUND');
    }
    expect(await deletionRow(userId)).toBeUndefined();
    await q(`UPDATE "S".billing_refund_requests SET state = 'succeeded', revision = revision + 1 WHERE "ownerId" = $1`, [userId]);
    await attempt().expect(200);
    expect((await deletionRow(userId)).status).toBe('scheduled');

    // A cancelled subscription of another user does not block, a 'canceled' status or canceledAt does not either.
    const other = await member('dl_refuse_ok'); await subscription(other, { status: 'canceled', canceledAt: new Date() });
    const otherToken = (await login('dl_refuse_ok').expect(200)).body.token as string;
    await post('deletion', { confirm: 'dl_refuse_ok', password }, otherToken).expect(200);
  });

  it('validates the request: policy switch, confirmation, reason length, grace days, and the recent-authentication gate', async () => {
    await member('dl_valid');
    const token = (await login('dl_valid').expect(200)).body.token as string;
    await setPolicy({ deletionEnabled: false });
    try { expect((await post('deletion', { confirm: 'dl_valid', password }, token).expect(403)).body.code).toBe('ACCOUNT_DELETION_DISABLED'); }
    finally { await setPolicy({ deletionEnabled: null }); }
    await post('deletion', { confirm: 'dl_valid' }, token).expect(403);
    expect((await post('deletion', { confirm: 'dl_valid', password: 'wrong' }, token).expect(403)).body.code).toBe('RECENT_AUTHENTICATION_FAILED');
    await post('deletion', { confirm: 'DL_VALID', password }, token).expect(400);
    await post('deletion', { confirm: 'dl_valid', password, reason: 'x'.repeat(501) }, token).expect(400);
    await post('deletion', { confirm: 'dl_valid', password, unknown: 1 }, token).expect(400);
    await request(server()).post('/api/authorize/deletion').send({ confirm: 'dl_valid', password }).expect(401);
    await request(server()).post('/api/authorize/deletion').set('Origin', 'https://foreign.invalid').set('Authorization', `Bearer ${token}`).send({ confirm: 'dl_valid', password }).expect(403);
    await setPolicy({ deletionGraceDays: 3 });
    try {
      const before = Date.now();
      const body = (await post('deletion', { confirm: 'dl_valid', password, reason: 'line\nbreak\u0000 reason' }, token).expect(200)).body;
      const after = new Date(body.executeAfter).getTime();
      expect(after).toBeGreaterThanOrEqual(before + 3 * DAY - 1000); expect(after).toBeLessThanOrEqual(Date.now() + 3 * DAY + 1000);
      expect((await deletionRow((await q('SELECT id FROM "S".users WHERE username = $1', ['dl_valid']))[0].id)).reason).not.toMatch(/[\u0000-\u001f]/);
    } finally { await setPolicy({ deletionGraceDays: null }); }
  });

  it('revokes every session and API key on scheduling, calls contributors once, and keeps the account blocked until cancelled', async () => {
    const userId = await member('dl_sessions');
    const a = (await login('dl_sessions').expect(200)), b = (await login('dl_sessions').expect(200));
    await q(`INSERT INTO "S".account_api_keys (id, "userId", name, "keyPrefix", "keyHash") VALUES ($1, $2, 'k', 'zk_', $3)`, [randomUUID(), userId, randomUUID()]);
    calls.length = 0;
    const scheduled = await post('deletion', { confirm: 'dl_sessions', password }, a.body.token).expect(200);
    // Cookie cleared, both access tokens and the refresh cookie dead.
    expect(((scheduled.headers['set-cookie'] as string[]) ?? []).join(';')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    await me(a.body.token).expect(401); await me(b.body.token).expect(401);
    await post('refresh').set('Cookie', cookie(b)).expect(401);
    expect(await q('SELECT 1 FROM "S".account_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL', [userId])).toEqual([]);
    expect(await q('SELECT 1 FROM "S".account_api_keys WHERE "userId" = $1 AND ("revokedAt" IS NULL OR "isActive")', [userId])).toEqual([]);
    expect(calls).toEqual([`synthetic-early:scheduled:${userId}`, `synthetic-late:scheduled:${userId}`]);
    // Blocked everywhere with the pending code; wrong password is still a plain 401.
    expect((await login('dl_sessions').expect(403)).body.code).toBe('ACCOUNT_DELETION_PENDING');
    await post('login', { username: 'dl_sessions', password: 'nope' }).expect(401);
    // Magic link: no mail for a pending account, and responses are identical to an unknown address.
    await setPolicy({ magicLinkEnabled: true });
    try {
      magicMail.length = 0;
      const pending = await post('magic-link', { email: 'dl_sessions@example.invalid' }).expect(200);
      expect(pending.body).toEqual({ accepted: true });
      await app.get(AccountService).settled(); expect(magicMail).toEqual([]);
    } finally { await setPolicy({ magicLinkEnabled: null }); }
    // Cancel: credentials checked identically for unknown user and wrong password; mixed forms refused.
    const unknown = await post('deletion/cancel', { username: 'no_such_user', password }).expect(401);
    const wrong = await post('deletion/cancel', { username: 'dl_sessions', password: 'wrong' }).expect(401);
    expect({ ...unknown.body, timestamp: 0 }).toEqual({ ...wrong.body, timestamp: 0 });
    await post('deletion/cancel', { username: 'dl_sessions', password, ticket: 'x'.repeat(43) }).expect(400);
    await post('deletion/cancel', { ticket: 'short' }).expect(400);
    await post('deletion/cancel', {}).expect(400);
    await post('deletion/cancel', { username: 'dl_sessions', password }).expect(200);
    expect((await post('deletion/cancel', { username: 'dl_sessions', password }).expect(409)).body.code).toBe('ACCOUNT_DELETION_NOT_PENDING');
    expect((await login('dl_sessions').expect(200)).body.token).toBeTruthy();
    // API keys stay revoked after the cancellation; executing a cancelled request does nothing.
    expect(await q('SELECT 1 FROM "S".account_api_keys WHERE "userId" = $1 AND "revokedAt" IS NULL', [userId])).toEqual([]);
    offsetMs = 30 * DAY;
    try { expect((await deletions.executeNow(userId)).executed).toBe(false); } finally { offsetMs = 0; }
    expect((await q('SELECT username FROM "S".users WHERE id = $1', [userId]))[0].username).toBe('dl_sessions');
    // A cancelled account can schedule again (new row state, new ticket).
    const again = (await login('dl_sessions').expect(200)).body.token as string;
    await post('deletion', { confirm: 'dl_sessions', password }, again).expect(200);
    expect((await deletionRow(userId)).status).toBe('scheduled');
    expect((await deletionRow(userId)).cancelledAt).toBeNull();
  });

  it('blocks OAuth sign-in while pending and lets the mailed ticket restore it', async () => {
    const flowFor = async (subject: string, email: string) => {
      const started = await post('oauth/github/start', { mode: 'code', locale: 'en', returnPath: '/account' }).expect(200);
      const state = new URL(started.body.authorizationUrl).searchParams.get('state')!, browser = cookie(started), code = randomUUID();
      identities.set(code, { provider: 'github', subject, email, emailVerified: true, displayName: 'Synthetic member' });
      const callback = await request(server()).get('/api/authorize/oauth/github/callback').query({ state, code }).set('Cookie', browser).expect(302);
      const proof = new URLSearchParams(new URL(callback.headers.location).hash.slice(1)).get('ticket')!;
      return post('oauth/github/complete', { proof }).set('Cookie', [browser, cookie(callback)].filter(Boolean).join('; '));
    };
    const created = await flowFor('dl-oauth-subject', 'dl_oauth@example.invalid'); expect(created.status).toBe(200);
    const userId = created.body.userId as string;
    scheduledMail.length = 0;
    await post('deletion', { confirm: (await q('SELECT username FROM "S".users WHERE id = $1', [userId]))[0].username }, created.body.token).expect(200);
    await app.get(AccountService).settled();
    const sessionsBefore = (await q('SELECT count(*)::int AS n FROM "S".account_sessions WHERE "userId" = $1', [userId]))[0].n;
    const blocked = await flowFor('dl-oauth-subject', 'dl_oauth@example.invalid'); expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ACCOUNT_DELETION_PENDING'); expect(blocked.body.token).toBeUndefined();
    expect((await q('SELECT count(*)::int AS n FROM "S".account_sessions WHERE "userId" = $1', [userId]))[0].n).toBe(sessionsBefore);
    const mailed = scheduledMail.find(entry => entry.email === 'dl_oauth@example.invalid')!;
    expect(mailed.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await post('deletion/cancel', { ticket: mailed.ticket }).expect(200);
    await post('deletion/cancel', { ticket: mailed.ticket }).expect(400);
    const restored = await flowFor('dl-oauth-subject', 'dl_oauth@example.invalid'); expect(restored.status).toBe(200); expect(restored.body.userId).toBe(userId);
  });

  it('runs the durable job after the grace period: contributors once in order, financial rows kept, anonymised, mail without log residue', async () => {
    const ip = '203.0.113.88';
    const userId = await member('dl_job', { ip });
    const token = (await login('dl_job').expect(200)).body.token as string;
    const kept = await subscription(userId, { cancelAtPeriodEnd: true });
    await refund(userId, 'succeeded');
    await q(`INSERT INTO "S".credit_account (id, "userId", balance) VALUES ($1, $2, 12)`, [randomUUID(), userId]);
    await q(`INSERT INTO "S".credit_lots (id, "userId", source, amount, "remainingAmount") VALUES ($1, $2, 'gift', 12, 12)`, [randomUUID(), userId]);
    await q(`INSERT INTO "S".email_logs (id, recipient, template, subject, status) VALUES ($1, 'dl_job@example.invalid', 'account.deletion-completed', 's', 'SENT')`, [randomUUID()])
      .catch(() => undefined);
    await post('deletion', { confirm: 'dl_job', password, reason: 'synthetic' }, token).expect(200);

    // Before the grace period ends the wake source submits nothing.
    expect(await deletions.scheduleDue(clock())).toBe(0);
    expect(await dueTask(userId)).toEqual([]);

    offsetMs = 8 * DAY;
    try {
      calls.length = 0;
      expect(await deletions.scheduleDue(clock())).toBeGreaterThanOrEqual(1);
      const [task] = await dueTask(userId); expect(task).toBeDefined();
      // Idempotent: a second scan neither duplicates the live job nor runs anything.
      await deletions.scheduleDue(clock()); expect(await dueTask(userId)).toHaveLength(1);
      await host.runTask(task!.id);
      expect((await dueTask(userId))[0]!.status).toBe('COMPLETED');
      // Each contributor exactly once, early before late, erase before afterCommit, built-ins in between.
      expect(calls).toEqual([`synthetic-early:erase:${userId}`, `synthetic-late:erase:${userId}`, `synthetic-early:after:${userId}`, `synthetic-late:after:${userId}`]);
      expect(completedMail.filter(email => email === 'dl_job@example.invalid')).toHaveLength(1);
      expect(await q(`SELECT 1 FROM "S".email_logs WHERE recipient = 'dl_job@example.invalid'`)).toEqual([]);
      // Re-running (retry after the fact, second scan) is a no-op and calls nothing again.
      calls.length = 0;
      expect((await deletions.executeNow(userId)).executed).toBe(false);
      expect(await deletions.scheduleDue(clock())).toBe(0);
      expect(calls).toEqual([]);
    } finally { offsetMs = 0; }

    expect((await q('SELECT username, name, email, password, status, "lastLoginIp", "deviceInfo", "avatarFileId" FROM "S".users WHERE id = $1', [userId]))[0])
      .toEqual({ username: `deleted-${userId}`, name: 'Deleted user', email: null, password: null, status: false, lastLoginIp: null, deviceInfo: null, avatarFileId: null });
    expect(await q('SELECT 1 FROM "S".billing_subscriptions WHERE id = $1', [kept.id])).toHaveLength(1);
    expect(await q('SELECT 1 FROM "S".billing_orders WHERE id = $1', [kept.orderId])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM "S".billing_refund_requests WHERE "ownerId" = $1`, [userId])).toHaveLength(1);
    expect((await q('SELECT balance FROM "S".credit_account WHERE "userId" = $1', [userId]))[0].balance).toBe(0);
    expect(await q(`SELECT amount FROM "S".credit_transaction WHERE "userId" = $1 AND type = 'EXPIRE'`, [userId])).toEqual([{ amount: -12 }]);
    expect((await deletionRow(userId)).status).toBe('completed');
    // Nothing identifying remains anywhere in text columns.
    const columns = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND data_type IN ('text', 'character varying', 'jsonb')`, [schema]);
    for (const { table_name: table, column_name: column } of columns.rows as Array<{ table_name: string; column_name: string }>) {
      const found = await pool.query(`SELECT 1 FROM "${schema}"."${table}" WHERE "${column}"::text LIKE '%dl_job%' OR "${column}"::text LIKE $1 LIMIT 1`, [`%${ip}%`]);
      // `deleted-<id>` and ids contain neither; the retained task payload carries only the user id.
      expect(found.rows, `${table}.${column}`).toEqual([]);
    }
    // Username and address are free again, the anonymised prefix is reserved.
    await post('login', { username: 'dl_job', password }).expect(401);
    await post('register', { username: `deleted-${randomUUID().slice(0, 8)}`, email: 'fresh@example.invalid', password }).expect(400);
    await post('register', { username: 'dl_job_again', email: 'dl_job@example.invalid', password }).expect(201);
  });

  it('retries a failing job, keeps data intact meanwhile, and resubmits only after the retry pause', async () => {
    const userId = await member('dl_retry');
    const token = (await login('dl_retry').expect(200)).body.token as string;
    await q(`INSERT INTO "S".chats (id, "ownerId", title, "providerId", model) VALUES ($1, $2, 'private title', 'p', 'm')`, [randomUUID(), userId]);
    await post('deletion', { confirm: 'dl_retry', password }, token).expect(200);
    offsetMs = 8 * DAY;
    try {
      behaviour.failErase = 1_000; calls.length = 0;
      await deletions.scheduleDue(clock());
      const [task] = await dueTask(userId);
      await expect(host.runTask(task!.id)).rejects.toBeDefined();
      // The whole attempt rolled back: contributors ran but nothing is erased and the request is still scheduled.
      expect((await q('SELECT username FROM "S".users WHERE id = $1', [userId]))[0].username).toBe('dl_retry');
      expect(await q('SELECT 1 FROM "S".chats WHERE "ownerId" = $1', [userId])).toHaveLength(1);
      expect((await deletionRow(userId)).status).toBe('scheduled');
      expect(calls.filter(call => call.includes(':after:'))).toEqual([]);
      expect(completedMail).not.toContain('dl_retry@example.invalid');
      // A job that is still alive (retry scheduled) blocks a duplicate submission.
      expect((await dueTask(userId))[0]!.status).not.toBe('COMPLETED');
      expect(await deletions.scheduleDue(new Date(Date.now() + 8 * DAY))).toBe(0);

      // Exhausted job: FAILED. Within the pause the wake source leaves it; after the pause it submits a new job.
      await scoped(`UPDATE async_jobs SET status = 'FAILED', "updatedAt" = $2 WHERE id = $1`, [task!.id, new Date(Date.now() + 8 * DAY)]);
      const justAfter = new Date(Date.now() + 8 * DAY);
      expect(await deletions.scheduleDue(justAfter)).toBe(0);
      expect(await deletions.scheduleDue(new Date(Date.now() + 8 * DAY + FAILED_DELETION_RETRY_MS - 60_000))).toBe(0);
      expect(await deletions.scheduleDue(new Date(Date.now() + 8 * DAY + FAILED_DELETION_RETRY_MS + 60_000))).toBe(1);
      const tasks = await dueTask(userId); expect(tasks).toHaveLength(2);
      // The cause is fixed: the new job completes the deletion exactly once.
      behaviour.failErase = 0; calls.length = 0;
      await host.runTask(tasks[1]!.id);
      expect((await deletionRow(userId)).status).toBe('completed');
      expect(await q('SELECT 1 FROM "S".chats WHERE "ownerId" = $1', [userId])).toEqual([]);
      expect(calls.filter(call => call.includes(':erase:'))).toHaveLength(2);
      expect(completedMail.filter(email => email === 'dl_retry@example.invalid')).toHaveLength(1);
    } finally { offsetMs = 0; behaviour.failErase = 0; }
  });

  it('keeps the deletion committed when post-commit cleanup fails, and postpones when a refusal appears before execution', async () => {
    const userId = await member('dl_after');
    const token = (await login('dl_after').expect(200)).body.token as string;
    await post('deletion', { confirm: 'dl_after', password }, token).expect(200);
    offsetMs = 8 * DAY;
    try {
      behaviour.failAfterCommit = true;
      expect((await deletions.executeNow(userId)).executed).toBe(true);
      expect((await deletionRow(userId)).status).toBe('completed');
    } finally { behaviour.failAfterCommit = false; offsetMs = 0; }

    // A subscription created during the grace period postpones execution (re-checked at execution time).
    const blocked = await member('dl_postponed');
    const blockedToken = (await login('dl_postponed').expect(200)).body.token as string;
    await post('deletion', { confirm: 'dl_postponed', password }, blockedToken).expect(200);
    await subscription(blocked);
    offsetMs = 8 * DAY;
    try {
      calls.length = 0;
      await expect(deletions.executeNow(blocked)).rejects.toThrow(/postponed/i);
      expect(calls).toEqual([]);
      expect((await q('SELECT username FROM "S".users WHERE id = $1', [blocked]))[0].username).toBe('dl_postponed');
      expect((await deletionRow(blocked)).status).toBe('scheduled');
    } finally { offsetMs = 0; }
  });

  it('does not count an expired superadmin assignment or a pending-deletion holder as a remaining administrator', async () => {
    await q(`INSERT INTO "S".roles (id, name) VALUES ('role_super', 'superadmin') ON CONFLICT DO NOTHING`);
    const roleId = (await q(`SELECT id FROM "S".roles WHERE name = 'superadmin'`))[0].id as string;
    const first = await member('dl_super_a'), expired = await member('dl_super_expired');
    await q(`INSERT INTO "S".user_roles (id, "userId", "roleId") VALUES ($1, $2, $3)`, [randomUUID(), first, roleId]);
    await q(`INSERT INTO "S".user_roles (id, "userId", "roleId", "expiresAt") VALUES ($1, $2, $3, now() - interval '1 day')`, [randomUUID(), expired, roleId]);
    const token = (await login('dl_super_a').expect(200)).body.token as string;
    expect((await post('deletion', { confirm: 'dl_super_a', password }, token).expect(409)).body.code).toBe('ACCOUNT_LAST_SUPERADMIN');
    // With a live second holder the first may go; the second then becomes the last one.
    const second = await member('dl_super_b');
    await q(`INSERT INTO "S".user_roles (id, "userId", "roleId") VALUES ($1, $2, $3)`, [randomUUID(), second, roleId]);
    await post('deletion', { confirm: 'dl_super_a', password }, (await login('dl_super_a').expect(200)).body.token).expect(200);
    const secondToken = (await login('dl_super_b').expect(200)).body.token as string;
    expect((await post('deletion', { confirm: 'dl_super_b', password }, secondToken).expect(409)).body.code).toBe('ACCOUNT_LAST_SUPERADMIN');
  });
});
