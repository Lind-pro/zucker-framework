import { Module } from '@nestjs/common';
import { createPlanAdminController, type PlanAdminPort } from '@zucker-framework/admin';
import { BackOfficeBillingModule, creditPackAdminPort } from '@zucker-framework/back-office/billing';
import { BillingService, BILLING_OPTIONS, billingOptionsFromEnvironment } from './billing.service';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { billingTestFakeControllers } from './test-fakes';
import { PaymentCredentialResolver } from './payment-credentials';
import { PaymentCredentialsController } from './payment-credentials.controller';
import { PaymentCredentialRetention } from './payment-credential-retention';
import { isPaymentProfileProvider } from './providers';
import { BILLING_WEBHOOK_LIMITER } from '../rate-limits';
import { accountOrigins } from './billing.config';

export const CREDIT_PACK_ADMIN = Symbol('CREDIT_PACK_ADMIN');
/**
 * `/management/credit-packs`: the plan administration controller over the credit pack port (same
 * list/detail/create/update/status/delete contract, `plans:*` permissions, port-error mapping). The
 * global AccountGuard/PermissionsGuard enforce the permission metadata, so factory guards are off.
 */
const CreditPackAdminController = createPlanAdminController({ path: 'management/credit-packs', service: CREDIT_PACK_ADMIN,
  auditModule: 'credit-packs', guards: [] });

/**
 * The template's billing configuration: BILLING_OPTIONS from the environment and hot-applied payment
 * profiles (WP 4.1c), the template BillingService (credit ledger, `billing` policy, affiliate programs)
 * and the D13 retention service. Exported so plans, promotions and the job runtime share one instance.
 */
@Module({
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
    } }, BillingService, PaymentCredentialRetention],
  exports: [BillingService, BILLING_OPTIONS, PaymentCredentialRetention],
})
export class BillingCoreModule {}

/**
 * Billing HTTP surface from `@zucker-framework/back-office/billing` over the template service:
 * `/billing` orders and webhooks, `/billing/subscriptions`, `/billing/refunds`, order recovery
 * (`POST /management/orders/:id/recover`), plus the template's credit pack administration, the D13
 * payment credential purge and the TEST-ONLY checkout page (BILLING_TEST_FAKE_PROVIDER=true).
 */
@Module({
  imports: [BillingCoreModule, BackOfficeBillingModule.forRoot({ imports: [BillingCoreModule], service: BillingService,
    trustedOrigins: accountOrigins, guards: [], rateLimit: 'billing', webhookRateLimit: BILLING_WEBHOOK_LIMITER })],
  controllers: [CreditPackAdminController, PaymentCredentialsController, ...billingTestFakeControllers(process.env)],
  providers: [{ provide: CREDIT_PACK_ADMIN, inject: [BillingService], useFactory: (billing: BillingService): PlanAdminPort => creditPackAdminPort(billing) }],
  exports: [BillingCoreModule, BackOfficeBillingModule],
})
export class BillingModule {}
