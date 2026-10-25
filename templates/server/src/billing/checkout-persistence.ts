import type { ModelOperations } from '@zucker-framework/core';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { DatabaseOrderPersistence, HostedCheckoutError } from '@zucker-framework/payment';
import type { HostedCheckoutOrder, HostedCheckoutPersistence } from '@zucker-framework/payment';
import { ApplicationDatabase, ApplicationTransaction } from '../database';
import { checkoutCreditOperation, createCreditLedger, validateCreditFulfillmentPolicy } from './ledger';
import { bindCheckoutSubscription } from './subscription-persistence';
import { refundCheckoutGrant } from './refunds/refunds.grant';

const coordinator = new PostgresCreditOperationCoordinator();
export const CHECKOUT_FULFILLED_OUTBOX_KIND = 'billing.credit-fulfilled';

function inconsistent(): never {
  throw new HostedCheckoutError('conflict', 'Billing fulfillment evidence is inconsistent; automatic granting stopped');
}

/** The same account → order lock order is used by every checkout CAS. */
class TransactionCheckoutOrders extends DatabaseOrderPersistence<HostedCheckoutOrder> {
  constructor(private readonly transaction: ApplicationTransaction) {
    super(transaction.model('billingOrders') as ModelOperations<HostedCheckoutOrder>);
  }
  override async compareAndSet(id: string, expected: Record<string, unknown>, data: Record<string, unknown>): Promise<boolean> {
    if (['ownerId', 'offer', 'offerId', 'providerId', 'accountScope', 'createKey', 'captureKey'].some(key => key in data))
      throw new HostedCheckoutError('conflict', 'Frozen order identity cannot be changed');
    const order = await this.findUnique({ where: { id } });
    if (!order) return false;
    await coordinator.lockAccount(this.transaction, order.ownerId);
    return super.compareAndSet(id, { AND: [expected, { ownerId: order.ownerId }] }, data);
  }
}

class RootCheckoutOrders extends DatabaseOrderPersistence<HostedCheckoutOrder> {
  constructor(private readonly database: ApplicationDatabase) {
    super(database.model('billingOrders') as ModelOperations<HostedCheckoutOrder>);
  }
  override create(args: Record<string, unknown>): Promise<HostedCheckoutOrder> {
    const data = args.data as Record<string, unknown>;
    if (data.providerMetadata === null) {
      // Omission writes SQL NULL for this optional JSON field; bare JSON null is ambiguous to Prisma.
      const { providerMetadata: _empty, ...fields } = data;
      return super.create({ ...args, data: fields });
    }
    return super.create(args);
  }
  override compareAndSet(id: string, expected: Record<string, unknown>, data: Record<string, unknown>): Promise<boolean> {
    return this.database.transaction(tx => new TransactionCheckoutOrders(tx).compareAndSet(id, expected, data));
  }
}

/** All payment/order, operation receipt, lot, balance, journal and outbox writes share this transaction. */
export function createCheckoutPersistence(database: ApplicationDatabase): HostedCheckoutPersistence {
  const ledger = createCreditLedger(database);
  return {
    orders: new RootCheckoutOrders(database),
    transaction: work => database.transaction(async tx => {
      const orders = new TransactionCheckoutOrders(tx);
      return work({
        orders,
        fulfill: async supplied => {
          // Read the immutable policy from this transaction's persisted order, not today's catalog.
          const order = await orders.findUnique({ where: { id: supplied.id } });
          if (!order || order.ownerId !== supplied.ownerId || order.revision !== supplied.revision
            || order.state !== 'paid' || !order.fulfilledAt || !order.checkoutId || !order.paymentId || !order.paymentKind
            || order.fulfilledAt.getTime() !== supplied.fulfilledAt?.getTime()) inconsistent();
          await coordinator.lockAccount(tx, order.ownerId);
          if (order.offer.mode === 'subscription') {
            await bindCheckoutSubscription(tx, order);
            return;
          }
          const policy = validateCreditFulfillmentPolicy(order.offer.fulfillmentData);
          const source = 'purchase';
          const expiresAt = policy.expiresInDays === null ? undefined
            : new Date(order.fulfilledAt.getTime() + policy.expiresInDays * 86_400_000);
          if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new TypeError('Credit expiry exceeds the supported date range');

          // A prior partial/manual write is not an idempotent success. A normal replay
          // is handled by the paid order CAS before this callback is entered.
          const [fulfillment, lots, journals, outbox] = await Promise.all([
            tx.model('billingFulfillments').findUnique({ where: { orderId: order.id } }),
            tx.model('creditLots').count({ where: { sourceId: order.id } }),
            tx.model('creditTransaction').count({ where: { orderId: order.id } }),
            tx.model('billingOutbox').count({ where: { kind: CHECKOUT_FULFILLED_OUTBOX_KIND, aggregateId: order.id } }),
          ]);
          if (fulfillment || lots || journals || outbox) inconsistent();
          const allowance = await refundCheckoutGrant(tx, order);
          if (allowance.credits > 0) {
            const granted = await ledger.grant(tx, {
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
          await tx.model('billingFulfillments').create({ data: {
            orderId: order.id, ownerId: order.ownerId, credits: allowance.credits, policy,
          } });
          await tx.model('billingOutbox').create({ data: {
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
