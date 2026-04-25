import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerEventModule } from '@zucker/event';
import { ZuckerCommonModule } from '@zucker/common';
import { ZuckerCrudModule, PrismaAdapter, InMemoryAdapter } from '@zucker/crud';
import { PrismaClient } from '@prisma/client';
import { ZuckerAuthModule, JwtAuthGuard, PermissionsGuard } from '@zucker/auth';
import { ZuckerLoggingModule } from '@zucker/logging';
import { ZuckerConfigModule } from '@zucker/config';
import { ZuckerDictionaryModule } from '@zucker/dictionary';
import { ZuckerCacheModule } from '@zucker/cache';
import { ZuckerRateLimiterModule } from '@zucker/rate-limiter';
import { ZuckerStorageModule } from '@zucker/storage';
import { ZuckerNotificationModule } from '@zucker/notification';
import { ZuckerCreditModule } from '@zucker/credit';
import { ZuckerAIModule } from '@zucker/ai';
import { ZuckerProviderModule } from '@zucker/provider';
import { ZuckerReferenceModule } from '@zucker/reference';
import { ZuckerScriptModule } from '@zucker/script';
import { ZuckerRuleEngineModule } from '@zucker/rule-engine';
import { ZuckerMonitoringModule } from '@zucker/monitoring';
import { ZuckerAdminModule } from '@zucker/admin';
import { ZuckerFormModule } from '@zucker/form';

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
    ...(process.env.DATABASE_URL
      ? [
          ZuckerCrudModule.forRootAsync({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            useFactory: () => new PrismaAdapter(new PrismaClient() as any),
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
