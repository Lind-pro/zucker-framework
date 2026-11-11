import type { Type } from '@nestjs/common';
import { FakeCheckoutController } from './fake-checkout.controller';
import { billingTestFakesEnabled } from './switch';

export * from './switch';
export {
  createBillingTestFakes, findFakePaymentLedger, signFakeWebhook, verifyFakeWebhook, FakePaymentLedger, FAKE_PAYMENT_LEDGER,
  type FakeCheckoutAdapter, type FakeCheckoutEvidence, type FakeSignedWebhook, type FakeWebhookEnvelope, type FakeWebhookType,
} from './fake-payment-provider';
export { FakeCheckoutController } from './fake-checkout.controller';

/** Controllers for `BillingModule`: the test checkout only when the switch is on (throws in production). */
export function billingTestFakeControllers(env: Readonly<Record<string, string | undefined>>): Type[] {
  return billingTestFakesEnabled(env) ? [FakeCheckoutController] : [];
}
