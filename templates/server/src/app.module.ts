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
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { MailModule } from './mail/mail.module';
import { RuntimeSettingsModule } from './runtime-settings/runtime-settings.module';
import { RUNTIME_ENVIRONMENT } from './runtime-settings/runtime-settings.tokens';
import { AIConnectionsModule } from './ai-connections/ai-connections.module';
import { AITasksModule, AI_POLICIES, AI_TASK_RATE_LIMITERS } from './ai-tasks';
import { ChatModule, CHAT_RATE_LIMITERS } from './chat';
import { PUBLIC_ASSET_RATE_LIMITERS } from './files/public-assets.controller';
import { aiModuleOptionsFromEnvironment } from './ai-connections/runtime-ai-config.source';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { ZuckerDictionaryModule } from '@zucker-framework/dictionary';
import { ZuckerCacheModule } from '@zucker-framework/cache';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { APP_RATE_LIMITERS, composeRateLimiters } from './rate-limits';
import { PolicyModule } from './policy/policy.module';
import { ACCOUNT_POLICIES } from './accounts/account.policy';
import { BILLING_POLICIES } from './billing/billing.policy';
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
// Bare import mounts only /health; /metrics and /monitoring/alerts stay off (opt-in via forRoot with permissions).
import { ZuckerMonitoringModule } from '@zucker-framework/monitoring';
import { RetentionModule } from './maintenance/retention';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { AdminUserSessionHooks } from './accounts/admin-user-hooks';
import { ZuckerFormModule } from '@zucker-framework/form';
import { AccountDeletionModule } from './accounts/deletion';
import { APP_DELETION_CONTRIBUTORS } from './accounts/deletion/app-contributors';
import { FeedbackModule, FEEDBACK_POLICIES, FEEDBACK_RATE_LIMITERS } from './feedback';
import { InboxModule, InboxService, INBOX_RATE_LIMITERS, inboxFeedbackNotifier, inboxReferralNotifier } from './inbox';
import { ReferralsModule, REFERRAL_POLICIES, REFERRAL_RATE_LIMITERS } from './referrals';
import { PromotionsModule } from './promotions';
import { InsightsModule } from './insights';
import { ACCOUNT_SECURITY_RATE_LIMITERS } from './accounts/security/account-security.limits';

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
    // Hot-applied product policies; features append their exported definitions to `policies`.
    PolicyModule.forRoot({ policies: [...ACCOUNT_POLICIES, ...BILLING_POLICIES, ...AI_POLICIES, ...FEEDBACK_POLICIES, ...REFERRAL_POLICIES] }),
    // Role links with `expiresAt` in the past grant nothing (users.expiresAt column, account:role --expires).
    ZuckerAuthModule.forRoot({ jwtSecret, registerControllers: false, roleAssignments: { expiry: true } }),
    AccountModule,
    AccountAvatarModule,
    AccountApiKeysModule,
    BillingModule,
    BillingRuntimeModule,
    ContentModule,
    CreditsModule,
    ManagementModule,
    SubscriptionsModule,
    MailModule,
    OAuthModule,
    ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {},
      captureParameters: false, captureResults: false }),

    // ============ Layer 3: 基础设施 ============
    ZuckerConfigModule.forRoot(),
    ZuckerDictionaryModule.forRoot(),
    ZuckerCacheModule.forRoot({ provider: 'memory' }),
    ZuckerRateLimiterModule.forRoot({
      // Controllers list this guard so it runs after authentication (user-keyed limits). A request is
      // charged once per limiter even if the guard runs twice, but the global copy is not needed.
      globalGuard: false,
      // Feature fragments are appended here: composeRateLimiters(APP_RATE_LIMITERS, FEATURE_RATE_LIMITERS, ...).
      limiters: { ...composeRateLimiters(APP_RATE_LIMITERS, PUBLIC_ASSET_RATE_LIMITERS, AI_TASK_RATE_LIMITERS, CHAT_RATE_LIMITERS,
        FEEDBACK_RATE_LIMITERS, INBOX_RATE_LIMITERS, REFERRAL_RATE_LIMITERS, ACCOUNT_SECURITY_RATE_LIMITERS) },
      // Shared budgets across replicas/restarts; requires the optional `ioredis` package. Memory otherwise.
      ...(process.env.RATE_LIMIT_REDIS_URL?.trim() ? { redis: { url: process.env.RATE_LIMIT_REDIS_URL.trim() } } : {}),
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
    // Metered media generation (/ai/*, /v1/ai/*) and streaming chat (/chat*) on the shared Jobs host.
    AITasksModule,
    ChatModule,

    // ============ Account growth (Phase 3) ============
    // In-app notifications; feedback replies and referral rewards post into the inbox in their own transaction.
    InboxModule,
    FeedbackModule.forRoot({ imports: [InboxModule], notifier: { inject: [InboxService], useFactory: inboxFeedbackNotifier } }),
    ReferralsModule.forRoot({ imports: [InboxModule], notifier: { inject: [InboxService], useFactory: inboxReferralNotifier } }),
    PromotionsModule,
    InsightsModule,
    // Built-in erase list + feature contributors (order documented in app-contributors.ts).
    AccountDeletionModule.forRoot({ imports: [AITasksModule, FilesModule], contributors: APP_DELETION_CONTRIBUTORS }),

    // ============ Layer 4: 高级能力 ============
    ZuckerProviderModule,
    ZuckerReferenceModule,
    ZuckerScriptModule,
    ZuckerRuleEngineModule,
    ZuckerMonitoringModule,
    RetentionModule,

    // ============ Admin 管理后台路由 ============
    ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'permissions', 'dictionary', 'config',
      'form', 'dashboard'],
    // Back-office password/e-mail/status changes end the account's sessions (credentialVersion).
    users: { hooks: AdminUserSessionHooks } }),
  ],
})
export class AppModule {}
