import { definePolicy } from '../policy/policy.registry';

const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;

export interface BillingPolicyValues {
  [key: string]: string | boolean;
  /** Provider id preselected at checkout ('' = the first provider that can sell the offer). */
  defaultProvider: string;
  /** When false, checkout accepts only `defaultProvider` (if it is enabled) and the pricing page hides the choice. */
  allowProviderChoice: boolean;
}

/**
 * Checkout provider choice. Both fields are public (`GET /site/public/config`) because the pricing page
 * needs them before sign-in; neither is a secret. Register with
 * `PolicyModule.forRoot({ policies: [...BILLING_POLICIES] })`.
 */
export const BILLING_POLICY = definePolicy<BillingPolicyValues>({
  id: 'billing',
  name: 'Billing',
  fields: [
    { key: 'defaultProvider', type: 'text', default: '', max: 32, public: true, label: 'Default payment provider',
      description: 'Provider id (stripe, paypal, creem, …) preselected at checkout; empty uses the first available.' },
    { key: 'allowProviderChoice', type: 'boolean', default: true, public: true, label: 'Let buyers choose the provider',
      description: 'When off, checkout uses only the default provider (if it is enabled).' },
  ],
  validate(values) {
    if (values.defaultProvider !== '' && !PROVIDER.test(values.defaultProvider)) throw new Error('defaultProvider must be a provider id or empty');
  },
});
export const BILLING_POLICIES = [BILLING_POLICY] as const;
