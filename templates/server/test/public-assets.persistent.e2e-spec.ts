import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { ZuckerStorageModule } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { FilesModule } from '../src/files/files.module';
import { FILES_OPTIONS } from '../src/files/files.config';
import { PUBLIC_ASSET_RATE_LIMITERS } from '../src/files/public-assets.controller';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_public_assets_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';

/** Real PostgreSQL, Nest HTTP, account/permission guards, local objects and sharp decoding; synthetic images only. */
run('public assets with real PostgreSQL and local objects', () => {
  let app: INestApplication, database: ApplicationDatabase, pool: Pool, directory: string;
  let editor: { id: string; token: string }, member: { id: string; token: string };
  const tickets = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { tickets.set(email, ticket); } };
  const upload = (body: Buffer, token = editor.token, contentType = 'image/png', filename = 'cover.png') => request(app.getHttpServer())
    .post('/api/management/public-assets').set('Authorization', `Bearer ${token}`).set('Origin', origin)
    .attach('file', body, { filename, contentType });
  async function account(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticAssets9!';
    const action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username, email, password }).expect(201);
    await action('verify-email', { ticket: tickets.get(email) }).expect(200);
    const login = await action('login', { username, password }).expect(200);
    return { id: login.body.userId as string, token: login.body.token as string };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-public-asset-objects-'));
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-public-assets-only-secret', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'session-refresh': { points: 2000, duration: 60 }, 'session-refresh-network': { points: 2000, duration: 60 }, 'session-read': { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 }, ...PUBLIC_ASSET_RATE_LIMITERS, 'public-asset-upload': { points: 2000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), AccountModule, FilesModule,
    ], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer)
      .overrideProvider(FILES_OPTIONS).useValue({ maxObjectBytes: 10 * 1024 * 1024, maxOwnerBytes: 10 * 1024 * 1024, maxOwnerFiles: 4 }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    editor = await account('assetseditor'); member = await account('assetsmember');
    await database.model('permissions').create({ data: { id: 'content:manage', name: 'Manage synthetic content' } });
    await database.model('userPermissions').create({ data: { userId: editor.id, permissionId: 'content:manage', grantType: 'grant' } });
  });
  afterAll(async () => {
    try { await app?.close(); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  it('stores concurrent identical uploads as one object and one row, re-encoded without EXIF', async () => {
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg().withExif({ IFD0: { Copyright: 'synthetic-exif-sentinel' } }).toBuffer();
    expect(jpeg.includes('synthetic-exif-sentinel')).toBe(true);
    const responses = await Promise.all(Array.from({ length: 6 }, () => upload(jpeg, editor.token, 'text/plain', 'x.txt')));
    for (const response of responses) expect(response.status).toBe(200);
    const urls = new Set(responses.map(response => response.body.url));
    expect(urls.size).toBe(1);
    expect(responses.filter(response => response.body.deduplicated === false)).toHaveLength(1);
    expect(responses[0].body).toMatchObject({ mimeType: 'image/jpeg', width: 640, height: 480 });
    const rows = await pool.query(`SELECT * FROM "${schema}".public_assets`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ ownerId: editor.id, state: 'ready' });
    expect(readdirSync(join(directory, 'public-assets'))).toHaveLength(1);
    const url = [...urls][0] as string;
    expect(url).toMatch(/^\/api\/public-assets\/[0-9a-f]{64}\.jpg$/);
    const served = await request(app.getHttpServer()).get(url).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (part: Buffer) => parts.push(part)); res.on('end', () => done(null, Buffer.concat(parts))); }).expect(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((served.body as Buffer).includes('synthetic-exif-sentinel')).toBe(false);
    expect((await sharp(served.body as Buffer).metadata()).exif).toBeUndefined();
  });

  it('rejects SVG, spoofed types, non-staff users, untrusted origins and enforces the shared quota', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(svg, editor.token, 'image/png', 'logo.png').expect(415)).body.code).toBe('SVG_REJECTED');
    expect((await upload(Buffer.from('<html><body>not an image</body></html>'), editor.token, 'image/jpeg', 'a.jpg').expect(415)).body.code).toBe('UNSUPPORTED_TYPE');
    const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    expect((await upload(truncated).expect(422)).body.code).toBe('INVALID_IMAGE');
    const png = (red: number) => sharp({ create: { width: 32, height: 32, channels: 3, background: { r: red, g: 0, b: 0 } } }).png().toBuffer();
    await upload(await png(1), member.token).expect(403);
    await request(app.getHttpServer()).post('/api/management/public-assets').set('Authorization', `Bearer ${editor.token}`)
      .set('Origin', 'https://attacker.invalid').attach('file', await png(2), 'a.png').expect(403);
    // maxOwnerFiles=4: one row from the previous test, three more fit, the next one is refused.
    for (const red of [3, 4, 5]) await upload(await png(red)).expect(200);
    expect((await upload(await png(6)).expect(413)).body.code).toBe('FILE_QUOTA_EXCEEDED');
    await upload(await png(3)).expect(200);
  });

  it('serves only ready assets under the public prefix', async () => {
    mkdirSync(join(directory, 'private-assets'), { recursive: true });
    writeFileSync(join(directory, 'private-assets', 'secret'), 'private');
    const server = app.getHttpServer();
    for (const path of ['../private-assets/secret', '..%2Fprivate-assets%2Fsecret', `${'a'.repeat(64)}.png`, `${'a'.repeat(64)}.svg`, 'secret'])
      expect([400, 404]).toContain((await request(server).get(`/api/public-assets/${path}`)).status);
    expect(existsSync(join(directory, 'private-assets', 'secret'))).toBe(true);
  });
});
