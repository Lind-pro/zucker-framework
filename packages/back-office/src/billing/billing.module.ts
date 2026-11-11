import { Module, type DynamicModule, type InjectionToken, type Provider, type Type } from '@nestjs/common';
import { createPlanAdminController, type PlanAdminPort } from '@zucker-framework/admin';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import type { HostedCheckoutOrder } from '@zucker-framework/payment';
import type { BillingDatabase } from './billing.database';
import {
  createBillingController, createBillingOrderRecoveryController, createBillingRefundsController, createBillingSubscriptionsController,
  createFakeCheckoutController, createPaymentCredentialsController, type BillingControllerSettings,
} from './billing.controllers';
import { resolveBillingOptions, type BackOfficeBillingOptions, type BillingCheckoutPolicyProvider, type ResolvedBillingOptions } from './billing.options';
import type { BillingCheckoutHooks, BillingRefundHooks } from './billing.ports';
import { BillingService, type BillingRuntimeSource } from './billing.service';
import {
  BILLING_CHECKOUT_HOOKS, BILLING_CHECKOUT_POLICY, BILLING_CREDENTIAL_ARCHIVE, BILLING_CREDENTIAL_RETENTION, BILLING_CREDIT_PACK_ADMIN,
  BILLING_OPTIONS, BILLING_REFUND_HOOKS, BILLING_REFUND_SUMMARY, BILLING_RUNTIME, BILLING_SERVICE,
} from './billing.tokens';
import { PaymentCredentialRetention, type PaymentCredentialArchive } from './payment-credential-retention';
import { readOrderRefundSummary, type PublicRefundSummary, type RefundSummaryOrder } from './refunds/refunds.projection';

/** Refund state of one order for read models (structurally `ManagementRefundSummaryPort`). */
export interface BillingRefundSummary { summarize(order: Readonly<RefundSummaryOrder>): Promise<PublicRefundSummary | null> }

/**
 * Billing host: `/billing` orders and provider webhooks, `/billing/subscriptions`, `/billing/refunds`,
 * order recovery, D13 payment credential purge, credit pack administration and the TEST-ONLY checkout
 * page, each a switchable feature. Needs the consumer's `DATABASE_ADAPTER` (PostgreSQL; transactions
 * with `query`), the auth guards (or global guards with `guards: []`) and, unless `rateLimit: false`,
 * `ZuckerRateLimiterModule` limiters named `billing` and `billing-webhook` (or the configured names).
 *
 * The consumer either lets the module construct the {@link BillingService} (`runtime`) or registers its
 * own subclass in an imported module and passes it as `service`. Scheduling reconciliation
 * (`BillingSubscriptionsService.refresh`, `BillingRefundsService.due`/`reconcile`) belongs to the
 * consumer's job host.
 */
@Module({})
export class BackOfficeBillingModule {
  static forRoot(input: BackOfficeBillingOptions): DynamicModule {
    const options = resolveBillingOptions(input);
    const database = options.database ?? DATABASE_ADAPTER;
    const ports = options.ports ?? {};
    const port = (token: symbol, type: Type<unknown> | undefined): Provider[] => (type ? [{ provide: token, useClass: type }] : []);
    const providers: Provider[] = [
      { provide: BILLING_OPTIONS, useValue: options },
      ...port(BILLING_CHECKOUT_HOOKS, ports.checkout),
      ...port(BILLING_REFUND_HOOKS, ports.refunds),
      ...port(BILLING_CHECKOUT_POLICY, ports.policy),
    ];
    if (ports.credentialArchive) providers.push('token' in ports.credentialArchive
      ? { provide: BILLING_CREDENTIAL_ARCHIVE, useExisting: ports.credentialArchive.token }
      : { provide: BILLING_CREDENTIAL_ARCHIVE, useClass: ports.credentialArchive });
    if (options.service) providers.push({ provide: BILLING_SERVICE, useExisting: options.service });
    else {
      providers.push({ provide: BILLING_RUNTIME, inject: options.runtime!.inject ?? [], useFactory: options.runtime!.useFactory as (...args: unknown[]) => unknown });
      providers.push({
        provide: BILLING_SERVICE,
        inject: [database, BILLING_RUNTIME, { token: BILLING_CHECKOUT_HOOKS, optional: true }, { token: BILLING_REFUND_HOOKS, optional: true },
          { token: BILLING_CHECKOUT_POLICY, optional: true }],
        useFactory: (db: BillingDatabase, runtime: BillingRuntimeSource, checkout?: BillingCheckoutHooks, refunds?: BillingRefundHooks,
          policy?: BillingCheckoutPolicyProvider) => new BillingService(db, runtime, billingServiceConfig(options, { checkout, refunds, policy })),
      });
    }
    providers.push({
      provide: BILLING_REFUND_SUMMARY, inject: [database, BILLING_SERVICE],
      useFactory: (db: BillingDatabase, billing: BillingService): BillingRefundSummary => ({
        summarize: order => readOrderRefundSummary(db, order as Pick<HostedCheckoutOrder, 'id' | 'ownerId' | 'providerId' | 'accountScope' | 'paymentId' | 'paymentKind'>, billing.persistence.storage),
      }),
    });
    const exports: InjectionToken[] = [BILLING_SERVICE, BILLING_OPTIONS, BILLING_REFUND_SUMMARY];
    const settings: BillingControllerSettings = { service: BILLING_SERVICE, trustedOrigins: options.trustedOrigins, guards: options.guards,
      rateLimit: options.rateLimit, webhookRateLimit: options.webhookRateLimit };
    const { features, paths, permissions } = options;
    const controllers: Type<unknown>[] = [];
    if (features.orders) controllers.push(createBillingController({ ...settings, path: paths.billing, balance: !!options.persistence.credits?.balance || !!options.service }));
    if (features.subscriptions) controllers.push(createBillingSubscriptionsController({ ...settings, path: paths.subscriptions }));
    if (features.refunds) controllers.push(createBillingRefundsController({ ...settings, path: paths.refunds, permission: permissions.refund }));
    if (features.recovery) controllers.push(createBillingOrderRecoveryController({ ...settings, path: paths.recovery, permission: permissions.recover }));
    if (features.paymentCredentials) {
      providers.push({
        provide: BILLING_CREDENTIAL_RETENTION, inject: [database, BILLING_SERVICE, { token: BILLING_CREDENTIAL_ARCHIVE, optional: true }],
        useFactory: (db: BillingDatabase, billing: BillingService, archive?: PaymentCredentialArchive) => new PaymentCredentialRetention(db, billing, archive, {
          retentionDays: options.paymentCredentials?.retentionDays, profiles: options.paymentCredentials?.profiles,
          storage: billing.persistence.storage, isOperator: options.paymentCredentials?.operator }),
      });
      exports.push(BILLING_CREDENTIAL_RETENTION);
      controllers.push(createPaymentCredentialsController({ ...settings, retention: BILLING_CREDENTIAL_RETENTION, path: paths.paymentCredentials,
        permission: permissions.paymentCredentials }));
    }
    if (features.creditPacks) {
      providers.push({ provide: BILLING_CREDIT_PACK_ADMIN, inject: [BILLING_SERVICE], useFactory: (billing: BillingService) => creditPackAdminPort(billing) });
      // Same list/detail/create/update/status/delete contract and `plans:*` permissions as plan administration.
      controllers.push(createPlanAdminController({ path: paths.creditPacks, service: BILLING_CREDIT_PACK_ADMIN, auditModule: 'credit-packs', guards: options.guards }));
    }
    if (features.testCheckout) controllers.push(createFakeCheckoutController({ service: BILLING_SERVICE, path: paths.testCheckout,
      rateLimit: options.webhookRateLimit, ...options.testCheckout! }));
    return { module: BackOfficeBillingModule, imports: options.imports ?? [], controllers, providers, exports };
  }
}

/** The `BillingServiceConfig` the module builds from resolved options and port instances. */
export function billingServiceConfig(options: ResolvedBillingOptions, ports: {
  checkout?: BillingCheckoutHooks; refunds?: BillingRefundHooks; policy?: BillingCheckoutPolicyProvider;
} = {}) {
  return { persistence: options.persistence, referrals: options.referrals ?? null,
    policy: ports.policy ? () => ports.policy!.values() : null, checkout: ports.checkout, refunds: ports.refunds,
    returnUrls: options.returnUrls, portalReturnPath: options.portalReturnPath };
}

/** Credit packs satisfy the plan administration port structurally except for the record type; the wire contract is CreditPack. */
export function creditPackAdminPort(billing: BillingService): PlanAdminPort {
  if (!billing.packs) throw new Error('[back-office/billing] credit pack administration needs a credit ledger');
  return billing.packs as unknown as PlanAdminPort;
}
