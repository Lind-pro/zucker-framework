import { HostedCheckoutError, type HostedCheckoutOrder } from '@zucker-framework/payment';
import type { BillingTransaction } from './billing.database';
import type { BillingFulfillmentHooks, BillingPaymentRefunded, BillingPlanOffers } from './billing.ports';

/** True when an order/subscription offer was sold as a plan (its fulfillment data has a `plan` snapshot). */
export function soldAsPlan(fulfillmentData: unknown): boolean {
  return !!fulfillmentData && typeof fulfillmentData === 'object' && (fulfillmentData as { plan?: unknown }).plan !== undefined;
}
/**
 * A plan sale must never be fulfilled without its entitlement: with no registered plan hook (for
 * example the plan module was removed while plan orders were open) the fulfillment transaction
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
  async checkoutFulfilled(tx: BillingTransaction, order: Readonly<HostedCheckoutOrder>): Promise<void> {
    assertPlanFulfillment(order.offer.fulfillmentData, this.handlesPlans);
    for (const hook of this.hooks) await hook.checkoutFulfilled?.(tx, order);
  }
  async cycleFulfilled(tx: BillingTransaction, input: Parameters<NonNullable<BillingFulfillmentHooks['cycleFulfilled']>>[1]): Promise<void> {
    assertPlanFulfillment(input.subscription.offer.fulfillmentData, this.handlesPlans);
    for (const hook of this.hooks) await hook.cycleFulfilled?.(tx, input);
  }
  /**
   * Full refund of one payment. Returns false when the payment was a plan sale and no registered
   * hook revokes plan terms (the caller then reports it instead of keeping the term silently).
   */
  async paymentRefunded(tx: BillingTransaction, input: Readonly<BillingPaymentRefunded>): Promise<boolean> {
    const handlers = this.hooks.filter(hook => typeof hook.paymentRefunded === 'function');
    for (const hook of handlers) await hook.paymentRefunded!(tx, input);
    return !soldAsPlan(input.fulfillmentData) || handlers.some(hook => hook.plans === true);
  }
}
