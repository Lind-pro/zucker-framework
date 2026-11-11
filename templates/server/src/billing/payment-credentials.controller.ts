import { createPaymentCredentialsController } from '@zucker-framework/back-office/billing';
import { PaymentCredentialRetention } from './payment-credential-retention';
import { accountOrigins } from './billing.config';

/**
 * `/management/payment-credentials` (D13): retained payment credential revisions and the operator
 * purge. `config:update` at the guard plus the `superadmin` role in the service; trusted Origin on
 * the write. Responses carry revision numbers, dates, hold reasons and counts only, never values.
 */
export const PaymentCredentialsController = createPaymentCredentialsController({ retention: PaymentCredentialRetention,
  trustedOrigins: accountOrigins, guards: [] });
