import { createBillingController } from '@zucker-framework/back-office/billing';
import { BillingService } from './billing.service';
import { BILLING_WEBHOOK_LIMITER } from '../rate-limits';
import { accountOrigins } from './billing.config';

/** `/billing` orders and provider webhooks (global AccountGuard/PermissionsGuard enforce the metadata). */
export const BillingController = createBillingController({ service: BillingService, trustedOrigins: accountOrigins, guards: [],
  rateLimit: 'billing', webhookRateLimit: BILLING_WEBHOOK_LIMITER });
