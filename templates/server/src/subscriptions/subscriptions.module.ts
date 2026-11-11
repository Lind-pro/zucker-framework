import { Module } from '@nestjs/common';
import { BackOfficeSubscriptionsModule } from '@zucker-framework/back-office/subscriptions';
import { BillingModule } from '../billing/billing.module';
import { BillingService } from '../billing/billing.service';
import { AccountModule } from '../accounts/account.module';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { APP_ENTITLEMENT_CATALOG } from './entitlement-catalog';
import { OptionalViewer } from './optional-viewer';
import { SUBSCRIPTION_STORAGE_OPTIONS } from './storage';
import { subscriptionOptionsFromEnvironment } from './subscriptions.service';

/**
 * Plans, user subscriptions, entitlements and quota administration (RFC 8.1–8.4) from the back-office
 * host. Global AccountGuard/PermissionsGuard enforce the permission metadata, so its guards are disabled.
 */
@Module({
  imports: [BackOfficeSubscriptionsModule.forRoot({
    catalog: APP_ENTITLEMENT_CATALOG,
    ...SUBSCRIPTION_STORAGE_OPTIONS,
    imports: [BillingModule, AccountModule],
    billing: BillingService,
    viewer: OptionalViewer,
    guards: [],
    // Read on every use: a runtime configuration source can replace the environment without a restart.
    settings: { inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => {
        const options = subscriptionOptionsFromEnvironment(environment ?? process.env);
        return () => options;
      } },
  })],
  exports: [BackOfficeSubscriptionsModule],
})
export class SubscriptionsModule {}
