import type { DatabaseAdapter } from '@zucker-framework/core';
import type { HostedCheckoutOrder, ResolvedPlanOffer, SubscriptionCycleReceipt } from '@zucker-framework/payment';
import type { PublicBillingCheckoutPolicy, PublicCreditPack } from '@zucker-framework/fe-types/back-office';

/**
 * Identity of an optional bearer on a public route. Any missing, malformed, expired or revoked
 * credential must read as anonymous (`null`): a public page never fails because of a stale token.
 */
export interface SubscriptionsViewer {
  userId(authorization: unknown): Promise<string | null>;
}

/** Plans as checkout offers, registered on the billing integration so billing never imports plan code. */
export interface PlanOfferSource {
  /** A `plan:` offer for one provider, or null when not for sale; may refuse the buyer with an HTTP exception. */
  resolve(offerId: string, providerId: string, ownerId: string): Promise<ResolvedPlanOffer | null>;
  /** True when a plan has the slug of this static offer id (the plan then is the offer). */
  claims(offerId: string): Promise<boolean>;
}

/** Fulfillment integration points; they only write in `tx` (the billing fulfillment transaction). */
export interface PlanFulfillmentHooks {
  /** True: these hooks write the plan entitlement of orders that carry a `plan` snapshot. */
  readonly plans: true;
  checkoutFulfilled(tx: DatabaseAdapter, order: Readonly<Pick<HostedCheckoutOrder, 'id' | 'ownerId' | 'offer' | 'fulfilledAt' | 'createdAt'>>): Promise<void>;
  cycleFulfilled(tx: DatabaseAdapter, input: {
    ownerId: string;
    subscription: Readonly<{ initialOrderId: string; offer: { fulfillmentData?: unknown } }>;
    receipt: Readonly<Pick<SubscriptionCycleReceipt, 'id' | 'periodStart' | 'periodEnd' | 'paidAt' | 'initial'>>;
  }): Promise<void>;
  /**
   * A payment refunded in full (called once per payment, in the refund settlement transaction):
   * revokes or shortens the plan term that payment defined. Partial refunds never reach it.
   */
  paymentRefunded?(tx: DatabaseAdapter, input: Readonly<PlanPaymentRefunded>): Promise<void>;
}

/** The part of billing's full-refund notification the plan write-back reads. */
export interface PlanPaymentRefunded {
  ownerId: string;
  /** Payment ledger reference: `order:<orderId>` or `cycle:<cycleId>`. */
  reference: string;
  /** Frozen fulfillment data of the order or subscription; plan sales carry a `plan` snapshot. */
  fulfillmentData: unknown;
}

/**
 * The billing integration as seen by the subscription host. The Framework template's
 * `BillingService` satisfies it structurally (register it with `billing: BillingService`).
 */
export interface SubscriptionsBillingPort {
  readonly catalog: {
    /** Enabled providers able to sell a plan price with these references in this checkout mode. */
    planProviders(mode: 'payment' | 'subscription', providerRefs: Readonly<Record<string, string>>): string[];
    /** Listed credit packs (optionally one currency, localized). */
    publicPacks(currency?: string, locale?: string): Promise<PublicCreditPack[]>;
  };
  checkoutPolicy(): Promise<PublicBillingCheckoutPolicy>;
  usePlanOffers(offers: PlanOfferSource): void;
  useFulfillmentHooks(hooks: PlanFulfillmentHooks): void;
}
