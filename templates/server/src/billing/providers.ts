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

/** Adapters of one payment provider built from one configuration (checkout, renewal and refund). */
export interface PaymentProviderSet { checkout: HostedCheckoutAdapter; subscription?: SubscriptionAdapter; refund?: RefundAdapter }

/** Providers whose credentials are saved connection profiles (`payment-<id>`). */
export const PAYMENT_PROFILE_PROVIDERS = Object.freeze({
  stripe: Object.freeze({ profileId: 'payment-stripe', modeKey: 'BILLING_STRIPE_MODE', scopeKey: 'BILLING_STRIPE_ACCOUNT_SCOPE', webhookKeys: ['STRIPE_WEBHOOK_SECRET'] }),
  paypal: Object.freeze({ profileId: 'payment-paypal', modeKey: 'BILLING_PAYPAL_MODE', scopeKey: 'BILLING_PAYPAL_ACCOUNT_SCOPE', webhookKeys: [] as string[] }),
  creem: Object.freeze({ profileId: 'payment-creem', modeKey: 'BILLING_CREEM_MODE', scopeKey: 'BILLING_CREEM_ACCOUNT_SCOPE', webhookKeys: ['CREEM_WEBHOOK_SECRET'] }),
});
export type PaymentProfileProviderId = keyof typeof PAYMENT_PROFILE_PROVIDERS;
export function isPaymentProfileProvider(id: string): id is PaymentProfileProviderId { return Object.hasOwn(PAYMENT_PROFILE_PROVIDERS, id); }

/**
 * Builds the adapters of ONE profile provider from `env`, or undefined when it is not enabled there.
 * Construction is local (no charge, account mutation or network request). Throws on invalid settings.
 */
export function paymentProviderSet(env: NodeJS.ProcessEnv, id: PaymentProfileProviderId): PaymentProviderSet | undefined {
  if (id === 'stripe') {
    if (env.BILLING_STRIPE_ENABLED !== 'true') return undefined;
    const mode = required(env, 'BILLING_STRIPE_MODE');
    if (!['test', 'live'].includes(mode)) throw new Error('BILLING_STRIPE_MODE must be test or live');
    const stripe = {
      client: createStripeClient(required(env, 'STRIPE_SECRET_KEY'), { maxNetworkRetries: 0 }),
      accountScope: required(env, 'BILLING_STRIPE_ACCOUNT_SCOPE'), livemode: mode === 'live',
      webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    };
    return { checkout: createStripeHostedCheckoutAdapter(stripe), subscription: createStripeSubscriptionAdapter(stripe), refund: createStripeRefundAdapter(stripe) };
  }
  if (id === 'paypal') {
    if (env.BILLING_PAYPAL_ENABLED !== 'true') return undefined;
    const mode = required(env, 'BILLING_PAYPAL_MODE');
    if (mode !== 'sandbox' && mode !== 'live') throw new Error('BILLING_PAYPAL_MODE must be sandbox or live');
    const paypal = {
      transport: new PayPalPaymentTransport({ clientId: required(env, 'PAYPAL_CLIENT_ID'),
        clientSecret: required(env, 'PAYPAL_CLIENT_SECRET'), mode }),
      accountScope: required(env, 'BILLING_PAYPAL_ACCOUNT_SCOPE'), webhookId: required(env, 'PAYPAL_WEBHOOK_ID'),
    };
    return { checkout: createPayPalHostedCheckoutAdapter(paypal), subscription: createPayPalSubscriptionAdapter(paypal), refund: createPayPalRefundAdapter(paypal) };
  }
  if (env.BILLING_CREEM_ENABLED !== 'true') return undefined;
  const environment = required(env, 'BILLING_CREEM_MODE');
  if (environment !== 'test' && environment !== 'production') throw new Error('BILLING_CREEM_MODE must be test or production');
  const adapter = createCreemAdapter({ apiKey: required(env, 'CREEM_API_KEY'), environment,
    webhookSecret: required(env, 'CREEM_WEBHOOK_SECRET') });
  const accountScope = required(env, 'BILLING_CREEM_ACCOUNT_SCOPE');
  return { checkout: createCreemHostedCheckoutAdapter({ adapter, accountScope }),
    subscription: createCreemSubscriptionAdapter({ transport: adapter, accountScope }), refund: createCreemRefundAdapter({ transport: adapter, accountScope }) };
}

/**
 * Providers that are NOT connection profiles and stay fixed for the process lifetime: only the
 * TEST-ONLY in-memory `fake` provider (BILLING_TEST_FAKE_PROVIDER=true; refused when NODE_ENV=production).
 */
export function fixedBillingProviders(env: NodeJS.ProcessEnv): PaymentProviderSet[] {
  if (!billingTestFakesEnabled(env)) return [];
  const fakes = createBillingTestFakes(env);
  return [{ checkout: fakes.checkout, subscription: fakes.subscription, refund: fakes.refund }];
}

/** No provider is enabled implicitly. SDK construction performs no charge or account mutation. */
export function configuredBillingProviders(env: NodeJS.ProcessEnv): { checkouts: HostedCheckoutAdapter[]; subscriptions: SubscriptionAdapter[]; refunds: RefundAdapter[] } {
  const sets: PaymentProviderSet[] = [];
  for (const id of ['stripe', 'paypal', 'creem'] as const) { const set = paymentProviderSet(env, id); if (set) sets.push(set); }
  sets.push(...fixedBillingProviders(env));
  return { checkouts: sets.map(set => set.checkout), subscriptions: sets.flatMap(set => set.subscription ? [set.subscription] : []),
    refunds: sets.flatMap(set => set.refund ? [set.refund] : []) };
}

export function configuredCheckoutProviders(env: NodeJS.ProcessEnv): HostedCheckoutAdapter[] {
  return configuredBillingProviders(env).checkouts;
}
