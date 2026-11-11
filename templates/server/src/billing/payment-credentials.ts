import {
  PaymentCredentialResolver as HostPaymentCredentialResolver, type PaymentCredentialResolverOptions, type PaymentCredentialSettings,
} from '@zucker-framework/back-office/billing';
import { PAYMENT_PROFILE_PROVIDERS, paymentProviderSet } from './providers';

export {
  staticAccountAdapters, verifyWithCandidates, recordedPaymentRevision, paymentRevisionLabel,
  type PaymentCredentialSettings, type PaymentCredentialEntry, type AccountAdapterSource,
} from '@zucker-framework/back-office/billing';

/**
 * Hot-applied payment credentials (WP 4.1c, decision D12) over the template's `payment-<id>`
 * connection profiles; see the billing host's `PaymentCredentialResolver`.
 */
export class PaymentCredentialResolver extends HostPaymentCredentialResolver {
  constructor(settings: PaymentCredentialSettings, options: Partial<PaymentCredentialResolverOptions> = {}) {
    super(settings, { profiles: PAYMENT_PROFILE_PROVIDERS, factory: (env, id) => paymentProviderSet(env, id as keyof typeof PAYMENT_PROFILE_PROVIDERS), ...options });
  }
}
export type { PaymentCredentialResolverOptions };
