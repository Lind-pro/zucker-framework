/**
 * TEST-ONLY switch for checkout, renewal and refund runs without a paid payment provider (local
 * demos and the real-stack acceptance run). Mirrors `AI_TEST_FAKE_PROVIDERS`:
 * `BILLING_TEST_FAKE_PROVIDER=true` adds the in-memory `fake` provider (checkout, subscription and
 * refund adapters, account scope `fake-test`) and mounts `/api/billing/test-checkout/*`. Any other
 * non-empty value except `false` is a configuration error, and the switch is refused when
 * `NODE_ENV=production`, so a production server can never take a fake payment.
 *
 * This file imports only constants, so it can be imported by provider and module composition.
 */
export const BILLING_TEST_FAKE_PROVIDER_ENV = 'BILLING_TEST_FAKE_PROVIDER';
/** Optional absolute base of the hosted page; default `${WEB_URL}/api/billing/test-checkout` (the web proxy). */
export const BILLING_TEST_FAKE_CHECKOUT_URL_ENV = 'BILLING_TEST_FAKE_CHECKOUT_URL';

// The fake provider itself (constants, ledger, adapters, hosted page) lives in the billing host.
export {
  FAKE_PAYMENT_PROVIDER_ID, FAKE_PAYMENT_ACCOUNT_SCOPE, FAKE_WEBHOOK_SECRET, FAKE_SIGNATURE_HEADER,
} from '@zucker-framework/back-office/billing';

type Env = Readonly<Record<string, string | undefined>>;

export function billingTestFakesEnabled(env: Env): boolean {
  const value = env[BILLING_TEST_FAKE_PROVIDER_ENV]?.trim();
  if (!value || value === 'false') return false;
  if (value !== 'true') throw new Error(`${BILLING_TEST_FAKE_PROVIDER_ENV} must be true or false`);
  assertNotProduction(env);
  return true;
}

/** Defence in depth: every fake entry point (adapters, controller) calls this, not only the switch. */
export function assertNotProduction(env: Env): void {
  if (env.NODE_ENV === 'production')
    throw new Error(`${BILLING_TEST_FAKE_PROVIDER_ENV} is a test-only switch and is refused when NODE_ENV=production`);
}
