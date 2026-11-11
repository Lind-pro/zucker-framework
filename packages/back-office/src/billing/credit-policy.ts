import { createHash } from 'node:crypto';
import type { CreditOperationInput } from '@zucker-framework/credit';
import { CYCLE_FOR_INTERVAL } from '@zucker-framework/fe-types/back-office';
import { HostedCheckoutError, addBillingCycle, readPlanPriceSnapshot } from '@zucker-framework/payment';

export interface CreditFulfillmentPolicy {
  credits: number;
  expiresInDays: number | null;
  grantBasis?: 'period' | 'payment';
  /** Plan offers only: the credits expire with the paid period (one-time term end, cycle end). */
  expiresAtPeriodEnd?: true;
}

/**
 * Frozen fulfillment policy of an offer, never a client-selected amount. A plan offer also carries
 * its frozen `plan` snapshot (validated by the plan write-back hook) and may grant no credits; a
 * credit pack offer carries its frozen `pack` snapshot (audit only: the grant reads
 * `credits`/`expiresInDays` here); every other offer must grant a positive amount.
 */
export function validateCreditFulfillmentPolicy(value: unknown): CreditFulfillmentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid credit fulfillment policy');
  const policy = value as Record<string, unknown>;
  const plan = policy.plan !== undefined;
  const snapshot = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    Object.keys(policy).some((key) => !['credits', 'expiresInDays', 'grantBasis', 'plan', 'pack', 'expiresAtPeriodEnd'].includes(key)) ||
    (plan && !snapshot(policy.plan)) ||
    (policy.pack !== undefined && (plan || !snapshot(policy.pack))) ||
    (policy.expiresAtPeriodEnd !== undefined &&
      (policy.expiresAtPeriodEnd !== true || !plan || (policy.expiresInDays ?? null) !== null)) ||
    !Number.isSafeInteger(policy.credits) ||
    Number(policy.credits) < (plan ? 0 : 1) ||
    Number(policy.credits) > 2_147_483_647
  )
    throw new TypeError('Invalid credit fulfillment policy');
  const days = policy.expiresInDays ?? null;
  if (days !== null && (!Number.isSafeInteger(days) || Number(days) <= 0 || Number(days) > 100_000_000))
    throw new TypeError('Invalid credit expiry policy');
  if (policy.grantBasis !== undefined && policy.grantBasis !== 'period' && policy.grantBasis !== 'payment')
    throw new TypeError('Invalid subscription grant basis');
  return {
    credits: Number(policy.credits),
    expiresInDays: days === null ? null : Number(days),
    ...(policy.grantBasis === undefined ? {} : { grantBasis: policy.grantBasis }),
    ...(policy.expiresAtPeriodEnd === true ? { expiresAtPeriodEnd: true as const } : {}),
  };
}

/**
 * End of the paid period a grant belongs to, from the frozen plan snapshot in `fulfillmentData`.
 * One-time: `start + termDays`; lifetime: null (never); a subscription cycle: the receipt's proven
 * period end, else one billing interval after payment (receipt-basis channels).
 */
export function paidPeriodEnd(fulfillmentData: unknown, start: Date, receiptPeriodEnd?: Date | null): Date | null {
  const raw = fulfillmentData && typeof fulfillmentData === 'object' ? (fulfillmentData as { plan?: unknown }).plan : undefined;
  const plan = readPlanPriceSnapshot(raw);
  if (!plan) throw new HostedCheckoutError('conflict', 'Plan snapshot of the order is invalid');
  if (plan.interval === 'lifetime') return null;
  if (plan.interval === 'one_time') return new Date(start.getTime() + (plan.termDays ?? 0) * 86_400_000);
  const cycle = CYCLE_FOR_INTERVAL[plan.interval];
  return receiptPeriodEnd ?? addBillingCycle(start, cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY');
}

/** Expiry of granted credits: with the paid period, `expiresInDays` after the grant, or never. */
export function creditExpiresAt(policy: CreditFulfillmentPolicy, grantedAt: Date, periodEnd: () => Date | null): Date | null {
  const expiresAt = policy.expiresAtPeriodEnd ? periodEnd()
    : policy.expiresInDays === null ? null : new Date(grantedAt.getTime() + policy.expiresInDays * 86_400_000);
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new TypeError('Credit expiry exceeds the supported date range');
  return expiresAt;
}

/** Idempotent credit operation of a one-time checkout grant. */
export function checkoutCreditOperation(orderId: string, ownerId: string, credits: number): CreditOperationInput {
  return {
    idempotencyKey: `checkout-credit:${createHash('sha256').update(orderId).digest('hex')}`,
    accountId: ownerId,
    operationType: 'CHECKOUT_CREDIT_GRANT',
    amount: credits,
    resourceType: 'billing-order',
    resourceId: orderId,
  };
}
