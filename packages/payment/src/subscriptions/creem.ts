import type { CreemCheckoutAdapter } from '../providers/creem';
import { SubscriptionProtocolError, type SubscriptionAdapter, type SubscriptionDetails, type SubscriptionPaidPeriodPage } from './types';
import { decodeCursor, encodeCursor, isoDate, requiredId, sameId, secureUrl, validMoney } from './validation';

export interface CreemSubscriptionOptions {
  transport: Pick<CreemCheckoutAdapter, 'retrieveSubscription' | 'listTransactions' | 'cancelSubscription' | 'createCustomerBillingLink' | 'parseWebhook'>;
  accountScope: string;
}
export function createCreemSubscriptionAdapter(options: CreemSubscriptionOptions): SubscriptionAdapter {
  requiredId(options.accountScope);
  const retrieve = async (id: string): Promise<SubscriptionDetails> => {
    const observed = await options.transport.retrieveSubscription(requiredId(id)); sameId(observed.subscriptionId, id);
    const { raw: _raw, ...facts } = observed;
    return { ...facts, catalogReference: facts.productId };
  };
  return { id: 'creem', accountScope: options.accountScope,
    capabilities: { cancel: ['immediate', 'period_end'], billingPortal: true, invoices: false, paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' },
    retrieve,
    async listPaidPeriods(id, input = {}) {
      const sub = await retrieve(id);
      if (!sub.customerId || !sub.catalogReference) throw new SubscriptionProtocolError('invalid_response', 'Creem subscription customer and product are required');
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      if (cursor && (cursor.provider !== 'creem' || cursor.accountScope !== options.accountScope || cursor.subscriptionId !== id ||
          cursor.customerId !== sub.customerId || cursor.productId !== sub.catalogReference || !Number.isSafeInteger(cursor.page) || Number(cursor.page) < 1)) {
        throw new SubscriptionProtocolError('invalid_input', 'Creem cursor identity mismatch');
      }
      // The provider-side product filter supplies the catalog identity absent from TransactionEntity.
      const page = await options.transport.listTransactions({ customerId: sub.customerId, productId: sub.catalogReference, page: cursor ? Number(cursor.page) : 1 });
      const result: SubscriptionPaidPeriodPage = { data: [], issues: [] };
      for (const item of page.items) {
        if (item.subscriptionId !== id || item.state !== 'captured') continue;
        const paidAt = typeof item.raw.created_at === 'number' && Number.isSafeInteger(item.raw.created_at)
          ? isoDate(new Date(item.raw.created_at).toISOString()) : isoDate(item.raw.created_at);
        if (!item.period || !item.money || !paidAt) {
          result.issues?.push({ recordId: item.id, code: !item.period ? 'missing_period' : !item.money ? 'missing_money' : 'missing_paid_at' }); continue;
        }
        result.data.push({ recordId: item.id, subscriptionId: id, catalogReference: sub.catalogReference, period: item.period,
          paidMoney: validMoney(item.money), paymentId: item.id, paymentKind: 'transaction', paidAt });
      }
      if (page.nextPage) result.nextCursor = encodeCursor({ provider: 'creem', accountScope: options.accountScope, subscriptionId: id,
        customerId: sub.customerId, productId: sub.catalogReference, page: page.nextPage });
      return result;
    },
    async cancel(id, input) {
      if (!['immediate', 'period_end'].includes(input.mode)) throw new SubscriptionProtocolError('unsupported', 'Unsupported Creem cancellation mode');
      await options.transport.cancelSubscription(requiredId(id), input.mode === 'immediate' ? { mode: 'immediate' } : { mode: 'scheduled', onExecute: 'cancel' });
      return retrieve(id);
    },
    async createBillingPortal(input) {
      if (input.returnUrl) throw new SubscriptionProtocolError('unsupported', 'Creem billing portal does not accept a return URL');
      return { url: secureUrl((await options.transport.createCustomerBillingLink(requiredId(input.customerId))).url) };
    },
    async verifyWebhook(request) {
      const event = options.transport.parseWebhook(request);
      const subscriptionId = event.subscription?.subscriptionId ?? event.transaction?.subscriptionId;
      return subscriptionId ? { eventId: event.eventId, subscriptionId } : null;
    },
  };
}
