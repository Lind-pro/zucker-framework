import { HostedCheckoutError, type HostedCheckoutOrder, type ResolvedPlanOffer, type SubscriptionCycleReceipt } from '@zucker-framework/payment';
import type { ApplicationTransaction } from '../database';
import type { BillingSubscription } from './subscription-persistence';

/**
 * Plans as checkout offers. Supplied by the module that owns plans (SubscriptionsModule) so billing
 * never imports plan code; without it, only the static BILLING_CATALOG_JSON offers exist.
 */
export interface BillingPlanOffers {
  /**
   * A `plan:` offer for one provider from the current plan catalog, or null when it is not for sale.
   * It may refuse the buyer (`ownerId`) with an HTTP exception when the purchase would not improve
   * their current term; that runs before an order exists.
   */
  resolve(offerId: string, providerId: string, ownerId: string): Promise<ResolvedPlanOffer | null>;
  /**
   * True when a plan was seeded from (has the slug of) this static offer id. The plan then is the
   * offer: the static subscription entry stays a seed and is no longer sold on its own.
   */
  claims(offerId: string): Promise<boolean>;
}

/** Integration points inside the fulfillment transactions; they must only write in `tx`. */
export interface BillingFulfillmentHooks {
  /** True when these hooks write the plan entitlement of orders that carry a `plan` snapshot. */
  readonly plans?: boolean;
  /** A verified one-time checkout (mode `payment`) committed with its credit grant. */
  checkoutFulfilled?(tx: ApplicationTransaction, order: Readonly<HostedCheckoutOrder>): Promise<void>;
  /** A verified subscription cycle committed with its receipt, credit grant and outbox event. */
  cycleFulfilled?(tx: ApplicationTransaction, input: {
    ownerId: string; subscription: Readonly<BillingSubscription>; receipt: Readonly<SubscriptionCycleReceipt>;
  }): Promise<void>;
}

/** True when an order/subscription offer was sold as a plan (its fulfillment data has a `plan` snapshot). */
export function soldAsPlan(fulfillmentData: unknown): boolean {
  return !!fulfillmentData && typeof fulfillmentData === 'object' && (fulfillmentData as { plan?: unknown }).plan !== undefined;
}
/**
 * A plan sale must never be fulfilled without its entitlement: with no registered plan hook (for
 * example SubscriptionsModule was removed while plan orders were open) the fulfillment transaction
 * fails and the paid order stays retryable for reconciliation.
 */
export function assertPlanFulfillment(fulfillmentData: unknown, handled: boolean): void {
  if (soldAsPlan(fulfillmentData) && !handled)
    throw new HostedCheckoutError('conflict', 'A plan purchase cannot be fulfilled: no plan fulfillment hook is registered');
}

/** Mutable registry shared by BillingService and the persistences it builds; read at call time. */
export class BillingExtensions {
  planOffers: BillingPlanOffers | null = null;
  private readonly hooks: BillingFulfillmentHooks[] = [];
  register(hooks: BillingFulfillmentHooks): void { this.hooks.push(hooks); }
  private get handlesPlans(): boolean { return this.hooks.some(hook => hook.plans === true); }
  async checkoutFulfilled(tx: ApplicationTransaction, order: Readonly<HostedCheckoutOrder>): Promise<void> {
    assertPlanFulfillment(order.offer.fulfillmentData, this.handlesPlans);
    for (const hook of this.hooks) await hook.checkoutFulfilled?.(tx, order);
  }
  async cycleFulfilled(tx: ApplicationTransaction, input: Parameters<NonNullable<BillingFulfillmentHooks['cycleFulfilled']>>[1]): Promise<void> {
    assertPlanFulfillment(input.subscription.offer.fulfillmentData, this.handlesPlans);
    for (const hook of this.hooks) await hook.cycleFulfilled?.(tx, input);
  }
}
