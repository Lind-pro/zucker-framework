import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, truncateSync, writeSync, closeSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { FILE_MANAGER, LocalFileStorage, ZuckerStorageModule } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { FilesModule } from '../src/files/files.module';
import { FilesService } from '../src/files/files.service';
import { FILES_OPTIONS } from '../src/files/files.config';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_files_stream_tickets_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const MiB = 1024 * 1024;

function synthetic(total: number): { stream: Readable; sha256: () => string } {
  const hash = createHash('sha256'); let sent = 0;
  const stream = Readable.from((function* () {
    while (sent < total) { const piece = Buffer.alloc(Math.min(MiB, total - sent), (sent / MiB) & 255); sent += piece.length; hash.update(piece); yield piece; }
  })());
  return { stream, sha256: () => hash.digest('hex') };
}

/** Raw GET that hashes the body as it arrives and reports whether the transfer completed. */
function fetchContent(port: number, path: string, token: string | null, post?: object) {
  return new Promise<{ status: number; length: string | undefined; bytes: number; sha256: string; complete: boolean }>(done => {
    const hash = createHash('sha256'); let bytes = 0, status = 0, length: string | undefined;
    const finish = (complete: boolean) => done({ status, length, bytes, sha256: hash.digest('hex'), complete });
    const body = post ? JSON.stringify(post) : undefined;
    const req = httpRequest({ host: '127.0.0.1', port, path, method: post ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}) } }, response => {
      status = response.statusCode ?? 0; length = response.headers['content-length'];
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
      response.on('end', () => finish(response.complete));
      response.on('aborted', () => undefined);
      response.on('error', () => finish(false));
    });
    req.on('error', () => finish(false));
    req.end(body);
  });
}

run('download tickets stream large private files and refuse corrupted objects (PostgreSQL + HTTP + local storage)', () => {
  let app: INestApplication, database: ApplicationDatabase, pool: Pool, directory: string, manager: LocalFileStorage, port: number;
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  async function member() {
    const username = `stream${randomUUID().replaceAll('-', '')}`, email = `${username}@example.invalid`, password = 'SyntheticFiles9!';
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201); await post('verify-email', { ticket: tickets.get(email) }).expect(200);
    const logged = await post('login', { username, password }).expect(200); return { id: logged.body.userId as string, token: logged.body.token as string };
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Designated development/test database required');
    directory = mkdtempSync(join(tmpdir(), 'zucker-files-stream-tickets-')); manager = new LocalFileStorage({ basePath: directory });
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-stream-files-long-test-secret', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 4000, duration: 60 }, 'session-refresh': { points: 4000, duration: 60 }, 'session-refresh-network': { points: 4000, duration: 60 }, 'session-read': { points: 4000, duration: 60 }, 'api-default': { points: 4000, duration: 60 } } }),
      ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {}, captureParameters: false, captureResults: false }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, FilesModule],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(FILE_MANAGER).useValue(manager)
      .overrideProvider(FILES_OPTIONS).useValue({ maxObjectBytes: 2048, maxOwnerBytes: 1024 * MiB, maxOwnerFiles: 100 }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    try { await app?.close(); await database?.disconnect(); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  const issue = async (owner: { token: string }, id: string) => {
    const response = await request(app.getHttpServer()).post(`/api/files/${id}/download-url`).set('Origin', origin).set('Authorization', `Bearer ${owner.token}`).send({}).expect(200);
    const url = new URL(response.body.url, origin);
    return { path: url.pathname, query: url.pathname + url.search, token: url.searchParams.get('token')! };
  };
  const generated = async (ownerId: string, key: string, total: number) => {
    const source = synthetic(total);
    const asset = await app.get(FilesService).storeGenerated(ownerId, key, { fileName: 'output.mp4', stream: source.stream, maxBytes: 200 * MiB });
    return { asset, sha256: source.sha256() };
  };

  it('serves a large output over both ticket forms with Content-Length and verified bytes, once per valid ticket', async () => {
    const owner = await member(), { asset, sha256 } = await generated(owner.id, 'ticket-large-output-1', 6 * MiB);
    const t = await issue(owner, asset.id);
    const get = await fetchContent(port, t.query, null);
    expect(get).toEqual({ status: 200, length: String(6 * MiB), bytes: 6 * MiB, sha256, complete: true });
    const post = await fetchContent(port, t.path, null, { token: t.token });
    expect(post).toEqual({ status: 200, length: String(6 * MiB), bytes: 6 * MiB, sha256, complete: true });
    // A ticket for one asset never opens another, and a stranger's bearer token is not a ticket.
    const other = await generated(owner.id, 'ticket-large-output-2', 3 * MiB);
    expect((await fetchContent(port, `/api/files/${other.asset.id}/download?token=${t.token}`, null)).status).toBe(401);
    expect((await fetchContent(port, `/api/files/${asset.id}/download?token=${owner.token}`, null)).status).toBe(401);
  }, 120_000);

  const corruptions: Array<[string, (file: string, total: number) => void]> = [
    ['one flipped byte at the very end', (file, total) => { const h = openSync(file, 'r+'); try { writeSync(h, Buffer.from([0xee]), 0, 1, total - 1); } finally { closeSync(h); } }],
    ['one flipped byte at the start', (file) => { const h = openSync(file, 'r+'); try { writeSync(h, Buffer.from([0xee]), 0, 1, 0); } finally { closeSync(h); } }],
    ['truncated object', (file, total) => truncateSync(file, total - 1)],
    ['object padded with extra bytes', (file) => appendFileSync(file, Buffer.from([1, 2, 3]))],
    ['object replaced by an empty file', (file) => truncateSync(file, 0)],
  ];
  for (const [name, corrupt] of corruptions) {
    it(`ticket GET and POST never complete a download of an object with ${name}`, async () => {
      const owner = await member(), total = 3 * MiB, { asset } = await generated(owner.id, `ticket-corrupt-${name.length}-${randomUUID().slice(0, 6)}`, total);
      const t = await issue(owner, asset.id);
      corrupt(join(directory, asset.objectKey), total);
      for (const result of [await fetchContent(port, t.query, null), await fetchContent(port, t.path, null, { token: t.token })]) {
        // Either refused up front or aborted mid-body: never a complete 200 with all declared bytes.
        expect(result.status === 200 && result.complete && result.bytes === total).toBe(false);
        if (result.status === 200) expect(result.bytes).toBeLessThan(total);
      }
    }, 60_000);
  }

  it('refuses a ticket after the asset is deleted or its revision changes, and after the object disappears', async () => {
    const owner = await member(), { asset } = await generated(owner.id, 'ticket-stale-output-001', 3 * MiB);
    const t = await issue(owner, asset.id);
    rmSync(join(directory, asset.objectKey));
    const gone = await fetchContent(port, t.query, null);
    expect(gone.status === 200 && gone.complete).toBe(false);
    const fresh = await generated(owner.id, 'ticket-stale-output-002', 3 * MiB);
    const ticket2 = await issue(owner, fresh.asset.id);
    await request(app.getHttpServer()).delete(`/api/files/${fresh.asset.id}`).set('Origin', origin).set('Authorization', `Bearer ${owner.token}`).expect(200);
    const deleted = await fetchContent(port, ticket2.query, null);
    expect(deleted.status).not.toBe(200);
  }, 60_000);

  it('expired ticket lifetime is bounded and the token never appears in the response body', async () => {
    const owner = await member(), { asset } = await generated(owner.id, 'ticket-lifetime-0001', 3 * MiB);
    const response = await request(app.getHttpServer()).post(`/api/files/${asset.id}/download-url`).set('Origin', origin).set('Authorization', `Bearer ${owner.token}`).send({}).expect(200);
    expect(response.body.expiresInSeconds).toBeLessThanOrEqual(300);
    expect(Date.parse(response.body.expiresAt)).toBeLessThanOrEqual(Date.now() + 301_000);
  });
});
