import { createFakePaymentProvider, type FakeCheckoutAdapter, type FakePaymentLedger } from '@zucker-framework/back-office/billing';
import type { RefundAdapter, SubscriptionAdapter } from '@zucker-framework/payment';
import { assertNotProduction, BILLING_TEST_FAKE_CHECKOUT_URL_ENV } from './switch';

export {
  FakePaymentLedger, FAKE_PAYMENT_LEDGER, findFakePaymentLedger, signFakeWebhook, verifyFakeWebhook, parseFakeMoney,
  isFakeCheckoutId, isFakeSubscriptionId, isFakeRefundId,
  type FakeCheckoutAdapter, type FakeCheckoutEvidence, type FakeSignedWebhook, type FakeWebhookEnvelope, type FakeWebhookType,
} from '@zucker-framework/back-office/billing';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * TEST-ONLY adapters with id `fake` and account scope `fake-test`, sharing one in-memory ledger.
 * Refuses to construct when `NODE_ENV=production`, independently of the switch. The hosted page base
 * is `BILLING_TEST_FAKE_CHECKOUT_URL`, else `${WEB_URL}/api/billing/test-checkout` (the web proxy).
 */
export function createBillingTestFakes(env: Env, options: { periodDays?: number } = {}): {
  checkout: FakeCheckoutAdapter; subscription: SubscriptionAdapter; refund: RefundAdapter; ledger: FakePaymentLedger;
} {
  assertNotProduction(env);
  const configured = env[BILLING_TEST_FAKE_CHECKOUT_URL_ENV]?.trim();
  const checkoutBaseUrl = configured || `${(env.WEB_URL?.trim() || 'http://localhost:4202').replace(/\/+$/, '')}/api/billing/test-checkout`;
  try {
    return createFakePaymentProvider({ checkoutBaseUrl, periodDays: options.periodDays });
  } catch (error) {
    if (error instanceof Error && /URL/.test(error.message)) throw new Error(error.message.replace('Fake checkout URL', BILLING_TEST_FAKE_CHECKOUT_URL_ENV));
    throw error;
  }
}
