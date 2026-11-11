import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { FILE_MANAGER, LocalFileStorage, ZuckerStorageModule } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { FilesModule } from '../src/files/files.module';
import { FILES_OPTIONS, filesOptionsFromEnvironment, MAX_FILE_BYTES, storageOptionsFromEnvironment } from '../src/files/files.config';
import { PostgresFileAssetRepository } from '../src/files/file-asset.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_files_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202';
const content = Buffer.from('%PDF-1.7\nSynthetic private file fixture\n');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

run('private files over HTTP with PostgreSQL and isolated local objects', () => {
  let app: INestApplication, otherApp: INestApplication, pool: Pool, scopedUrl: string, directory: string;
  let manager: LocalFileStorage;
  let owner: { id: string; token: string }, other: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };

  async function startApp() {
    const database = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-private-files-test-secret-only', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'session-refresh': { points: 2000, duration: 60 }, 'session-refresh-network': { points: 2000, duration: 60 }, 'session-read': { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, FilesModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(FILE_MANAGER).useValue(manager)
      .overrideProvider(FILES_OPTIONS).useValue({ maxObjectBytes: 2048 }).compile();
    const instance = module.createNestApplication();
    instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init(); return instance;
  }
  async function member(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticFiles9!';
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200);
    return { id: login.body.userId as string, token: login.body.token as string };
  }
  const get = (path: string, token = owner.token) => request(app.getHttpServer()).get(`/api/files/${path}`).set('Authorization', `Bearer ${token}`);
  const recover = (id: string, token = owner.token) => request(app.getHttpServer()).post(`/api/files/${id}/recover`)
    .set('Authorization', `Bearer ${token}`).set('Origin', origin);
  const remove = (id: string, token = owner.token) => request(app.getHttpServer()).delete(`/api/files/${id}`)
    .set('Authorization', `Bearer ${token}`).set('Origin', origin);
  const upload = (key: string, body = content, token = owner.token, instance = app) => request(instance.getHttpServer()).post('/api/files')
    .set('Authorization', `Bearer ${token}`).set('Origin', origin).set('Idempotency-Key', key)
    .attach('file', body, { filename: 'report.pdf', contentType: 'image/png' });
  async function row(id: string) {
    return (await pool.query<{ id: string; ownerId: string; objectKey: string; state: string; cleanupStatus: string; revision: number }>(
      `SELECT * FROM "${schema}"."file_assets" WHERE "id"=$1`, [id])).rows[0];
  }
  async function failMetadata(event: 'INSERT' | 'UPDATE', condition: string, work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_file_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic file metadata failure'; END; $$`);
    try {
      await pool.query(`CREATE TRIGGER synthetic_file_failure BEFORE ${event} ON "${schema}"."file_assets" FOR EACH ROW ${condition} EXECUTE FUNCTION "${schema}".synthetic_file_failure()`);
      try { await work(); }
      finally { await pool.query(`DROP TRIGGER synthetic_file_failure ON "${schema}"."file_assets"`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_file_failure()`); }
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-private-file-objects-'));
    manager = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href;
    app = await startApp(); otherApp = await startApp();
    owner = await member('filesowner'); other = await member('filesother');
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    try { await Promise.all([app?.close(), otherApp?.close()]); }
    finally {
      try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    }
  });

  it('requires the actual account guard for every private entry', async () => {
    expect(app.get(FILE_MANAGER)).toBe(manager);
    for (const path of ['missing', 'missing/content', `requests/${randomUUID()}`])
      await request(app.getHttpServer()).get(`/api/files/${path}`).expect(401);
    await request(app.getHttpServer()).post('/api/files').set('Origin', origin).set('Idempotency-Key', randomUUID()).attach('file', content, 'test.pdf').expect(401);
    await request(app.getHttpServer()).post('/api/files/missing/recover').set('Origin', origin).expect(401);
    await request(app.getHttpServer()).delete('/api/files/missing').set('Origin', origin).expect(401);
  });

  it('stores a private asset and returns only an owner-authorized attachment with detected MIME', async () => {
    const key = randomUUID(), created = await upload(key);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ fileName: 'report.pdf', size: content.length, mimeType: 'application/pdf', state: 'ready' });
    expect(JSON.stringify(created.body)).not.toMatch(/objectKey|ownerId|scope|sha256|idempotencyKey|https?:/);
    const metadata = await get(created.body.id).expect(200);
    expect(metadata.body.id).toBe(created.body.id);
    expect((await get(`requests/${key}`).expect(200)).body.id).toBe(created.body.id);
    const downloaded = await get(`${created.body.id}/content`).expect(200);
    expect(downloaded.body).toEqual(content);
    expect(downloaded.headers['content-type']).toBe('application/pdf');
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/);
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    const stored = await row(created.body.id);
    expect(stored.ownerId).toBe(owner.id);
    expect(existsSync(join(directory, stored.objectKey))).toBe(true);
    await request(app.getHttpServer()).get(`/uploads/${stored.objectKey}`).expect(404);
  });

  it('downloads filenames containing RFC5987 punctuation with a standards-parsable attachment header', async () => {
    const name = "O'Brien(1)*.pdf";
    const created = await request(app.getHttpServer()).post('/api/files').set('Authorization', `Bearer ${owner.token}`)
      .set('Origin', origin).set('Idempotency-Key', randomUUID()).attach('file', content, { filename: name, contentType: 'application/pdf' }).expect(200);
    const downloaded = await get(`${created.body.id}/content`).expect(200);
    const consumerRequire = createRequire(resolve('package.json'));
    const platformRequire = createRequire(consumerRequire.resolve('@nestjs/platform-express'));
    const expressRequire = createRequire(platformRequire.resolve('express'));
    const disposition = expressRequire('content-disposition') as { parse(value: string): { type: string; parameters: { filename: string } } };
    expect(disposition.parse(downloaded.headers['content-disposition'])).toMatchObject({ type: 'attachment', parameters: { filename: name } });
    expect(downloaded.body).toEqual(content);
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reserves one identity across concurrent HTTP applications and rejects changed content', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([upload(key), upload(key, content, owner.token, otherApp)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.id).toBe(b.body.id);
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."file_assets" WHERE "ownerId"=$1 AND "idempotencyKey"=$2`, [owner.id, key])).rows[0].count).toBe(1);
    await upload(key, Buffer.from('%PDF-1.7\nChanged content')).expect(409);
    const ownOther = await upload(key, content, other.token).expect(200);
    expect(ownOther.body.id).not.toBe(a.body.id);
  });

  it('does not expose or mutate another owner’s metadata or bytes', async () => {
    const key = randomUUID(), created = await upload(key).expect(200), id = created.body.id;
    for (const path of [id, `${id}/content`, `requests/${key}`]) await get(path, other.token).expect(404);
    await remove(id, other.token).expect(404); await recover(id, other.token).expect(404);
    expect((await row(id)).state).toBe('ready');
    await get(`${id}/content`).expect(200);
  });

  it('rejects untrusted mutation origins, missing keys, extra owner fields and configured oversize uploads', async () => {
    const count = (await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."file_assets"`)).rows[0].count;
    await upload(randomUUID()).set('Origin', 'https://foreign.invalid').expect(403);
    await upload(randomUUID()).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await upload(randomUUID()).unset('Idempotency-Key').expect(400);
    await upload(randomUUID(), Buffer.alloc(2049)).expect(413);
    await upload(randomUUID()).field('ownerId', other.id).expect(400);
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."file_assets"`)).rows[0].count).toBe(count);
  });

  it('never writes an object when the durable metadata reservation fails', async () => {
    const key = randomUUID(), write = vi.spyOn(manager, 'upload');
    try {
      await failMetadata('INSERT', '', async () => {
        await upload(key).expect(503);
        expect(write).not.toHaveBeenCalled();
        await get(`requests/${key}`).expect(404);
      });
    } finally { write.mockRestore(); }
  });

  it('recovers a metadata commit failure from a fresh Node process, then serves it after application restart', async () => {
    const key = randomUUID(), write = vi.spyOn(manager, 'upload');
    let id: string;
    try {
      await failMetadata('UPDATE', `WHEN (NEW."state" = 'ready')`, async () => {
        await upload(key).expect(503);
        const pending = await get(`requests/${key}`).expect(200);
        id = pending.body.id;
        expect(pending.body.state).toBe('pending');
        await get(`${id}/content`).expect(409);
      });
      await app.close();
      const workerDirectory = mkdtempSync(join(tmpdir(), 'zucker-file-recovery-'));
      const script = join(workerDirectory, 'worker.cjs');
      writeFileSync(script, String.raw`
const {createRequire}=require('node:module'); const {resolve}=require('node:path');
const load=createRequire(resolve('package.json')); load('tsx/cjs'); load('reflect-metadata');
const {ApplicationDatabase}=load('./src/database.ts'); const {FilesService}=load('./src/files/files.service.ts');
const {LocalFileStorage}=load('@zucker-framework/storage');
(async()=>{let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);
const db=new ApplicationDatabase(process.env.TEST_DATABASE_URL);
try{const files=new FilesService(db,new LocalFileStorage({basePath:input.directory}),{maxObjectBytes:2048});
const asset=await files.recover(input.ownerId,input.id);process.stdout.write('EVIDENCE:'+JSON.stringify({state:asset.state,pid:process.pid}));}
finally{await db.disconnect();}})().catch(()=>{process.stderr.write('Synthetic file recovery worker failed');process.exitCode=1;});
`);
      try {
        const result = await new Promise<{ state: string; pid: number }>((done, reject) => {
          const child = spawn(process.execPath, [script], { cwd: process.cwd(), env: { ...process.env, TEST_DATABASE_URL: scopedUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
          let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
          const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
          child.on('error', error => { clearTimeout(timer); reject(error); });
          child.on('exit', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error('Synthetic recovery process failed'));
            try { done(JSON.parse(output.slice(output.lastIndexOf('EVIDENCE:') + 9))); } catch { reject(new Error('Invalid recovery evidence')); }
          });
          child.stdin.end(JSON.stringify({ ownerId: owner.id, id: id!, directory }));
        });
        expect(result.state).toBe('ready'); expect(result.pid).not.toBe(process.pid);
      } finally { rmSync(workerDirectory, { recursive: true, force: true }); }
      app = await startApp();
      expect((await get(`${id!}/content`).expect(200)).body).toEqual(content);
      expect(write).toHaveBeenCalledTimes(1);
    } finally { write.mockRestore(); }
  });

  it('keeps uncertain object completion pending and never leaks provider diagnostics', async () => {
    const original = manager.upload.bind(manager), key = randomUUID();
    const write = vi.spyOn(manager, 'upload').mockImplementationOnce(async (...args) => {
      await original(...args); throw new Error('SYNTHETIC_PRIVATE_STORAGE_CREDENTIAL');
    });
    try {
      const failed = await upload(key).expect(503);
      expect(JSON.stringify(failed.body)).not.toContain('SYNTHETIC_PRIVATE_STORAGE_CREDENTIAL');
      const pending = await get(`requests/${key}`).expect(200);
      expect(pending.body.state).toBe('pending');
      expect((await recover(pending.body.id).expect(200)).body.state).toBe('ready');
      expect(write).toHaveBeenCalledTimes(1);
    } finally { write.mockRestore(); }
  });

  it('denies deleted bytes while a failed physical cleanup stays recoverable', async () => {
    const created = await upload(randomUUID()).expect(200), id = created.body.id;
    const deletion = vi.spyOn(manager, 'delete').mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_STORAGE_CREDENTIAL'));
    try {
      const failed = await remove(id).expect(503);
      expect(JSON.stringify(failed.body)).not.toContain('SYNTHETIC_PRIVATE_STORAGE_CREDENTIAL');
      expect((await get(id).expect(200)).body).toMatchObject({ state: 'deleted', cleanupStatus: 'pending', cleanupConfirmedAt: null });
      await get(`${id}/content`).expect(410);
      expect((await recover(id).expect(200)).body).toMatchObject({ state: 'deleted', cleanupStatus: 'confirmed' });
      const stored = await row(id);
      expect(existsSync(join(directory, stored.objectKey))).toBe(false);
      // Model a remote request outliving an earlier absence check; logical deletion remains authoritative.
      await manager.upload(content, stored.objectKey, { acl: 'private' });
      await get(`${id}/content`).expect(410);
      await recover(id).expect(200);
      expect(existsSync(join(directory, stored.objectKey))).toBe(false);
    } finally { deletion.mockRestore(); }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not confirm physical cleanup when the real object directory denies access', async () => {
      const created = await upload(randomUUID()).expect(200), id = created.body.id;
      const stored = await row(id), objectPath = join(directory, stored.objectKey), parent = dirname(objectPath);
      chmodSync(parent, 0o000);
      try {
        await remove(id).expect(503);
        expect((await get(id).expect(200)).body).toMatchObject({ state: 'deleted', cleanupStatus: 'pending', cleanupConfirmedAt: null });
        await get(`${id}/content`).expect(410);
      } finally { chmodSync(parent, 0o700); }
      expect(existsSync(objectPath)).toBe(true);
      expect((await recover(id).expect(200)).body.cleanupStatus).toBe('confirmed');
      expect(existsSync(objectPath)).toBe(false);
    });

  it('does not resurrect a deleted asset when an in-flight upload completes late', async () => {
    const original = manager.upload.bind(manager), started = deferred(), finish = deferred(), key = randomUUID();
    const write = vi.spyOn(manager, 'upload').mockImplementationOnce(async (...args) => {
      started.resolve(); await finish.promise; return original(...args);
    });
    const pending = upload(key).then(response => response);
    try {
      await Promise.race([started.promise, pending.then(response => { throw new Error(`Upload ended before object IO: ${response.status}`); })]);
      const metadata = await get(`requests/${key}`).expect(200), id = metadata.body.id;
      expect((await remove(id).expect(200)).body.state).toBe('deleted');
      finish.resolve();
      expect((await pending).status).toBe(410);
      expect((await get(id).expect(200)).body).toMatchObject({ state: 'deleted', cleanupStatus: 'confirmed' });
      expect(existsSync(join(directory, (await row(id)).objectKey))).toBe(false);
    } finally { finish.resolve(); await pending; write.mockRestore(); }
  });

  it('enforces immutable ownership/content and terminal deletion in PostgreSQL', async () => {
    const created = await upload(randomUUID()).expect(200), id = created.body.id;
    await expect(pool.query(`UPDATE "${schema}"."file_assets" SET "ownerId"=$1,"revision"="revision"+1 WHERE "id"=$2`, [other.id, id])).rejects.toThrow('immutable');
    const repository = new PostgresFileAssetRepository(app.get<ApplicationDatabase>(DATABASE_ADAPTER));
    expect(await repository.get(other.id, id)).toBeNull();
    await remove(id).expect(200);
    await expect(pool.query(`UPDATE "${schema}"."file_assets" SET "state"='ready',"deletedAt"=NULL,"cleanupStatus"=NULL,"cleanupConfirmedAt"=NULL,"revision"="revision"+1 WHERE "id"=$1`, [id])).rejects.toThrow('cannot be restored');
  });

  it('rejects corrupt stored bytes and never trusts a ready metadata row as content proof', async () => {
    const created = await upload(randomUUID()).expect(200), stored = await row(created.body.id);
    const corrupted = Buffer.from(content); corrupted[corrupted.length - 1] ^= 1;
    writeFileSync(join(directory, stored.objectKey), corrupted);
    await get(`${created.body.id}/content`).expect(409);
  });

  it('keeps local storage development-only and configures S3 without public or generated download URLs', () => {
    expect(storageOptionsFromEnvironment({ NODE_ENV: 'development' })).toEqual({ provider: 'local', basePath: './uploads' });
    expect(() => storageOptionsFromEnvironment({ NODE_ENV: 'production' })).toThrow('explicit S3');
    expect(() => filesOptionsFromEnvironment({ FILES_MAX_BYTES: String(MAX_FILE_BYTES + 1) })).toThrow();
    const options = storageOptionsFromEnvironment({ NODE_ENV: 'production', FILES_STORAGE_PROVIDER: 's3',
      FILES_S3_BUCKET: 'synthetic-private-bucket', FILES_S3_ACCESS_KEY_ID: 'synthetic', FILES_S3_SECRET_ACCESS_KEY: 'synthetic', FILES_S3_ENDPOINT: 'https://synthetic.invalid' });
    expect(options).toMatchObject({ provider: 's3', objectAclMode: 'none', uploadUrlMode: 'public-only' });
    expect(options).not.toHaveProperty('publicUrl');
  });
});
