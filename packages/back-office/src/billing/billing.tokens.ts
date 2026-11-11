import { backOfficeToken } from '../shared/tokens';

/** The {@link BillingService} instance used by the billing controllers (exported by `BackOfficeBillingModule`). */
export const BILLING_SERVICE = backOfficeToken('billing', 'service');
/** Resolved `BackOfficeBillingOptions`. */
export const BILLING_OPTIONS = backOfficeToken('billing', 'options');
/** `BillingRuntimeSource` (provider instances, static catalog, site URL) when the module builds the service. */
export const BILLING_RUNTIME = backOfficeToken('billing', 'runtime');
/** `PaymentCredentialRetention` (D13 inventory and purge). */
export const BILLING_CREDENTIAL_RETENTION = backOfficeToken('billing', 'credentialRetention');
/** Refund summary of one order (satisfies `ManagementRefundSummaryPort` of `/management`). */
export const BILLING_REFUND_SUMMARY = backOfficeToken('billing', 'refundSummary');
/** Credit pack administration port (`PlanAdminPort` shape over `CreditPackCatalogService`). */
export const BILLING_CREDIT_PACK_ADMIN = backOfficeToken('billing', 'creditPackAdmin');
/** Optional provider handed to the test checkout's ledger lookup. */
export const BILLING_FAKE_LEDGER_SOURCE = backOfficeToken('billing', 'fakeLedgerSource');
// Port tokens (registered from `ports.*` classes).
export const BILLING_CHECKOUT_HOOKS = backOfficeToken('billing', 'checkoutHooks');
export const BILLING_REFUND_HOOKS = backOfficeToken('billing', 'refundHooks');
export const BILLING_CHECKOUT_POLICY = backOfficeToken('billing', 'checkoutPolicy');
export const BILLING_CREDENTIAL_ARCHIVE = backOfficeToken('billing', 'credentialArchive');
