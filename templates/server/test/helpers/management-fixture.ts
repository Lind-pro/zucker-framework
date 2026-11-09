import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { MenuController, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { ZuckerMonitoringModule } from '@zucker-framework/monitoring';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import type { HostedCheckoutOffer } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../../src/database';
import { BillingModule } from '../../src/billing/billing.module';
import { BILLING_OPTIONS, type BillingOptions } from '../../src/billing/billing.service';
import { AccountModule } from '../../src/accounts/account.module';
import { AccountGuard } from '../../src/accounts/account.guard';
import { ACCOUNT_MAILER } from '../../src/accounts/account.service';
import { createAdministrator } from '../../src/accounts/create-administrator';
import { ContentModule } from '../../src/content/content.module';
import { CONTENT_OPTIONS } from '../../src/content/content.options';
import { CreditsService } from '../../src/credits/credits.service';
import { ManagementService } from '../../src/management/management.service';
import { ManagementController } from '../../src/management/management.controller';
import {
  ConnectionsService,
  MANAGEMENT_CONNECTION_ENV,
} from '../../src/management/connections.service';

export async function managementFixture(databaseUrl: string, origin = 'http://localhost:4320', billingOptions?: BillingOptions,
  extraImports: NonNullable<Parameters<typeof Test.createTestingModule>[0]['imports']> = []) {
  const url = new URL(databaseUrl);
  if (!/(?:_dev|_test|_tests)$/.test(url.pathname))
    throw new Error('Use an isolated development/test database');
  const schema = `zucker_management_${randomUUID().replaceAll('-', '')}`,
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  let setupFailure: unknown;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name)))
      await client.query(
        readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8').replace(
          'CREATE SCHEMA IF NOT EXISTS "public";',
          '',
        ),
      );
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
  const database = new ApplicationDatabase(url.href),
    priorOrigin = process.env.ACCOUNT_ORIGINS;
  process.env.ACCOUNT_ORIGINS = origin;
  const deliveries = new Map<string, string>();
  const builder = Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot(),
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({
        jwtSecret: 'synthetic-management-secret-long-enough',
        registerControllers: false,
      }),
      ZuckerConfigModule.forRoot(),
      ZuckerMonitoringModule,
      ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {} }),
      ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'permissions'] }),
      ZuckerRateLimiterModule.forRoot({
        limiters: {
          accounts: { points: 5000, duration: 60 },
          'session-refresh': { points: 5000, duration: 60 },
          'session-refresh-network': { points: 5000, duration: 60 },
          'session-read': { points: 5000, duration: 60 },
          billing: { points: 5000, duration: 60 },
          'api-default': { points: 5000, duration: 60 },
        },
      }),
      AccountModule,
      ContentModule,
      ...(billingOptions ? [BillingModule] : []),
      ...extraImports,
    ],
    controllers: [MenuController, ManagementController],
    providers: [
      CreditsService,
      ManagementService,
      ConnectionsService,
      {
        provide: MANAGEMENT_CONNECTION_ENV,
        useValue: {
          WEB_URL: 'http://localhost:4202',
          BILLING_STRIPE_ENABLED: 'true',
          BILLING_STRIPE_MODE: 'test',
          STRIPE_SECRET_KEY: 'SYNTHETIC-SECRET-NEVER-EXPOSE',
          GOOGLE_OAUTH_ENABLED: 'true',
          FILES_STORAGE_PROVIDER: 'local',
        },
      },
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
    .overrideProvider(CONTENT_OPTIONS)
    .useValue({ siteUrl: 'http://localhost:4202', origins: [origin] });
  if (billingOptions) builder.overrideProvider(BILLING_OPTIONS).useValue(billingOptions);
  const module = await builder.compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const password = 'SyntheticManage9!';
  const action = (path: string, body: object) =>
    request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
  const adminId = await createAdministrator(database, {
    username: 'manageadmin',
    email: 'admin@example.invalid',
    password,
  });
  const admin = (await action('login', { username: 'manageadmin', password }).expect(200)).body as {
    token: string;
    userId: string;
  };
  async function member(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`;
    await action('register', { username, email, password }).expect(201);
    await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = (await action('login', { username, password }).expect(200)).body as {
      token: string;
      userId: string;
    };
    for (const permission of permissions) {
      const exists = await database.model('permissions').findUnique({ where: { id: permission } });
      if (!exists)
        await database.model('permissions').create({ data: { id: permission, name: permission } });
      await database
        .model('userPermissions')
        .create({ data: { userId: login.userId, permissionId: permission, grantType: 'grant' } });
    }
    return login;
  }
  return {
    app,
    pool,
    database,
    schema,
    origin,
    password,
    admin: { ...admin, userId: adminId },
    member,
    async close() {
      await app.close();
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
        if (priorOrigin === undefined) delete process.env.ACCOUNT_ORIGINS;
        else process.env.ACCOUNT_ORIGINS = priorOrigin;
      }
    },
  };
}

/** Synthetic private payloads exercise the projection boundary without any provider request. */
export async function seedManagementRecords(
  f: Awaited<ReturnType<typeof managementFixture>>,
  ownerId: string,
) {
  return f.database.transaction(async (tx) => {
    const offer: HostedCheckoutOffer = {
      catalogReference: 'offer',
      description: 'Synthetic safe offer',
      version: 'v1',
      mode: 'payment',
      money: { amount: '10.00', currency: 'USD' },
      fulfillmentData: { credits: 25, expiresInDays: null },
    };
    for (const suffix of ['one', 'two'])
      await tx.model('billingOrders').create({
        data: {
          id: `projection-order-${suffix}`,
          ownerId,
          offerId: 'offer',
          providerId: 'stripe',
          accountScope: 'PRIVATE-ACCOUNT-SCOPE',
          offer:
            suffix === 'one'
              ? { ...offer, mode: 'subscription', catalogReference: 'offer' }
              : offer,
          providerMetadata: { private: 'PRIVATE-ATTRIBUTION' },
          successUrl: 'https://synthetic.invalid/success',
          cancelUrl: 'https://synthetic.invalid/cancel',
          createKey: `PRIVATE-CREATE-${suffix}`,
          captureKey: `PRIVATE-CAPTURE-${suffix}`,
          creationState: suffix === 'one' ? 'created' : 'prepared',
          captureState: suffix === 'one' ? 'confirmed' : 'idle',
          state: suffix === 'one' ? 'paid' : 'unknown',
          ...(suffix === 'one'
            ? {
                checkoutId: 'synthetic-checkout',
                subscriptionId: 'private-subscription-ref',
                paymentId: 'private-initial-payment',
                paymentKind: 'payment-intent',
                fulfilledAt: new Date(),
              }
            : {}),
        },
      });
    await tx.model('billingSubscriptions').create({
      data: {
        id: 'projection-subscription',
        ownerId,
        initialOrderId: 'projection-order-one',
        providerId: 'stripe',
        accountScope: 'PRIVATE-ACCOUNT-SCOPE',
        providerSubscriptionId: 'private-subscription-ref',
        catalogReference: 'offer',
        offer: { ...offer, mode: 'subscription', catalogReference: 'offer' },
        grantBasis: 'period',
        initialPaymentId: 'private-initial-payment',
        initialPaymentKind: 'payment-intent',
        customerId: 'PRIVATE-CUSTOMER',
      },
    });
    await tx.model('AsyncJob').create({
      data: {
        id: 'projection-task',
        kind: 'synthetic.task',
        resourceType: 'test',
        resourceId: 'synthetic-resource',
        userId: ownerId,
        maxAttempts: 1,
        idempotencyKey: 'PRIVATE-TASK-KEY',
        idempotencyFingerprint: 'a'.repeat(64),
        handlerVersion: 'v1',
        payload: { private: 'PRIVATE-TASK-PAYLOAD' },
      },
    });
    await tx.model('NotificationDelivery').create({
      data: {
        id: 'projection-delivery',
        idempotencyKey: 'PRIVATE-DELIVERY-KEY',
        idempotencyFingerprint: 'b'.repeat(64),
        channel: 'email',
        deliveryRef: 'PRIVATE-RECIPIENT-REF',
        maxAttempts: 1,
      },
    });
  });
}

export async function seedManagementApiKeys(
  f: Awaited<ReturnType<typeof managementFixture>>,
  ownerId: string,
) {
  const now = new Date();
  for (const status of ['active', 'revoked', 'expired'] as const)
    await f.database.model('accountApiKeys').create({
      data: {
        id: `projection-key-${status}`,
        userId: ownerId,
        name: `Synthetic ${status} key`,
        keyPrefix: `zk_api_${status}`,
        keyHash: `PRIVATE-HASH-${status}`,
        scopes: ['account:read'],
        isActive: true,
        expiresAt: new Date(now.getTime() + (status === 'expired' ? -86400000 : 86400000)),
        revokedAt: status === 'revoked' ? now : null,
      },
    });
}
