import type { DatabaseAdapter } from '@zucker-framework/core';
import { createPlanCatalogStore as createStore } from '@zucker-framework/back-office/subscriptions';
import { SUBSCRIPTION_STORAGE } from './storage';

/** The payment `PlanCatalogStore` over this application's plan tables. */
export const createPlanCatalogStore = (database: DatabaseAdapter) => createStore(database, SUBSCRIPTION_STORAGE);
