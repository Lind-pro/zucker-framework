// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH_EVENT_TOPICS, DimensionUserService, generateTotpCode, ScryptEncoder, UserService, type PermissionService } from '@zucker-framework/auth';
import { TransactionAwareDatabaseAdapter, type DatabaseAdapter } from '@zucker-framework/core';
import { UsersController } from '@zucker-framework/admin';
import { PgTestAdapter, type PgQueryable } from '../subscriptions/testing/pg-test-adapter';
import { AccountSessionAdminHooks } from './admin-user-hooks';
import { PASSWORD, createFixture } from './testing/account-fixture';
import { transactionalSqlRuntime, type TestSqlConnection, type TestSqlRuntime } from '../testing/transactional-sql-runtime';

const SCHEMA = `
CREATE TABLE users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, username text NOT NULL UNIQUE, password text, name text, email text UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, "typeId" text, status boolean NOT NULL DEFAULT true, locale text, "creatorId" text,
  "credentialVersion" int NOT NULL DEFAULT 0, "createTime" timestamptz NOT NULL DEFAULT now(), "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_sessions (id text PRIMARY KEY, "userId" text NOT NULL, "refreshJti" text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz, "revokedReason" text, "lastActiveAt" timestamptz NOT NULL DEFAULT now(), "credentialVersion" int NOT NULL DEFAULT 0,
  "authMethod" text, "oauthBindingId" text, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_totp (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL UNIQUE, "secretCiphertext" text NOT NULL,
  status text NOT NULL, "confirmedAt" timestamptz, "lastUsedStep" bigint, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_recovery (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL, "codeHash" text NOT NULL,
  "usedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE roles (id text PRIMARY KEY, name text NOT NULL, status boolean NOT NULL DEFAULT true);
CREATE TABLE "userRoles" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL, "roleId" text NOT NULL);
`;

function queryable(sql: TestSqlConnection): PgQueryable {
  return { async query(statement, values) {
    const result = await sql.query<Record<string, unknown>>(statement, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  } };
}
class TestDatabase extends TransactionAwareDatabaseAdapter {
  constructor(private readonly pg: TestSqlRuntime) { super(); }
  model(name: string) { return new PgTestAdapter(queryable(this.pg), true).model(name); }
  protected doTransaction<T>(work: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.pg.transaction(tx => work(new PgTestAdapter(queryable(tx), true)));
  }
}

const actor = { user: { id: 'synthetic-admin' } };
const permissions = {
  findUserPermissions: async (id: string) => id === actor.user.id ? ['superadmin'] : [],
  hasPermission: async () => true,
} as unknown as PermissionService;

describe('account security transaction boundaries', () => {
  let pg: TestSqlRuntime, db: TestDatabase;
  beforeAll(async () => { pg = await transactionalSqlRuntime('zf_account_security', process.env.TEST_DATABASE_URL); await pg.exec(SCHEMA); db = new TestDatabase(pg); }, 30_000);
  afterAll(async () => { await pg?.close(); });
  const fixture = () => createFixture({ db: db as never,
    models: { accountSessions: 'auth_sessions', accountTwoFactor: 'auth_totp', accountRecoveryCodes: 'auth_recovery' },
    features: { deletion: false, twoFactor: true }, sql: tx => tx as never,
  });

  it('rolls back the admin email and credential version when session revocation fails, then retries atomically', async () => {
    const f = fixture();
    const user = await f.createUser('atomic-admin-edit');
    const signedIn = await f.accounts.login({ username: user.username, password: PASSWORD }) as { accessToken: string };
    const { sid } = await f.jwt.verifyAsync(signedIn.accessToken, { audience: f.options.tokens.accessAudience });
    const hooks = new AccountSessionAdminHooks(db, f.options);
    let fail = true;
    const original = hooks.sensitiveFieldsChanging.bind(hooks);
    const changing = vi.spyOn(hooks, 'sensitiveFieldsChanging').mockImplementation(async (change, tx) => {
      // The actual hook has written both the version and revocation; a later failure must roll all of it back.
      await original(change, tx);
      if (fail) throw new Error('synthetic transaction failure');
    });
    const legacy = vi.spyOn(hooks, 'sensitiveFieldsChanged');
    const controller = new UsersController(f.accounts.users(), permissions, new DimensionUserService(db), db, {}, hooks);
    const input = { email: ' Updated@Example.Invalid ' };
    await expect(controller.update(user.id, input, actor)).rejects.toThrow('synthetic transaction failure');
    expect(await f.accounts.currentUser(user.id, sid)).toMatchObject({ email: user.email, credentialVersion: 0 });
    fail = false;
    await expect(controller.update(user.id, input, actor)).resolves.toMatchObject({ email: 'updated@example.invalid' });
    expect(changing).toHaveBeenCalledTimes(2);
    expect(legacy).not.toHaveBeenCalled();
    await expect(f.accounts.currentUser(user.id, sid)).rejects.toMatchObject({ status: 401 });
    expect(await db.model('users').findUnique({ where: { id: user.id } })).toMatchObject({ credentialVersion: 1 });
    expect(await db.model('auth_sessions').findUnique({ where: { id: sid } })).toMatchObject({ revokedReason: 'admin-credential-change' });
  });

  it('preserves the configured password encoder and only publishes user changes after commit', async () => {
    const f = fixture();
    const user = await f.createUser('transactional-encoder');
    const encoder = new ScryptEncoder();
    const bus = { publish: vi.fn().mockResolvedValue(undefined) };
    const users = new UserService(db, encoder, bus);
    const nextPassword = 'Changed!SyntheticPassword8';
    await expect(db.$transaction(async tx => {
      await users.updateUser(user.id, { password: nextPassword }, { transaction: tx });
      expect(bus.publish).not.toHaveBeenCalled();
      throw new Error('rollback password edit');
    })).rejects.toThrow('rollback password edit');
    expect(bus.publish).not.toHaveBeenCalled();
    expect((await users.findById(user.id))?.password).toBe(user.password);
    await db.$transaction(async tx => {
      await users.updateUser(user.id, { password: nextPassword }, { transaction: tx });
      expect(bus.publish).not.toHaveBeenCalled();
    });
    const saved = await users.findById(user.id);
    expect(await encoder.matches(nextPassword, saved?.password ?? '')).toBe(true);
    expect(bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.USER_MODIFIED, expect.objectContaining({ passwordChanged: true }));
    expect(bus.publish).toHaveBeenCalledWith(AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE, expect.objectContaining({ userId: user.id }));
    expect(JSON.stringify(bus.publish.mock.calls)).not.toContain(nextPassword);
  });

  it('accepts normalized admin emails and unambiguous legacy mixed-case addresses, refusing case collisions', async () => {
    const f = fixture();
    const controller = new UsersController(f.accounts.users(), permissions, new DimensionUserService(db), db);
    const created = await controller.create({ username: 'admin-email-case', email: ' Admin.Email@Example.Invalid ', name: 'Case',
      password: PASSWORD, emailVerified: true, typeId: 'member' }, actor);
    expect(created.email).toBe('admin.email@example.invalid');
    const emailHost = createFixture({ db: db as never, models: f.options.models, login: { identifier: 'email' }, features: { deletion: false } });
    await expect(emailHost.accounts.login({ email: 'Admin.Email@Example.Invalid', password: PASSWORD })).resolves.toMatchObject({ userId: created.id });
    const legacy = await f.createUser('legacy-email-case', { email: 'Legacy.Email@Example.Invalid' });
    await expect(emailHost.accounts.login({ email: 'legacy.email@example.invalid', password: PASSWORD })).resolves.toMatchObject({ userId: legacy.id });
    await f.createUser('legacy-email-collision', { email: 'legacy.email@example.invalid' });
    await expect(emailHost.accounts.login({ email: 'Legacy.Email@Example.Invalid', password: PASSWORD })).rejects.toMatchObject({ status: 401 });
  });

  it('reuses the valid TOTP after transaction rollback and rejects it after a committed claim', async () => {
    const f = fixture();
    const user = await f.createUser('rollback-factor');
    const { secret } = await f.twoFactor!.enrol(user);
    const code = () => generateTotpCode({ secret, time: f.clock.now.getTime() });
    await f.twoFactor!.confirm(user.id, 'synthetic-session', code());
    f.clock.advance(31);
    await expect(db.$transaction(async tx => {
      expect(await f.twoFactor!.verify(tx, user.id, { code: code() })).toBe(true);
      throw new Error('protected action failed');
    })).rejects.toThrow('protected action failed');
    expect(await db.$transaction(tx => f.twoFactor!.verify(tx, user.id, { code: code() }))).toBe(true);
    expect(await db.$transaction(tx => f.twoFactor!.verify(tx, user.id, { code: code() }))).toBe(false);
  });

  it('does not spend a TOTP when its durable claim fails before writing', async () => {
    const f = fixture();
    const user = await f.createUser('failed-factor-claim');
    const { secret } = await f.twoFactor!.enrol(user);
    const code = () => generateTotpCode({ secret, time: f.clock.now.getTime() });
    await f.twoFactor!.confirm(user.id, 'synthetic-session', code());
    f.clock.advance(31);
    await expect(db.$transaction(tx => {
      const fault: DatabaseAdapter = { $transaction: work => work(fault), model(name) {
        const model = tx.model(name);
        return name !== 'auth_totp' ? model : { ...model, updateMany: async () => { throw new Error('claim failed before write'); } };
      } };
      return f.twoFactor!.verify(fault, user.id, { code: code() });
    })).rejects.toThrow('claim failed before write');
    expect(await db.$transaction(tx => f.twoFactor!.verify(tx, user.id, { code: code() }))).toBe(true);
  });

  it('admits only one simultaneous durable claim for the same TOTP', async () => {
    const f = fixture();
    const user = await f.createUser('concurrent-factor-claim');
    const { secret } = await f.twoFactor!.enrol(user);
    await f.twoFactor!.confirm(user.id, 'synthetic-session', generateTotpCode({ secret, time: f.clock.now.getTime() }));
    f.clock.advance(31);
    const code = generateTotpCode({ secret, time: f.clock.now.getTime() });
    const claims = await Promise.all(Array.from({ length: 8 }, () =>
      db.$transaction(tx => f.twoFactor!.verify(tx, user.id, { code }))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await db.$transaction(tx => f.twoFactor!.verify(tx, user.id, { code }))).toBe(false);
  });

  it('rolls back policy-hook writes when a validated user update is refused', async () => {
    const f = fixture();
    const user = await f.createUser('policy-update-rollback');
    const controller = new UsersController(f.accounts.users(), permissions, new DimensionUserService(db), db, {}, {
      userChanging: async (change, tx) => {
        expect(change.userId).toBe(user.id);
        await tx.model('users').update({ where: { id: user.id }, data: { name: 'transaction-only-policy-write' } });
        throw new Error('policy refused update');
      },
    });
    await expect(controller.update(user.id, { status: false }, actor)).rejects.toThrow('policy refused update');
    expect(await db.model('users').findUnique({ where: { id: user.id } })).toMatchObject({ status: true, name: user.name });
  });

  it('rolls back policy-hook writes and retains bindings when role replacement is refused', async () => {
    const f = fixture();
    const user = await f.createUser('policy-role-rollback');
    await db.model('roles').create({ data: { id: 'policy-old-role', name: 'reader' } });
    await db.model('roles').create({ data: { id: 'policy-new-role', name: 'editor' } });
    await db.model('userRoles').create({ data: { userId: user.id, roleId: 'policy-old-role' } });
    const controller = new UsersController(f.accounts.users(), permissions, new DimensionUserService(db), db, {}, {
      userRolesChanging: async (change, tx) => {
        expect(change.roleIds).toEqual(['policy-new-role']);
        await tx.model('users').update({ where: { id: user.id }, data: { name: 'transaction-only-role-policy-write' } });
        throw new Error('policy refused roles');
      },
    });
    await expect(controller.setUserRoles(user.id, { roleIds: ['policy-new-role'] }, actor)).rejects.toThrow('policy refused roles');
    expect(await db.model('users').findUnique({ where: { id: user.id } })).toMatchObject({ name: user.name });
    expect(await db.model('userRoles').findMany({ where: { userId: user.id } })).toMatchObject([{ roleId: 'policy-old-role' }]);
  });
});
