import type { CreemCheckoutAdapter } from '../providers/creem';
import type { CreemCheckoutObservation } from '../providers/creem-types';
import { toMinorUnits } from '../contract/money';
import { HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutObservation } from './types';
import { record, snapshotProviderMetadata } from './validation';

export interface CreemHostedCheckoutOptions {
  adapter: Pick<CreemCheckoutAdapter, 'createCheckout' | 'retrieveCheckout' | 'parseWebhook'>;
  accountScope: string;
}

export function createCreemHostedCheckoutAdapter(options: CreemHostedCheckoutOptions): HostedCheckoutAdapter {
  const observe = (checkout: CreemCheckoutObservation): HostedCheckoutObservation => {
    const billingType = record(checkout.raw.order)?.type ?? record(checkout.raw.product)?.billing_type;
    return {
      checkoutId: checkout.id, url: checkout.url, reference: checkout.requestId,
      catalogReference: checkout.productId, quantity: typeof checkout.raw.units === 'number' ? checkout.raw.units : undefined,
      mode: billingType === 'recurring' ? 'subscription' : billingType === 'onetime' ? 'payment' : undefined,
      state: checkout.state === 'captured' ? 'paid' : checkout.state === 'canceled' ? 'unpaid'
        : checkout.state === 'created' ? 'pending' : 'unknown',
      paidMoney: checkout.state === 'captured' ? checkout.paidMoney : undefined,
      dueMoney: checkout.dueMoney,
      paymentId: checkout.transactionId, paymentKind: checkout.transactionId ? 'transaction' : undefined,
      subscriptionId: checkout.subscriptionId,
    };
  };
  return {
    id: 'creem', accountScope: options.accountScope, modes: ['payment', 'subscription'], supportsMetadata: true,
    // Creem's API uses cents for every currency; this is deliberately not Stripe's exponent table.
    validate(offer) {
      // Creem's checkout response type exposes no subtotal/discount evidence, so a frozen promotion
      // could not be verified; refuse it before an order exists instead of ignoring it.
      if (offer.promotion) throw new HostedCheckoutError('unsupported', 'Creem checkout does not support promotions');
      toMinorUnits(offer.money.amount, 'USD');
    },
    async create(order) {
      const metadata = snapshotProviderMetadata(order.providerMetadata ?? undefined);
      return observe(await options.adapter.createCheckout({ productId: order.offer.catalogReference,
        requestId: order.id, units: 1, successUrl: order.successUrl, ...(metadata ? { metadata } : {}) }));
    },
    async retrieve(id) { return observe(await options.adapter.retrieveCheckout(id)); },
    async verifyWebhook(request) {
      const event = await options.adapter.parseWebhook(request);
      // Subscription events belong to the cycle workflow and never re-fulfill the initial order.
      return event.checkout ? { eventId: event.eventId, checkoutId: event.checkout.id, reference: event.checkout.requestId } : null;
    },
  };
}
