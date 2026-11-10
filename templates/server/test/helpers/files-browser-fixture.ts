import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { FILE_MANAGER, LocalFileStorage, ZuckerStorageModule } from '@zucker-framework/storage';
import request from 'supertest';
import { ApplicationDatabase } from '../../src/database';
import { AccountModule } from '../../src/accounts/account.module';
import { AccountAvatarModule } from '../../src/accounts/avatar/avatar.module';
import { AccountGuard } from '../../src/accounts/account.guard';
import { ACCOUNT_MAILER } from '../../src/accounts/account.service';
import { FilesModule } from '../../src/files/files.module';
import { FILES_OPTIONS, MAX_FILE_BYTES } from '../../src/files/files.config';
import {
  FILES_IMPORT_FETCH,
  FILES_TRANSFER_OPTIONS,
  type FilesTransferOptions,
} from '../../src/files/files-transfer.config';
export async function filesBrowserFixture(databaseUrl: string, origin: string) {
  const url = new URL(databaseUrl);
  if (url.pathname !== '/cnipa_dev' && !/_test$/.test(url.pathname))
    throw new Error('Use a designated test database');
  const schema = `zucker_files_browser_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }),
    client = await pool.connect();
  let setupError: unknown;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const migration of readdirSync(resolve('prisma/migrations'), { withFileTypes: true })
      .filter((row) => row.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name)))
      await client.query(
        readFileSync(resolve('prisma/migrations', migration.name, 'migration.sql'), 'utf8').replace(
          'CREATE SCHEMA IF NOT EXISTS "public";',
          '',
        ),
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    setupError = error;
  } finally {
    client.release();
  }
  if (setupError) {
    await pool.end();
    throw setupError;
  }
  url.searchParams.set('schema', schema);
  const database = new ApplicationDatabase(url.href),
    directory = mkdtempSync(join(tmpdir(), 'zucker-files-browser-'));
  const manager = new LocalFileStorage({ basePath: directory }),
    previousOrigin = process.env.ACCOUNT_ORIGINS;
  process.env.ACCOUNT_ORIGINS = origin;
  const password = 'SyntheticFilesBrowser9!',
    deliveries = new Map<string, string>(),
    importRequests: string[] = [];
  const transferOptions: FilesTransferOptions = {
    downloadTtlSeconds: 3,
    importAllowedHosts: ['assets.example.com'],
    importTimeoutMs: 2000,
  };
  const imported = Buffer.from('%PDF-1.7\nSynthetic imported private file\n');
  let app!: INestApplication;
  async function close() {
    try {
      await app?.close();
      await database.disconnect();
    } finally {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
        rmSync(directory, { recursive: true, force: true });
        if (previousOrigin === undefined) delete process.env.ACCOUNT_ORIGINS;
        else process.env.ACCOUNT_ORIGINS = previousOrigin;
      }
    }
  }
  try {
    const module = await Test.createTestingModule({
      imports: [
        ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
        ZuckerAuthModule.forRoot({
          jwtSecret: 'synthetic-browser-files-secret-at-least-32-characters',
          registerControllers: false,
        }),
        ZuckerRateLimiterModule.forRoot({
          limiters: {
            accounts: { points: 5000, duration: 60 },
            'session-refresh': { points: 5000, duration: 60 },
            'session-refresh-network': { points: 5000, duration: 60 },
            'session-read': { points: 5000, duration: 60 },
            'api-default': { points: 5000, duration: 60 },
          },
        }),
        ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }),
        AccountModule,
        AccountAvatarModule,
        FilesModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AccountGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    })
      .overrideProvider(ACCOUNT_MAILER)
      .useValue({
        assertConfigured() {},
        async send(email: string, _purpose: string, ticket: string) {
          deliveries.set(email, ticket);
        },
      })
      .overrideProvider(FILE_MANAGER)
      .useValue(manager)
      .overrideProvider(FILES_OPTIONS)
      .useValue({ maxObjectBytes: MAX_FILE_BYTES })
      .overrideProvider(FILES_TRANSFER_OPTIONS)
      .useValue(transferOptions)
      .overrideProvider(FILES_IMPORT_FETCH)
      .useValue(async (source: string) => {
        importRequests.push(source);
        return new Response(imported, { headers: { 'content-length': String(imported.length) } });
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    async function member(username: string) {
      const email = `${username}@example.invalid`;
      const post = (path: string, body: object) =>
        request(app.getHttpServer())
          .post(`/api/authorize/${path}`)
          .set('Origin', origin)
          .send(body);
      await post('register', { username, email, password }).expect(201);
      await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
      const response = await post('login', { username, password }).expect(200);
      return { id: response.body.userId as string, token: response.body.token as string };
    }
    const owner = await member('filebrowser'),
      other = await member('fileother');
    return {
      app,
      database,
      pool,
      schema,
      manager,
      password,
      owner,
      other,
      importRequests,
      imported,
      transferOptions,
      origin,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
