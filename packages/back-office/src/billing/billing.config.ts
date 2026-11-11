import type { BillingCredits } from './billing.ports';
import { DEFAULT_BILLING_STORAGE, type BillingStorage } from './billing.database';

/**
 * Persistence configuration shared by the plain billing components (persistences, services,
 * stores): where the rows live and whether a credit ledger exists. `credits: null` is plans-only mode.
 */
export interface BillingPersistenceConfig {
  readonly storage: BillingStorage;
  readonly credits: BillingCredits | null;
}

export function billingPersistenceConfig(input: { storage?: BillingStorage; credits?: BillingCredits | null } = {}): BillingPersistenceConfig {
  if (input.credits !== undefined && input.credits !== null && typeof input.credits.ledger !== 'function')
    throw new TypeError('[back-office/billing] credits.ledger must be a function');
  const storage = input.storage ?? DEFAULT_BILLING_STORAGE;
  // The default lock lives in the credit ledger's `credit_account_locks` table, which a plans-only
  // schema does not have: fail at startup instead of on the first order.
  if (input.credits === null && storage.creditLockDefault)
    throw new TypeError('[back-office/billing] plans-only billing (credits: null) needs lockAccount, e.g. advisoryAccountLock() or the lock the product\'s other per-account billing paths use');
  return Object.freeze({ storage, credits: input.credits ?? null });
}

/** Plans-only failure for a payment that would grant credits without a configured ledger. */
export const CREDITS_UNAVAILABLE = 'Credit fulfillment is not configured (plans-only billing)';
