/**
 * Polling cadence for provider subscription reconciliation.
 *
 * Webhooks and user actions call `refresh` directly, so the scheduled poll is only a safety net.
 * Polling every subscription every 15 minutes forever multiplies provider calls and async_jobs rows by
 * every subscription ever sold, so the cadence depends on how much can still change:
 * - unsettled states (cancellation in flight, past_due, unknown): 15 minutes;
 * - stable states (active, trialing, paused, unpaid): every 6 hours, or shortly after the current
 *   period ends when that comes sooner (renewal evidence appears then);
 * - confirmed cancellations: one follow-up within a day (late final invoices), then parked.
 * A parked row is woken again by a webhook or a user-initiated refresh.
 */
export const SUBSCRIPTION_RECONCILE_PARKED_AT = new Date('9999-12-31T00:00:00.000Z');
const MINUTE = 60_000, HOUR = 60 * MINUTE;
const UNSETTLED = 15 * MINUTE, STABLE = 6 * HOUR, AFTER_PERIOD_END = 15 * MINUTE, CANCELED_FOLLOW_UP = 24 * HOUR;

export interface SubscriptionScheduleFacts {
  status: string;
  cancelState: string;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
}

export function nextSubscriptionReconcileAt(facts: SubscriptionScheduleFacts, now = new Date()): Date {
  const at = (delay: number) => new Date(now.getTime() + delay);
  if (facts.cancelState === 'submitting') return at(UNSETTLED);
  if (facts.status === 'canceled') {
    const canceledAt = facts.canceledAt?.getTime() ?? now.getTime();
    // One follow-up after the cancellation settles; afterwards only webhooks/user refreshes reopen it.
    return now.getTime() - canceledAt < CANCELED_FOLLOW_UP ? new Date(canceledAt + CANCELED_FOLLOW_UP) : SUBSCRIPTION_RECONCILE_PARKED_AT;
  }
  if (facts.status === 'past_due' || facts.status === 'unknown') return at(UNSETTLED);
  const stable = now.getTime() + STABLE;
  const periodEnd = facts.currentPeriodEnd?.getTime();
  if (periodEnd !== undefined && periodEnd + AFTER_PERIOD_END > now.getTime() && periodEnd + AFTER_PERIOD_END < stable)
    return new Date(periodEnd + AFTER_PERIOD_END);
  return new Date(stable);
}
