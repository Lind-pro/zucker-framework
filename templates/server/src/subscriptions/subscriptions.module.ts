import { Module } from '@nestjs/common';
import { createPlanAdminController, createQuotaAdminControllers, createUserSubscriptionAdminController } from '@zucker-framework/admin';
import { BillingModule } from '../billing/billing.module';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { SubscriptionsController } from './subscriptions.controller';
import { SUBSCRIPTION_OPTIONS, SubscriptionsService, subscriptionOptionsFromEnvironment } from './subscriptions.service';

export const PLAN_ADMIN = Symbol('PLAN_ADMIN');
export const QUOTA_RESERVATIONS = Symbol('QUOTA_RESERVATIONS');
const quota = createQuotaAdminControllers({ reservations: QUOTA_RESERVATIONS, guards: [] });

/**
 * Plans, user subscriptions, entitlements and quota administration (RFC 8.1–8.4). Global
 * AccountGuard/PermissionsGuard enforce the permission metadata, so factory guards are disabled.
 */
@Module({
  imports: [BillingModule],
  controllers: [
    SubscriptionsController,
    createPlanAdminController({ service: PLAN_ADMIN, guards: [] }),
    createUserSubscriptionAdminController({ service: SubscriptionsService, guards: [] }),
    quota.usage,
    quota.reservations,
  ],
  providers: [
    // A resolver, read on every use: a runtime configuration source can replace it without a restart.
    { provide: SUBSCRIPTION_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => {
        const options = subscriptionOptionsFromEnvironment(environment ?? process.env);
        return () => options;
      } },
    SubscriptionsService,
    { provide: PLAN_ADMIN, inject: [SubscriptionsService], useFactory: (service: SubscriptionsService) => service.plans },
    { provide: QUOTA_RESERVATIONS, inject: [SubscriptionsService], useFactory: (service: SubscriptionsService) => service.reservations },
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
