import {
  createStripeClient, createStripeHostedCheckoutAdapter,
  PayPalPaymentTransport, createPayPalHostedCheckoutAdapter,
  createCreemAdapter, createCreemHostedCheckoutAdapter,
  createStripeSubscriptionAdapter, createPayPalSubscriptionAdapter, createCreemSubscriptionAdapter,
  createStripeRefundAdapter, createPayPalRefundAdapter, createCreemRefundAdapter,
  type HostedCheckoutAdapter, type SubscriptionAdapter, type RefundAdapter,
} from '@zucker-framework/payment';
// Direct file imports (not './test-fakes'): its index pulls the controller, which imports billing.
import { billingTestFakesEnabled } from './test-fakes/switch';
import { createBillingTestFakes } from './test-fakes/fake-payment-provider';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for the enabled payment provider`);
  return value;
}

/** No provider is enabled implicitly. SDK construction performs no charge or account mutation. */
export function configuredBillingProviders(env: NodeJS.ProcessEnv): { checkouts: HostedCheckoutAdapter[]; subscriptions: SubscriptionAdapter[]; refunds: RefundAdapter[] } {
  const providers: HostedCheckoutAdapter[] = [];
  const subscriptions: SubscriptionAdapter[] = [];
  const refunds: RefundAdapter[] = [];
  if (env.BILLING_STRIPE_ENABLED === 'true') {
    const mode = required(env, 'BILLING_STRIPE_MODE');
    if (!['test', 'live'].includes(mode)) throw new Error('BILLING_STRIPE_MODE must be test or live');
    const stripe = {
      client: createStripeClient(required(env, 'STRIPE_SECRET_KEY'), { maxNetworkRetries: 0 }),
      accountScope: required(env, 'BILLING_STRIPE_ACCOUNT_SCOPE'), livemode: mode === 'live',
      webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    };
    providers.push(createStripeHostedCheckoutAdapter(stripe));
    subscriptions.push(createStripeSubscriptionAdapter(stripe));
    refunds.push(createStripeRefundAdapter(stripe));
  }
  if (env.BILLING_PAYPAL_ENABLED === 'true') {
    const mode = required(env, 'BILLING_PAYPAL_MODE');
    if (mode !== 'sandbox' && mode !== 'live') throw new Error('BILLING_PAYPAL_MODE must be sandbox or live');
    const paypal = {
      transport: new PayPalPaymentTransport({ clientId: required(env, 'PAYPAL_CLIENT_ID'),
        clientSecret: required(env, 'PAYPAL_CLIENT_SECRET'), mode }),
      accountScope: required(env, 'BILLING_PAYPAL_ACCOUNT_SCOPE'), webhookId: required(env, 'PAYPAL_WEBHOOK_ID'),
    };
    providers.push(createPayPalHostedCheckoutAdapter(paypal));
    subscriptions.push(createPayPalSubscriptionAdapter(paypal));
    refunds.push(createPayPalRefundAdapter(paypal));
  }
  if (env.BILLING_CREEM_ENABLED === 'true') {
    const environment = required(env, 'BILLING_CREEM_MODE');
    if (environment !== 'test' && environment !== 'production') throw new Error('BILLING_CREEM_MODE must be test or production');
    const adapter = createCreemAdapter({ apiKey: required(env, 'CREEM_API_KEY'), environment,
      webhookSecret: required(env, 'CREEM_WEBHOOK_SECRET') });
    const accountScope = required(env, 'BILLING_CREEM_ACCOUNT_SCOPE');
    providers.push(createCreemHostedCheckoutAdapter({ adapter, accountScope }));
    subscriptions.push(createCreemSubscriptionAdapter({ transport: adapter, accountScope }));
    refunds.push(createCreemRefundAdapter({ transport: adapter, accountScope }));
  }
  // TEST-ONLY in-memory provider `fake` (BILLING_TEST_FAKE_PROVIDER=true; refused when NODE_ENV=production).
  if (billingTestFakesEnabled(env)) {
    const fakes = createBillingTestFakes(env);
    providers.push(fakes.checkout);
    subscriptions.push(fakes.subscription);
    refunds.push(fakes.refund);
  }
  return { checkouts: providers, subscriptions, refunds };
}

export function configuredCheckoutProviders(env: NodeJS.ProcessEnv): HostedCheckoutAdapter[] {
  return configuredBillingProviders(env).checkouts;
}
