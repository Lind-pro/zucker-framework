import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { resolveModelNames, type ModelNames } from '../shared/models';

/** Fixed, parameterized SQL on the same connection/transaction as the model operations. */
export interface BillingSqlClient {
  query<TRow = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}
/** A transaction-bound adapter: model operations and raw SQL in ONE database transaction. */
export type BillingTransaction = DatabaseAdapter & BillingSqlClient;
/**
 * The consumer's `DATABASE_ADAPTER`. Its transactions must expose `query` (the Framework server
 * template's `ApplicationDatabase` does; a product wraps its Prisma transaction client the same way).
 * When the adapter has a `transaction(work)` method it is preferred over `$transaction`.
 */
export interface BillingDatabase extends DatabaseAdapter {
  transaction?<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T>;
}

/** Runs `work` in one database transaction that also accepts raw SQL. */
export function billingTransaction<T>(database: BillingDatabase, work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
  if (typeof database.transaction === 'function') return database.transaction(work);
  return database.$transaction(async tx => {
    if (typeof (tx as Partial<BillingSqlClient>).query !== 'function')
      throw new Error('[back-office/billing] the database adapter transaction must expose query(sql, values)');
    return work(tx as BillingTransaction);
  });
}

/**
 * Logical model → adapter model name. Defaults are the Framework server template's Prisma models; a
 * product maps its own (for example `billingOrders: 'subscriptionCheckout'`). Credit models are only
 * touched when a credit ledger is configured.
 */
export const DEFAULT_BILLING_MODELS = {
  billingOrders: 'billingOrders',
  billingSubscriptions: 'billingSubscriptions',
  billingSubscriptionCycles: 'billingSubscriptionCycles',
  billingFulfillments: 'billingFulfillments',
  billingOutbox: 'billingOutbox',
  creditPacks: 'creditPacks',
  creditPackPrices: 'creditPackPrices',
  creditPackPriceRefs: 'creditPackPriceRefs',
  creditLots: 'creditLots',
  creditTransactions: 'creditTransaction',
  creditHolds: 'creditHolds',
  operationLogs: 'operationLogs',
} as const;
export type BillingModelKey = keyof typeof DEFAULT_BILLING_MODELS;

/**
 * Tables addressed by raw SQL (row locks, refund journal, joins). Always emitted double-quoted. They
 * must hold the same rows as the corresponding models (for example `orders` is the table of
 * `billingOrders`). Column names are the template's camelCase names.
 */
export const DEFAULT_BILLING_TABLES = {
  orders: 'billing_orders',
  subscriptions: 'billing_subscriptions',
  subscriptionCycles: 'billing_subscription_cycles',
  refundPayments: 'billing_refund_payments',
  refundAliases: 'billing_refund_aliases',
  refundRequests: 'billing_refund_requests',
  refundReceipts: 'billing_refund_receipts',
  refundEvents: 'billing_refund_events',
  promotionRedemptions: 'promotion_redemptions',
  creditPacks: 'credit_packs',
  creditHolds: 'credit_holds',
  creditHoldAllocations: 'credit_hold_allocations',
  userRoles: 'user_roles',
  roles: 'roles',
} as const;
export type BillingTableKey = keyof typeof DEFAULT_BILLING_TABLES;

/**
 * Serializes every billing writer of one account (checkout, cycle fulfillment, refunds, schedule).
 * With a credit ledger it MUST be the ledger's own account lock (the default), otherwise lock order
 * between billing and credit writers is no longer guaranteed.
 */
export type BillingAccountLock = (tx: BillingTransaction, ownerId: string) => Promise<void>;

/** The credit ledger's account lock (`credit_account_locks` row lock, `@zucker-framework/credit`). */
export function creditAccountLock(): BillingAccountLock {
  const coordinator = new PostgresCreditOperationCoordinator();
  return (tx, ownerId) => coordinator.lockAccount(tx, ownerId);
}
/**
 * A transaction-scoped advisory lock per account, for plans-only consumers without credit tables.
 * `namespace` separates it from other advisory locks of the same database.
 */
export function advisoryAccountLock(namespace = 'billing-account'): BillingAccountLock {
  if (!/^[a-z][a-z0-9:-]{0,63}$/.test(namespace)) throw new TypeError('[back-office/billing] invalid advisory lock namespace');
  return async (tx, ownerId) => {
    if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('[back-office/billing] account lock needs an owner');
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1 || ':' || $2, 0))::text AS locked", [namespace, ownerId]);
  };
}

/** Resolved model and table names plus the account lock, shared by every billing component. */
export class BillingStorage {
  readonly models: ModelNames<BillingModelKey>;
  readonly tables: ModelNames<BillingTableKey>;
  /** Double-quoted table identifiers for raw SQL. */
  readonly t: Readonly<Record<BillingTableKey, string>>;
  readonly lockAccount: BillingAccountLock;
  /** True when `lockAccount` is the default credit account lock (rows of `credit_account_locks`). */
  readonly creditLockDefault: boolean;
  constructor(input: { models?: Partial<Record<BillingModelKey, string>>; tables?: Partial<Record<BillingTableKey, string>>; lockAccount?: BillingAccountLock } = {}) {
    this.models = resolveModelNames('billing', DEFAULT_BILLING_MODELS, input.models);
    this.tables = resolveModelNames('billing', DEFAULT_BILLING_TABLES, input.tables);
    this.t = Object.freeze(Object.fromEntries(Object.entries(this.tables).map(([key, value]) => [key, `"${value}"`])) as Record<BillingTableKey, string>);
    if (input.lockAccount !== undefined && typeof input.lockAccount !== 'function') throw new TypeError('[back-office/billing] lockAccount must be a function');
    this.lockAccount = input.lockAccount ?? creditAccountLock();
    this.creditLockDefault = input.lockAccount === undefined;
    Object.freeze(this);
  }
  model(database: DatabaseAdapter, key: BillingModelKey): ModelOperations {
    return database.model(this.models[key]);
  }
}

/** Default storage (template model and table names, credit account lock). */
export const DEFAULT_BILLING_STORAGE = new BillingStorage();
