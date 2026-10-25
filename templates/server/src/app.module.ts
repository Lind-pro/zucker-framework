import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerEventModule } from '@zucker-framework/event';
import { ZuckerCommonModule } from '@zucker-framework/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ApplicationDatabase } from './database';
import { ApplicationHealth } from './application-health';
import { ZuckerAuthModule, PermissionsGuard, MenuController } from '@zucker-framework/auth';
import { AccountModule } from './accounts/account.module';
import { AccountAvatarModule } from './accounts/avatar/avatar.module';
import { AccountApiKeysModule } from './api-keys/api-keys.module';
import { OAuthModule } from './oauth/oauth.module';
import { AccountGuard } from './accounts/account.guard';
import { BillingModule } from './billing/billing.module';
import { BillingRuntimeModule } from './billing/billing-runtime';
import { ContentModule } from './content/content.module';
import { CreditsModule } from './credits/credits.module';
import { ManagementModule } from './management/management.module';
import { RuntimeSettingsModule } from './runtime-settings/runtime-settings.module';
import { RUNTIME_ENVIRONMENT } from './runtime-settings/runtime-settings.tokens';
import { AIConnectionsModule } from './ai-connections/ai-connections.module';
import { aiModuleOptionsFromEnvironment } from './ai-connections/runtime-ai-config.source';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerDictionaryModule } from '@zucker-framework/dictionary';
import { ZuckerCacheModule } from '@zucker-framework/cache';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerStorageModule } from '@zucker-framework/storage';
import { FilesModule } from './files/files.module';
import { storageOptionsFromEnvironment } from './files/files.config';
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
if (!databaseUrl) throw new Error('DATABASE_URL is required for the Server template. Configure its isolated database before starting.');
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be an explicit secret of at least 32 characters.');

@Module({
  controllers: [MenuController],
  providers: [
    ApplicationHealth,
    // 全局认证 Guard — 未标记 @Public() 的端点默认需要认证
    { provide: APP_GUARD, useClass: AccountGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  imports: [
    // ============ Layer 1: 基础 ============
    EventEmitterModule.forRoot(),
    ZuckerEventModule.forRoot(),
    ZuckerCommonModule,

    // ============ Layer 2: 框架核心 ============
    ZuckerCrudModule.forRootAsync({ useFactory: () => new ApplicationDatabase(databaseUrl) }),
    RuntimeSettingsModule,
    ZuckerAuthModule.forRoot({ jwtSecret, registerControllers: false }),
    AccountModule,
    AccountAvatarModule,
    AccountApiKeysModule,
    BillingModule,
    BillingRuntimeModule,
    ContentModule,
    CreditsModule,
    ManagementModule,
    OAuthModule,
    ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {},
      captureParameters: false, captureResults: false }),

    // ============ Layer 3: 基础设施 ============
    ZuckerConfigModule.forRoot(),
    ZuckerDictionaryModule.forRoot(),
    ZuckerCacheModule.forRoot({ provider: 'memory' }),
    ZuckerRateLimiterModule.forRoot({
      // Controllers run this guard after authentication; a global copy would consume twice.
      globalGuard: false,
      limiters: {
        accounts: { points: 20, duration: 60 },
        'api-key': { points: 60, duration: 60, blockDuration: 0 },
        billing: { points: 60, duration: 60 },
        login: { points: 5, duration: 900 },        // 15分钟最多5次登录
        'api-default': { points: 100, duration: 60 }, // 每分钟100次API调用
      },
    }),
    ZuckerStorageModule.forRootAsync({ inject: [RUNTIME_ENVIRONMENT],
      useFactory: environment => storageOptionsFromEnvironment(environment as NodeJS.ProcessEnv) }),
    FilesModule,
    ZuckerNotificationModule.forRoot({ providers: [] }),
    ZuckerCreditModule.forRoot(),
    ZuckerFormModule.forRoot(),
    ZuckerAIModule.forRootAsync({ inject: [RUNTIME_ENVIRONMENT],
      useFactory: environment => aiModuleOptionsFromEnvironment(environment as Readonly<NodeJS.ProcessEnv>) }),
    AIConnectionsModule,

    // ============ Layer 4: 高级能力 ============
    ZuckerProviderModule,
    ZuckerReferenceModule,
    ZuckerScriptModule,
    ZuckerRuleEngineModule,
    ZuckerMonitoringModule,

    // ============ Admin 管理后台路由 ============
    ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'permissions', 'dictionary', 'config',
      'form', 'dashboard'] }),
  ],
})
export class AppModule {}
