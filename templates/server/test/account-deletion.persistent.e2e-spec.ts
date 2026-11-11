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
import { AccountDeletionModule, AccountDeletionService, type AccountDeletionContributor } from '../src/accounts/deletion';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';

/**
 * WP 3.3b implementer checks (Sonnet extends): schedule → pending login → cancel (password, ticket),
 * execution erases personal data and keeps orders/ledger, a failing contributor rolls back and the retry
 * completes, last-superadmin guard. PostgreSQL, stub mailer, injected clock; synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_del_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticDeletion9!';

run('account deletion (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, deletions: AccountDeletionService;
  let now = new Date('2026-11-10T10:00:00.000Z');
  const tickets: Array<{ email: string; ticket: string }> = [];
  const completed: string[] = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send() {},
    async deletionScheduled(email, _locale, _userId, notice) { tickets.push({ email, ticket: notice.ticket }); },
    async deletionCompleted(email) { completed.push(email); } };
  let failOnce = false;
  const flaky: AccountDeletionContributor = { name: 'synthetic-flaky', order: 950, async erase() {
    if (failOnce) { failOnce = false; throw new Error('synthetic contributor failure'); } } };
  const post = (path: string, body: object = {}, token?: string) => {
    const call = request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin);
    return (token ? call.set('Authorization', `Bearer ${token}`) : call).send(body);
  };
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  async function member(username: string) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, password, "lastLoginIp") VALUES ($1,$2,$2,'member',$3,true,true,$4,$5)`,
      [id, username, `${username}@example.invalid`, await new BcryptEncoder().encode(password), username === 'del_exec' ? '203.0.113.77' : null]);
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
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-deletion-jwt-at-least-32-chars' };
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, login: limits, 'login-account': limits, 'session-refresh': limits,
        'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }),
      RuntimeSettingsModule, ZuckerConfigModule.forRoot(), PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES] }), AccountModule,
      AccountDeletionModule.forRoot({ contributors: [flaky] })],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(ACCOUNT_SECURITY_CLOCK).useValue(() => now).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    deletions = app.get(AccountDeletionService);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('schedules, blocks sign-in, cancels by password and by mailed ticket', async () => {
    const userId = await member('del_cancel');
    const token = (await login('del_cancel').expect(200)).body.token as string;
    expect((await post('deletion', { confirm: 'someone-else', password }, token).expect(400)).body.code).toBe('ACCOUNT_DELETION_CONFIRM_MISMATCH');
    const scheduled = await post('deletion', { confirm: 'del_cancel', password, reason: 'synthetic' }, token).expect(200);
    expect(scheduled.body).toEqual({ scheduled: true, executeAfter: new Date(now.getTime() + 7 * 86_400_000).toISOString() });
    await request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${token}`).expect(401);
    const pending = await login('del_cancel').expect(403);
    expect(pending.body).toMatchObject({ code: 'ACCOUNT_DELETION_PENDING', result: { details: { executeAfter: scheduled.body.executeAfter } } });
    await post('deletion/cancel', { username: 'del_cancel', password: 'wrong' }).expect(401);
    await post('deletion/cancel', { username: 'del_cancel', password }).expect(200);
    const again = (await login('del_cancel').expect(200)).body.token as string;

    await post('deletion', { confirm: 'del_cancel', password }, again).expect(200);
    await app.get(AccountService).settled();
    const mailed = tickets.filter(entry => entry.email === 'del_cancel@example.invalid').at(-1)!;
    expect(tickets.filter(entry => entry.email === 'del_cancel@example.invalid')).toHaveLength(2);
    expect(mailed).toBeDefined();
    expect((await post('deletion/cancel', { ticket: mailed.ticket }).expect(200)).body).toEqual({ cancelled: true });
    await post('deletion/cancel', { ticket: mailed.ticket }).expect(400);
    await login('del_cancel').expect(200);
    expect((await q('SELECT status FROM "S".account_deletions WHERE "userId" = $1', [userId]))[0].status).toBe('cancelled');
  });

  it('executes after the grace period: personal data erased, orders and ledger kept, retried after a contributor failure', async () => {
    const userId = await member('del_exec');
    const token = (await login('del_exec').expect(200)).body.token as string;
    await q(`INSERT INTO "S".account_api_keys (id, "userId", name, "keyPrefix", "keyHash") VALUES ($1, $2, 'k', 'zk_', $3)`, [randomUUID(), userId, randomUUID()]);
    await q(`INSERT INTO "S".user_login_history (id, "userId", "loginMethod", ip) VALUES ($1, $2, 'password', '203.0.113.77')`, [randomUUID(), userId]);
    await q(`INSERT INTO "S".user_acquisition ("userId", "signupMethod", "signupIp") VALUES ($1, 'password', '203.0.113.77')`, [userId]);
    await q(`INSERT INTO "S".file_assets (id, "ownerId", "idempotencyKey", "objectKey", "fileName", sha256, size, "mimeType", state)
      VALUES ($1, $2, 'k1', $3, 'passport-scan.png', $4, 10, 'image/png', 'ready')`, [randomUUID(), userId, `private-assets/${randomUUID()}`, 'a'.repeat(64)]);
    const chatId = randomUUID();
    await q(`INSERT INTO "S".chats (id, "ownerId", title, "providerId", model) VALUES ($1, $2, 'private title', 'p', 'm')`, [chatId, userId]);
    await q(`INSERT INTO "S".chat_messages (id, "chatId", "ownerId", seq, role, parts, status) VALUES ($1, $2, $3, 0, 'user', '[]', 'COMPLETE')`, [randomUUID(), chatId, userId]);
    await q(`INSERT INTO "S".credit_account (id, "userId", balance) VALUES ($1, $2, 25)`, [randomUUID(), userId]);
    await q(`INSERT INTO "S".credit_lots (id, "userId", source, amount, "remainingAmount") VALUES ($1, $2, 'gift', 25, 25)`, [randomUUID(), userId]);
    const orderId = randomUUID();
    await q(`INSERT INTO "S".billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
      "creationState", "captureState", state) VALUES ($1, $2, 'offer', 'fake', 'acct', '{}', 'https://x.invalid/s', 'https://x.invalid/c', $3, $4, 'created', 'captured', 'fulfilled')`,
      [orderId, userId, randomUUID(), randomUUID()]);

    await post('deletion', { confirm: 'del_exec', password }, token).expect(200);
    expect(await q('SELECT 1 FROM "S".account_api_keys WHERE "userId" = $1 AND "revokedAt" IS NULL', [userId])).toEqual([]);
    expect(await deletions.executeNow(userId)).toMatchObject({ executed: false });

    now = new Date(now.getTime() + 8 * 86_400_000);
    failOnce = true;
    await expect(deletions.executeNow(userId)).rejects.toThrow('synthetic contributor failure');
    expect((await q('SELECT username, email FROM "S".users WHERE id = $1', [userId]))[0]).toEqual({ username: 'del_exec', email: 'del_exec@example.invalid' });
    expect(await q('SELECT 1 FROM "S".chats WHERE "ownerId" = $1', [userId])).toHaveLength(1);

    expect(await deletions.executeNow(userId)).toMatchObject({ executed: true, email: 'del_exec@example.invalid' });
    expect(completed).toContain('del_exec@example.invalid');
    expect((await q('SELECT username, name, email, password, status, "lastLoginIp" FROM "S".users WHERE id = $1', [userId]))[0])
      .toEqual({ username: `deleted-${userId}`, name: 'Deleted user', email: null, password: null, status: false, lastLoginIp: null });
    for (const table of ['account_api_keys', 'user_login_history', 'user_acquisition', 'chats', 'chat_messages', 'account_sessions', 'account_tickets'])
      expect(await q(`SELECT 1 FROM "S".${table} WHERE "${table.startsWith('chat') ? 'ownerId' : 'userId'}" = $1`, [userId])).toEqual([]);
    expect(await q('SELECT state, "cleanupStatus" FROM "S".file_assets WHERE "ownerId" = $1', [userId])).toEqual([{ state: 'deleted', cleanupStatus: 'pending' }]);
    expect(await q('SELECT 1 FROM "S".billing_orders WHERE id = $1', [orderId])).toHaveLength(1);
    expect((await q('SELECT balance FROM "S".credit_account WHERE "userId" = $1', [userId]))[0].balance).toBe(0);
    expect(await q(`SELECT amount, metadata FROM "S".credit_transaction WHERE "userId" = $1 AND type = 'EXPIRE'`, [userId]))
      .toEqual([{ amount: -25, metadata: { reason: 'account-deleted' } }]);
    expect((await q('SELECT status, reason FROM "S".account_deletions WHERE "userId" = $1', [userId]))[0]).toEqual({ status: 'completed', reason: null });
    // Data inventory: no text column of the remaining schema holds the address or the old username.
    const leaks = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND data_type IN ('text', 'character varying', 'jsonb')`, [schema]);
    for (const { table_name: table, column_name: column } of leaks as Array<{ table_name: string; column_name: string }>) {
      const found = await pool.query(`SELECT 1 FROM "${schema}"."${table}" WHERE "${column}"::text LIKE '%del_exec%' OR "${column}"::text LIKE '%203.0.113.77%' LIMIT 1`);
      expect(found.rows, `${table}.${column}`).toEqual([]);
    }
    expect((await deletions.executeNow(userId)).executed).toBe(false);
    await login('del_exec').expect(401);
  });

  it('refuses to delete the last superadmin', async () => {
    const userId = await member('del_admin');
    await q(`INSERT INTO "S".roles (id, name) VALUES ('role_super', 'superadmin') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "S".user_roles (id, "userId", "roleId") VALUES ($1, $2, (SELECT id FROM "S".roles WHERE name = 'superadmin'))`, [randomUUID(), userId]);
    const token = (await login('del_admin').expect(200)).body.token as string;
    expect((await post('deletion', { confirm: 'del_admin', password }, token).expect(409)).body.code).toBe('ACCOUNT_LAST_SUPERADMIN');
  });
});
