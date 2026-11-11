import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { BcryptEncoder, PermissionService, Permissions, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { AssignRoleError, assignRoleByEmail } from '../src/accounts/assign-role';
import { createIsolatedSchema, dropIsolatedSchema } from './helpers/account-security-fixture';

/**
 * WP 3.3b Sonnet checks for expiring role assignments on PostgreSQL: the owner command stores `expiresAt`
 * and audits it, an expired link grants nothing (permission service and HTTP guard), the permission cache
 * never outlives the earliest expiry, and the opt-in is what turns the behaviour on.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_roleexp_${randomUUID().replaceAll('-', '')}`, password = 'SyntheticExpiry9!', origin = 'http://localhost:4202';
const DAY = 86_400_000;

@Controller('expiry-probe')
class ProbeController {
  @Get() @Permissions('expiry:read') read() { return { ok: true }; }
}

run('expiring role assignments (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, permissions: PermissionService;
  let clockMs = Date.now();
  const mailer: AccountMailer = { assertConfigured() {}, async send() {} };
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const roleId = randomUUID(), otherRoleId = randomUUID();
  async function member(username: string) {
    const id = randomUUID();
    await q(`INSERT INTO "S".users (id, username, name, "typeId", email, "emailVerified", status, password) VALUES ($1,$2,$2,'member',$3,true,true,$4)`,
      [id, username, `${username}@example.invalid`, await new BcryptEncoder().encode(password)]);
    return id;
  }
  const link = async (userId: string) => (await q('SELECT "roleId", "expiresAt" FROM "S".user_roles WHERE "userId" = $1 ORDER BY "roleId"', [userId])) as Array<{ roleId: string; expiresAt: Date | null }>;
  const allowed = (userId: string) => permissions.hasPermission(userId, ['expiry:read']);
  const probe = async (username: string) => {
    const login = await request(app.getHttpServer()).post('/api/authorize/login').set('Origin', origin).send({ username, password }).expect(200);
    return request(app.getHttpServer()).get('/api/expiry-probe').set('Authorization', `Bearer ${login.body.token}`);
  };

  beforeAll(async () => {
    const created = await createIsolatedSchema(databaseUrl!, schema);
    pool = created.pool; database = created.database;
    await q(`INSERT INTO "S".permissions (id, name) VALUES ('expiry:read', 'Expiry probe')`);
    await q(`INSERT INTO "S".roles (id, name) VALUES ($1, 'expiring-reader'), ($2, 'disabled-reader')`, [roleId, otherRoleId]);
    await q(`UPDATE "S".roles SET status = false WHERE id = $1`, [otherRoleId]);
    await q(`INSERT INTO "S".role_permissions (id, "roleId", "permissionId") VALUES ($1, $2, 'expiry:read')`, [randomUUID(), roleId]);
    const jwtSecret = 'synthetic-role-expiry-jwt-secret-at-least-32-chars';
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret, registerControllers: false, roleAssignments: { expiry: true } }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, login: limits, 'login-account': limits, 'session-refresh': limits,
        'session-refresh-network': limits, 'session-read': limits, 'api-default': limits } }), AccountModule],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    permissions = app.get(PermissionService);
    permissions.configureRoleAssignments({ expiry: true }, () => clockMs);
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); } finally { await dropIsolatedSchema(pool, schema); }
  });

  it('stores and audits the expiry, leaves an existing assignment alone without the flag, and replaces it with one', async () => {
    const userId = await member('exp_assign');
    const now = new Date();
    const first = await assignRoleByEmail(database, { email: 'Exp_Assign@Example.Invalid', role: 'expiring-reader', expires: '30d' }, now);
    expect(first).toMatchObject({ assigned: true, roleName: 'expiring-reader' });
    expect(first.expiresAt!.getTime()).toBe(now.getTime() + 30 * DAY);
    expect((await link(userId))[0]!.expiresAt!.getTime()).toBe(now.getTime() + 30 * DAY);
    // Without the flag the existing end date is kept.
    expect(await assignRoleByEmail(database, { email: 'exp_assign@example.invalid', role: roleId })).toMatchObject({ assigned: false, expiresAt: first.expiresAt });
    expect((await link(userId))[0]!.expiresAt!.getTime()).toBe(now.getTime() + 30 * DAY);
    // With a different one it is replaced; the same one is a no-op.
    const changed = await assignRoleByEmail(database, { email: 'exp_assign@example.invalid', role: 'expiring-reader', expires: '2099-01-01' }, now);
    expect(changed).toMatchObject({ assigned: false, expiryUpdated: true });
    expect((await link(userId))[0]!.expiresAt!.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(await assignRoleByEmail(database, { email: 'exp_assign@example.invalid', role: 'expiring-reader', expires: '2099-01-01' }, now)).toMatchObject({ assigned: false });
    expect(await link(userId)).toHaveLength(1);
    const audit = await q(`SELECT action, metadata FROM "S".operation_logs WHERE "targetId" = $1 AND module = 'accounts' ORDER BY "createdAt"`, [userId]);
    expect(audit.map(row => row.action)).toEqual(['assign-role', 'assign-role-expiry']);
    expect(audit[0]!.metadata).toMatchObject({ via: 'cli', expiresAt: new Date(now.getTime() + 30 * DAY).toISOString() });
    // Non-expiring by default (the sign-up path never sets an end).
    const open = await member('exp_open');
    expect(await assignRoleByEmail(database, { email: 'exp_open@example.invalid', role: 'expiring-reader' })).toMatchObject({ assigned: true, expiresAt: null });
    expect((await link(open))[0]!.expiresAt).toBeNull();
  });

  it('refuses unknown accounts, unknown or disabled roles and bad dates without writing', async () => {
    const userId = await member('exp_refuse');
    const before = await q('SELECT count(*)::int AS n FROM "S".user_roles');
    for (const input of [
      { email: 'nobody@example.invalid', role: 'expiring-reader', expires: '7d' },
      { email: 'exp_refuse@example.invalid', role: 'no-such-role', expires: '7d' },
      { email: 'exp_refuse@example.invalid', role: 'disabled-reader', expires: '7d' },
      { email: 'exp_refuse@example.invalid', role: 'expiring-reader', expires: '2001-01-01' },
      { email: 'exp_refuse@example.invalid', role: 'expiring-reader', expires: 'soon' },
      { email: 'not-an-email', role: 'expiring-reader' },
    ]) await expect(assignRoleByEmail(database, input), JSON.stringify(input)).rejects.toBeInstanceOf(AssignRoleError);
    expect(await link(userId)).toEqual([]);
    expect(await q('SELECT count(*)::int AS n FROM "S".user_roles')).toEqual(before);
  });

  it('grants nothing from an expired link, and the cache never keeps a role past its end', async () => {
    const userId = await member('exp_grants');
    const expiry = new Date(clockMs + 60_000);
    await q('INSERT INTO "S".user_roles (id, "userId", "roleId", "expiresAt") VALUES ($1, $2, $3, $4)', [randomUUID(), userId, roleId, expiry]);
    expect(await allowed(userId)).toBe(true);
    // Cached at T+58s: the entry may not live to its 5 s TTL because the role ends at T+60s.
    clockMs = expiry.getTime() - 2_000;
    expect(await allowed(userId)).toBe(true);
    clockMs = expiry.getTime() - 1;
    expect(await allowed(userId)).toBe(true);
    clockMs = expiry.getTime();
    expect(await allowed(userId)).toBe(false);
    clockMs = expiry.getTime() + 60_000;
    expect(await permissions.findUserPermissions(userId)).not.toContain('expiry:read');
    // Extending the end date brings the access back; clearing the row removes it.
    await assignRoleByEmail(database, { email: 'exp_grants@example.invalid', role: 'expiring-reader', expires: '3000-01-01' });
    clockMs = Date.now() + 2 * DAY; permissions.configureRoleAssignments({ expiry: true }, () => clockMs);
    expect(await allowed(userId)).toBe(true);
    clockMs = Date.now();
  });

  it('applies the same rule at the HTTP guard and does not let a still-valid token keep an expired role', async () => {
    const userId = await member('exp_http');
    const soon = new Date(Date.now() + 3_000);
    await q('INSERT INTO "S".user_roles (id, "userId", "roleId", "expiresAt") VALUES ($1, $2, $3, $4)', [randomUUID(), userId, roleId, soon]);
    permissions.configureRoleAssignments({ expiry: true }, () => Date.now());
    const login = await request(app.getHttpServer()).post('/api/authorize/login').set('Origin', origin).send({ username: 'exp_http', password }).expect(200);
    const get = () => request(app.getHttpServer()).get('/api/expiry-probe').set('Authorization', `Bearer ${login.body.token}`);
    await get().expect(200);
    await new Promise(done => setTimeout(done, soon.getTime() - Date.now() + 50));
    const denied = await get().expect(403);
    expect(denied.body.token).toBeUndefined();
    // A role link without any expiry keeps working, and a user with no role at all is denied.
    const permanent = await member('exp_http_open');
    await q('INSERT INTO "S".user_roles (id, "userId", "roleId") VALUES ($1, $2, $3)', [randomUUID(), permanent, roleId]);
    (await probe('exp_http_open')).status === 200 || expect.fail('permanent assignment must keep working');
    await member('exp_http_none'); expect((await probe('exp_http_none')).status).toBe(403);
  });

  it('keeps the column nullable, indexed and absent from rows created without an end date', async () => {
    const columns = await q(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'user_roles' AND column_name = 'expiresAt'`, [schema]);
    expect(columns).toEqual([{ is_nullable: 'YES' }]);
    const indexes = await q(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'user_roles'`, [schema]);
    expect(indexes.some(row => /"expiresAt"/.test(row.indexdef as string))).toBe(true);
    expect(await q(`SELECT 1 FROM "S".user_roles WHERE "userId" IN (SELECT id FROM "S".users WHERE username = 'exp_open') AND "expiresAt" IS NOT NULL`)).toEqual([]);
  });
});
