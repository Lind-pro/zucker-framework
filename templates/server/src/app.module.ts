import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerEventModule } from '@zucker-framework/event';
import { ZuckerCommonModule } from '@zucker-framework/common';
import { ZuckerCrudModule, PrismaAdapter, InMemoryAdapter } from '@zucker-framework/crud';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { ZuckerAuthModule, JwtAuthGuard, PermissionsGuard } from '@zucker-framework/auth';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerDictionaryModule } from '@zucker-framework/dictionary';
import { ZuckerCacheModule } from '@zucker-framework/cache';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerStorageModule } from '@zucker-framework/storage';
import { ZuckerNotificationModule } from '@zucker-framework/notification';
import { ZuckerCreditModule } from '@zucker-framework/credit';
import { ZuckerAIModule } from '@zucker-framework/ai';
import { ZuckerProviderModule } from '@zucker-framework/provider';
import { ZuckerReferenceModule } from '@zucker-framework/reference';
import { ZuckerScriptModule } from '@zucker-framework/script';
import { ZuckerRuleEngineModule } from '@zucker-framework/rule-engine';
import { ZuckerMonitoringModule } from '@zucker-framework/monitoring';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { ZuckerFormModule } from '@zucker-framework/form';

const databaseUrl = process.env.DATABASE_URL;

@Module({
  providers: [
    // 全局认证 Guard — 未标记 @Public() 的端点默认需要认证
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  imports: [
    // ============ Layer 1: 基础 ============
    EventEmitterModule.forRoot(),
    ZuckerEventModule.forRoot(),
    ZuckerCommonModule,

    // ============ Layer 2: 框架核心 ============
    // When DATABASE_URL is set, instantiate a real PrismaClient via factory.
    // Otherwise fall back to InMemoryAdapter for local dev (no DB required).
    ...(databaseUrl
      ? [
          ZuckerCrudModule.forRootAsync({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            useFactory: () =>
              new PrismaAdapter(
                new PrismaClient({
                  adapter: new PrismaPg({ connectionString: databaseUrl }),
                }) as any,
              ),
          }),
        ]
      : [ZuckerCrudModule.forRoot({ adapterClass: InMemoryAdapter })]),
    ZuckerAuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET }),
    ZuckerLoggingModule.forRoot(),

    // ============ Layer 3: 基础设施 ============
    ZuckerConfigModule.forRoot(),
    ZuckerDictionaryModule.forRoot(),
    ZuckerCacheModule.forRoot({ provider: 'memory' }),
    ZuckerRateLimiterModule.forRoot({
      limiters: {
        login: { points: 5, duration: 900 },        // 15分钟最多5次登录
        'api-default': { points: 100, duration: 60 }, // 每分钟100次API调用
      },
    }),
    ZuckerStorageModule.forRoot({ provider: 'local', basePath: './uploads' }),
    ZuckerNotificationModule.forRoot({ providers: [] }),
    ZuckerCreditModule.forRoot(),
    ZuckerFormModule.forRoot(),
    ZuckerAIModule.forRoot(),

    // ============ Layer 4: 高级能力 ============
    ZuckerProviderModule,
    ZuckerReferenceModule,
    ZuckerScriptModule,
    ZuckerRuleEngineModule,
    ZuckerMonitoringModule,

    // ============ Admin 管理后台路由 ============
    ZuckerAdminModule.forRoot(),
  ],
})
export class AppModule {}
