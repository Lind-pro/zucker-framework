import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import sharp from 'sharp';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ACCESS_LOG_EVENT, ACCESS_LOG_BEFORE_EVENT, ACCESS_LOGGER_KEY, OPERATION_LOG_EVENT, ZuckerLoggingModule } from '@zucker-framework/logging';
import { FILE_MANAGER, LocalFileStorage, ZuckerStorageModule } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase, ApplicationTransaction } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../src/accounts/account.service';
import { AccountAvatarModule } from '../src/accounts/avatar/avatar.module';
import { FilesModule } from '../src/files/files.module';
import { FilesService } from '../src/files/files.service';
import { FilesController } from '../src/files/files.controller';
import { FilesDownloadController } from '../src/files/files-download.controller';
import { FILE_DOWNLOAD_AUDIENCE, FILE_DOWNLOAD_PURPOSE } from '../src/files/files-download.service';
import { FILES_OPTIONS } from '../src/files/files.config';
import { FILES_IMPORT_FETCH, FILES_TRANSFER_OPTIONS, filesTransferOptionsFromEnvironment, type FilesTransferOptions } from '../src/files/files-transfer.config';
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_files_extra_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const content = Buffer.from('%PDF-1.7\nSYNTHETIC_PRIVATE_FILE_BODY_SHOULD_NOT_BE_LOGGED\n');
interface Member { id: string; token: string }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
run('private file listing, short downloads, constrained import and avatar protection', () => {
  let app: INestApplication, database: ApplicationDatabase, pool: Pool, directory: string, manager: LocalFileStorage, jwt: JwtService, image: Buffer;
  const options: FilesTransferOptions = { downloadTtlSeconds: 60, importAllowedHosts: ['files.example.invalid'], importTimeoutMs: 300 };
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(), tickets = new Map<string, string>(), logs: unknown[] = [];
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  async function member(): Promise<Member> {
    const username = `extra${randomUUID().replaceAll('-', '')}`, email = `${username}@example.invalid`, password = 'SyntheticFiles9!';
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201); await post('verify-email', { ticket: tickets.get(email) }).expect(200);
    const logged = await post('login', { username, password }).expect(200); return { id: logged.body.userId, token: logged.body.token };
  }
  const get = (path: string, owner: Member) => request(app.getHttpServer()).get(`/api/files${path}`).set('Authorization', `Bearer ${owner.token}`);
  const post = (path: string, owner: Member, body: object = {}) => request(app.getHttpServer()).post(`/api/files${path}`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).send(body);
  const upload = (owner: Member, key = randomUUID()) => request(app.getHttpServer()).post('/api/files').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', key).attach('file', content, { filename: 'report.pdf', contentType: 'application/pdf' });
  const remove = (id: string, owner: Member) => request(app.getHttpServer()).delete(`/api/files/${id}`).set('Authorization', `Bearer ${owner.token}`).set('Origin', origin);
  const importUrl = (owner: Member, url = 'https://files.example.invalid/signed.pdf?signature=SYNTHETIC_SOURCE_PRIVATE_SIGNATURE', key = randomUUID()) => post('/import', owner, { url, fileName: 'import.pdf' }).set('Idempotency-Key', key);
  const ticket = async (owner: Member, id: string) => (await post(`/${id}/download-url`, owner).expect(200)).body as { url: string; expiresAt: string; expiresInSeconds: number };
  const redeem = (url: string) => request(app.getHttpServer()).get(url);
  async function stored(id: string) { return (await pool.query(`SELECT * FROM "${schema}".file_assets WHERE id=$1`, [id])).rows[0]; }
  async function sign(owner: Member, id: string, changes: Record<string, unknown> = {}, audience = FILE_DOWNLOAD_AUDIENCE) {
    const iat = Math.floor(Date.now() / 1000), asset = await stored(id), user = await database.model('users').findUnique({ where: { id: owner.id } }) as { credentialVersion: number };
    const claims = { sub: owner.id, sid: jwt.decode<{ sid: string }>(owner.token).sid, purpose: FILE_DOWNLOAD_PURPOSE, assetId: id,
      assetRevision: asset.revision, credentialVersion: user.credentialVersion, iat, exp: iat + 60, ...changes };
    const { exp, ...payload } = claims; return jwt.signAsync(payload, { algorithm: 'HS256', audience, expiresIn: Number(exp) - Number(payload.iat) });
  }
  async function failReady(work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".reject_import_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='ready' THEN RAISE EXCEPTION 'Synthetic ready commit failure'; END IF; RETURN NEW; END $$`);
    try { await pool.query(`CREATE TRIGGER reject_import_ready BEFORE UPDATE ON "${schema}".file_assets FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_import_ready()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER reject_import_ready ON "${schema}".file_assets`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".reject_import_ready()`); }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Designated development/test database required');
    directory = mkdtempSync(join(tmpdir(), 'zucker-files-extra-')); manager = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    // A controller opting into body/result logging cannot override the root's global privacy policy.
    for (const controller of [FilesController, FilesDownloadController]) Reflect.defineMetadata(ACCESS_LOGGER_KEY, { describe: 'Synthetic file verification', module: 'files-extra-test', logParameters: true, logResult: true }, controller);
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-extra-files-long-test-secret', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 4000, duration: 60 }, 'session-refresh': { points: 4000, duration: 60 }, 'session-refresh-network': { points: 4000, duration: 60 }, 'session-read': { points: 4000, duration: 60 }, 'api-default': { points: 4000, duration: 60 } } }),
      ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {}, captureParameters: false, captureResults: false }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, FilesModule, AccountAvatarModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(FILE_MANAGER).useValue(manager).overrideProvider(FILES_OPTIONS).useValue({ maxObjectBytes: 2048 })
      .overrideProvider(FILES_TRANSFER_OPTIONS).useValue(options).overrideProvider(FILES_IMPORT_FETCH).useValue(fetch).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1'); jwt = app.get(JwtService);
    for (const event of [ACCESS_LOG_EVENT, ACCESS_LOG_BEFORE_EVENT, OPERATION_LOG_EVENT]) app.get(EventEmitter2).on(event, payload => logs.push(payload));
    image = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  });
  beforeEach(() => { fetch.mockReset(); fetch.mockImplementation(async () => new Response(new Uint8Array(content), { status: 200, headers: { 'content-length': String(content.length) } })); logs.length = 0; });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { for (const controller of [FilesController, FilesDownloadController]) Reflect.deleteMetadata(ACCESS_LOGGER_KEY, controller);
    try { await app?.close(); await database?.onModuleDestroy(); } finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } finally { if (directory) rmSync(directory, { recursive: true, force: true }); } } });
  it('lists only owned metadata with stable pagination, safe limits and no internal storage identifiers', async () => {
    const owner = await member(), other = await member(), first = await upload(owner).expect(200); await upload(other).expect(200);
    for (let index = 0; index < 20; index++) await pool.query(`INSERT INTO "${schema}".file_assets (id,"ownerId","idempotencyKey","objectKey","fileName",sha256,size,"mimeType")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), owner.id, randomUUID(), `private-assets/${randomUUID()}`, `synthetic-${index}.pdf`, 'a'.repeat(64), content.length, 'application/pdf']);
    await request(app.getHttpServer()).get('/api/files').expect(401);
    const page1 = await get('?page=1', owner).expect(200), page2 = await get('?page=2', owner).expect(200);
    expect(page1.body).toMatchObject({ total: 21, page: 1, pageSize: 20, limits: { maxFileBytes: 2048, urlImportEnabled: true } }); expect(page1.body.data).toHaveLength(20); expect(page2.body.data).toHaveLength(1);
    expect(new Set([...page1.body.data, ...page2.body.data].map(row => row.id)).size).toBe(21);
    expect(JSON.stringify(page1.body)).not.toMatch(/objectKey|sha256|idempotencyKey|ownerId|allowedHosts|token|sourceUrl/);
    expect((await get('', other).expect(200)).body.total).toBe(1); expect(first.body.id).toBeTruthy();
    await get('?page=0', owner).expect(400); await get(`?ownerId=${other.id}`, owner).expect(400);
  });
  it('issues a short owner/session-authorized ticket and serves a verified attachment without accepting it as a login token', async () => {
    const owner = await member(), other = await member(), asset = await upload(owner).expect(200), id = asset.body.id;
    await post(`/${id}/download-url`, owner).set('Origin', 'https://foreign.invalid').expect(403);
    await post(`/${id}/download-url`, owner, { ownerId: other.id }).expect(400); await post(`/${id}/download-url`, other).expect(404);
    const issued = await ticket(owner, id); expect(issued.expiresInSeconds).toBe(60); expect(issued.url).toMatch(new RegExp(`^/api/files/${id}/download\\?token=`));
    const downloaded = await redeem(issued.url).expect(200); expect(downloaded.body).toEqual(content);
    expect(downloaded.headers).toMatchObject({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/);
    const token = new URL(issued.url, origin).searchParams.get('token')!;
    await request(app.getHttpServer()).get('/api/files').set('Authorization', `Bearer ${token}`).expect(401);
    await redeem(`/api/files/${id}/download?token=${owner.token}`).expect(401);
  });
  it('redeems a public body ticket without putting it in the URL and rejects mixed or extra input sources', async () => {
    const owner = await member(), asset = await upload(owner).expect(200), issued = await ticket(owner, asset.body.id), url = new URL(issued.url, origin), token = url.searchParams.get('token')!;
    const downloaded = await request(app.getHttpServer()).post(url.pathname).send({ token }).expect(200);
    expect(downloaded.body).toEqual(content); expect(downloaded.headers).toMatchObject({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    await request(app.getHttpServer()).post(issued.url).send({ token }).expect(400);
    await request(app.getHttpServer()).post(url.pathname).send({ token, ownerId: owner.id }).expect(400);
    await request(app.getHttpServer()).post(url.pathname).send({}).expect(400);
    await request(app.getHttpServer()).get(issued.url).send({ token }).expect(400);
    await request(app.getHttpServer()).post(url.pathname).send({ token: 'SYNTHETIC_INVALID_BODY_TICKET' }).expect(401);
    await redeem(issued.url).expect(200);
  });
  it('rejects expired, tampered, cross-asset, wrong-purpose, wrong-audience and excessive-lifetime tickets', async () => {
    const owner = await member(), a = await upload(owner).expect(200), b = await upload(owner).expect(200), now = Math.floor(Date.now() / 1000);
    const good = await sign(owner, a.body.id);
    for (const token of [good.slice(0, -4) + 'AAAA', await sign(owner, a.body.id, { iat: now - 61, exp: now - 1 }),
      await sign(owner, a.body.id, { purpose: 'access' }), await sign(owner, a.body.id, {}, 'zucker:access'), await sign(owner, a.body.id, { exp: now + 301 })])
      await redeem(`/api/files/${a.body.id}/download?token=${token}`).expect(401);
    await redeem(`/api/files/${b.body.id}/download?token=${good}`).expect(401);
  });
  for (const change of ['disabled', 'credentials', 'session'] as const) it(`revokes issued download access after ${change} changes`, async () => {
    const owner = await member(), asset = await upload(owner).expect(200), issued = await ticket(owner, asset.body.id);
    if (change === 'disabled') await database.model('users').update({ where: { id: owner.id }, data: { status: false } });
    if (change === 'credentials') await database.model('users').update({ where: { id: owner.id }, data: { credentialVersion: { increment: 1 } } });
    if (change === 'session') await app.get(AccountService).sessions.revokeSession(jwt.decode<{ sid: string }>(owner.token).sid, 'synthetic-revocation');
    await redeem(issued.url).expect(401);
  });
  it('rejects changed revisions, deleted assets and corrupt bytes before releasing a ticket download', async () => {
    const owner = await member(), asset = await upload(owner).expect(200), id = asset.body.id;
    const stale = await ticket(owner, id); await post(`/${id}/recover`, owner).expect(200); expect((await redeem(stale.url).expect(409)).body.code).toBe('FILE_DOWNLOAD_STALE');
    const corrupted = await ticket(owner, id), row = await stored(id), bytes = Buffer.from(content); bytes[bytes.length - 1] ^= 1; writeFileSync(join(directory, row.objectKey), bytes);
    await redeem(corrupted.url).expect(409); writeFileSync(join(directory, row.objectKey), content);
    const deleted = await ticket(owner, id); await remove(id, owner).expect(200); await redeem(deleted.url).expect(410);
  });
  it('keeps successful and rejected tickets, signed source URLs and file bodies out of persistent logs and event payloads', async () => {
    const owner = await member(), asset = await upload(owner).expect(200), issued = await ticket(owner, asset.body.id), token = new URL(issued.url, origin).searchParams.get('token')!;
    await redeem(issued.url).expect(200); const rejected = 'SYNTHETIC_PRIVATE_OPAQUE_DOWNLOAD_TICKET';
    const bodyPath = new URL(issued.url, origin).pathname;
    await request(app.getHttpServer()).post(bodyPath).send({ token }).expect(200);
    await request(app.getHttpServer()).post(bodyPath).send({ token: rejected }).expect(401);
    await request(app.getHttpServer()).post(issued.url).send({ token }).expect(400);
    const refused = await redeem(`/api/files/${asset.body.id}/download?t%6Fken=${rejected}`).expect(401);
    expect(refused.headers).toMatchObject({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    await importUrl(owner).expect(200);
    await expect.poll(async () => database.model('accessLogs').count({ where: { requestUrl: { contains: `/files/${asset.body.id}/download` } } }), { timeout: 3000 }).toBeGreaterThan(0);
    const records = JSON.stringify([await database.model('accessLogs').findMany(), await database.model('operationLogs').findMany(), logs]);
    for (const value of [token, rejected, 'SYNTHETIC_SOURCE_PRIVATE_SIGNATURE', content.toString('utf8')]) expect(records).not.toContain(value);
    expect(logs.length).toBeGreaterThan(0);
  });
  it('defaults URL import off and rejects non-HTTPS, IP, localhost, credentials, foreign hosts and redirects without source persistence', async () => {
    expect(filesTransferOptionsFromEnvironment({})).toMatchObject({ importAllowedHosts: [], downloadTtlSeconds: 60, importTimeoutMs: 15000 });
    for (const value of ['0', '301']) expect(() => filesTransferOptionsFromEnvironment({ FILES_DOWNLOAD_TTL_SECONDS: value })).toThrow();
    for (const host of ['*', '*.example.invalid', 'localhost', '127.0.0.1', '[::1]', 'https://files.example.invalid']) expect(() => filesTransferOptionsFromEnvironment({ FILES_IMPORT_ALLOWED_HOSTS: host })).toThrow();
    const owner = await member(); const prior = options.importAllowedHosts; options.importAllowedHosts = [];
    try { expect((await importUrl(owner).expect(403)).body.code).toBe('FILE_IMPORT_DISABLED'); expect((await get('', owner).expect(200)).body.limits.urlImportEnabled).toBe(false); } finally { options.importAllowedHosts = prior; }
    for (const url of ['http://files.example.invalid/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://files.example.invalid.evil.invalid/x', 'https://user:pass@files.example.invalid/x', 'https://files.example.invalid:444/x'])
      expect((await importUrl(owner, url).expect(403)).body.code).toBe('FILE_IMPORT_SOURCE_FORBIDDEN');
    expect(fetch).not.toHaveBeenCalled(); fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://foreign.invalid/private' } }));
    expect((await importUrl(owner).expect(400)).body.code).toBe('FILE_IMPORT_REDIRECT_BLOCKED'); expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(await database.model('fileAssets').count({ where: { ownerId: owner.id } })).toBe(0);
  });
  it('bounds reported and actual bytes, timeout and provider failures without leaking source diagnostics', async () => {
    const owner = await member();
    fetch.mockResolvedValueOnce(new Response('short', { headers: { 'content-length': '2049' } })); expect((await importUrl(owner).expect(413)).body.code).toBe('FILE_IMPORT_TOO_LARGE');
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(2049), { headers: { 'content-length': '1' } })); await importUrl(owner).expect(413);
    fetch.mockImplementationOnce(async () => new Promise<Response>(() => {})); expect((await importUrl(owner).expect(503)).body.code).toBe('FILE_IMPORT_FAILED');
    fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }))); await importUrl(owner).expect(503);
    fetch.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_SOURCE_CREDENTIAL')); const failed = await importUrl(owner).expect(503); expect(JSON.stringify(failed.body)).not.toContain('SYNTHETIC_PRIVATE');
    expect(await database.model('fileAssets').count({ where: { ownerId: owner.id } })).toBe(0);
  });
  it('reuses a stable import identity, rejects changed source bytes and recovers an object written before metadata failed', async () => {
    const owner = await member(), key = randomUUID(), write = vi.spyOn(manager, 'upload'); let id = '';
    await failReady(async () => { await importUrl(owner, undefined, key).expect(503); const pending = await get(`/requests/${key}`, owner).expect(200); id = pending.body.id; expect(pending.body.state).toBe('pending'); });
    await post(`/${id}/recover`, owner).expect(200); expect(fetch).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    expect((await importUrl(owner, undefined, key).expect(200)).body.id).toBe(id); expect(write).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(new Response(new TextEncoder().encode('%PDF-1.7\nChanged source'))); await importUrl(owner, undefined, key).expect(409);
    expect((await get(`/${id}/content`, owner).expect(200)).body).toEqual(content);
    const row = await stored(id); expect(JSON.stringify(row)).not.toMatch(/signature|https:|sourceUrl/);
  });
  it('prevents generic deletion after avatar binding and permits deletion only after explicit removal', async () => {
    const owner = await member();
    const avatar = await request(app.getHttpServer()).post('/api/authorize/avatar').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', randomUUID()).set('If-Match', '"0"').attach('file', image, 'avatar.png').expect(200);
    expect((await remove(avatar.body.assetId, owner).expect(409)).body.code).toBe('ASSET_IN_USE'); expect((await stored(avatar.body.assetId)).state).toBe('ready');
    await request(app.getHttpServer()).delete('/api/authorize/avatar').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', randomUUID()).set('If-Match', '"1"').expect(200);
    await remove(avatar.body.assetId, owner).expect(200);
  });
  it('serializes avatar binding before concurrent generic deletion under the same owner-row lock', async () => {
    const owner = await member(), locked = deferred(), release = deferred(), original = ApplicationTransaction.prototype.query; let paused = false;
    vi.spyOn(ApplicationTransaction.prototype, 'query').mockImplementation(async function(this: ApplicationTransaction, sql, values) {
      const result = await original.call(this, sql, values);
      if (!paused && sql.includes('FROM users WHERE id=$1 FOR UPDATE') && values?.[0] === owner.id) { paused = true; locked.resolve(); await release.promise; }
      return result;
    });
    const pending = request(app.getHttpServer()).post('/api/authorize/avatar').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', randomUUID()).set('If-Match', '"0"').attach('file', image, 'avatar.png').then(row => row);
    try {
      await locked.promise; const rows = await database.model('fileAssets').findMany({ where: { ownerId: owner.id } }) as Array<{ id: string }>;
      const deleting = remove(rows[0].id, owner).then(row => row); release.resolve(); expect((await pending).status).toBe(200); expect((await deleting).status).toBe(409);
      expect((await stored(rows[0].id)).state).toBe('ready');
    } finally { release.resolve(); await pending; }
  });
  it('rejects avatar binding when a concurrent generic deletion already committed the tombstone', async () => {
    const owner = await member(), uploaded = deferred<string>(), release = deferred(), files = app.get(FilesService), original = files.upload.bind(files);
    vi.spyOn(files, 'upload').mockImplementationOnce(async (...args) => { const asset = await original(...args); uploaded.resolve(asset.id); await release.promise; return asset; });
    const pending = request(app.getHttpServer()).post('/api/authorize/avatar').set('Authorization', `Bearer ${owner.token}`).set('Origin', origin).set('Idempotency-Key', randomUUID()).set('If-Match', '"0"').attach('file', image, 'avatar.png').then(row => row);
    try { const id = await uploaded.promise; await remove(id, owner).expect(200); release.resolve(); expect((await pending).status).toBe(409); expect((await stored(id)).state).toBe('deleted'); }
    finally { release.resolve(); await pending; }
  });
});
