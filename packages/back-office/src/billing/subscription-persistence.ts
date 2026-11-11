import { createHash } from 'node:crypto';
import { HostedCheckoutError } from '@zucker-framework/payment';
import type { HostedCheckoutOffer, HostedCheckoutOrder, SubscriptionCyclePersistence,
  SubscriptionCycleReceipt, SubscriptionEntitlementBinding } from '@zucker-framework/payment';
import { billingTransaction, type BillingDatabase, type BillingTransaction } from './billing.database';
import { CREDITS_UNAVAILABLE, type BillingPersistenceConfig } from './billing.config';
import { creditExpiresAt, paidPeriodEnd, validateCreditFulfillmentPolicy } from './credit-policy';
import { refundCycleGrant } from './refunds/refunds.grant';
import { assertPlanFulfillment, type BillingExtensions } from './billing-extensions';

export const SUBSCRIPTION_RECONCILE_EVENT = 'billing.subscription-reconcile';
export const SUBSCRIPTION_CREDIT_FULFILLED_OUTBOX_KIND = 'billing.subscription-credit-fulfilled';
/**
 * Runs at the start and end of every financial transaction of a scheduled (leased) execution; it must
 * throw when the lease was lost so a superseded worker never commits.
 */
export type BillingExecutionFence = (transaction: BillingTransaction) => Promise<void>;
/** @deprecated name kept for template compatibility; use {@link BillingExecutionFence}. */
export type SubscriptionExecutionFence = BillingExecutionFence;

export interface BillingSubscription {
  id: string; ownerId: string; initialOrderId: string; providerId: string; accountScope: string;
  providerSubscriptionId: string; catalogReference: string; offer: HostedCheckoutOffer;
  grantBasis: 'period' | 'payment'; initialPaymentId: string; initialPaymentKind: HostedCheckoutOrder['paymentKind'];
  initialFulfilledAt: Date | null; customerId: string | null; status: string; providerStatus: string;
  currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean | null;
  canceledAt: Date | null; cancelState: 'idle' | 'submitting' | 'confirmed'; cancelMode: 'immediate' | 'period_end' | null;
  cancelRequestedAt: Date | null; observedAt: Date | null; nextReconcileAt: Date; revision: number;
  reconcileStatus: 'pending' | 'idle' | 'attention'; reconcileErrorCode: string | null; lastReconcileTaskId: string | null;
  createdAt: Date; updatedAt: Date;
}

function conflict(): never { throw new HostedCheckoutError('conflict', 'Subscription fulfillment evidence is inconsistent'); }

/** Called by hosted checkout on its existing transaction; a handoff is not a credit grant. */
export async function bindCheckoutSubscription(tx: BillingTransaction, order: Readonly<HostedCheckoutOrder>, config: BillingPersistenceConfig): Promise<void> {
  const { storage } = config;
  if (order.offer.mode !== 'subscription' || order.state !== 'paid' || !order.fulfilledAt || !order.subscriptionId
    || !order.paymentId || !order.paymentKind) conflict();
  const policy = validateCreditFulfillmentPolicy(order.offer.fulfillmentData);
  if (!policy.grantBasis) throw new HostedCheckoutError('invalid_input', 'Subscription grant basis must be explicit');
  if (policy.credits > 0 && !config.credits) throw new HostedCheckoutError('unsupported', CREDITS_UNAVAILABLE);
  const existing = await storage.model(tx, 'billingSubscriptions').findUnique({ where: { id: order.id } });
  if (existing) conflict();
  await storage.model(tx, 'billingSubscriptions').create({ data: {
    id: order.id, ownerId: order.ownerId, initialOrderId: order.id, providerId: order.providerId,
    accountScope: order.accountScope, providerSubscriptionId: order.subscriptionId,
    catalogReference: order.offer.catalogReference, offer: order.offer,
    grantBasis: policy.grantBasis, initialPaymentId: order.paymentId, initialPaymentKind: order.paymentKind,
  } });
  await storage.model(tx, 'billingOutbox').create({ data: { kind: SUBSCRIPTION_RECONCILE_EVENT,
    aggregateId: order.id, payload: { subscriptionId: order.id, ownerId: order.ownerId } } });
}

function entitlementBinding(row: BillingSubscription): SubscriptionEntitlementBinding {
  const frozenPolicy = row.offer.fulfillmentData;
  if (!frozenPolicy) conflict();
  const policy = validateCreditFulfillmentPolicy(frozenPolicy);
  if (row.offer.mode !== 'subscription' || row.offer.catalogReference !== row.catalogReference
    || !row.initialPaymentKind || policy.grantBasis !== row.grantBasis) conflict();
  return { id: row.id, ownerId: row.ownerId, providerId: row.providerId, accountScope: row.accountScope,
    subscriptionId: row.providerSubscriptionId, catalogReference: row.catalogReference,
    money: row.offer.money, ...(row.offer.promotion ? { initialMoney: row.offer.promotion.payable } : {}),
    policyVersion: row.offer.version, policy: { ...frozenPolicy }, grantBasis: row.grantBasis,
    initialOrderId: row.initialOrderId, initialPaymentId: row.initialPaymentId, initialPaymentKind: row.initialPaymentKind };
}

/** Account locking, cycle uniqueness and one transaction for receipt, ledger and outbox. */
export function createSubscriptionCyclePersistence(database: BillingDatabase, config: BillingPersistenceConfig, fence?: BillingExecutionFence,
  extensions?: Pick<BillingExtensions, 'cycleFulfilled'>): SubscriptionCyclePersistence {
  const { storage } = config, ledger = config.credits?.ledger(database) ?? null;
  return { transaction: (bindingId, ownerId, work) => billingTransaction(database, async tx => {
    await fence?.(tx);
    await storage.lockAccount(tx, ownerId);
    const subscription = await storage.model(tx, 'billingSubscriptions').findUnique({ where: { id: bindingId } }) as BillingSubscription | null;
    if (!subscription) throw new HostedCheckoutError('not_found', 'Subscription not found');
    if (subscription.ownerId !== ownerId) throw new HostedCheckoutError('forbidden', 'Subscription owner mismatch');
    const binding = entitlementBinding(subscription);
    const result = await work({ binding,
      findCycle: async cycleKey => await storage.model(tx, 'billingSubscriptionCycles').findUnique({ where: { cycleKey } }) as SubscriptionCycleReceipt | null,
      findPayment: async identity => {
        const rows = await storage.model(tx, 'billingSubscriptionCycles').findMany({ where: identity, take: 1 }) as SubscriptionCycleReceipt[];
        return rows[0] ?? null;
      },
      insertReceipt: async receipt => { await storage.model(tx, 'billingSubscriptionCycles').create({ data: receipt }); },
      fulfill: async receipt => {
        const policy = validateCreditFulfillmentPolicy(receipt.policy);
        if (policy.credits > 0 && !ledger) throw new HostedCheckoutError('unsupported', CREDITS_UNAVAILABLE);
        // Plan credits with `creditExpiry: 'period'` end with this paid cycle (the same period the plan
        // write-back records); otherwise `expiresInDays` after payment, or never.
        const expiresAt = creditExpiresAt(policy, receipt.paidAt,
          () => paidPeriodEnd(receipt.policy, receipt.paidAt, receipt.periodEnd));
        const lotCount = ledger ? await storage.model(tx, 'creditLots').count({ where: { source: 'subscription', sourceId: receipt.id } }) : 0;
        const events = await storage.model(tx, 'billingOutbox').count({ where: { kind: SUBSCRIPTION_CREDIT_FULFILLED_OUTBOX_KIND, aggregateId: receipt.id } });
        if (lotCount || events) conflict();
        const allowance = await refundCycleGrant(storage, tx, subscription, receipt);
        if (allowance.credits > 0) {
          const granted = await ledger!.grant(tx, {
            accountId: ownerId, amount: allowance.credits, source: 'subscription', sourceId: receipt.id,
            expiresAt: expiresAt ?? undefined, description: subscription.offer.description,
            operation: { idempotencyKey: `subscription-credit:${createHash('sha256').update(receipt.cycleKey).digest('hex')}`,
              accountId: ownerId, operationType: 'SUBSCRIPTION_CREDIT_GRANT', amount: allowance.credits,
              resourceType: 'subscription-cycle', resourceId: receipt.id },
            transactionData: { type: 'GRANT', orderId: receipt.initial ? subscription.initialOrderId : null,
              description: subscription.offer.description, expireAt: expiresAt,
              metadata: { source: 'subscription', sourceId: receipt.id, subscriptionId: subscription.id,
                basis: receipt.basis, cycleKey: receipt.cycleKey, policy, offerVersion: receipt.policyVersion,
                suppressedCredits: allowance.suppressedCredits } },
          });
          if (!granted) conflict();
        }
        // Catching up an old payment must not resurrect credits whose consumer-defined lifetime has elapsed.
        // Keep the grant and expiry evidence together while exposing no transient spendable balance.
        if (allowance.credits > 0 && expiresAt && expiresAt <= receipt.fulfilledAt) {
          const lots = await storage.model(tx, 'creditLots').findMany({ where: { userId: ownerId,
            source: 'subscription', sourceId: receipt.id }, select: { id: true } }) as Array<{ id: string }>;
          await ledger!.revokeUnused(tx, { accountId: ownerId, lotIds: lots.map(lot => lot.id),
            transactionData: { type: 'EXPIRE', description: 'Expired subscription credits',
              metadata: { subscriptionId: subscription.id, sourceId: receipt.id, expiresAt: expiresAt.toISOString() } } });
        }
        if (receipt.initial) {
          const changed = await storage.model(tx, 'billingSubscriptions').updateMany({
            where: { id: subscription.id, ownerId, revision: subscription.revision, initialFulfilledAt: null },
            data: { initialFulfilledAt: receipt.fulfilledAt, revision: { increment: 1 } },
          });
          if (changed.count !== 1) conflict();
          await storage.model(tx, 'billingFulfillments').create({ data: { orderId: subscription.initialOrderId,
            ownerId, credits: allowance.credits, policy } });
        }
        // Registered integrations (plan entitlement write-back) commit with the receipt and credit grant.
        if (extensions) await extensions.cycleFulfilled(tx, { ownerId, subscription, receipt });
        else assertPlanFulfillment(subscription.offer.fulfillmentData, false);
        await storage.model(tx, 'billingOutbox').create({ data: { kind: SUBSCRIPTION_CREDIT_FULFILLED_OUTBOX_KIND, aggregateId: receipt.id,
          payload: { subscriptionId: subscription.id, cycleId: receipt.id, ownerId, credits: allowance.credits,
            suppressedCredits: allowance.suppressedCredits,
            expiresAt: expiresAt?.toISOString() ?? null } } });
      },
    });
    await fence?.(tx);
    return result;
  }) };
}
