import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { MenuController, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { ZuckerAIModule, type NativeModelFactory } from '@zucker-framework/ai';
import {
  AIConnectionsModule,
  AI_NATIVE_MODEL_FACTORY,
  aiModuleOptionsFromEnvironment,
} from '../../src/ai-connections';
import request from 'supertest';
import { ApplicationDatabase } from '../../src/database';
import { AccountModule } from '../../src/accounts/account.module';
import { AccountGuard } from '../../src/accounts/account.guard';
import { ACCOUNT_MAILER } from '../../src/accounts/account.service';
import { createAdministrator } from '../../src/accounts/create-administrator';
import { CreditsService } from '../../src/credits/credits.service';
import { ManagementService } from '../../src/management/management.service';
import { ManagementController } from '../../src/management/management.controller';
import {
  ConnectionsService,
  MANAGEMENT_CONNECTION_ENV,
} from '../../src/management/connections.service';
import { RuntimeSettingsModule } from '../../src/runtime-settings/runtime-settings.module';
import {
  ConnectionSettingsService,
  CONNECTION_SETTINGS_SCOPE,
} from '../../src/runtime-settings/connection-settings.service';
import {
  RUNTIME_ENVIRONMENT,
  RUNTIME_SETTINGS_BASE_ENV,
} from '../../src/runtime-settings/runtime-settings.tokens';

/** Real HTTP auth, menus, runtime settings and PostgreSQL; only account email delivery is synthetic. */
export async function connectionBrowserFixture(
  databaseUrl: string,
  origin: string,
  options: {
    nativeAI?: { factory?: NativeModelFactory; routes?: Readonly<Record<string, string>> };
  } = {},
) {
  const url = new URL(databaseUrl);
  if (!/(?:_dev|_test|_tests)$/.test(url.pathname))
    throw new Error('Use an isolated development/test database');
  const schema = `zucker_connection_browser_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  let setupFailure: unknown;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await client.query(
        readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8').replace(
          'CREATE SCHEMA IF NOT EXISTS "public";',
          '',
        ),
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    setupFailure = error;
  } finally {
    client.release();
  }
  if (setupFailure) {
    await pool.end();
    throw setupFailure;
  }
  url.searchParams.set('schema', schema);
  const priorOrigin = process.env.ACCOUNT_ORIGINS;
  process.env.ACCOUNT_ORIGINS = origin;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    WEB_URL: origin,
    JWT_SECRET: 'synthetic-connection-browser-jwt-at-least-32-characters',
    CONFIG_ENCRYPTION_KEY: 'synthetic-connection-browser-dedicated-encryption-key',
    GOOGLE_OAUTH_ENABLED: 'false',
    GOOGLE_ONE_TAP_ENABLED: 'false',
    GOOGLE_CLIENT_ID: 'synthetic-google-environment',
    GOOGLE_CLIENT_SECRET: 'SYNTHETIC-BROWSER-ENV-SECRET',
    FILES_STORAGE_PROVIDER: 'local',
  };
  const password = 'SyntheticConnections9!';
  const deliveries = new Map<string, string>();
  let database: ApplicationDatabase, app: INestApplication;
  async function start(port = 0) {
    database = new ApplicationDatabase(url.href);
    const builder = Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
        ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }),
        ZuckerConfigModule.forRoot(),
        ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'permissions'] }),
        ZuckerRateLimiterModule.forRoot({
          limiters: {
            accounts: { points: 5000, duration: 60 },
            'api-default': { points: 5000, duration: 60 },
          },
        }),
        RuntimeSettingsModule,
        AccountModule,
        ...(options.nativeAI
          ? [
              ZuckerAIModule.forRootAsync({
                inject: [RUNTIME_ENVIRONMENT],
                useFactory: (environment) =>
                  aiModuleOptionsFromEnvironment(environment as Readonly<NodeJS.ProcessEnv>, {
                    routes: options.nativeAI?.routes,
                  }),
              }),
              AIConnectionsModule,
            ]
          : []),
      ],
      controllers: [MenuController, ManagementController],
      providers: [
        CreditsService,
        ManagementService,
        ConnectionsService,
        {
          provide: MANAGEMENT_CONNECTION_ENV,
          inject: [RUNTIME_ENVIRONMENT],
          useFactory: (environment: NodeJS.ProcessEnv) => environment,
        },
        { provide: APP_GUARD, useClass: AccountGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV)
      .useValue({ ...env })
      .overrideProvider(ACCOUNT_MAILER)
      .useValue({
        assertConfigured() {},
        async send(email: string, _purpose: string, ticket: string) {
          deliveries.set(email, ticket);
        },
      });
    if (options.nativeAI?.factory)
      builder.overrideProvider(AI_NATIVE_MODEL_FACTORY).useValue(options.nativeAI.factory);
    const module = await builder.compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(port, '127.0.0.1');
  }
  async function close() {
    try {
      await app?.close();
      await database?.onModuleDestroy();
    } finally {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
        if (priorOrigin === undefined) delete process.env.ACCOUNT_ORIGINS;
        else process.env.ACCOUNT_ORIGINS = priorOrigin;
      }
    }
  }
  try {
    await start();
    await createAdministrator(database!, {
      username: 'connectionadmin',
      email: 'connectionadmin@example.invalid',
      password,
    });
    const action = (path: string, body: object) =>
      request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    const admin = (await action('login', { username: 'connectionadmin', password }).expect(200))
      .body as { token: string; userId: string };
    const email = 'connectionreader@example.invalid';
    await action('register', { username: 'connectionreader', email, password }).expect(201);
    await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const reader = (await action('login', { username: 'connectionreader', password }).expect(200))
      .body as { token: string; userId: string };
    if (!(await database!.model('permissions').findUnique({ where: { id: 'config:query' } })))
      await database!
        .model('permissions')
        .create({ data: { id: 'config:query', name: 'Read connection settings' } });
    await database!.model('userPermissions').create({
      data: { userId: reader.userId, permissionId: 'config:query', grantType: 'grant' },
    });
    return {
      get app() {
        return app;
      },
      get database() {
        return database;
      },
      get settings() {
        return app.get(ConnectionSettingsService);
      },
      pool,
      schema,
      env,
      password,
      admin,
      reader,
      async restart(
        options: { withoutEncryptionKey?: boolean; clearSavedProfiles?: boolean } = {},
      ) {
        const address = app.getHttpServer().address();
        if (!address || typeof address === 'string')
          throw new Error('HTTP server is not listening');
        if (options.clearSavedProfiles)
          await database.transaction(async (tx) => {
            await tx.query('DELETE FROM config WHERE scope=$1', [CONNECTION_SETTINGS_SCOPE]);
            await tx.query('DELETE FROM config_history WHERE scope=$1', [
              CONNECTION_SETTINGS_SCOPE,
            ]);
          });
        await app.close();
        await database.onModuleDestroy();
        if (options.withoutEncryptionKey) delete env.CONFIG_ENCRYPTION_KEY;
        await start(address.port);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
