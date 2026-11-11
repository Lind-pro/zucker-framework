import {
  createSqlBillingLink, resolveSubscriptionsStorage, type SubscriptionsStorageInput,
} from '@zucker-framework/back-office/subscriptions';

/**
 * This application's subscription storage: the Framework default model names (see prisma/schema.prisma),
 * credit-account locks shared with billing, and the billing tables that block administrator term
 * changes or plan deletion while a plan purchase is open.
 */
export const SUBSCRIPTION_STORAGE_OPTIONS: SubscriptionsStorageInput = { billingLink: createSqlBillingLink() };
export const SUBSCRIPTION_STORAGE = resolveSubscriptionsStorage(SUBSCRIPTION_STORAGE_OPTIONS);
