// @vitest-environment node
import { UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaAdapter } from '@zucker-framework/crud';
import { ScryptEncoder, UserService } from '@zucker-framework/auth';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { PgTestAdapter, type PgPoolLike } from '../subscriptions/testing/pg-test-adapter';
import { PASSWORD, CodeMailer, createFixture } from './testing/account-fixture';

/**
 * Account host and passwordless `addUser` on a real PostgreSQL schema whose models differ from the Framework
 * template (auth_sessions / auth_tickets / mail_codes, `type` instead of `purpose`), the way ccopyright maps them.
 * Needs TEST_DATABASE_URL (an isolated *_test database).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

const SCHEMA_SQL = `
CREATE TABLE users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, username text NOT NULL UNIQUE, password text, name text, email text UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, "typeId" text, status boolean NOT NULL DEFAULT true, locale text, "credentialVersion" int NOT NULL DEFAULT 0,
  "createTime" timestamptz NOT NULL DEFAULT now(), "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_sessions (id text PRIMARY KEY, "userId" text NOT NULL, "refreshJti" text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz, "revokedReason" text, "lastActiveAt" timestamptz NOT NULL DEFAULT now(), "credentialVersion" int NOT NULL DEFAULT 0,
  "authMethod" text, "oauthBindingId" text, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_tickets (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "tokenHash" text NOT NULL UNIQUE, "userId" text NOT NULL, email text NOT NULL,
  purpose text NOT NULL, "credentialVersion" int NOT NULL, "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE mail_codes (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, email text NOT NULL, type text NOT NULL, code text NOT NULL,
  used boolean NOT NULL DEFAULT false, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_totp (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL UNIQUE, "secretCiphertext" text NOT NULL, status text NOT NULL,
  "confirmedAt" timestamptz, "lastUsedStep" bigint, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_recovery (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL, "codeHash" text NOT NULL, "usedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now());
`;

run('account host on a differently named PostgreSQL schema', () => {
  const schema = `zf_accounts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let db: PgTestAdapter;
  const q = (sql: string, values?: unknown[]) => pool.query(sql, values);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    admin = new Pool({ connectionString: url.href, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, max: 10, options: `-c search_path=${schema}` });
    await pool.query(SCHEMA_SQL);
    db = new PgTestAdapter(pool as unknown as PgPoolLike);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  const models = { accountSessions: 'auth_sessions', accountTickets: 'auth_tickets', emailVerifications: 'mail_codes', accountTwoFactor: 'auth_totp',
    accountRecoveryCodes: 'auth_recovery' } as const;
  const make = (extra: Record<string, unknown> = {}) => createFixture({ db: db as never, models, mailer: new CodeMailer(), sql: tx => tx as never,
    verification: { mode: 'code', fields: { subject: 'email', purpose: 'type' }, signInOnVerify: true, codeExpirySeconds: 3600, resendSeconds: 60 },
    policy: { requireEmailVerification: true }, ...extra });

  it('registers, verifies by code, signs in, rotates and revokes on the renamed tables', async () => {
    const f = make();
    expect(await f.accounts.register({ username: 'pg-user', email: 'pg-user@example.invalid', password: PASSWORD, locale: 'en' })).toEqual({ verificationRequired: true });
    const stored = (await q('SELECT password, "emailVerified" FROM users WHERE username=$1', ['pg-user'])).rows[0];
    expect(stored.emailVerified).toBe(false);
    expect(stored.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect((await q('SELECT type, used FROM mail_codes WHERE email=$1', ['pg-user@example.invalid'])).rows).toEqual([{ type: 'verify-email', used: false }]);

    const code = f.mailer.last('verify-email')!.secret;
    const verified = await f.accounts.consumeEmail({ email: 'pg-user@example.invalid', code }, 'verify-email');
    expect(verified).toMatchObject({ success: true, signIn: { twoFactorRequired: false } });
    expect((await q('SELECT "emailVerified" FROM users WHERE username=$1', ['pg-user'])).rows[0].emailVerified).toBe(true);
    expect((await q('SELECT used FROM mail_codes WHERE email=$1', ['pg-user@example.invalid'])).rows).toEqual([{ used: true }]);
    expect((await q('SELECT "authMethod" FROM auth_sessions')).rows.map(row => row.authMethod)).toContain('email-code');

    const login = await f.accounts.login({ username: 'pg-user', password: PASSWORD }) as { refreshToken: string; accessToken: string; userId: string };
    const claims = await f.jwt.verifyAsync(login.refreshToken, { audience: f.options.tokens.refreshAudience });
    const rotated = await f.accounts.refresh(login.refreshToken);
    await expect(f.accounts.refresh(login.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await q('SELECT "revokedAt" FROM auth_sessions WHERE id=$1', [claims.sub])).rows[0].revokedAt).toBeNull(); // replay does not revoke
    await f.accounts.sessions.revokeSession(claims.sub as string, 'logout');
    await expect(f.accounts.refresh(rotated.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    // Default-named tables were never created, so nothing could have used them.
    expect((await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('accountSessions','accountTickets','emailVerifications')`, [schema])).rows[0].n).toBe(0);
  });

  it('refreshing one token concurrently has exactly one winner and does not revoke the session', async () => {
    const f = make();
    const user = await f.createUser('pg-refresher');
    const session = await f.accounts.signIn(user, { kind: 'password' }) as { refreshToken: string };
    const claims = await f.jwt.verifyAsync(session.refreshToken, { audience: f.options.tokens.refreshAudience });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.accounts.refresh(session.refreshToken)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(UnauthorizedException);
    const winner = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ refreshToken: string }>).value;
    expect((await q('SELECT "revokedAt" FROM auth_sessions WHERE id=$1', [claims.sub])).rows[0].revokedAt).toBeNull();
    expect(await f.accounts.refresh(winner.refreshToken)).toMatchObject({ accessToken: expect.any(String) });
  });

  it('a verification code is consumed by exactly one of several simultaneous requests', async () => {
    const f = make();
    await f.accounts.register({ username: 'pg-race', email: 'pg-race@example.invalid', password: PASSWORD, locale: 'en' });
    const code = f.mailer.last('verify-email')!.secret;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.accounts.consumeEmail({ email: 'pg-race@example.invalid', code }, 'verify-email')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    // Losers are told the code is invalid (400) or, once their failures add up, that verification is locked (429).
    for (const result of results) if (result.status === 'rejected') expect([400, 429]).toContain((result.reason as { getStatus(): number }).getStatus());
    expect((await q('SELECT count(*)::int AS n FROM auth_sessions s JOIN users u ON u.id = s."userId" WHERE u.username=$1', ['pg-race'])).rows[0].n).toBe(1);
  });

  it('the resend window holds under simultaneous requests: one live code, one mail', async () => {
    const f = make();
    await f.createUser('pg-resend', { emailVerified: false });
    await Promise.all(Array.from({ length: 5 }, () => f.accounts.requestEmail({ email: 'pg-resend@example.invalid' }, 'verify-email')));
    await f.accounts.settled();
    expect((await q(`SELECT count(*)::int AS n FROM mail_codes WHERE email='pg-resend@example.invalid' AND used=false`)).rows[0].n).toBe(1);
    expect(f.mailer.sent.filter(mail => mail.email === 'pg-resend@example.invalid')).toHaveLength(1);
  });

  it('password change revokes every session in the same transaction (no half-applied change)', async () => {
    const f = make();
    const user = await f.createUser('pg-changer');
    const a = await f.accounts.signIn(user, { kind: 'password' }) as { accessToken: string };
    await f.accounts.signIn(user, { kind: 'password' });
    await f.accounts.changePassword(user.id, { currentPassword: PASSWORD, password: 'An0ther!Passw0rd#2' });
    expect((await q(`SELECT count(*)::int AS n FROM auth_sessions WHERE "userId"=$1 AND "revokedAt" IS NULL`, [user.id])).rows[0].n).toBe(0);
    expect((await q('SELECT "credentialVersion" FROM users WHERE id=$1', [user.id])).rows[0].credentialVersion).toBe(1);
    const claims = await f.jwt.verifyAsync(a.accessToken, { audience: f.options.tokens.accessAudience });
    await expect(f.accounts.currentUser(user.id, claims.sid)).rejects.toBeInstanceOf(UnauthorizedException);
    // Two concurrent changes from the same current password: the credentialVersion compare-and-set admits one.
    const fresh = await f.createUser('pg-changer-2');
    const results = await Promise.allSettled(['X1!Strong#Passw0rd', 'X2!Strong#Passw0rd'].map(password =>
      f.accounts.changePassword(fresh.id, { currentPassword: PASSWORD, password })));
    expect(results.filter(result => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect((await q('SELECT "credentialVersion" FROM users WHERE id=$1', [fresh.id])).rows[0].credentialVersion).toBe(results.filter(result => result.status === 'fulfilled').length);
  });
});

/**
 * F1 contract: `UserService.addUser(..., { transaction })` on a real PrismaAdapter whose delegates are backed by
 * PostgreSQL. A rolled-back caller transaction leaves no row and publishes no event; a commit publishes after the row
 * is visible.
 */
run('UserService.addUser with a caller transaction on PostgreSQL', () => {
  const schema = `zf_adduser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let adapter: PrismaAdapter;
  const events: Array<{ topic: string; payload: Record<string, unknown>; visible: boolean }> = [];
  let service: UserService;
  const q = (sql: string, values?: unknown[]) => pool.query(sql, values);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    admin = new Pool({ connectionString: url.href, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, username text NOT NULL UNIQUE, password text, name text,
      email text, "emailVerified" boolean NOT NULL DEFAULT false, "typeId" text, status boolean NOT NULL DEFAULT true, locale text,
      "createTime" timestamptz NOT NULL DEFAULT now())`);
    // A Prisma-shaped client: delegates per model, and an interactive $transaction on one pinned connection.
    const delegates = (target: PgPoolLike) => ({ users: new PgTestAdapter(target).model('users') });
    const prismaLike = {
      ...delegates(pool as unknown as PgPoolLike),
      async $transaction<T>(work: (tx: Record<string, unknown>) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(delegates(client as never));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally { client.release(); }
      },
    };
    adapter = new PrismaAdapter(prismaLike as never);
    service = new UserService(adapter, new ScryptEncoder(), {
      publish: async (topic: string, payload: unknown) => {
        const username = (payload as { username?: string }).username;
        const visible = username ? (await q('SELECT 1 FROM users WHERE username=$1', [username])).rowCount === 1 : false;
        events.push({ topic, payload: payload as Record<string, unknown>, visible });
      },
    } as never);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  const created = () => events.filter(event => /created/i.test(event.topic));
  const base = { email: 'x@example.invalid', typeId: 'member', status: true, emailVerified: true };

  it('rollback leaves no row and publishes no event; the identical commit publishes exactly one, after the row is visible', async () => {
    events.length = 0;
    await expect(adapter.$transaction(async (tx: DatabaseAdapter) => {
      await service.addUser({ ...base, username: 'member_rolledback' }, { passwordless: true, transaction: tx });
      expect((await tx.model('users').findMany({ where: { username: 'member_rolledback' } }))).toHaveLength(1); // visible inside
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username='member_rolledback'`)).rows[0].n).toBe(0);
    expect(created()).toEqual([]);

    const user = await adapter.$transaction(tx => service.addUser({ ...base, username: 'member_committed' }, { passwordless: true, transaction: tx }));
    expect(user.password).toBeNull();
    expect((await q(`SELECT password FROM users WHERE username='member_committed'`)).rows).toEqual([{ password: null }]);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ visible: true, payload: expect.objectContaining({ username: 'member_committed' }) });
  });

  it('a failure after several users rolls all of them back, with no events', async () => {
    events.length = 0;
    await expect(adapter.$transaction(async tx => {
      await service.addUser({ ...base, username: 'member_a' }, { passwordless: true, transaction: tx });
      await service.addUser({ ...base, username: 'member_b', email: 'b@example.invalid' }, { passwordless: true, transaction: tx });
      await tx.model('users').create({ data: { username: 'member_a' } }); // unique violation
    })).rejects.toBeTruthy();
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username IN ('member_a','member_b')`)).rows[0].n).toBe(0);
    expect(created()).toEqual([]);
  });

  it('the duplicate check runs inside the caller transaction (a name taken earlier in it is refused)', async () => {
    events.length = 0;
    await expect(adapter.$transaction(async tx => {
      await service.addUser({ ...base, username: 'member_twice' }, { passwordless: true, transaction: tx });
      await service.addUser({ ...base, username: 'member_twice', email: 'again@example.invalid' }, { passwordless: true, transaction: tx });
    })).rejects.toMatchObject({ status: 409 });
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username='member_twice'`)).rows[0].n).toBe(0);
    expect(created()).toEqual([]);
  });

  it('two simultaneous transactions creating the same username: one row, one event', async () => {
    events.length = 0;
    const attempts = await Promise.allSettled([1, 2, 3].map(() => adapter.$transaction(tx =>
      service.addUser({ ...base, username: 'member_raced', email: undefined }, { passwordless: true, transaction: tx }))));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username='member_raced'`)).rows[0].n).toBe(1);
    expect(created()).toHaveLength(1);
  });

  it('passwordless refuses a password, and a normal addUser still needs one (and hashes it)', async () => {
    events.length = 0;
    await expect(adapter.$transaction(tx => service.addUser({ ...base, username: 'member_pw', password: PASSWORD }, { passwordless: true, transaction: tx })))
      .rejects.toMatchObject({ errors: expect.anything() });
    await expect(service.addUser({ ...base, username: 'member_nopw' })).rejects.toBeTruthy();
    const withPassword = await adapter.$transaction(tx => service.addUser({ ...base, username: 'member_withpw', password: PASSWORD }, { transaction: tx }));
    expect(withPassword.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username IN ('member_pw','member_nopw')`)).rows[0].n).toBe(0);
  });

  it('without a caller transaction the event is published immediately after the insert', async () => {
    events.length = 0;
    await service.addUser({ ...base, username: 'member_plain', password: PASSWORD });
    expect(created()).toHaveLength(1);
    expect(created()[0]!.visible).toBe(true);
  });
});
