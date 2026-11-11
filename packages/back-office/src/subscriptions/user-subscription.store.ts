import type { DatabaseAdapter } from '@zucker-framework/core';
import type {
  AssignablePlan, SubscriptionPaymentEvidence, UserSubscriptionRecord, UserSubscriptionStore,
} from '@zucker-framework/payment';
import type { SubscriptionsStorage } from './storage';

/**
 * An unsettled plan checkout and a provider subscription still `unknown` block administrator term
 * changes only while they are this young (hosted checkout sessions expire within 24 hours). A late
 * payment is still applied by the ledger's precedence rules. Billing links should use this bound.
 */
export const PENDING_PAYMENT_BLOCK_MS = 24 * 60 * 60 * 1000;

const EVIDENCE_FIELDS = { reference: true, userId: true, planId: true, billingCycle: true, periodStart: true, periodEnd: true, orderId: true } as const;
const SUBSCRIPTION_FIELDS = {
  id: true, userId: true, planId: true, status: true, billingCycle: true, startDate: true, endDate: true, cancelAtPeriodEnd: true,
  canceledAt: true, source: true, paymentReference: true, createdAt: true, updatedAt: true,
} as const;

export interface UserSubscriptionStoreOptions {
  /** Reuse a caller transaction (payment write-back inside billing fulfillment); the account lock is re-entrant. */
  transaction?: DatabaseAdapter;
  now?: () => Date;
}

/**
 * User subscriptions + payment ledger binding of the payment `UserSubscriptionStore` port. Every
 * writer takes the storage's account lock (the same lock as billing checkout and cycle
 * fulfillment), so an administrator cannot overwrite a term while a payment is being applied, and
 * the ledger insert and the update-then-insert of the single subscription row are race-free.
 */
export function createUserSubscriptionStore(database: DatabaseAdapter, storage: SubscriptionsStorage,
  options: UserSubscriptionStoreOptions = {}): UserSubscriptionStore<DatabaseAdapter> {
  const now = options.now ?? (() => new Date());
  const read = async (tx: DatabaseAdapter, where: { id: string } | { slug: string }) =>
    await storage.of(tx).plans.findUnique({ where, select: { id: true, slug: true, status: true } }) as unknown as AssignablePlan | null;
  // Every lookup binds a term to the plan: hold the shared plan lock until commit (a delete takes it
  // exclusively before its reference checks) and re-read, since a delete may have committed between
  // the first read and the lock. Works without a database foreign key.
  const plan = async (tx: DatabaseAdapter, where: { id: string } | { slug: string }) => {
    const found = await read(tx, where);
    if (!found) return null;
    await storage.locks.plan(tx, found.id, 'share');
    return read(tx, { id: found.id });
  };
  return {
    transaction: async (userId, work) => {
      const run = async (tx: DatabaseAdapter) => { await storage.locks.account(tx, userId); return work(tx); };
      return options.transaction ? run(options.transaction) : database.$transaction(run);
    },
    async userAssignable(tx, userId) {
      const user = await storage.of(tx).users.findUnique({ where: { id: userId }, select: { status: true } }) as { status: unknown } | null;
      return user?.status === true;
    },
    find: async (tx, userId) =>
      await storage.of(tx).subscriptions.findUnique({ where: { userId }, select: SUBSCRIPTION_FIELDS }) as unknown as UserSubscriptionRecord | null,
    findPlanBySlug: (tx, slug) => plan(tx, { slug }),
    findPlanById: (tx, id) => plan(tx, { id }),
    // Only plan purchases decide the term; billing owns which of its states block (see SubscriptionBillingLink).
    pendingPayment: async (tx, userId) => storage.billingLink ? storage.billingLink.pendingPlanPayment(tx, userId, now()) : null,
    async recordPaymentEvidence(tx, evidence: SubscriptionPaymentEvidence) {
      // Runs under the account lock: no concurrent writer can insert the same reference in between.
      const payments = storage.of(tx).subscriptionPayments;
      if (await payments.count({ where: { reference: evidence.reference } })) return false;
      await payments.create({ data: { reference: evidence.reference, userId: evidence.userId, planId: evidence.planId,
        billingCycle: evidence.billingCycle, periodStart: evidence.periodStart, periodEnd: evidence.periodEnd, orderId: evidence.orderId } });
      return true;
    },
    findPaymentEvidence: async (tx, reference) =>
      await storage.of(tx).subscriptionPayments.findUnique({ where: { reference }, select: EVIDENCE_FIELDS }) as unknown as SubscriptionPaymentEvidence | null,
    async save(tx, userId, data) {
      const subscriptions = storage.of(tx).subscriptions;
      // Safe as update-then-insert because every writer holds the account lock; userId is unique.
      const changed = await subscriptions.updateMany({ where: { userId }, data: { ...data, updatedAt: new Date() } });
      if (!changed.count) await subscriptions.create({ data: { userId, ...data } });
      return await subscriptions.findUnique({ where: { userId }, select: SUBSCRIPTION_FIELDS }) as unknown as UserSubscriptionRecord;
    },
  };
}
