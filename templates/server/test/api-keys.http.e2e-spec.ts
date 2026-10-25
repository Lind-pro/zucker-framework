import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { Permissions, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { AccountApiKeysModule } from '../src/api-keys/api-keys.module';
import { ApplicationDatabase } from '../src/database';
import { applicationCorsOptions } from '../src/http-options';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_api_keys_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202', password = 'SyntheticUser9!';
interface Owner { id: string; token: string }
interface CreatedKey { apiKey: { id: string; keyPrefix: string; scopes: string[]; expiresAt: string; rateLimit: number }; secretKey: string }
@Controller('api-key-admin-probe')
@Permissions('users:query')
class AdminProbeController { @Get() read() { return { shouldNotBeVisible: true }; } }

run('account API key HTTP and persistence boundary', () => {
  let app: INestApplication, pool: Pool, scopedUrl: string, owner: Owner, other: Owner;
  const deliveries = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  async function startApp() {
    const module = await Test.createTestingModule({
      imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => new ApplicationDatabase(scopedUrl) }),
        ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-api-key-test-secret-only-long', registerControllers: false }),
        ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 }, 'api-key': { points: 60, duration: 60, blockDuration: 0 } } }),
        AccountModule, AccountApiKeysModule],
      controllers: [AdminProbeController],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }],
    }).overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    const instance = module.createNestApplication(); instance.enableCors(applicationCorsOptions({ ACCOUNT_ORIGINS: origin }));
    instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter()); await instance.init(); return instance;
  }
  async function member(username: string): Promise<Owner> {
    const email = `${username}@example.invalid`;
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200); return { id: login.body.userId, token: login.body.token };
  }
  const create = (body: object = { name: 'Synthetic integration' }, account = owner) => request(app.getHttpServer()).post('/api/authorize/api-keys')
    .set('Origin', origin).set('Authorization', `Bearer ${account.token}`).send(body);
  const list = (account = owner) => request(app.getHttpServer()).get('/api/authorize/api-keys').set('Authorization', `Bearer ${account.token}`);
  const read = (key: string) => request(app.getHttpServer()).get('/api/v1/account').set('X-API-Key', key);
  const revoke = (id: string, account = owner) => request(app.getHttpServer()).delete(`/api/authorize/api-keys/${id}`)
    .set('Origin', origin).set('Authorization', `Bearer ${account.token}`);
  const rename = (id: string, body: object = { name: 'Renamed integration' }, account = owner) => request(app.getHttpServer()).patch(`/api/authorize/api-keys/${id}`)
    .set('Origin', origin).set('Authorization', `Bearer ${account.token}`).send(body);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`); await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; app = await startApp();
    owner = await member('keyowner'); other = await member('keyother');
  });
  afterAll(async () => {
    try { await app?.close(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('keeps management behind JWT sessions, origin checks and a strict scope/field whitelist', async () => {
    await request(app.getHttpServer()).get('/api/authorize/api-keys').expect(401);
    await create().set('Origin', 'https://foreign.invalid').expect(403);
    for (const body of [{ name: 'admin', scopes: ['*'] }, { name: 'admin', scopes: ['users:query'] },
      { name: 'injected', userId: other.id }, { name: 'rate override', rateLimit: 999 }, { name: 'bad expiry', expiresInDays: 0 }, { name: '  ' }]) {
      await create(body).expect(400);
    }
    const preflight = await request(app.getHttpServer()).options('/api/v1/account').set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'x-api-key').expect(204);
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('x-api-key');
    await request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${owner.token}`).expect(200);
  });

  it('returns a secret once, persists only its hash, and lists metadata for the owner only', async () => {
    const response = await create({ name: 'First integration', expiresInDays: 30, scopes: ['account:read'] }).expect(201);
    const created = response.body as CreatedKey;
    expect(response.headers['cache-control']).toBe('no-store');
    expect(/^zk_api_[A-Za-z0-9_-]{32}$/.test(created.secretKey)).toBe(true);
    expect(created.apiKey.scopes).toEqual(['account:read']); expect(created.apiKey.rateLimit).toBe(60);
    expect(Date.parse(created.apiKey.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400_000);
    expect(response.body.apiKey.keyHash).toBeUndefined();
    const { rows } = await pool.query(`SELECT * FROM "${schema}".account_api_keys WHERE id=$1`, [created.apiKey.id]);
    expect(rows[0].keyHash).toBe(createHash('sha256').update(created.secretKey).digest('hex'));
    expect(JSON.stringify(rows).includes(created.secretKey)).toBe(false);
    const own = await list().expect(200), others = await list(other).expect(200);
    expect(own.body.apiKeys.some((key: { id: string }) => key.id === created.apiKey.id)).toBe(true);
    expect(others.body.apiKeys).toEqual([]);
    expect(JSON.stringify(own.body).includes(created.secretKey)).toBe(false);
    expect(JSON.stringify(own.body).includes(rows[0].keyHash)).toBe(false);
    await request(app.getHttpServer()).get(`/api/authorize/api-keys/${created.apiKey.id}`).set('Authorization', `Bearer ${owner.token}`).expect(404);
  });

  it('authenticates only the explicit read-only API route and never turns scopes into admin permissions', async () => {
    const { body } = await create().expect(201); const key = body as CreatedKey;
    const profile = await read(key.secretKey).query({ userId: other.id }).expect(200);
    expect(profile.body.id).toBe(owner.id); expect(profile.body.password).toBeUndefined(); expect(profile.body.permissions).toBeUndefined();
    await request(app.getHttpServer()).get('/api/v1/account').set('Authorization', `Bearer ${key.secretKey}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/account').expect(401);
    await request(app.getHttpServer()).get('/api/v1/account').query({ api_key: key.secretKey }).expect(401);
    await request(app.getHttpServer()).get('/api/v1/account').set('Authorization', `Bearer ${owner.token}`).expect(401);
    await request(app.getHttpServer()).get('/api/authorize/me').set('Authorization', `Bearer ${key.secretKey}`).expect(401);
    await request(app.getHttpServer()).post('/api/authorize/api-keys').set('Origin', origin).set('X-API-Key', key.secretKey).send({ name: 'unauthorized' }).expect(401);
    await request(app.getHttpServer()).get('/api/api-key-admin-probe').set('Authorization', `Bearer ${key.secretKey}`).expect(401);
    await request(app.getHttpServer()).get('/api/api-key-admin-probe').set('Authorization', `Bearer ${owner.token}`).expect(403);
  });

  it('enforces key ownership and persists revocation across an application restart', async () => {
    const { body } = await create({ name: 'Revoked integration' }).expect(201); const key = body as CreatedKey;
    await revoke(key.apiKey.id, other).expect(404); await read(key.secretKey).expect(200);
    await revoke(key.apiKey.id).expect(200); await read(key.secretKey).expect(401);
    await app.close(); app = await startApp(); await read(key.secretKey).expect(401);
    const own = await list().expect(200); expect(own.body.apiKeys.some((item: { id: string }) => item.id === key.apiKey.id)).toBe(false);
  });

  it('rejects expired/disabled keys and disabled account owners', async () => {
    const expired = (await create({ name: 'Expired integration' }).expect(201)).body as CreatedKey;
    const db = app.get<ApplicationDatabase>('DATABASE_ADAPTER');
    await db.model('accountApiKeys').update({ where: { id: expired.apiKey.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const stored = await db.model('accountApiKeys').findUnique({ where: { id: expired.apiKey.id }, select: { expiresAt: true } }) as { expiresAt: Date };
    expect(stored.expiresAt.getTime() < Date.now()).toBe(true);
    await read(expired.secretKey).expect(401);
    const disabled = (await create({ name: 'Disabled integration' }).expect(201)).body as CreatedKey;
    await pool.query(`UPDATE "${schema}".account_api_keys SET "isActive"=false WHERE id=$1`, [disabled.apiKey.id]);
    await read(disabled.secretKey).expect(401);
    const ownerDisabled = (await create({ name: 'Disabled owner integration' }, other).expect(201)).body as CreatedKey;
    await pool.query(`UPDATE "${schema}".users SET status=false WHERE id=$1`, [other.id]);
    try { await read(ownerDisabled.secretKey).expect(401); await list(other).expect(401); }
    finally { await pool.query(`UPDATE "${schema}".users SET status=true WHERE id=$1`, [other.id]); }
  });

  it('requires the endpoint scope even for an otherwise valid key', async () => {
    const key = (await create({ name: 'Legacy empty scope' }).expect(201)).body as CreatedKey;
    await pool.query(`UPDATE "${schema}".account_api_keys SET scopes=ARRAY[]::TEXT[] WHERE id=$1`, [key.apiKey.id]);
    await read(key.secretKey).expect(403);
  });

  it('uses per-key limits with 429 and records only path/method metadata for completed requests', async () => {
    const key = (await create({ name: 'Rate-limited integration' }).expect(201)).body as CreatedKey;
    await pool.query(`UPDATE "${schema}".account_api_keys SET "rateLimit"=2 WHERE id=$1`, [key.apiKey.id]);
    const first = await read(key.secretKey).query({ detail: 'synthetic-query' }).expect(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect(Number.isFinite(Date.parse(first.headers['x-ratelimit-reset']))).toBe(true);
    await read(key.secretKey).expect(200); const denied = await read(key.secretKey).expect(429);
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    await expect.poll(async () => Number((await pool.query(`SELECT count(*) FROM "${schema}".account_api_key_usage WHERE "apiKeyId"=$1`, [key.apiKey.id])).rows[0].count)).toBe(2);
    const usage = await pool.query(`SELECT endpoint, method, "statusCode" FROM "${schema}".account_api_key_usage WHERE "apiKeyId"=$1`, [key.apiKey.id]);
    expect(usage.rows.every(row => row.endpoint === '/api/v1/account' && row.method === 'GET' && row.statusCode === 200)).toBe(true);
    expect(JSON.stringify(usage.rows).includes(key.secretKey)).toBe(false);
  });

  it('renames owned metadata durably without rotating the secret or widening scopes', async () => {
    const key = (await create({ name: 'Before rename' }).expect(201)).body as CreatedKey;
    const before = (await pool.query(`SELECT "keyHash","keyPrefix",scopes,"rateLimit","expiresAt","isActive","revokedAt" FROM "${schema}".account_api_keys WHERE id=$1`, [key.apiKey.id])).rows[0];
    const response = await rename(key.apiKey.id, { name: '  Renamed integration  ' }).expect(200);
    expect(response.body).toEqual({ id: key.apiKey.id, name: 'Renamed integration' }); expect(response.headers['cache-control']).toBe('no-store');
    const after = (await pool.query(`SELECT "keyHash","keyPrefix",scopes,"rateLimit","expiresAt","isActive","revokedAt" FROM "${schema}".account_api_keys WHERE id=$1`, [key.apiKey.id])).rows[0];
    expect(after).toEqual(before); await read(key.secretKey).expect(200);
    await app.close(); app = await startApp();
    expect((await list().expect(200)).body.apiKeys.find((row: { id: string }) => row.id === key.apiKey.id)).toMatchObject({ name: 'Renamed integration', canRename: true });
    await read(key.secretKey).expect(200);
  });

  it('protects key rename with owner, origin, session and name-only field boundaries', async () => {
    const key = (await create({ name: 'Rename boundary' }).expect(201)).body as CreatedKey;
    await rename(key.apiKey.id, { name: 'Foreign owner' }, other).expect(404);
    await rename(key.apiKey.id).set('Origin', 'https://foreign.invalid').expect(403);
    await rename(key.apiKey.id).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await rename(key.apiKey.id).unset('Authorization').expect(401);
    await rename(key.apiKey.id).set('Authorization', `Bearer ${key.secretKey}`).expect(401);
    for (const body of [{ name: 'x', scopes: ['*'] }, { name: 'x', isActive: true }, { name: 'x', userId: other.id },
      { name: '' }, { name: 'x'.repeat(81) }, { name: 'bad\nname' }, { scopes: ['account:read'] }]) await rename(key.apiKey.id, body).expect(400);
    expect((await list().expect(200)).body.apiKeys.find((row: { id: string }) => row.id === key.apiKey.id).name).toBe('Rename boundary');
  });

  it('rejects renaming expired, disabled or revoked keys and advertises the same capability', async () => {
    const db = app.get<ApplicationDatabase>('DATABASE_ADAPTER');
    for (const state of ['expired', 'disabled', 'revoked'] as const) {
      const key = (await create({ name: `${state} rename` }).expect(201)).body as CreatedKey;
      if (state === 'expired') await db.model('accountApiKeys').update({ where: { id: key.apiKey.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      else if (state === 'disabled') await db.model('accountApiKeys').update({ where: { id: key.apiKey.id }, data: { isActive: false } });
      else await revoke(key.apiKey.id).expect(200);
      await rename(key.apiKey.id).expect(404);
      const listed = (await list().expect(200)).body.apiKeys.find((row: { id: string }) => row.id === key.apiKey.id);
      if (state === 'revoked') expect(listed).toBeUndefined(); else expect(listed.canRename).toBe(false);
      expect((await db.model('accountApiKeys').findUnique({ where: { id: key.apiKey.id } }) as { name: string }).name).toBe(`${state} rename`);
    }
  });
});
