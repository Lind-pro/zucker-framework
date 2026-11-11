// Billing host (work package F4): orders, provider webhooks, subscriptions, refunds (including plan
// orders), order recovery, payment credential revisions, credit packs and the TEST-ONLY fake provider.
export { BackOfficeBillingModule, billingServiceConfig, creditPackAdminPort, type BillingRefundSummary } from './billing.module';
export {
  resolveBillingOptions, BILLING_FEATURES, DEFAULT_BILLING_PATHS, DEFAULT_BILLING_PERMISSIONS,
  type BackOfficeBillingOptions, type ResolvedBillingOptions, type BillingFeature, type BillingCheckoutPolicyProvider,
} from './billing.options';
export {
  BILLING_SERVICE, BILLING_OPTIONS, BILLING_RUNTIME, BILLING_CREDENTIAL_RETENTION, BILLING_REFUND_SUMMARY, BILLING_CREDIT_PACK_ADMIN,
  BILLING_FAKE_LEDGER_SOURCE, BILLING_CHECKOUT_HOOKS, BILLING_REFUND_HOOKS, BILLING_CHECKOUT_POLICY, BILLING_CREDENTIAL_ARCHIVE,
} from './billing.tokens';
export {
  billingTransaction, BillingStorage, DEFAULT_BILLING_STORAGE, DEFAULT_BILLING_MODELS, DEFAULT_BILLING_TABLES, creditAccountLock, advisoryAccountLock,
  type BillingDatabase, type BillingTransaction, type BillingSqlClient, type BillingModelKey, type BillingTableKey, type BillingAccountLock,
} from './billing.database';
export { billingPersistenceConfig, CREDITS_UNAVAILABLE, type BillingPersistenceConfig } from './billing.config';
export type {
  BillingCredits, BillingCreditLedger, BillingReferrals, BillingCheckoutPolicyValues, BillingCheckoutPolicySource, BillingPlanOffers,
  BillingPaymentRefunded, BillingFulfillmentHooks, BillingPromotions, BillingCheckoutHooks, BillingRefundAdmissionInput,
  BillingRefundSettledInput, BillingRefundHooks,
} from './billing.ports';
export { BillingExtensions, soldAsPlan, assertPlanFulfillment } from './billing-extensions';
export {
  BillingService, promoInvalid, publicCheckoutOrder,
  type BillingRuntimeOptions, type BillingRuntimeSource, type BillingServiceConfig,
} from './billing.service';
export { BillingCatalog, readBillingCatalog, type BillingCatalogItem, type BillingPackOffers } from './catalog';
export { createCheckoutPersistence, CHECKOUT_FULFILLED_OUTBOX_KIND } from './checkout-persistence';
export {
  bindCheckoutSubscription, createSubscriptionCyclePersistence, SUBSCRIPTION_RECONCILE_EVENT, SUBSCRIPTION_CREDIT_FULFILLED_OUTBOX_KIND,
  type BillingSubscription, type BillingExecutionFence, type SubscriptionExecutionFence,
} from './subscription-persistence';
export { nextSubscriptionReconcileAt, SUBSCRIPTION_RECONCILE_PARKED_AT, TERMINAL_SUBSCRIPTION_STATUSES, type SubscriptionScheduleFacts } from './subscription-schedule';
export { BillingSubscriptionsService, type BillingSubscriptionsServiceOptions } from './subscriptions.service';
export {
  validateCreditFulfillmentPolicy, paidPeriodEnd, creditExpiresAt, checkoutCreditOperation, type CreditFulfillmentPolicy,
} from './credit-policy';
export { createCreditPackStore, creditPacksConfigured, presentCreditPack, CREDIT_PACK_INCLUDE } from './credit-packs.store';
export {
  PaymentCredentialResolver, staticAccountAdapters, verifyWithCandidates, recordedPaymentRevision, paymentRevisionLabel,
  type PaymentCredentialSettings, type PaymentCredentialEntry, type AccountAdapterSource, type PaymentCredentialResolverOptions,
  type PaymentProviderSet, type PaymentProfileDescriptor, type PaymentProfileMap,
} from './payment-credentials';
export {
  PaymentCredentialRetention, parsePaymentPurgeRequest, paymentRevisionRetentionDays, superadminOperator, PAYMENT_REVISION_RETENTION_MIN_DAYS,
  type PaymentCredentialArchive, type PaymentCredentialOperatorCheck, type PaymentRevisionHold, type PaymentRevisionStatus,
  type PaymentPurgeRequest, type PaymentPurgeContext, type PaymentCredentialRetentionOptions,
} from './payment-credential-retention';
export {
  BillingRefundsService, PAYMENT_REFUNDED_OUTBOX_KIND, PLAN_REFUND_UNAPPLIED_OUTBOX_KIND, REFUND_SETTLED_OUTBOX_KIND, REFUND_RECONCILE_OUTBOX_KIND,
  type BillingRefundsServiceOptions,
} from './refunds/refunds.service';
export { readOrderRefundSummary, type PublicRefundSummary, type RefundSummaryOrder } from './refunds/refunds.projection';
export { minorAmount, minorMoney, requiredCredits } from './refunds/refunds.money';
export type { RefundTargetType, RefundRequestState, RefundTargetRow, RefundRequestRow } from './refunds/refunds.types';
export {
  createBillingController, createBillingSubscriptionsController, createBillingRefundsController, createBillingOrderRecoveryController,
  createPaymentCredentialsController, createFakeCheckoutController, type BillingControllerSettings,
} from './billing.controllers';
export {
  createFakePaymentProvider, fakeCheckoutBaseUrl, FakePaymentLedger, findFakePaymentLedger, signFakeWebhook, verifyFakeWebhook, parseFakeMoney,
  isFakeCheckoutId, isFakeSubscriptionId, isFakeRefundId, FAKE_PAYMENT_LEDGER, FAKE_PAYMENT_PROVIDER_ID, FAKE_PAYMENT_ACCOUNT_SCOPE,
  FAKE_WEBHOOK_SECRET, FAKE_SIGNATURE_HEADER,
  type FakeCheckoutAdapter, type FakeCheckoutEvidence, type FakeSignedWebhook, type FakeWebhookEnvelope, type FakeWebhookType,
  type FakePaymentProviderOptions,
} from './test-fakes/fake-payment-provider';
