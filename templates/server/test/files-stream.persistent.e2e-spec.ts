import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeSync, closeSync } from 'node:fs';
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
const schema = `zucker_files_stream_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const MiB = 1024 * 1024;

function synthetic(total: number): { stream: Readable; sha256: () => string } {
  const hash = createHash('sha256'); let sent = 0;
  const stream = Readable.from((function* () {
    while (sent < total) { const piece = Buffer.alloc(Math.min(MiB, total - sent), (sent / MiB) & 255); sent += piece.length; hash.update(piece); yield piece; }
  })());
  return { stream, sha256: () => hash.digest('hex') };
}

/** Raw GET that hashes the body as it arrives and reports whether the transfer completed. */
function fetchContent(port: number, path: string, token: string) {
  return new Promise<{ status: number; length: string | undefined; bytes: number; sha256: string; complete: boolean }>(done => {
    const hash = createHash('sha256'); let bytes = 0, status = 0, length: string | undefined;
    const finish = (complete: boolean) => done({ status, length, bytes, sha256: hash.digest('hex'), complete });
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` } }, response => {
      status = response.statusCode ?? 0; length = response.headers['content-length'];
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
      response.on('end', () => finish(response.complete));
      response.on('aborted', () => undefined);
      response.on('error', () => finish(false));
    });
    req.on('error', () => finish(false));
    req.end();
  });
}

run('owner content route streams large private files (PostgreSQL + HTTP + local storage)', () => {
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
    directory = mkdtempSync(join(tmpdir(), 'zucker-files-stream-')); manager = new LocalFileStorage({ basePath: directory });
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

  it('streams a 60 MiB generated output to its owner with Content-Length and verified bytes; others get 404', async () => {
    const owner = await member(), other = await member(), source = synthetic(60 * MiB);
    const asset = await app.get(FilesService).storeGenerated(owner.id, 'stream-owner-video-001', { fileName: 'ai-video-1.mp4', stream: source.stream, maxBytes: 200 * MiB });
    const result = await fetchContent(port, `/api/files/${asset.id}/content`, owner.token);
    expect(result).toEqual({ status: 200, length: String(60 * MiB), bytes: 60 * MiB, sha256: source.sha256(), complete: true });
    expect((await fetchContent(port, `/api/files/${asset.id}/content`, other.token)).status).toBe(404);
  }, 120_000);

  it('aborts the transfer before the last byte when the stored object no longer matches its hash', async () => {
    const owner = await member(), source = synthetic(4 * MiB);
    const asset = await app.get(FilesService).storeGenerated(owner.id, 'stream-corrupt-video-01', { fileName: 'ai-video-2.mp4', stream: source.stream, maxBytes: 200 * MiB });
    // Same size, one flipped byte near the end.
    const handle = openSync(join(directory, asset.objectKey), 'r+'); try { writeSync(handle, Buffer.from([0xee]), 0, 1, 4 * MiB - 10); } finally { closeSync(handle); }
    const result = await fetchContent(port, `/api/files/${asset.id}/content`, owner.token);
    expect(result.status).toBe(200);
    expect(result.complete).toBe(false);
    expect(result.bytes).toBeLessThan(4 * MiB);
  }, 60_000);

  it('keeps the buffered, verified path for files within the HTTP object limit', async () => {
    const owner = await member();
    const asset = await app.get(FilesService).storeGenerated(owner.id, 'stream-small-output-01', { fileName: 'note.bin', stream: Readable.from([Buffer.from('small synthetic output')]), maxBytes: MiB });
    const response = await request(app.getHttpServer()).get(`/api/files/${asset.id}/content`).set('Authorization', `Bearer ${owner.token}`).buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(response.headers['content-length']).toBe('22');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect((response.body as Buffer).toString()).toBe('small synthetic output');
  });
});
