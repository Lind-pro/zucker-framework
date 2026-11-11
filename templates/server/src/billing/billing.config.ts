import { billingPersistenceConfig, DEFAULT_BILLING_STORAGE, type BillingCredits, type BillingReferrals } from '@zucker-framework/back-office/billing';
import { referralMetadata, type ReferralProvider } from '@zucker-framework/fe-site';
import type { ApplicationDatabase } from '../database';
import { readCreditBalance } from '../credits/credits.service';
import { createCreditLedger } from './ledger';

/**
 * Template billing configuration for `@zucker-framework/back-office/billing`: the template's Prisma
 * models and tables (the host defaults), the credit ledger's account lock (default) and this
 * template's credit ledger, so credit packs, credit-granting offers and credit-recovering refunds work.
 */
export const TEMPLATE_BILLING_CREDITS: BillingCredits = {
  ledger: (database, options) => createCreditLedger(database as ApplicationDatabase, options) as unknown as ReturnType<BillingCredits['ledger']>,
  balance: (database, ownerId) => readCreditBalance(database as ApplicationDatabase, ownerId),
};
export const TEMPLATE_BILLING_PERSISTENCE = billingPersistenceConfig({ storage: DEFAULT_BILLING_STORAGE, credits: TEMPLATE_BILLING_CREDITS });

/**
 * Affiliate programs through `@zucker-framework/fe-site`: official provider support only, not merely a
 * gateway that accepts arbitrary metadata (Stripe: every enabled program; Creem: Affonso).
 */
export function templateBillingReferrals(enabled: readonly ReferralProvider[] = []): BillingReferrals | null {
  if (!enabled.length) return null;
  const supported = (provider: string): ReferralProvider[] =>
    provider === 'stripe' ? [...enabled] : provider === 'creem' ? enabled.filter(value => value === 'affonso') : [];
  return {
    providers: supported,
    metadata: (provider, referral) => referralMetadata(referral, { enabledProviders: supported(provider) }),
  };
}

/** Browser origins allowed to change billing state (read when a controller is constructed). */
export function accountOrigins(): string[] {
  return (process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim());
}
