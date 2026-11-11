import { definePolicy } from '@zucker-framework/back-office/settings';

const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;

export interface BillingPolicyValues {
  [key: string]: string | boolean;
  /** Provider id preselected at checkout ('' = the first provider that can sell the offer). */
  defaultProvider: string;
  /** When false, checkout accepts only `defaultProvider` (if it is enabled) and the pricing page hides the choice. */
  allowProviderChoice: boolean;
  /** When true (and promotions are installed), buyers may enter a promotion alias at checkout. */
  allowCustomerPromoCodes: boolean;
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
    { key: 'allowCustomerPromoCodes', type: 'boolean', default: false, public: true, label: 'Let buyers enter promo codes',
      description: 'Shows a promo code field at checkout. Codes are managed under Promotions; automatic promotions apply either way.' },
  ],
  validate(values) {
    if (values.defaultProvider !== '' && !PROVIDER.test(values.defaultProvider)) throw new Error('defaultProvider must be a provider id or empty');
  },
});
export const BILLING_POLICIES = [BILLING_POLICY] as const;
