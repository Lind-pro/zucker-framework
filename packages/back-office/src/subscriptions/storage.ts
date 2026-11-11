import { createHash } from 'node:crypto';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import type { PendingPaymentBlock, SubscriptionPlanWrite } from '@zucker-framework/payment';
import { resolveModelNames, type ModelNames } from '../shared/models';

/**
 * Logical model → adapter model name (`DatabaseAdapter.model()`). Defaults are the Framework server
 * template's Prisma models. Products map their own (for example `quotaUsage: 'userQuotaUsage'`).
 */
export const DEFAULT_SUBSCRIPTIONS_MODELS = {
  users: 'users',
  plans: 'subscriptionPlans',
  planPrices: 'subscriptionPlanPrices',
  planPriceRefs: 'subscriptionPlanPriceRefs',
  subscriptions: 'userSubscriptions',
  subscriptionPayments: 'userSubscriptionPayments',
  quotaUsage: 'quotaUsage',
  quotaReservations: 'quotaReservation',
  /** Written by the payment write-back (plan term events); billing-owned. */
  billingOutbox: 'billingOutbox',
  /** Read by the payment write-back (purchase time of a renewing subscription); billing-owned. */
  billingOrders: 'billingOrders',
} as const;
export type SubscriptionsModelKey = keyof typeof DEFAULT_SUBSCRIPTIONS_MODELS;

/**
 * Logical fields the host reads or writes, per model. A field map renames any of them to the
 * adapter's field (for Prisma: the model field, which may itself `@map` a column). Fields not in
 * a map keep their logical name.
 */
export const SUBSCRIPTIONS_LOGICAL_FIELDS = {
  users: ['id', 'username', 'email', 'status'],
  plans: ['id', 'slug', 'name', 'description', 'status', 'order', 'features', 'quotas', 'revision', 'featured', 'badge',
    'highlights', 'nameI18n', 'descriptionI18n', 'badgeI18n', 'highlightsI18n', 'createdAt', 'updatedAt'],
  planPrices: ['id', 'planId', 'interval', 'currency', 'amount', 'termDays', 'credits', 'creditExpiryPeriod', 'creditExpiryDays',
    'createdAt', 'updatedAt'],
  planPriceRefs: ['id', 'priceId', 'provider', 'reference'],
  subscriptions: ['id', 'userId', 'planId', 'status', 'billingCycle', 'startDate', 'endDate', 'cancelAtPeriodEnd', 'canceledAt',
    'source', 'paymentReference', 'createdAt', 'updatedAt'],
  subscriptionPayments: ['id', 'reference', 'userId', 'planId', 'billingCycle', 'periodStart', 'periodEnd', 'orderId'],
  quotaUsage: ['subjectId', 'counter', 'period', 'limit', 'used', 'updatedAt'],
  quotaReservations: ['id', 'subjectId', 'counter', 'period', 'amount', 'limit', 'policyVersion', 'resourceType', 'resourceId',
    'status', 'expiresAt', 'createdAt', 'updatedAt', 'finishedAt', 'reason', 'activeResourceKey'],
  billingOutbox: ['kind', 'aggregateId', 'payload'],
  billingOrders: ['id', 'createdAt'],
} as const satisfies Record<SubscriptionsModelKey, readonly string[]>;
export type SubscriptionsFieldMaps = {
  [K in SubscriptionsModelKey]?: Partial<Record<(typeof SUBSCRIPTIONS_LOGICAL_FIELDS)[K][number], string>>;
};

/**
 * Serializes writers. `account` must be the same lock every billing writer of the account takes
 * (checkout, cycle fulfillment, account deletion); `quota` the lock of every writer of one
 * subject/counter usage row (including direct consumption outside this host).
 */
export interface SubscriptionLocks {
  account(tx: DatabaseAdapter, userId: string): Promise<void>;
  quota(tx: DatabaseAdapter, identity: { subjectId: string; counter: string }): Promise<void>;
  /**
   * Transaction-scoped plan lock: `share` while an assignment or payment write-back binds a term to the
   * plan, `exclusive` while the plan is deleted. It keeps a delete from passing its reference checks
   * between an assignment's plan read and its write, also without a database foreign key. Default:
   * PostgreSQL advisory locks on `subscriptions:plan:<planId>` (shared/exclusive).
   */
  plan?(tx: DatabaseAdapter, planId: string, mode: 'share' | 'exclusive'): Promise<void>;
}

/** Default plan lock: `pg_advisory_xact_lock[_shared](hashtextextended('subscriptions:plan:<id>', 0))`. */
export function advisoryPlanLock(key: (planId: string) => string = planId => `subscriptions:plan:${planId}`): NonNullable<SubscriptionLocks['plan']> {
  return async (tx, planId, mode) => {
    const fn = mode === 'share' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    // `::text`: a void column cannot be read by every driver (Prisma raw queries refuse it).
    await requireSql(tx, 'the plan lock').query(`SELECT ${fn}(hashtextextended($1, 0))::text AS locked`, [key(planId)]);
  };
}

/**
 * Billing-owned state the subscription host must respect (supplied by the billing integration).
 * Without it nothing blocks an administrator change and only subscriptions reference a plan.
 */
export interface SubscriptionBillingLink {
  /**
   * The unsettled plan checkout or the provider plan subscription that still decides the user's term,
   * if any (see `UserSubscriptionStore.pendingPayment`). Runs on the account-locked transaction.
   */
  pendingPlanPayment(tx: DatabaseAdapter, userId: string, now: Date): Promise<PendingPaymentBlock | null>;
  /** True while an open order or a live provider subscription still needs the plan for write-back. */
  planReferenced(tx: DatabaseAdapter, planId: string): Promise<boolean>;
}

/** Identity of a metered charge (one subject, counter and resource). */
export interface QuotaChargeIdentity { subjectId: string; counter: string; resourceType: string; resourceId: string }

/** Product policy of the quota reservation rows (all optional; defaults are the Framework template's). */
export interface SubscriptionsQuotaPolicy {
  /**
   * Which reservations get an `activeResourceKey` (charge-once resources). Default: every one.
   * Per-use rows that legitimately repeat a resource return false and stay unkeyed.
   */
  chargeOnce?: (identity: QuotaChargeIdentity) => boolean;
  /**
   * Clear `activeResourceKey` when a reservation is RELEASED/EXPIRED. Default true (a plain unique
   * index). With a partial unique index over RESERVED/CONFIRMED rows pass false to keep it as history.
   */
  clearKeyOnFinish?: boolean;
  /**
   * Older resource types that already count as a charge of a resource type on any counter (read
   * only), e.g. `{ 'prototype-project': ['dossier'] }`.
   */
  legacyResourceTypes?: Readonly<Record<string, readonly string[]>>;
  /** Extra columns written with a new reservation (e.g. legacy `metadata` read by a previous version). */
  insertExtras?: (input: QuotaChargeIdentity & { period: string; limit: number; amount: number }) => Record<string, unknown>;
  /** Extra columns written with a transition; `current` is the row before it (e.g. legacy `confirmedAt`/`releasedAt`). */
  transitionExtras?: (input: { to: string; at: Date; reason: string | null; current: Record<string, unknown> | null }) => Record<string, unknown>;
  /** Period/limit of a row stored without them (written before policy capture). Without it such a row cannot be charged. */
  legacyPolicy?: (tx: DatabaseAdapter, row: Record<string, unknown> & { subjectId: string; counter: string }) => Promise<{ period: string; limit: number }>;
  /** Called in the transaction after usage was charged (product events). */
  charged?: (tx: DatabaseAdapter, usage: { subjectId: string; counter: string; period: string; amount: number }) => Promise<void> | void;
}

export interface SubscriptionsStorageInput {
  /** Reservation-row policy (charge-once keys, legacy columns). */
  quota?: SubscriptionsQuotaPolicy;
  models?: Partial<Record<SubscriptionsModelKey, string>>;
  fields?: SubscriptionsFieldMaps;
  /** Default {@link creditAccountLocks}. */
  locks?: SubscriptionLocks;
  billingLink?: SubscriptionBillingLink;
  /**
   * Extra plan row fields derived from each plan write (create: the full write; update: the partial
   * one), e.g. a legacy NOT NULL `price` column kept in step for a previous application version.
   */
  planRowExtras?: (write: Partial<SubscriptionPlanWrite>, mode: 'create' | 'update') => Record<string, unknown>;
}

type LogicalOps = ModelOperations<Record<string, unknown>>;
export interface SubscriptionsModels {
  users: LogicalOps; plans: LogicalOps; planPrices: LogicalOps; planPriceRefs: LogicalOps; subscriptions: LogicalOps;
  subscriptionPayments: LogicalOps; quotaUsage: LogicalOps; quotaReservations: LogicalOps; billingOutbox: LogicalOps;
  billingOrders: LogicalOps;
}

/** Resolved, frozen storage mapping shared by every store of the host. */
export interface SubscriptionsStorage {
  readonly models: ModelNames<SubscriptionsModelKey>;
  readonly fields: Readonly<Record<SubscriptionsModelKey, Readonly<Record<string, string>>>>;
  /** `plan` is always present (default {@link advisoryPlanLock}). */
  readonly locks: SubscriptionLocks & { plan: NonNullable<SubscriptionLocks['plan']> };
  readonly billingLink?: SubscriptionBillingLink;
  readonly planRowExtras?: SubscriptionsStorageInput['planRowExtras'];
  readonly quota: Readonly<SubscriptionsQuotaPolicy>;
  /** Logical model operations on `database` (or a transaction of it). */
  of(database: DatabaseAdapter): SubscriptionsModels;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
function fail(message: string): never {
  throw new TypeError(`[back-office/subscriptions] ${message}`);
}

function resolveFieldMaps(input: SubscriptionsFieldMaps | undefined): SubscriptionsStorage['fields'] {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) fail('fields must be an object');
  const out = {} as Record<SubscriptionsModelKey, Readonly<Record<string, string>>>;
  for (const model of Object.keys(DEFAULT_SUBSCRIPTIONS_MODELS) as SubscriptionsModelKey[]) out[model] = Object.freeze({});
  for (const [model, map] of Object.entries(input ?? {})) {
    if (!(model in SUBSCRIPTIONS_LOGICAL_FIELDS)) fail(`fields: unknown model key "${model}"`);
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(`fields.${model} must be an object`);
    const known: readonly string[] = SUBSCRIPTIONS_LOGICAL_FIELDS[model as SubscriptionsModelKey];
    const resolved: Record<string, string> = {};
    for (const [logical, physical] of Object.entries(map as Record<string, unknown>)) {
      if (!known.includes(logical)) fail(`fields.${model}: unknown field "${logical}"`);
      if (physical === undefined) continue;
      if (typeof physical !== 'string' || !FIELD.test(physical)) fail(`fields.${model}.${logical} must be an identifier`);
      if (physical !== logical) resolved[logical] = physical;
    }
    // Every logical field must land on a distinct adapter field, or rows could not be mapped back.
    const targets = known.map(field => resolved[field] ?? field);
    if (new Set(targets).size !== targets.length) fail(`fields.${model} maps two fields to the same name`);
    out[model as SubscriptionsModelKey] = Object.freeze(resolved);
  }
  return Object.freeze(out);
}

const OPERATOR_KEYS = new Set(['AND', 'OR', 'NOT']);
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** Renames logical keys of `where` (recursing through AND/OR/NOT); operator values are left as is. */
function mapWhere(where: unknown, map: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(where)) return where.map(item => mapWhere(item, map));
  if (!plain(where)) return where;
  return Object.fromEntries(Object.entries(where).map(([key, value]) =>
    OPERATOR_KEYS.has(key) ? [key, mapWhere(value, map)] : [map[key] ?? key, value]));
}
function mapKeys(value: unknown, map: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) return value.map(item => mapKeys(item, map));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [map[key] ?? key, item]));
}
function mapArgs(args: Record<string, unknown>, map: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if ('include' in out) throw new Error('[back-office/subscriptions] relation includes are not portable; load related rows explicitly');
  if (out.where !== undefined) out.where = mapWhere(out.where, map);
  if (out.data !== undefined) out.data = mapKeys(out.data, map);
  if (out.select !== undefined) out.select = mapKeys(out.select, map);
  if (out.orderBy !== undefined) out.orderBy = mapKeys(out.orderBy, map);
  return out;
}

/** Logical view of one adapter model: arguments are renamed on the way in, rows on the way out. */
export function mappedModel(operations: ModelOperations, map: Readonly<Record<string, string>>): LogicalOps {
  if (!Object.keys(map).length) return operations as LogicalOps;
  const reverse: Record<string, string> = Object.fromEntries(Object.entries(map).map(([logical, physical]) => [physical, logical]));
  const row = (value: unknown) => (plain(value) ? mapKeys(value, reverse) : value) as Record<string, unknown>;
  const rows = (value: unknown[]) => value.map(row);
  const findFirst = operations.findFirst?.bind(operations);
  return {
    findUnique: async args => row(await operations.findUnique(mapArgs(args, map))),
    ...(findFirst ? { findFirst: async (args: Record<string, unknown>) => row(await findFirst(mapArgs(args, map))) } : {}),
    findMany: async args => rows(await operations.findMany(args && mapArgs(args, map))),
    create: async args => row(await operations.create(mapArgs(args, map))),
    update: async args => row(await operations.update(mapArgs(args, map))),
    delete: async args => row(await operations.delete(mapArgs(args, map))),
    count: args => operations.count(args && mapArgs(args, map)),
    createMany: args => operations.createMany(mapArgs(args, map)),
    updateMany: args => operations.updateMany(mapArgs(args, map)),
    deleteMany: args => operations.deleteMany(args && mapArgs(args, map)),
  };
}

/** A transaction able to run parameterized SQL (the template's ApplicationTransaction, a pg client wrapper). */
export interface SqlCapableTransaction extends DatabaseAdapter {
  query<TRow = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}
export function requireSql(tx: DatabaseAdapter, purpose: string): SqlCapableTransaction {
  if (typeof (tx as Partial<SqlCapableTransaction>).query !== 'function')
    throw new Error(`[back-office/subscriptions] ${purpose} needs a transaction with query(sql, values)`);
  return tx as SqlCapableTransaction;
}

/**
 * Locks of `@zucker-framework/credit`'s `PostgresCreditOperationCoordinator` (rows of
 * `credit_account_locks`), shared with the Framework billing host and credit ledger. Quota locks
 * use a hashed subject/counter key in the same table.
 */
export function creditAccountLocks(): SubscriptionLocks {
  const coordinator = new PostgresCreditOperationCoordinator();
  return {
    account: async (tx, userId) => coordinator.lockAccount(requireSql(tx, 'the account lock'), userId),
    quota: async (tx, identity) => coordinator.lockAccount(requireSql(tx, 'the quota lock'),
      `quota:${createHash('sha256').update(JSON.stringify([identity.subjectId, identity.counter])).digest('hex')}`),
  };
}

/**
 * Transaction-scoped PostgreSQL advisory locks (`pg_advisory_xact_lock(hashtextextended(key, 0))`),
 * needing no lock table. The key functions must equal those of every other writer of the same state.
 */
export function advisoryLocks(keys: {
  account?: (userId: string) => string;
  quota?: (identity: { subjectId: string; counter: string }) => string;
} = {}): SubscriptionLocks {
  // Async, so a transaction without query() rejects instead of throwing synchronously.
  const lock = async (tx: DatabaseAdapter, key: string) => {
    await requireSql(tx, 'an advisory lock').query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked', [key]);
  };
  const account = keys.account ?? (userId => `subscriptions:account:${userId}`);
  const quota = keys.quota ?? (identity => `quota:${identity.subjectId}:${identity.counter}`);
  return { account: (tx, userId) => lock(tx, account(userId)), quota: (tx, identity) => lock(tx, quota(identity)) };
}

export function resolveSubscriptionsStorage(input: SubscriptionsStorageInput = {}): SubscriptionsStorage {
  const models = resolveModelNames('subscriptions', DEFAULT_SUBSCRIPTIONS_MODELS, input.models);
  const fields = resolveFieldMaps(input.fields);
  const given = input.locks ?? creditAccountLocks();
  if (typeof given?.account !== 'function' || typeof given.quota !== 'function') fail('locks must provide account() and quota()');
  if (given.plan !== undefined && typeof given.plan !== 'function') fail('locks.plan must be a function');
  const locks = Object.freeze({ account: given.account, quota: given.quota, plan: given.plan ?? advisoryPlanLock() });
  const link = input.billingLink;
  if (link !== undefined && (typeof link?.pendingPlanPayment !== 'function' || typeof link.planReferenced !== 'function'))
    fail('billingLink must provide pendingPlanPayment() and planReferenced()');
  if (input.planRowExtras !== undefined && typeof input.planRowExtras !== 'function') fail('planRowExtras must be a function');
  const quota = input.quota ?? {};
  if (!quota || typeof quota !== 'object') fail('quota must be an object');
  for (const hook of ['chargeOnce', 'insertExtras', 'transitionExtras', 'legacyPolicy', 'charged'] as const)
    if (quota[hook] !== undefined && typeof quota[hook] !== 'function') fail(`quota.${hook} must be a function`);
  if (quota.clearKeyOnFinish !== undefined && typeof quota.clearKeyOnFinish !== 'boolean') fail('quota.clearKeyOnFinish must be a boolean');
  for (const [type, legacy] of Object.entries(quota.legacyResourceTypes ?? {}))
    if (!Array.isArray(legacy) || legacy.some(item => typeof item !== 'string' || !item)) fail(`quota.legacyResourceTypes.${type} must list resource types`);
  const keys = Object.keys(DEFAULT_SUBSCRIPTIONS_MODELS) as SubscriptionsModelKey[];
  return Object.freeze({
    models, fields, locks, quota: Object.freeze({ ...quota }),
    ...(link ? { billingLink: link } : {}),
    ...(input.planRowExtras ? { planRowExtras: input.planRowExtras } : {}),
    of(database: DatabaseAdapter): SubscriptionsModels {
      // Built lazily: a disabled feature never touches (or even resolves) its model.
      const cache = new Map<SubscriptionsModelKey, LogicalOps>();
      const view = {} as SubscriptionsModels;
      for (const key of keys)
        Object.defineProperty(view, key, { enumerable: true, get: () => {
          let ops = cache.get(key);
          if (!ops) { ops = mappedModel(database.model(models[key]), fields[key]); cache.set(key, ops); }
          return ops;
        } });
      return view;
    },
  });
}

/** Unique-violation detection across Prisma (P2002) and PostgreSQL drivers (23505). */
export function isUniqueViolation(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof value?.code === 'string' ? value.code : value?.cause?.code;
  return code === 'P2002' || code === '23505' || (error instanceof Error && /Unique constraint/i.test(error.message));
}
export function isForeignKeyViolation(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof value?.code === 'string' ? value.code : value?.cause?.code;
  return code === 'P2003' || code === '23503' || (error instanceof Error && /Foreign key constraint/i.test(error.message));
}
