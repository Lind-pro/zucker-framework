import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService, BILLING_OPTIONS, billingOptionsFromEnvironment } from './billing.service';
import { BillingSubscriptionsController } from './subscriptions.controller';
import { BillingRefundsController } from './refunds/refunds.controller';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';

@Module({
  controllers: [BillingController, BillingSubscriptionsController, BillingRefundsController],
  providers: [{ provide: BILLING_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => billingOptionsFromEnvironment(environment ?? process.env) }, BillingService],
  exports: [BillingService],
})
export class BillingModule {}
