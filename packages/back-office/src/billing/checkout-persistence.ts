import type { ModelOperations } from '@zucker-framework/core';
import { DatabaseOrderPersistence, HostedCheckoutError } from '@zucker-framework/payment';
import type { HostedCheckoutObservation, HostedCheckoutOrder, HostedCheckoutPersistence } from '@zucker-framework/payment';
import { billingTransaction, type BillingDatabase, type BillingStorage, type BillingTransaction } from './billing.database';
import { CREDITS_UNAVAILABLE, type BillingPersistenceConfig } from './billing.config';
import { checkoutCreditOperation, creditExpiresAt, paidPeriodEnd, validateCreditFulfillmentPolicy } from './credit-policy';
import { bindCheckoutSubscription } from './subscription-persistence';
import { refundCheckoutGrant } from './refunds/refunds.grant';
import { assertPlanFulfillment, type BillingExtensions } from './billing-extensions';

export const CHECKOUT_FULFILLED_OUTBOX_KIND = 'billing.credit-fulfilled';

function inconsistent(): never {
  throw new HostedCheckoutError('conflict', 'Billing fulfillment evidence is inconsistent; automatic granting stopped');
}

/**
 * Marks the order's promotion use redeemed (or records it when its reservation is gone) with the
 * fulfillment. The amounts are the frozen ones the service already verified against the provider,
 * so the order's frozen promotion wins over whatever its reservation named. A second redemption of
 * the same order, or one owned by another account, stops automatic granting.
 */
async function redeemPromotion(storage: BillingStorage, tx: BillingTransaction, order: HostedCheckoutOrder, observation?: Readonly<HostedCheckoutObservation>): Promise<void> {
  const promotion = order.offer.promotion;
  if (!promotion) return;
  const reference = observation?.discountReferences?.[0] ?? promotion.providerCode;
  const { rows } = await tx.query<{ orderId: string }>(`INSERT INTO ${storage.t.promotionRedemptions} AS redemption
      ("orderId","promotionId","ownerId","providerId","status","reference","discountAmount","payableAmount","currency","expiresAt","redeemedAt")
    VALUES ($1,$2,$3,$4,'redeemed',$5,$6,$7,$8,$9,$9)
    ON CONFLICT ("orderId") DO UPDATE SET "promotionId"=EXCLUDED."promotionId", "providerId"=EXCLUDED."providerId",
      "status"='redeemed', "reference"=EXCLUDED."reference", "discountAmount"=EXCLUDED."discountAmount",
      "payableAmount"=EXCLUDED."payableAmount", "currency"=EXCLUDED."currency", "redeemedAt"=EXCLUDED."redeemedAt"
    WHERE redemption."ownerId"=EXCLUDED."ownerId" AND redemption."status"='reserved'
    RETURNING "orderId"`, [order.id, promotion.id, order.ownerId, order.providerId, reference.slice(0, 255),
    promotion.discount.amount, promotion.payable.amount, promotion.payable.currency, order.fulfilledAt]);
  if (rows.length !== 1) inconsistent();
}

/** The same account → order lock order is used by every checkout CAS. */
class TransactionCheckoutOrders extends DatabaseOrderPersistence<HostedCheckoutOrder> {
  constructor(private readonly storage: BillingStorage, private readonly transaction: BillingTransaction) {
    super(storage.model(transaction, 'billingOrders') as ModelOperations<HostedCheckoutOrder>);
  }
  override async compareAndSet(id: string, expected: Record<string, unknown>, data: Record<string, unknown>): Promise<boolean> {
    // `configRevision` selects the credentials an existing order resolves (D12); it is written once at creation.
    if (['ownerId', 'offer', 'offerId', 'providerId', 'accountScope', 'createKey', 'captureKey', 'configRevision'].some(key => key in data))
      throw new HostedCheckoutError('conflict', 'Frozen order identity cannot be changed');
    const order = await this.findUnique({ where: { id } });
    if (!order) return false;
    await this.storage.lockAccount(this.transaction, order.ownerId);
    return super.compareAndSet(id, { AND: [expected, { ownerId: order.ownerId }] }, data);
  }
}

class RootCheckoutOrders extends DatabaseOrderPersistence<HostedCheckoutOrder> {
  constructor(private readonly storage: BillingStorage, private readonly database: BillingDatabase, private readonly configRevision?: () => string | null) {
    super(storage.model(database, 'billingOrders') as ModelOperations<HostedCheckoutOrder>);
  }
  override create(args: Record<string, unknown>): Promise<HostedCheckoutOrder> {
    // The payment configuration revision this order is created with: the one the provider resolver
    // captured with the order's adapter when present, else the start-up value (null when unknown).
    const supplied = (args.data as Record<string, unknown>).configRevision;
    if (supplied !== undefined && supplied !== null && (typeof supplied !== 'string' || !supplied || supplied.length > 255))
      throw new HostedCheckoutError('invalid_input', 'Order configuration revision is invalid');
    const revision = supplied ?? this.configRevision?.() ?? null;
    if (revision) args = { ...args, data: { ...(args.data as Record<string, unknown>), configRevision: revision } };
    else if (supplied === null) { const { configRevision: _none, ...fields } = args.data as Record<string, unknown>; args = { ...args, data: fields }; }
    const data = args.data as Record<string, unknown>;
    if (data.providerMetadata === null) {
      // Omission writes SQL NULL for this optional JSON field; bare JSON null is ambiguous to Prisma.
      const { providerMetadata: _empty, ...fields } = data;
      return super.create({ ...args, data: fields });
    }
    return super.create(args);
  }
  override compareAndSet(id: string, expected: Record<string, unknown>, data: Record<string, unknown>): Promise<boolean> {
    return billingTransaction(this.database, tx => new TransactionCheckoutOrders(this.storage, tx).compareAndSet(id, expected, data));
  }
}

/** All payment/order, operation receipt, lot, balance, journal and outbox writes share this transaction. */
export function createCheckoutPersistence(database: BillingDatabase, config: BillingPersistenceConfig, options: {
  extensions?: Pick<BillingExtensions, 'checkoutFulfilled'>; configRevision?: () => string | null;
} = {}): HostedCheckoutPersistence {
  const { storage, credits } = config;
  const ledger = credits?.ledger(database) ?? null;
  return {
    orders: new RootCheckoutOrders(storage, database, options.configRevision),
    transaction: work => billingTransaction(database, async tx => {
      const orders = new TransactionCheckoutOrders(storage, tx);
      return work({
        orders,
        fulfill: async (supplied, observation) => {
          // Read the immutable policy from this transaction's persisted order, not today's catalog.
          const order = await orders.findUnique({ where: { id: supplied.id } });
          if (!order || order.ownerId !== supplied.ownerId || order.revision !== supplied.revision
            || order.state !== 'paid' || !order.fulfilledAt || !order.checkoutId || !order.paymentId || !order.paymentKind
            || order.fulfilledAt.getTime() !== supplied.fulfilledAt?.getTime()) inconsistent();
          await storage.lockAccount(tx, order.ownerId);
          await redeemPromotion(storage, tx, order, observation);
          if (order.offer.mode === 'subscription') {
            await bindCheckoutSubscription(tx, order, config);
            return;
          }
          const policy = validateCreditFulfillmentPolicy(order.offer.fulfillmentData);
          if (policy.credits > 0 && !ledger) throw new HostedCheckoutError('unsupported', CREDITS_UNAVAILABLE);
          const source = 'purchase';
          const fulfilledAt = order.fulfilledAt;
          // Plan credits with `creditExpiry: 'period'` end with the one-time term (never for lifetime).
          const expiresAt = creditExpiresAt(policy, fulfilledAt, () => paidPeriodEnd(order.offer.fulfillmentData, fulfilledAt)) ?? undefined;

          // A prior partial/manual write is not an idempotent success. A normal replay
          // is handled by the paid order CAS before this callback is entered.
          const [fulfillment, lots, journals, outbox] = await Promise.all([
            storage.model(tx, 'billingFulfillments').findUnique({ where: { orderId: order.id } }),
            ledger ? storage.model(tx, 'creditLots').count({ where: { sourceId: order.id } }) : 0,
            ledger ? storage.model(tx, 'creditTransactions').count({ where: { orderId: order.id } }) : 0,
            storage.model(tx, 'billingOutbox').count({ where: { kind: CHECKOUT_FULFILLED_OUTBOX_KIND, aggregateId: order.id } }),
          ]);
          if (fulfillment || lots || journals || outbox) inconsistent();
          const allowance = await refundCheckoutGrant(storage, tx, order);
          if (allowance.credits > 0) {
            const granted = await ledger!.grant(tx, {
              accountId: order.ownerId, amount: allowance.credits, source, sourceId: order.id,
              expiresAt, description: order.offer.description,
              operation: checkoutCreditOperation(order.id, order.ownerId, allowance.credits),
              transactionData: {
                type: 'GRANT', orderId: order.id, description: order.offer.description, expireAt: expiresAt ?? null,
                metadata: { source, sourceId: order.id, offerVersion: order.offer.version, policy,
                  suppressedCredits: allowance.suppressedCredits },
              },
            });
            if (!granted) inconsistent();
          }
          await storage.model(tx, 'billingFulfillments').create({ data: {
            orderId: order.id, ownerId: order.ownerId, credits: allowance.credits, policy,
          } });
          // Registered integrations (plan entitlement for one-time plan purchases) commit with the grant;
          // without them a plan order fails here instead of being fulfilled without its entitlement.
          if (options.extensions) await options.extensions.checkoutFulfilled(tx, order);
          else assertPlanFulfillment(order.offer.fulfillmentData, false);
          await storage.model(tx, 'billingOutbox').create({ data: {
            kind: CHECKOUT_FULFILLED_OUTBOX_KIND, aggregateId: order.id,
            payload: { orderId: order.id, ownerId: order.ownerId, credits: allowance.credits,
              suppressedCredits: allowance.suppressedCredits,
              offerVersion: order.offer.version, expiresAt: expiresAt?.toISOString() ?? null },
          } });
        },
      });
    }),
  };
}
