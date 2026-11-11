import type { DatabaseAdapter } from '@zucker-framework/core';
import { createAdministrator as createOwner, seedStarterData as seed, type StarterDataSeed } from '@zucker-framework/back-office/accounts';
import type { SubscriptionPlanWrite } from '@zucker-framework/payment';
import { seedPlans } from '../subscriptions/plan-seeds';
import { starterAdminMenus } from './starter-admin-menus';

export type { StarterDataSeed } from '@zucker-framework/back-office/accounts';

/**
 * Back-office permission codes (RFC §8) that are checked with `@Permissions(code)` rather than
 * discovered from `@Resource` declarations, so they must exist as rows before an administrator can
 * grant them to a delegated role. Together with every starter menu code they are seeded once.
 * Installations created before these codes existed get them (and the new starter menus) from the
 * idempotent data step of migration 20261109000000_back_office; keep both lists in sync.
 */
export const BACK_OFFICE_PERMISSIONS: readonly string[] = [
  'plans:query', 'plans:add', 'plans:update', 'plans:delete',
  'subscriptions:query', 'subscriptions:update',
  'quota:query', 'quota:update',
  'mail:query', 'mail:update',
  // Phase 3 features (menus seed only the query codes; the write codes are granted to roles explicitly).
  'feedback:query', 'feedback:update',
  'promotions:query', 'promotions:create', 'promotions:update', 'promotions:delete',
  'referrals:query', 'referrals:update',
  'insights:query',
];

/** Feature starter data (plans and credit packs, CMS pages, ...); the integration WP appends feature seeds here. */
export const STARTER_DATA_SEEDS: readonly StarterDataSeed[] = [];

/** Runs the starter seeds in order on the caller's transaction. A failing seed aborts the whole setup. */
export function seedStarterData(tx: DatabaseAdapter, seeds: readonly StarterDataSeed[] = STARTER_DATA_SEEDS): Promise<void> {
  return seed(tx, seeds);
}

/** Explicit owner setup only (`pnpm account:admin`); never reachable from public account HTTP routes. */
export async function createAdministrator(db: DatabaseAdapter, input: { username: string; email: string; password: string },
  /** Initial plans (see planSeedsFromBillingCatalog); existing slugs are never changed. */
  options: { plans?: readonly SubscriptionPlanWrite[]; seeds?: readonly StarterDataSeed[] } = {}): Promise<string> {
  return createOwner(db, input, { menus: starterAdminMenus, permissions: BACK_OFFICE_PERMISSIONS,
    seeds: [{ name: 'plans', run: async tx => { await seedPlans(tx, options.plans ?? []); } }, ...(options.seeds ?? STARTER_DATA_SEEDS)] });
}
