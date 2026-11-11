import { Inject, Injectable, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  BillingService as BillingHost, type BillingCheckoutPolicySource, type BillingRuntimeOptions,
} from '@zucker-framework/back-office/billing';
import type { ReferralProvider } from '@zucker-framework/fe-site';
import { ApplicationDatabase } from '../database';
import { configuredBillingProviders } from './providers';
import { BILLING_POLICY } from './billing.policy';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { TEMPLATE_BILLING_PERSISTENCE, templateBillingReferrals } from './billing.config';

export { promoInvalid, publicCheckoutOrder, type BillingPromotions } from '@zucker-framework/back-office/billing';

export const BILLING_OPTIONS = Symbol('BILLING_OPTIONS');

/** Template runtime options: the host's runtime options plus the affiliate programs enabled at start-up. */
export interface BillingOptions extends BillingRuntimeOptions {
  referralProviders?: readonly ReferralProvider[];
}
/**
 * BILLING_OPTIONS may be a value or a resolver. With a resolver, the static catalog and the config
 * revision recorded on new orders follow the resolver on every call. Payment provider instances follow
 * the saved payment configuration through `credentials`.
 */
export type BillingOptionsSource = BillingOptions | (() => BillingOptions);
export function billingOptionsFromEnvironment(env: NodeJS.ProcessEnv): BillingOptions {
  const referrals = (env.BILLING_REFERRAL_PROVIDERS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (referrals.some(value => value !== 'affonso' && value !== 'promotekit')) throw new Error('Unsupported billing referral provider');
  const providers = configuredBillingProviders(env);
  return { providers: providers.checkouts, subscriptionProviders: providers.subscriptions, refundProviders: providers.refunds, catalogJson: env.BILLING_CATALOG_JSON,
    webUrl: env.WEB_URL ?? 'http://localhost:4202', referralProviders: referrals as ReferralProvider[] };
}

/** The `billing` product policy when the policy module registered it, else the host defaults. */
function templateCheckoutPolicy(policies?: PolicyService): BillingCheckoutPolicySource | null {
  if (!policies) return null;
  return async () => policies.ids().includes(BILLING_POLICY.id) ? policies.get(BILLING_POLICY)
    : { defaultProvider: '', allowProviderChoice: true, allowCustomerPromoCodes: false };
}

/**
 * The template's billing service: `@zucker-framework/back-office/billing` over the template database,
 * its credit ledger, `BILLING_OPTIONS` (environment / hot-applied payment profiles) and the `billing` policy.
 */
@Injectable()
export class BillingService extends BillingHost {
  constructor(@Inject(DATABASE_ADAPTER) database: ApplicationDatabase,
    @Inject(BILLING_OPTIONS) source: BillingOptionsSource,
    @Optional() policies?: PolicyService) {
    const initial = typeof source === 'function' ? source() : source;
    super(database, source, { persistence: TEMPLATE_BILLING_PERSISTENCE, referrals: templateBillingReferrals(initial.referralProviders),
      policy: templateCheckoutPolicy(policies) });
  }
}
