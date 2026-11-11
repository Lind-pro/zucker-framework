import type { BatchCreditLedger } from '@zucker-framework/credit';
import type {
  HostedCheckoutObservation, HostedCheckoutOffer, HostedCheckoutOrder, HostedCheckoutSelection, Money, ResolvedPlanOffer,
  SubscriptionCycleReceipt,
} from '@zucker-framework/payment';
import type { BillingDatabase, BillingTransaction } from './billing.database';
import type { BillingSubscription } from './subscription-persistence';

/**
 * Optional credit ledger. Without it the host runs in **plans-only mode**: it touches no credit
 * table, every offer must grant zero credits (plan offers), credit packs and `GET /billing/balance`
 * are unavailable, and refunds never hold or revoke credits.
 */
export interface BillingCredits {
  /**
   * The consumer's batch ledger over its credit models. `refundSettlement: true` is the refund
   * channel (it may settle holds that the consumer's normal spending rules would block).
   */
  ledger(database: BillingDatabase, options?: { refundSettlement?: boolean }): BillingCreditLedger;
  /** Balance projection for `GET /billing/balance` (omit to disable that route). */
  balance?(database: BillingDatabase, ownerId: string): Promise<{ available: number; frozen: number; bookBalance: number }>;
}
export type BillingCreditLedger = Pick<BatchCreditLedger<BillingTransaction>,
  'grant' | 'revokeUnused' | 'expireInTransaction' | 'hold' | 'confirmHold' | 'releaseHold'>;

/** Affiliate/referral metadata attached to provider checkouts (for example `@zucker-framework/fe-site`). */
export interface BillingReferrals {
  /** Referral programs a provider officially supports, as shown in the catalog. */
  providers(providerId: string): readonly string[];
  /** Provider metadata from the untrusted browser referral value (never throws; `{}` when nothing applies). */
  metadata(providerId: string, referral: unknown): Record<string, string>;
}

/** Checkout provider policy (for example the template's `billing` product policy). */
export interface BillingCheckoutPolicyValues {
  /** Provider id preselected at checkout ('' = the first provider that can sell the offer). */
  defaultProvider: string;
  /** When false, checkout accepts only `defaultProvider` (if it is enabled). */
  allowProviderChoice: boolean;
  /** When true (and promotions are installed), buyers may enter a promotion alias at checkout. */
  allowCustomerPromoCodes: boolean;
}
export type BillingCheckoutPolicySource = () => Promise<BillingCheckoutPolicyValues>;

/**
 * Plans as checkout offers, registered by the module that owns plans so billing never imports plan code.
 */
export interface BillingPlanOffers {
  /**
   * A `plan:` offer for one provider from the current plan catalog, or null when it is not for sale.
   * It may refuse the buyer (`ownerId`) with an HTTP exception before an order exists.
   */
  resolve(offerId: string, providerId: string, ownerId: string): Promise<ResolvedPlanOffer | null>;
  /** True when a plan was seeded from (has the slug of) this static offer id; the plan then is the offer. */
  claims(offerId: string): Promise<boolean>;
}

/** A verified refund that returned the whole paid amount of one plan or credit payment. */
export interface BillingPaymentRefunded {
  ownerId: string;
  /** The checkout order (for a subscription cycle: the subscription's initial order). */
  orderId: string;
  /** The subscription cycle receipt id, or null for a one-time order. */
  cycleId: string | null;
  /**
   * The plan payment reference written by the plan write-back for this payment:
   * `order:<orderId>` for a one-time order, `cycle:<cycleId>` for a subscription cycle.
   */
  reference: string;
  /** True: refunded amount equals the paid amount. Partial refunds never reach the hooks. */
  full: true;
  paidMoney: Money;
  refundedMoney: Money;
  /** The frozen fulfillment data of the order/subscription (carries the `plan` snapshot of a plan sale). */
  fulfillmentData: unknown;
}

/** Integration points inside the billing transactions; they must only write in `tx`. */
export interface BillingFulfillmentHooks {
  /** True when these hooks write the plan entitlement of orders that carry a `plan` snapshot. */
  readonly plans?: boolean;
  /** A verified one-time checkout (mode `payment`) committed with its credit grant. */
  checkoutFulfilled?(tx: BillingTransaction, order: Readonly<HostedCheckoutOrder>): Promise<void>;
  /** A verified subscription cycle committed with its receipt, credit grant and outbox event. */
  cycleFulfilled?(tx: BillingTransaction, input: {
    ownerId: string; subscription: Readonly<BillingSubscription>; receipt: Readonly<SubscriptionCycleReceipt>;
  }): Promise<void>;
  /**
   * A payment was refunded in full (called once per payment, under the account lock, in the refund
   * settlement transaction). The plan host revokes the paid term here: a full refund revokes it, a
   * partial refund keeps it. A plan sale whose full refund no hook handles is reported through the
   * `billing.plan-refund-unapplied` outbox event instead of silently keeping the term.
   */
  paymentRefunded?(tx: BillingTransaction, input: Readonly<BillingPaymentRefunded>): Promise<void>;
}

/**
 * Promotions as a checkout extension, registered by the promotions feature (see
 * `BillingService.usePromotions`) so billing never imports it.
 */
export interface BillingPromotions {
  /**
   * Freeze a server-computed discount onto `offer` (`offer.promotion`) and reserve one use of it for
   * `selection.orderId` under a lock on the promotion. With `selection.promotionCode` that promotion
   * or `promoInvalid()`; without it an automatic promotion when one applies, else the offer unchanged.
   */
  apply(selection: Readonly<HostedCheckoutSelection>, offer: HostedCheckoutOffer): Promise<HostedCheckoutOffer>;
  /** Drop the reservation of an order that was never created. Idempotent; a created order keeps it. */
  release(orderId: string): Promise<void>;
}

/** Product checks around provider dispatch (account identity, catalog prices). */
export interface BillingCheckoutHooks {
  /**
   * Called with the final frozen offer (after promotions) before an order is created. Throw a
   * `HostedCheckoutError`/HTTP exception to refuse, for example when the provider price behind
   * `offer.catalogReference` differs from the frozen amount.
   */
  verifyOffer?(offer: Readonly<HostedCheckoutOffer>, selection: Readonly<HostedCheckoutSelection>): Promise<void>;
  /**
   * Administrator order recovery from a provider session id: extra product checks that `checkoutId`
   * belongs to this application (for example Stripe session metadata). Runs before the host reads the
   * provider evidence, which is always verified against the frozen order (reference, catalog, money).
   */
  verifyRecovery?(checkoutId: string, order: Readonly<HostedCheckoutOrder>): Promise<void>;
}

/** A refund command about to be prepared (nothing is written yet). */
export interface BillingRefundAdmissionInput {
  actorId: string;
  /** The caller's Idempotency-Key. */
  clientKey: string;
  ownerId: string;
  orderId: string;
  cycleId: string | null;
  targetType: 'order' | 'cycle';
  targetId: string;
  money: Money;
  reason: string | null;
  /** True for a plan payment (grants entitlement, not credits). */
  plan: boolean;
}
/** A refund request reached a terminal cash state (settlement transaction, under the account lock). */
export interface BillingRefundSettledInput {
  requestId: string;
  clientKey: string;
  actorId: string;
  ownerId: string;
  orderId: string;
  cycleId: string | null;
  state: 'succeeded' | 'failed' | 'canceled';
  money: Money;
  providerRefundId: string | null;
}
/**
 * Lets a product put its own customer request / approval step in front of refund dispatch and follow
 * the outcome. `admit` runs before any request row exists, so a refusal leaves nothing behind.
 */
export interface BillingRefundHooks {
  admit?(input: Readonly<BillingRefundAdmissionInput>): Promise<void>;
  settled?(tx: BillingTransaction, input: Readonly<BillingRefundSettledInput>): Promise<void>;
}

/** Re-exported for hook implementations. */
export type { HostedCheckoutObservation };
