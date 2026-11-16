import {
  USER_SUBSCRIPTION_CYCLES,
  USER_SUBSCRIPTION_STATUSES,
  brandPortError,
  type PendingPaymentDetails,
  type PortErrorReason,
  type UserSubscriptionCycle,
  type UserSubscriptionSource,
  type UserSubscriptionStatus,
} from '@zucker-framework/fe-types/back-office';

/**
 * One current plan subscription per user, assigned by administrators or written back from verified
 * payments. Validity is decided by an injected term predicate (normally `isActiveTerm` from
 * `@zucker-framework/credit`) so this package stays independent of the ledger.
 */
export type { UserSubscriptionStatus, UserSubscriptionCycle, UserSubscriptionSource };

export interface UserSubscriptionRecord {
  id: string;
  userId: string;
  planId: string;
  status: UserSubscriptionStatus;
  billingCycle: UserSubscriptionCycle;
  startDate: Date;
  endDate: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  source: UserSubscriptionSource;
  /** Reference of the payment evidence that currently defines the term; null for admin terms. */
  paymentReference: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export type UserSubscriptionWrite = Omit<UserSubscriptionRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;
export interface AssignablePlan {
  id: string;
  slug: string;
  status: boolean;
}

/** One verified payment for a plan term, kept per reference (the payment ledger). */
export interface SubscriptionPaymentEvidence {
  reference: string;
  userId: string;
  planId: string;
  billingCycle: UserSubscriptionCycle;
  periodStart: Date;
  /** Null only for LIFETIME. */
  periodEnd: Date | null;
  /** The order that sold it, when known (refunds attach here). */
  orderId: string | null;
}

/** Durable application ancestry. Keep it as long as the payment evidence; it is not a delivery event. */
export interface SubscriptionPaymentApplication {
  evidence: SubscriptionPaymentEvidence;
  appliedAt: Date;
  /** The live term before this application, including an administrator-granted baseline. */
  previous: UserSubscriptionWrite | null;
}
/** All writes join the same account-serialized transaction as evidence and the current term. */
export interface SubscriptionPaymentHistory<Tx> {
  recordApplication(tx: Tx, application: SubscriptionPaymentApplication): Promise<void>;
  findApplication(tx: Tx, reference: string): Promise<SubscriptionPaymentApplication | null>;
  /** Inserts a permanent full-refund marker; false on replay. */
  recordRefund(tx: Tx, reference: string, userId: string): Promise<boolean>;
  isRefunded(tx: Tx, reference: string): Promise<boolean>;
}

/** The billing record that must be settled before an administrator may change the term. */
export type PendingPaymentBlock = PendingPaymentDetails['blocking'];

/** All methods except `transaction` run on the transaction passed in. */
export interface UserSubscriptionStore<Tx> {
  /** One transaction that serializes every writer of this user's subscription and billing state. */
  transaction<T>(userId: string, work: (tx: Tx) => Promise<T>): Promise<T>;
  /** False when the user does not exist or is disabled. */
  userAssignable(tx: Tx, userId: string): Promise<boolean>;
  find(tx: Tx, userId: string): Promise<UserSubscriptionRecord | null>;
  findPlanBySlug(tx: Tx, slug: string): Promise<AssignablePlan | null>;
  findPlanById(tx: Tx, id: string): Promise<AssignablePlan | null>;
  /**
   * The unsettled plan checkout, or the provider-managed plan subscription that still controls the
   * term, if any. Only states that actually decide the term may block; return null otherwise.
   */
  pendingPayment(tx: Tx, userId: string): Promise<PendingPaymentBlock | null>;
  /** Inserts the evidence; false (and no write) when its reference was already recorded. */
  recordPaymentEvidence(tx: Tx, evidence: SubscriptionPaymentEvidence): Promise<boolean>;
  findPaymentEvidence(tx: Tx, reference: string): Promise<SubscriptionPaymentEvidence | null>;
  /** Required for automatic refunds. Legacy stores may omit it, but refunds then fail closed. */
  paymentHistory?: SubscriptionPaymentHistory<Tx>;
  save(tx: Tx, userId: string, data: UserSubscriptionWrite): Promise<UserSubscriptionRecord>;
}

export type SubscriptionAssignmentErrorReason = Extract<
  PortErrorReason,
  'invalid' | 'not_found' | 'conflict' | 'pending_payment' | 'unavailable'
>;
export class SubscriptionAssignmentError extends Error {
  constructor(
    readonly reason: SubscriptionAssignmentErrorReason,
    message: string,
    /** Client-safe details; `pending_payment` carries `{ blocking }`. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'SubscriptionAssignmentError';
    brandPortError(this);
  }
}

export interface SubscriptionAssignmentInput {
  planSlug: string;
  billingCycle: UserSubscriptionCycle;
  status?: UserSubscriptionStatus;
  /** Omit to keep the current live term's start (same plan) or start now. */
  startDate?: Date | string;
  /** Omit to keep the current live term's end (same plan and cycle) or derive it; null only for LIFETIME. */
  endDate?: Date | string | null;
}
export interface SubscriptionPaymentInput {
  userId: string;
  planId: string;
  billingCycle: UserSubscriptionCycle;
  periodStart: Date;
  /** Paid-through time; null only for a LIFETIME purchase. */
  periodEnd: Date | null;
  /** Unique evidence id (cycle receipt or order id); a recorded reference is never applied twice. */
  reference: string;
  orderId?: string | null;
  /**
   * When the purchase was made (the checkout order's creation time). A term an administrator revoked
   * (status EXPIRED) at or after this time is not resurrected by this payment: it is recorded with
   * outcome `revoked` for a refund instead. Omit for evidence with no purchase decision behind it.
   */
  purchasedAt?: Date | null;
}
/** A plan purchase being checked out (see {@link SubscriptionAssignmentService.admitPurchase}). */
export interface SubscriptionPurchaseInput {
  planId: string;
  billingCycle: UserSubscriptionCycle;
  /** Length of a ONE_TIME term in days (required for ONE_TIME, ignored otherwise). */
  termDays?: number | null;
}
/**
 * Why a plan purchase is refused before an order exists, because its payment would be recorded
 * without improving the term:
 * - `lifetime_active`: a live LIFETIME term is never replaced or extended by a payment;
 * - `term_covers_purchase`: the live term of the same plan already runs past the first paid period
 *   of a recurring purchase (a provider period cannot be stacked; buy a one-time term instead);
 * - `longer_admin_term`: an administrator-granted term of another plan ends after the purchased term;
 * - `provider_subscription`: a provider plan subscription still bills for the term (cancel it first).
 */
export type PlanPurchaseRefusal = 'lifetime_active' | 'term_covers_purchase' | 'longer_admin_term' | 'provider_subscription';
/**
 * What a payment did to the term:
 * - `applied`: the term now reflects this payment;
 * - `replayed`: the reference was already recorded;
 * - `ended`: the paid period is already over (catch-up of an old cycle), recorded only;
 * - `superseded`: the live term of the same plan already runs past this recurring period, or newer
 *   evidence on another plan defines the term; recorded only;
 * - `kept`: an active LIFETIME term, or a longer administrator-granted term of another plan, is never
 *   shortened or replaced by a payment; recorded only;
 * - `revoked`: an administrator revoked the term after this purchase was made; recorded only.
 *
 * `admitPurchase` refuses at checkout every purchase whose payment would be `kept` or `superseded`
 * at that moment, so these outcomes for a checkout payment mean the term changed between checkout
 * and payment; the caller should flag such payments for a refund.
 */
export type SubscriptionPaymentOutcome = 'applied' | 'replayed' | 'ended' | 'superseded' | 'kept' | 'revoked';
export interface SubscriptionPaymentResult {
  outcome: SubscriptionPaymentOutcome;
  subscription: UserSubscriptionRecord | null;
  /** Present when the term changed. Publish it after the caller's transaction commits (for example via an outbox). */
  change: SubscriptionChange | null;
}
/**
 * What a full refund of one payment did to the term (see {@link SubscriptionAssignmentService.revokePayment}):
 * - `revoked`: the term was defined by this payment and has ended;
 * - `shortened`: the term falls back to surviving unrefunded payments or an administrator baseline;
 * - `not_current`: the refund was already applied or does not change this term's entitlement ancestry;
 * - `inactive`: there is no live term;
 * - `not_found`: no payment evidence with this reference for this user.
 */
export type SubscriptionRefundOutcome = 'revoked' | 'shortened' | 'not_current' | 'inactive' | 'not_found';
export interface SubscriptionRefundInput {
  userId: string;
  /** The payment ledger reference of the refunded payment (as recorded by `recordPayment`). */
  reference: string;
}
export interface SubscriptionRefundResult {
  outcome: SubscriptionRefundOutcome;
  subscription: UserSubscriptionRecord | null;
  /** Present when the term changed. Publish it after the caller's transaction commits. */
  change: SubscriptionChange | null;
}
export interface SubscriptionChange {
  kind: 'assigned' | 'canceled' | 'paid' | 'refunded';
  userId: string;
  before: UserSubscriptionRecord | null;
  after: UserSubscriptionRecord;
  actorId?: string;
}
export interface SubscriptionAssignmentOptions {
  activeTerm: (term: { status: string; startDate: Date | null; endDate: Date | null; billingCycle?: string | null }, now: Date) => boolean;
  now?: () => Date;
  /**
   * Called after `assign`/`cancel` commit (never inside their transaction). It cannot undo the
   * change. `recordPayment` runs inside the caller's payment transaction and returns its change
   * instead of calling this.
   */
  changed?: (change: SubscriptionChange) => void | Promise<void>;
  /** Receives `changed` failures; the committed result is still returned. */
  onNotifyError?: (error: unknown, change: SubscriptionChange) => void;
}

function date(value: Date | string | undefined | null, field: string): Date | undefined | null {
  if (value === undefined || value === null) return value;
  const result = value instanceof Date ? new Date(value) : typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new SubscriptionAssignmentError('invalid', `Invalid ${field}`);
  return result;
}
/** Calendar addition in UTC, clamped to the target month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addBillingCycle(start: Date, cycle: 'MONTHLY' | 'YEARLY'): Date {
  const months = cycle === 'YEARLY' ? 12 : 1;
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target;
}

export class SubscriptionAssignmentService<Tx> {
  private readonly clock: () => Date;
  constructor(
    private readonly store: UserSubscriptionStore<Tx>,
    private readonly options: SubscriptionAssignmentOptions,
  ) {
    this.clock = options.now ?? (() => new Date());
  }

  isActive(record: UserSubscriptionRecord | null, now: Date = this.clock()): boolean {
    return !!record && this.options.activeTerm(record, now);
  }

  /**
   * Administrator assignment, modification or revocation (status EXPIRED). Rejects while a plan
   * payment is pending or a provider subscription controls the term; the error names that record.
   * A revocation proceeds despite an unsettled plan checkout: if that checkout is paid later, its
   * payment is recorded with outcome `revoked` and never resurrects the term (see `purchasedAt`).
   */
  async assign(userId: string, input: SubscriptionAssignmentInput, actorId?: string): Promise<UserSubscriptionRecord> {
    this.identifier(userId, 'userId');
    if (!input || typeof input !== 'object') throw new SubscriptionAssignmentError('invalid', 'Invalid subscription input');
    if (typeof input.planSlug !== 'string' || !input.planSlug.trim()) throw new SubscriptionAssignmentError('invalid', 'planSlug is required');
    if (!USER_SUBSCRIPTION_CYCLES.includes(input.billingCycle)) throw new SubscriptionAssignmentError('invalid', 'Invalid billingCycle');
    const status = input.status ?? 'ACTIVE';
    if (!USER_SUBSCRIPTION_STATUSES.includes(status)) throw new SubscriptionAssignmentError('invalid', 'Invalid status');
    if (input.billingCycle === 'LIFETIME' && status === 'CANCELED')
      throw new SubscriptionAssignmentError('invalid', 'A lifetime subscription cannot be canceled at period end; revoke it with status EXPIRED');
    const requestedStart = date(input.startDate, 'startDate');
    const requestedEnd = date(input.endDate, 'endDate');
    const result = await this.store.transaction(userId, async (tx) => {
      if (!(await this.store.userAssignable(tx, userId))) throw new SubscriptionAssignmentError('not_found', 'User not found or disabled');
      const plan = await this.store.findPlanBySlug(tx, input.planSlug);
      if (!plan) throw new SubscriptionAssignmentError('not_found', 'Plan not found');
      // Unlisted (draft) plans can still be assigned manually; that is how private plans are granted.
      const before = await this.store.find(tx, userId);
      await this.assertNoPendingPayment(tx, userId, status === 'EXPIRED');
      const now = this.clock();
      // Only a live term on the same plan is continued; a lapsed one starts over.
      const continues = !!before && before.planId === plan.id && this.isActive(before, now);
      const startDate = requestedStart ?? (continues && before ? before.startDate : now);
      let endDate: Date | null;
      if (input.billingCycle === 'LIFETIME') {
        if (requestedEnd) throw new SubscriptionAssignmentError('invalid', 'A lifetime subscription has no end date');
        endDate = null;
      } else if (requestedEnd) endDate = requestedEnd;
      else if (requestedEnd === null) throw new SubscriptionAssignmentError('invalid', 'A finite subscription needs an end date');
      else if (continues && before && before.billingCycle === input.billingCycle && before.endDate && !requestedStart)
        endDate = before.endDate;
      else if (input.billingCycle === 'ONE_TIME')
        throw new SubscriptionAssignmentError('invalid', 'A one-time term needs an explicit end date');
      else endDate = addBillingCycle(startDate, input.billingCycle);
      if (endDate && endDate <= startDate) throw new SubscriptionAssignmentError('invalid', 'endDate must be after startDate');
      if (status === 'ACTIVE' && endDate && endDate <= now)
        throw new SubscriptionAssignmentError('invalid', 'An active subscription needs a future end date');
      const after = await this.store.save(tx, userId, {
        planId: plan.id, status, billingCycle: input.billingCycle, startDate, endDate,
        cancelAtPeriodEnd: status === 'CANCELED',
        canceledAt: status === 'CANCELED' ? (before?.status === 'CANCELED' ? before.canceledAt : now) : null,
        source: 'admin', paymentReference: null,
      });
      return { before, after };
    });
    await this.notify({ kind: 'assigned', userId, ...result, actorId });
    return result.after;
  }

  /**
   * Cancels at period end: the paid term remains valid until its end date. Idempotent. A LIFETIME
   * term has no period end, so it cannot be canceled; revoke it through `assign` with status EXPIRED.
   * An unsettled plan checkout does not block it (only a billing provider subscription does); a
   * purchase paid afterwards is honored like any other payment: it extends or replaces the term.
   */
  async cancel(userId: string, actorId?: string): Promise<UserSubscriptionRecord> {
    this.identifier(userId, 'userId');
    const result = await this.store.transaction(userId, async (tx) => {
      const before = await this.store.find(tx, userId);
      if (!before) throw new SubscriptionAssignmentError('not_found', 'Subscription not found');
      if (before.status === 'CANCELED' || before.status === 'EXPIRED') return { before, after: before, changed: false };
      if (before.billingCycle === 'LIFETIME' || before.endDate === null)
        throw new SubscriptionAssignmentError('invalid', 'A lifetime subscription cannot be canceled at period end; revoke it with status EXPIRED');
      await this.assertNoPendingPayment(tx, userId, true);
      const after = await this.store.save(tx, userId, {
        ...this.write(before), status: 'CANCELED', cancelAtPeriodEnd: true, canceledAt: this.clock(),
      });
      return { before, after, changed: true };
    });
    if (result.changed) await this.notify({ kind: 'canceled', userId, before: result.before, after: result.after, actorId });
    return result.after;
  }

  /**
   * Checkout-time admission of a plan purchase, before any order exists. Throws when the payment
   * would be recorded without improving the term (see {@link PlanPurchaseRefusal}): `pending_payment`
   * while a provider plan subscription bills for the term, otherwise `conflict` with
   * `details.refusal`. Uses the same precedence as {@link recordPayment}.
   */
  async admitPurchase(userId: string, purchase: SubscriptionPurchaseInput): Promise<void> {
    this.identifier(userId, 'userId');
    this.identifier(purchase?.planId, 'planId');
    if (!USER_SUBSCRIPTION_CYCLES.includes(purchase.billingCycle)) throw new SubscriptionAssignmentError('invalid', 'Invalid billingCycle');
    const now = this.clock();
    let end: Date | null;
    if (purchase.billingCycle === 'LIFETIME') end = null;
    else if (purchase.billingCycle === 'ONE_TIME') {
      const days = purchase.termDays;
      if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) throw new SubscriptionAssignmentError('invalid', 'A one-time purchase needs termDays');
      end = new Date(now.getTime() + days * 86_400_000);
    } else end = addBillingCycle(now, purchase.billingCycle);
    await this.store.transaction(userId, async (tx) => {
      const blocking = await this.store.pendingPayment(tx, userId);
      if (blocking?.kind === 'subscription')
        throw new SubscriptionAssignmentError('pending_payment',
          `The plan is billed by subscription ${blocking.id} (${blocking.state}); cancel it before buying another plan term`,
          { blocking, refusal: 'provider_subscription' satisfies PlanPurchaseRefusal });
      const before = await this.store.find(tx, userId);
      const live = this.isActive(before, now) ? before : null;
      const decision = this.precedence(live, purchase.planId, purchase.billingCycle, end);
      const refuse = (refusal: PlanPurchaseRefusal, message: string) => new SubscriptionAssignmentError('conflict', message, { refusal });
      if (decision === 'lifetime') throw refuse('lifetime_active', 'A lifetime subscription is active; a purchase would not change it');
      if (decision === 'admin') throw refuse('longer_admin_term', 'A longer subscription term granted by an administrator is active; a purchase would not change it');
      if (decision === 'covered')
        throw refuse('term_covers_purchase', 'The current term of this plan runs past the first paid period; renew when it ends or buy a one-time term');
    });
  }

  /**
   * Payment write-back. Call it from the payment fulfillment transaction through a store bound to
   * that transaction. Every reference is recorded once in the payment ledger with its paid period;
   * the term changes only for a current period (see {@link SubscriptionPaymentOutcome}). Precedence:
   * - an active LIFETIME term is kept; a term revoked after the purchase (`purchasedAt`) stays revoked;
   * - same plan: a ONE_TIME term is stacked onto the live term (it extends from max(now, endDate) by
   *   the paid duration); a recurring period extends the term to its later end and never shortens
   *   it; a LIFETIME purchase makes the term lifetime;
   * - another plan replaces the term unless an administrator-granted term ends later, or the current
   *   term is defined by evidence whose period started later (an out-of-order older receipt).
   */
  async recordPayment(input: SubscriptionPaymentInput): Promise<SubscriptionPaymentResult> {
    this.identifier(input?.userId, 'userId');
    this.identifier(input?.planId, 'planId');
    this.identifier(input?.reference, 'reference');
    if (!USER_SUBSCRIPTION_CYCLES.includes(input.billingCycle)) throw new SubscriptionAssignmentError('invalid', 'Invalid billingCycle');
    const start = date(input.periodStart, 'periodStart') as Date | undefined;
    if (!start) throw new SubscriptionAssignmentError('invalid', 'periodStart is required');
    const end = date(input.periodEnd, 'periodEnd') ?? null;
    if (input.billingCycle === 'LIFETIME' ? end !== null : !end || end <= start)
      throw new SubscriptionAssignmentError('invalid', 'Invalid paid period');
    const purchasedAt = date(input.purchasedAt, 'purchasedAt') ?? null;
    return this.store.transaction(input.userId, async (tx) => {
      const plan = await this.store.findPlanById(tx, input.planId);
      if (!plan) throw new SubscriptionAssignmentError('not_found', 'Plan not found');
      const before = await this.store.find(tx, input.userId);
      const recorded = await this.store.recordPaymentEvidence(tx, {
        reference: input.reference, userId: input.userId, planId: plan.id, billingCycle: input.billingCycle,
        periodStart: start, periodEnd: end, orderId: input.orderId ?? null,
      });
      const unchanged = (outcome: SubscriptionPaymentOutcome): SubscriptionPaymentResult => ({ outcome, subscription: before, change: null });
      if (!recorded) return unchanged('replayed');
      const now = this.clock();
      if (end !== null && end <= now) return unchanged('ended');
      // The last write was an administrator revocation made after this purchase: it wins.
      if (purchasedAt && before && before.status === 'EXPIRED' && before.source === 'admin' && before.updatedAt >= purchasedAt)
        return unchanged('revoked');
      const live = this.isActive(before, now) ? before : null;
      const decision = this.precedence(live, plan.id, input.billingCycle, end);
      let write: UserSubscriptionWrite;
      if (decision === 'lifetime' || decision === 'admin') return unchanged('kept');
      if (decision === 'covered') return unchanged('superseded');
      if (live && (decision === 'stack' || decision === 'extend')) {
        // Stacking: the paid duration starts when the current term ends (never before now).
        const endDate = decision === 'stack' && end && live.endDate
          ? new Date(Math.max(now.getTime(), live.endDate.getTime()) + (end.getTime() - start.getTime())) : end;
        write = {
          ...this.write(live), status: 'ACTIVE', cancelAtPeriodEnd: false, canceledAt: null, source: 'payment',
          endDate, billingCycle: input.billingCycle, paymentReference: input.reference,
        };
      } else if (live) {
        const current = live.paymentReference ? await this.store.findPaymentEvidence(tx, live.paymentReference) : null;
        if (current && current.periodStart > start) return unchanged('superseded');
        write = this.paidTerm(plan.id, input, start, end);
      } else write = this.paidTerm(plan.id, input, start, end);
      await this.store.paymentHistory?.recordApplication(tx, {
        evidence: { reference: input.reference, userId: input.userId, planId: plan.id, billingCycle: input.billingCycle,
          periodStart: start, periodEnd: end, orderId: input.orderId ?? null },
        appliedAt: now, previous: live ? this.write(live) : null,
      });
      const after = await this.store.save(tx, input.userId, write);
      return { outcome: 'applied', subscription: after, change: { kind: 'paid', userId: input.userId, before, after } };
    });
  }

  /**
   * Full-refund write-back. Replays the current term's application ancestry excluding every refunded
   * reference, preserving unrefunded payments and administrator baselines in either refund order.
   * Refund markers make replay idempotent. Missing legacy ancestry fails closed: a consumer must
   * restore audited application history before retrying; payment periods alone cannot prove grants.
   * All history, markers and term updates must commit in the caller's refund transaction.
   */
  async revokePayment(input: SubscriptionRefundInput): Promise<SubscriptionRefundResult> {
    this.identifier(input?.userId, 'userId');
    this.identifier(input?.reference, 'reference');
    return this.store.transaction(input.userId, async (tx) => {
      const evidence = await this.store.findPaymentEvidence(tx, input.reference);
      const before = await this.store.find(tx, input.userId);
      const unchanged = (outcome: SubscriptionRefundOutcome): SubscriptionRefundResult => ({ outcome, subscription: before, change: null });
      if (!evidence || evidence.userId !== input.userId) return unchanged('not_found');
      const history = this.store.paymentHistory;
      if (!history) throw new SubscriptionAssignmentError('unavailable', 'Durable payment application history is required for refunds');
      const now = this.clock();
      const firstRefund = await history.recordRefund(tx, input.reference, input.userId);
      if (!before || before.status === 'EXPIRED' || (before.endDate !== null && before.endDate <= now)) return unchanged('inactive');
      if (!firstRefund || before.source !== 'payment' || !before.paymentReference) return unchanged('not_current');

      const applications: SubscriptionPaymentApplication[] = [];
      const seen = new Set<string>();
      let baseline: UserSubscriptionWrite | null = this.write(before);
      while (baseline?.source === 'payment' && baseline.paymentReference) {
        const reference = baseline.paymentReference;
        if (seen.has(reference)) throw new SubscriptionAssignmentError('unavailable', 'Cyclic payment application history');
        seen.add(reference);
        const application = await history.findApplication(tx, reference);
        if (!application || application.evidence.userId !== input.userId || application.evidence.reference !== reference)
          throw new SubscriptionAssignmentError('unavailable', 'Payment application history is incomplete; audited reconciliation is required', { reference });
        applications.unshift(application);
        baseline = application.previous;
      }
      // Refunding an unapplied payment or a term behind an administrator boundary changes no grant.
      if (!seen.has(input.reference)) return unchanged('not_current');
      let restored = baseline;
      for (const application of applications) {
        if (await history.isRefunded(tx, application.evidence.reference)) continue;
        const paid = application.evidence;
        const live = restored && this.options.activeTerm(restored, application.appliedAt) ? restored : null;
        const decision = this.precedence(live, paid.planId, paid.billingCycle, paid.periodEnd);
        if (decision === 'lifetime' || decision === 'admin' || decision === 'covered') continue;
        if (live && (decision === 'stack' || decision === 'extend')) {
          const endDate = decision === 'stack' && paid.periodEnd && live.endDate
            ? new Date(Math.max(application.appliedAt.getTime(), live.endDate.getTime()) + paid.periodEnd.getTime() - paid.periodStart.getTime())
            : paid.periodEnd;
          restored = { ...live, status: 'ACTIVE', cancelAtPeriodEnd: false, canceledAt: null, source: 'payment',
            endDate, billingCycle: paid.billingCycle, paymentReference: paid.reference };
        } else restored = this.paidTerm(paid.planId, paid, paid.periodStart, paid.periodEnd);
      }
      const write: UserSubscriptionWrite = restored
        ? { ...restored }
        : { ...this.write(before), paymentReference: null, status: 'EXPIRED',
          endDate: before.billingCycle === 'LIFETIME' ? null : now, cancelAtPeriodEnd: false, canceledAt: now };
      if (write.endDate && write.endDate <= now) {
        write.status = 'EXPIRED'; write.cancelAtPeriodEnd = false; write.canceledAt = now;
      } else if (restored && before.cancelAtPeriodEnd && write.billingCycle !== 'LIFETIME') {
        // A user's later cancellation remains in force for the surviving finite term.
        write.status = 'CANCELED'; write.cancelAtPeriodEnd = true; write.canceledAt = before.canceledAt;
      }
      if (JSON.stringify(write) === JSON.stringify(this.write(before))) return unchanged('not_current');
      const after = await this.store.save(tx, input.userId, write);
      return { outcome: write.status === 'EXPIRED' ? 'revoked' : 'shortened', subscription: after,
        change: { kind: 'refunded', userId: input.userId, before, after } };
    });
  }

  /**
   * Shared precedence of checkout admission and payment write-back for a purchase of `planId` ending
   * at `end` (null for LIFETIME) against the live term.
   */
  private precedence(live: UserSubscriptionWrite | null, planId: string, cycle: UserSubscriptionCycle, end: Date | null):
    'new' | 'lifetime' | 'admin' | 'covered' | 'stack' | 'extend' | 'replace' {
    if (!live) return 'new';
    if (live.billingCycle === 'LIFETIME' || live.endDate === null) return 'lifetime';
    if (live.planId === planId) {
      if (cycle === 'ONE_TIME') return 'stack';
      // A recurring period of the same plan never shortens the term or re-opens a cancellation.
      if (end !== null && end <= live.endDate) return 'covered';
      return 'extend';
    }
    if (live.source === 'admin' && end !== null && live.endDate > end) return 'admin';
    return 'replace';
  }

  private paidTerm(planId: string, input: SubscriptionPaymentInput, start: Date, end: Date | null): UserSubscriptionWrite {
    return { planId, status: 'ACTIVE', billingCycle: input.billingCycle, startDate: start, endDate: end,
      cancelAtPeriodEnd: false, canceledAt: null, source: 'payment', paymentReference: input.reference };
  }
  /** `ordersAllowed`: an unsettled checkout does not block (revocation and cancel); a provider subscription still does. */
  private async assertNoPendingPayment(tx: Tx, userId: string, ordersAllowed = false): Promise<void> {
    const blocking = await this.store.pendingPayment(tx, userId);
    if (blocking && !(ordersAllowed && blocking.kind === 'order'))
      throw new SubscriptionAssignmentError('pending_payment',
        `The user's plan billing is controlled by ${blocking.kind} ${blocking.id} (${blocking.state}); settle or cancel it first`,
        { blocking });
  }
  private write(record: UserSubscriptionRecord): UserSubscriptionWrite {
    const { planId, status, billingCycle, startDate, endDate, cancelAtPeriodEnd, canceledAt, source, paymentReference } = record;
    return { planId, status, billingCycle, startDate, endDate, cancelAtPeriodEnd, canceledAt, source, paymentReference };
  }
  private identifier(value: unknown, field: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 255)
      throw new SubscriptionAssignmentError('invalid', `Invalid ${field}`);
  }
  private async notify(change: SubscriptionChange): Promise<void> {
    try {
      await this.options.changed?.(change);
    } catch (error) {
      this.options.onNotifyError?.(error, change);
    }
  }
}
