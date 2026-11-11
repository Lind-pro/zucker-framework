import { createBillingRefundsController } from '@zucker-framework/back-office/billing';
import { BillingService } from '../billing.service';
import { accountOrigins } from '../billing.config';

/** `/billing/refunds` (`billing:refund`; global AccountGuard/PermissionsGuard enforce the metadata). */
export const BillingRefundsController = createBillingRefundsController({ service: BillingService, trustedOrigins: accountOrigins,
  guards: [], rateLimit: 'billing' });
