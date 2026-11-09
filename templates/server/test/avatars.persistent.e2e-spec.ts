import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import sharp from 'sharp';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { FILE_MANAGER, LocalFileStorage, ZuckerStorageModule } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { AccountAvatarModule } from '../src/accounts/avatar/avatar.module';
import { applicationCorsOptions } from '../src/http-options';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_avatars_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
interface Member { id: string; token: string }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
run('private account avatars with real PostgreSQL, local objects and image decoding', () => {
  let app: INestApplication, pool: Pool, scopedUrl: string, directory: string, manager: LocalFileStorage, red: Buffer, blue: Buffer;
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  async function startApp() {
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => new ApplicationDatabase(scopedUrl) }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-avatar-only-secret-long', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'session-refresh': { points: 2000, duration: 60 }, 'session-refresh-network': { points: 2000, duration: 60 }, 'session-read': { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, AccountAvatarModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(FILE_MANAGER).useValue(manager).compile();
    const instance = module.createNestApplication(); instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter());
    instance.enableCors(applicationCorsOptions({ ACCOUNT_ORIGINS: origin })); await instance.init(); return instance;
  }
  async function member(): Promise<Member> {
    const username = `avatar_${randomUUID().replaceAll('-', '')}`, email = `${username}@example.invalid`, password = 'SyntheticAvatar9!';
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201); await post('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200); return { id: login.body.userId, token: login.body.token };
  }
  const metadata = (owner: Member) => request(app.getHttpServer()).get('/api/authorize/avatar').set('Authorization', `Bearer ${owner.token}`);
  const content = (owner: Member, revision: number) => request(app.getHttpServer()).get('/api/authorize/avatar/content').query({ revision }).set('Authorization', `Bearer ${owner.token}`);
  const upload = (owner: Member, revision: number, key = randomUUID(), bytes = red) => request(app.getHttpServer()).post('/api/authorize/avatar')
    .set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', key).set('If-Match', `"${revision}"`)
    .attach('file', bytes, { filename: '../../untrusted.jpg', contentType: 'application/octet-stream' });
  const remove = (owner: Member, revision: number, key = randomUUID()) => request(app.getHttpServer()).delete('/api/authorize/avatar')
    .set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', key).set('If-Match', `"${revision}"`);
  const assets = async (owner: Member) => (await pool.query(`SELECT * FROM "${schema}".file_assets WHERE "ownerId"=$1`, [owner.id])).rows;
  async function failReceipt(work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_avatar_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic avatar receipt failure'; END; $$`);
    try { await pool.query(`CREATE TRIGGER synthetic_avatar_failure BEFORE INSERT ON "${schema}".account_avatar_changes FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_avatar_failure()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER synthetic_avatar_failure ON "${schema}".account_avatar_changes`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_avatar_failure()`); }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (url.pathname !== '/cnipa_dev') throw new Error('Requires approved isolated development database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-avatar-objects-')); manager = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; app = await startApp();
    red = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 240, g: 10, b: 10 } } }).jpeg().withMetadata().toBuffer();
    blue = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 10, g: 20, b: 230 } } }).png().toBuffer();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await app?.close(); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } } });

  it('normalizes an owned image to private PNG, strips metadata and survives restart', async () => {
    const owner = await member(), other = await member(); expect((await metadata(owner).expect(200)).body).toEqual({ assetId: null, revision: 0 });
    const saved = await upload(owner, 0).expect(200); expect(saved.body).toMatchObject({ revision: 1, appliedRevision: 1 });
    const image = await content(owner, 1).expect(200); expect(image.headers['content-type']).toMatch(/image\/png/); expect(image.headers['cache-control']).toBe('private, no-store');
    const decoded = await sharp(image.body).metadata(); expect(decoded).toMatchObject({ format: 'png', width: 256, height: 256 }); expect(decoded.exif).toBeUndefined();
    expect((await assets(owner))[0]).toMatchObject({ mimeType: 'image/png', fileName: 'avatar.png', state: 'ready' });
    await content(other, 1).expect(409); await request(app.getHttpServer()).get(`/api/files/${saved.body.assetId}/content`).set('Authorization', `Bearer ${other.token}`).expect(404);
    await app.close(); app = await startApp(); expect((await metadata(owner).expect(200)).body).toEqual({ assetId: saved.body.assetId, revision: 1 }); await content(owner, 1).expect(200);
  });

  it('requires JWT ownership, trusted origin, a stable key and an exact revision before mutation', async () => {
    const owner = await member(); await request(app.getHttpServer()).get('/api/authorize/avatar').expect(401);
    await upload(owner, 0).unset('Authorization').expect(401); await upload(owner, 0).set('Origin', 'https://foreign.invalid').expect(403);
    await upload(owner, 0).set('Sec-Fetch-Site', 'cross-site').expect(403); await upload(owner, 0).unset('Idempotency-Key').expect(400);
    await upload(owner, 0).unset('If-Match').expect(400); await upload(owner, 0).set('If-Match', '*').expect(400);
    await upload(owner, 0).field('userId', 'foreign').expect(400); await remove(owner, 0).set('Origin', 'https://foreign.invalid').expect(403);
    await request(app.getHttpServer()).options('/api/authorize/avatar').set('Origin', origin).set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'if-match,idempotency-key').expect(204).expect(response => expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain('if-match'));
    expect(await assets(owner)).toHaveLength(0);
  });

  it('rejects fake image bytes, oversized bodies and excessive decoded pixels before storage', async () => {
    const owner = await member();
    await upload(owner, 0, randomUUID(), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')).expect(400);
    await upload(owner, 0, randomUUID(), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])).expect(400);
    await upload(owner, 0, randomUUID(), Buffer.alloc(2 * 1024 * 1024 + 1)).expect(413);
    const excessive = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
    await upload(owner, 0, randomUUID(), excessive).expect(400); expect(await assets(owner)).toHaveLength(0);
  });

  it('recovers a lost response with the same request and rejects a changed image under that key', async () => {
    const owner = await member(), key = randomUUID(); const first = await upload(owner, 0, key).expect(200);
    const retry = await upload(owner, 0, key).expect(200); expect(retry.body).toEqual(first.body); expect(await assets(owner)).toHaveLength(1);
    await upload(owner, 0, key, blue).expect(409); expect((await metadata(owner).expect(200)).body).toMatchObject({ revision: 1, assetId: first.body.assetId });
    expect((await pool.query(`SELECT * FROM "${schema}".account_avatar_changes WHERE "userId"=$1`, [owner.id])).rows).toHaveLength(1);
  });

  it('never lets an older successful request replay overwrite a newer image', async () => {
    const owner = await member(), firstKey = randomUUID(); const first = await upload(owner, 0, firstKey).expect(200);
    const newer = await upload(owner, 1, randomUUID(), blue).expect(200); const replay = await upload(owner, 0, firstKey).expect(200);
    expect(replay.body).toEqual({ assetId: newer.body.assetId, revision: 2, appliedRevision: 1 });
    expect(replay.body.assetId).not.toBe(first.body.assetId); await content(owner, 1).expect(409);
    expect((await metadata(owner).expect(200)).body).toMatchObject({ assetId: newer.body.assetId, revision: 2 });
  });

  it('rejects an older slow upload when a newer concurrent image has already committed', async () => {
    const owner = await member(), entered = deferred(), release = deferred(), original = manager.upload.bind(manager);
    vi.spyOn(manager, 'upload').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    const old = upload(owner, 0).then(response => response); await entered.promise;
    let newer: Awaited<ReturnType<typeof upload>>;
    try { newer = await upload(owner, 0, randomUUID(), blue).expect(200); }
    finally { release.resolve(); }
    expect((await old).status).toBe(409);
    expect((await metadata(owner).expect(200)).body).toEqual({ assetId: newer!.body.assetId, revision: 1 });
  });

  it('rolls binding and revision back with a failed receipt, then recovers the existing file', async () => {
    const owner = await member(), key = randomUUID();
    await failReceipt(async () => { await upload(owner, 0, key).expect(503); });
    expect((await metadata(owner).expect(200)).body).toEqual({ assetId: null, revision: 0 }); expect(await assets(owner)).toHaveLength(1);
    await upload(owner, 0, key).expect(200); expect((await metadata(owner).expect(200)).body.revision).toBe(1); expect(await assets(owner)).toHaveLength(1);
  });

  it('does not claim a saved image after an object failure and retries the original request', async () => {
    const owner = await member(), key = randomUUID(), original = manager.upload.bind(manager);
    vi.spyOn(manager, 'upload').mockRejectedValueOnce(new Error('Synthetic object failure')).mockImplementation(original);
    await upload(owner, 0, key).expect(503); expect((await metadata(owner).expect(200)).body).toEqual({ assetId: null, revision: 0 });
    await upload(owner, 0, key).expect(200); expect(await assets(owner)).toHaveLength(1);
  });

  it('removes the binding idempotently while retaining owned files and newer avatar changes', async () => {
    const owner = await member(), first = await upload(owner, 0).expect(200), key = randomUUID();
    expect((await remove(owner, 1, key).expect(200)).body).toEqual({ assetId: null, revision: 2, appliedRevision: 2 });
    expect((await remove(owner, 1, key).expect(200)).body).toEqual({ assetId: null, revision: 2, appliedRevision: 2 });
    expect((await assets(owner))[0]).toMatchObject({ id: first.body.assetId, state: 'ready' });
    await content(owner, 2).expect(404); const next = await upload(owner, 2, randomUUID(), blue).expect(200);
    expect((await remove(owner, 1, key).expect(200)).body).toEqual({ assetId: next.body.assetId, revision: 3, appliedRevision: 2 });
    await expect(pool.query(`UPDATE "${schema}".account_avatar_changes SET "appliedRevision"=9 WHERE "userId"=$1`, [owner.id])).rejects.toThrow(/immutable/);
  });
});
