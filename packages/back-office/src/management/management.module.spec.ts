import { describe, expect, it } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { AccessLogService, ZuckerLoggingModule } from '@zucker-framework/logging';
import { BackOfficeManagementModule, BackOfficeManagementService } from '@zucker-framework/back-office/management';

/** Smoke: the module compiles with only log features and serves the shared log record contract. */
describe('BackOfficeManagementModule', () => {
  it('lists access logs through the logging service with the contract projection', async () => {
    const database = new InMemoryAdapter();
    @Module({
      imports: [
        { module: class DatabaseModule {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: database }], exports: [DATABASE_ADAPTER] },
        ZuckerLoggingModule.forRoot({ persistence: {} }),
        BackOfficeManagementModule.forRoot({
          guards: [], rateLimit: false,
          features: { apiKeys: false, orders: false, billingSubscriptions: false, jobs: false, deliveries: false, files: false },
        }),
      ],
    })
    class RootModule {}
    const moduleRef = await NestFactory.createApplicationContext(RootModule, { logger: false });
    await database.model('accessLogs').create({ data: { id: 'a1', action: 'read', userId: 'u1', module: 'm', requestTime: new Date(), parameters: { secret: 'x' } } });
    const service = moduleRef.get(BackOfficeManagementService);
    expect(moduleRef.get(AccessLogService)).toBeDefined();
    const page = await service.list('access-logs', { ownerId: 'u1' });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(page.data[0]).toMatchObject({ id: 'a1', userId: 'u1' });
    expect(page.data[0]).not.toHaveProperty('parameters');
    await expect(Promise.resolve().then(() => service.list('access-logs', { bogus: '1' }))).rejects.toThrow('Unsupported log filter');
    await moduleRef.close();
  });
});
