import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { MenuController, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { ZuckerDictionaryModule } from '@zucker-framework/dictionary';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { ApplicationDatabase } from '../../src/database';
import { AccountModule } from '../../src/accounts/account.module';
import { AccountGuard } from '../../src/accounts/account.guard';
import { ACCOUNT_MAILER } from '../../src/accounts/account.service';
import { createAdministrator } from '../../src/accounts/create-administrator';
export async function dictionaryFixture(databaseUrl: string, origin = 'http://localhost:4331') {
  const url = new URL(databaseUrl); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
  const schema = `zucker_dictionary_${randomUUID().replaceAll('-', '')}`, pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect(); let setupFailure: unknown;
  try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); setupFailure = error; } finally { client.release(); }
  if (setupFailure) { await pool.end(); throw setupFailure; }
  url.searchParams.set('schema', schema); const database = new ApplicationDatabase(url.href), priorOrigin = process.env.ACCOUNT_ORIGINS, deliveries = new Map<string, string>();
  process.env.ACCOUNT_ORIGINS = origin; let closeApp: (() => Promise<void>) | undefined;
  try {
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-dictionary-only-at-least-32-characters', registerControllers: false }), ZuckerDictionaryModule.forRoot(),
      ZuckerAdminModule.forRoot({ features: ['dictionary'] }), ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { accounts: { points: 3000, duration: 60 }, 'session-refresh': { points: 3000, duration: 60 }, 'session-refresh-network': { points: 3000, duration: 60 }, 'session-read': { points: 3000, duration: 60 }, 'api-default': { points: 3000, duration: 60 } } }), AccountModule],
      controllers: [MenuController], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue({ assertConfigured() {}, async send(email: string, _purpose: string, ticket: string) { deliveries.set(email, ticket); } }).compile();
    const app = module.createNestApplication(); closeApp = () => app.close(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    const password = 'SyntheticDictionary9!', action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await createAdministrator(database, { username: 'dictadmin', email: 'dictadmin@example.invalid', password });
    const admin = (await action('login', { username: 'dictadmin', password }).expect(200)).body as { token: string; userId: string };
    async function member(username: string, permissions: string[]) {
      const email = `${username}@example.invalid`; await action('register', { username, email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
      const login = (await action('login', { username, password }).expect(200)).body as { token: string; userId: string };
      for (const id of permissions) {
        if (!(await database.model('permissions').findUnique({ where: { id } }))) await database.model('permissions').create({ data: { id, name: id } });
        await database.model('userPermissions').create({ data: { userId: login.userId, permissionId: id, grantType: 'grant' } });
      }
      return login;
    }
    async function withFailedUpdate(table: 'dictionaries' | 'dictionary_items', work: () => Promise<void>) {
      await pool.query(`CREATE FUNCTION "${schema}".reject_dictionary_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic dictionary update failure'; END $$`);
      try { await pool.query(`CREATE TRIGGER reject_dictionary_update BEFORE UPDATE ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_dictionary_update()`);
        try { await work(); } finally { await pool.query(`DROP TRIGGER reject_dictionary_update ON "${schema}"."${table}"`); }
      } finally { await pool.query(`DROP FUNCTION "${schema}".reject_dictionary_update()`); }
    }
    return { app, database, pool, schema, origin, password, admin, member, withFailedUpdate,
      async close() { try { await app.close(); await database.disconnect(); } finally { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); if (priorOrigin === undefined) delete process.env.ACCOUNT_ORIGINS; else process.env.ACCOUNT_ORIGINS = priorOrigin; } } } };
  } catch (error) { await closeApp?.(); await database.disconnect(); try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); if (priorOrigin === undefined) delete process.env.ACCOUNT_ORIGINS; else process.env.ACCOUNT_ORIGINS = priorOrigin; } throw error; }
}
