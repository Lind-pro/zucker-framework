import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService, BILLING_OPTIONS, billingOptionsFromEnvironment } from './billing.service';
import { BillingSubscriptionsController } from './subscriptions.controller';
import { BillingRefundsController } from './refunds/refunds.controller';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';

@Module({
  controllers: [BillingController, BillingSubscriptionsController, BillingRefundsController],
  providers: [{ provide: BILLING_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }, { token: ConnectionSettingsService, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>, settings?: ConnectionSettingsService) => ({
      ...billingOptionsFromEnvironment(environment ?? process.env),
      // RUNTIME_ENVIRONMENT has been resolved, so the applied payment profile revisions are known.
      configRevision: settings?.appliedRevision('payment-') ?? null,
    }) }, BillingService],
  exports: [BillingService],
})
export class BillingModule {}
