import {
  createCreditPackStore as createHostCreditPackStore, creditPacksConfigured as hostCreditPacksConfigured, type BillingDatabase,
} from '@zucker-framework/back-office/billing';
import type { CreditPackStore } from '@zucker-framework/payment';

export { presentCreditPack, CREDIT_PACK_INCLUDE } from '@zucker-framework/back-office/billing';

/** `credit_packs` + prices + provider references binding of the payment CreditPackStore port. */
export function createCreditPackStore(database: BillingDatabase): CreditPackStore { return createHostCreditPackStore(database); }
/** True when at least one credit pack exists (listed or not): the database then replaces static payment offers. */
export function creditPacksConfigured(database: BillingDatabase): Promise<boolean> { return hostCreditPacksConfigured(database); }
