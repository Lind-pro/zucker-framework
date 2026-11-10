import { Module } from '@nestjs/common';
import { createPlanAdminController, type PlanAdminPort } from '@zucker-framework/admin';
import { BillingController } from './billing.controller';
import { BillingService, BILLING_OPTIONS, billingOptionsFromEnvironment } from './billing.service';
import { BillingSubscriptionsController } from './subscriptions.controller';
import { BillingRefundsController } from './refunds/refunds.controller';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';

export const CREDIT_PACK_ADMIN = Symbol('CREDIT_PACK_ADMIN');
/**
 * `/management/credit-packs`: the plan administration controller over the credit pack port (same
 * list/detail/create/update/status/delete contract, `plans:*` permissions, port-error mapping). The
 * global AccountGuard/PermissionsGuard enforce the permission metadata, so factory guards are off.
 */
const CreditPackAdminController = createPlanAdminController({ path: 'management/credit-packs', service: CREDIT_PACK_ADMIN,
  auditModule: 'credit-packs', guards: [] });

@Module({
  controllers: [BillingController, BillingSubscriptionsController, BillingRefundsController, CreditPackAdminController],
  providers: [{ provide: BILLING_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }, { token: ConnectionSettingsService, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>, settings?: ConnectionSettingsService) => ({
      ...billingOptionsFromEnvironment(environment ?? process.env),
      // RUNTIME_ENVIRONMENT has been resolved, so the applied payment profile revisions are known.
      configRevision: settings?.appliedRevision('payment-') ?? null,
    }) }, BillingService,
    // Pack records satisfy the plan port structurally except for the record type; the wire contract is CreditPack.
    { provide: CREDIT_PACK_ADMIN, inject: [BillingService], useFactory: (billing: BillingService) => billing.packs as unknown as PlanAdminPort }],
  exports: [BillingService],
})
export class BillingModule {}
