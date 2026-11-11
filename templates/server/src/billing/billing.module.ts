import { Module } from '@nestjs/common';
import { createPlanAdminController, type PlanAdminPort } from '@zucker-framework/admin';
import { BillingController } from './billing.controller';
import { BillingService, BILLING_OPTIONS, billingOptionsFromEnvironment } from './billing.service';
import { BillingSubscriptionsController } from './subscriptions.controller';
import { BillingRefundsController } from './refunds/refunds.controller';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { billingTestFakeControllers } from './test-fakes';
import { PaymentCredentialResolver } from './payment-credentials';
import { PaymentCredentialsController } from './payment-credentials.controller';
import { PaymentCredentialRetention } from './payment-credential-retention';
import { isPaymentProfileProvider } from './providers';

export const CREDIT_PACK_ADMIN = Symbol('CREDIT_PACK_ADMIN');
/**
 * `/management/credit-packs`: the plan administration controller over the credit pack port (same
 * list/detail/create/update/status/delete contract, `plans:*` permissions, port-error mapping). The
 * global AccountGuard/PermissionsGuard enforce the permission metadata, so factory guards are off.
 */
const CreditPackAdminController = createPlanAdminController({ path: 'management/credit-packs', service: CREDIT_PACK_ADMIN,
  auditModule: 'credit-packs', guards: [] });

@Module({
  controllers: [BillingController, BillingSubscriptionsController, BillingRefundsController, CreditPackAdminController,
    // Retained payment credential revisions and the superadmin purge (D13).
    PaymentCredentialsController,
    // TEST-ONLY hosted checkout page (/billing/test-checkout/*) when BILLING_TEST_FAKE_PROVIDER=true.
    ...billingTestFakeControllers(process.env)],
  providers: [{ provide: BILLING_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }, { token: ConnectionSettingsService, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>, settings?: ConnectionSettingsService) => {
      // Start-up assembly still fails fast on an invalid saved payment configuration.
      const options = billingOptionsFromEnvironment(environment ?? process.env);
      // RUNTIME_ENVIRONMENT has been resolved, so the applied payment profile revisions are known.
      const configRevision = settings?.appliedRevision('payment-') ?? null;
      if (!settings) return { ...options, configRevision };
      // Payment profiles apply hot (WP 4.1c): new orders use the current saved revision, existing
      // orders/subscriptions/refunds the newest retained credentials of their own account. Providers
      // that are not connection profiles (the TEST-ONLY fake) keep their start-up instances.
      const fixed = options.providers.filter(provider => !isPaymentProfileProvider(provider.id)).map(checkout => ({ checkout,
        subscription: options.subscriptionProviders?.find(adapter => adapter.id === checkout.id),
        refund: options.refundProviders?.find(adapter => adapter.id === checkout.id) }));
      return { ...options, configRevision, credentials: new PaymentCredentialResolver(settings, { fixed }) };
    } }, BillingService,
    // Pack records satisfy the plan port structurally except for the record type; the wire contract is CreditPack.
    PaymentCredentialRetention,
    { provide: CREDIT_PACK_ADMIN, inject: [BillingService], useFactory: (billing: BillingService) => billing.packs as unknown as PlanAdminPort }],
  exports: [BillingService],
})
export class BillingModule {}
