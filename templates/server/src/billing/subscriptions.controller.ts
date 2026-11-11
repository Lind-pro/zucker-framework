import { createBillingSubscriptionsController } from '@zucker-framework/back-office/billing';
import { BillingService } from './billing.service';
import { accountOrigins } from './billing.config';

/** `/billing/subscriptions` (global AccountGuard/PermissionsGuard enforce the metadata). */
export const BillingSubscriptionsController = createBillingSubscriptionsController({ service: BillingService, trustedOrigins: accountOrigins,
  guards: [], rateLimit: 'billing' });
