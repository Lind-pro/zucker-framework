import { createFakeCheckoutController, findFakePaymentLedger } from '@zucker-framework/back-office/billing';
import { BILLING_OPTIONS, BillingService, type BillingOptionsSource } from '../billing.service';
import { BILLING_WEBHOOK_LIMITER } from '../../rate-limits';
import { assertNotProduction } from './switch';

/**
 * TEST-ONLY hosted checkout of the `fake` provider (`/billing/test-checkout/*`), mounted only when
 * `BILLING_TEST_FAKE_PROVIDER=true` (see `billingTestFakeControllers`) and refused when
 * `NODE_ENV=production`. The ledger is found among the providers of BILLING_OPTIONS.
 */
export const FakeCheckoutController = createFakeCheckoutController({
  service: BillingService,
  ledgerSource: BILLING_OPTIONS,
  ledger: (_billing, source) => {
    const options = source as BillingOptionsSource | undefined;
    if (!options) return null;
    return findFakePaymentLedger((typeof options === 'function' ? options() : options).providers);
  },
  rateLimit: BILLING_WEBHOOK_LIMITER,
  assertAllowed: () => assertNotProduction(process.env),
});
