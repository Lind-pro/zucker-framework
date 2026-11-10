import type Stripe from 'stripe';
import { fromStripeMinorUnits } from '../contract/money';
import type { SubscriptionStatus } from '../contract/subscription-observation';
import { stripeResourceId, verifyStripeWebhookEvent } from '../providers/stripe';
import { checkoutUrl } from '../hosted-checkout/validation';
import { SubscriptionProtocolError, type SubscriptionAdapter, type SubscriptionDetails, type SubscriptionPaidPeriodPage } from './types';
import { decodeCursor, encodeCursor, requiredId, sameId, secondsDate, secureUrl, validPeriod } from './validation';

export interface StripeSubscriptionOptions {
  client: Pick<Stripe, 'subscriptions' | 'invoices' | 'billingPortal' | 'webhooks'>;
  accountScope: string;
  livemode: boolean;
  webhookSecret?: string;
}

export function createStripeSubscriptionAdapter(options: StripeSubscriptionOptions): SubscriptionAdapter {
  requiredId(options.accountScope);
  const mode = (raw: { livemode: boolean }) => {
    if (raw.livemode !== options.livemode) throw new SubscriptionProtocolError('verification_failed', 'Stripe environment mismatch');
  };
  const money = (raw: Stripe.Invoice) => {
    if (!Number.isSafeInteger(raw.amount_paid) || raw.amount_paid < 0 || !/^[a-z]{3}$/.test(raw.currency)) {
      throw new SubscriptionProtocolError('invalid_response', 'Stripe invoice has invalid paid money');
    }
    const currency = raw.currency.toUpperCase();
    return { amount: fromStripeMinorUnits(raw.amount_paid, currency), currency };
  };
  const retrieve = async (id: string): Promise<SubscriptionDetails> => {
    const raw = await options.client.subscriptions.retrieve(requiredId(id), { expand: ['latest_invoice'] });
    sameId(raw.id, id); mode(raw);
    const single = !raw.items.has_more && raw.items.data.length === 1 ? raw.items.data[0] : undefined;
    const known: readonly string[] = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'];
    const invoice = typeof raw.latest_invoice === 'object' ? raw.latest_invoice : null;
    if (invoice) mode(invoice);
    return { provider: 'stripe', subscriptionId: raw.id, customerId: stripeResourceId(raw.customer),
      catalogReference: single?.price.id, productId: single ? stripeResourceId(single.price.product) : undefined,
      status: known.includes(raw.status) ? raw.status as SubscriptionStatus : 'unknown', providerStatus: raw.status,
      period: single ? validPeriod(secondsDate(single.current_period_start), secondsDate(single.current_period_end)) : undefined,
      cancelAtPeriodEnd: raw.cancel_at_period_end, canceledAt: secondsDate(raw.canceled_at),
      lastTransactionId: stripeResourceId(raw.latest_invoice),
      payment: { settlement: invoice?.status === 'paid' && invoice.amount_paid > 0 ? 'paid' : 'unknown', transactionId: invoice?.id },
    };
  };
  return {
    id: 'stripe', accountScope: options.accountScope,
    capabilities: { cancel: ['immediate', 'period_end'], billingPortal: true, invoices: true, paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' },
    retrieve,
    async listPaidPeriods(id, input = {}) {
      const subscription = await retrieve(id);
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      if (cursor && (cursor.provider !== 'stripe' || cursor.subscriptionId !== id || cursor.accountScope !== options.accountScope)) {
        throw new SubscriptionProtocolError('invalid_input', 'Subscription cursor identity mismatch');
      }
      const after = cursor ? requiredId(cursor.after) : undefined;
      const page = await options.client.invoices.list({ subscription: id, status: 'paid', limit: 100,
        ...(after ? { starting_after: after } : {}) });
      const result: SubscriptionPaidPeriodPage = { data: [], issues: [] };
      for (const invoice of page.data) {
        mode(invoice);
        sameId(stripeResourceId(invoice.parent?.subscription_details?.subscription), id);
        if (subscription.customerId) sameId(stripeResourceId(invoice.customer), subscription.customerId);
        if (invoice.status !== 'paid' || invoice.amount_paid === 0) continue;
        // Full invoice money cannot be assigned to one cycle when there are multiple/prorated lines.
        const line = !invoice.lines.has_more && invoice.lines.data.length === 1 ? invoice.lines.data[0] : undefined;
        const details = line?.parent?.subscription_item_details;
        if (!line || !details || details.proration || details.subscription !== id || line.quantity !== 1) {
          result.issues?.push({ recordId: invoice.id, code: 'ambiguous_period' }); continue;
        }
        const catalogReference = stripeResourceId(line.pricing?.price_details?.price);
        const period = validPeriod(secondsDate(line.period.start), secondsDate(line.period.end));
        const paidAt = secondsDate(invoice.status_transitions.paid_at);
        if (!catalogReference || !period || !paidAt) {
          result.issues?.push({ recordId: invoice.id, code: !catalogReference ? 'missing_identity' : !period ? 'missing_period' : 'missing_paid_at' }); continue;
        }
        result.data.push({ recordId: invoice.id, subscriptionId: id, catalogReference, period,
          paidMoney: money(invoice), paymentId: invoice.id, paymentKind: 'invoice', paidAt });
      }
      if (page.has_more) {
        const last = page.data.at(-1)?.id;
        if (!last || last === after) throw new SubscriptionProtocolError('invalid_response', 'Stripe pagination made no progress');
        result.nextCursor = encodeCursor({ provider: 'stripe', accountScope: options.accountScope, subscriptionId: id, after: last });
      }
      return result;
    },
    async cancel(id, input) {
      requiredId(id);
      if (input.mode === 'period_end') await options.client.subscriptions.update(id, { cancel_at_period_end: true });
      else if (input.mode === 'immediate') await options.client.subscriptions.cancel(id);
      else throw new SubscriptionProtocolError('unsupported', 'Unsupported Stripe cancellation mode');
      return retrieve(id);
    },
    async createBillingPortal(input) {
      const raw = await options.client.billingPortal.sessions.create({ customer: requiredId(input.customerId),
        ...(input.returnUrl ? { return_url: checkoutUrl(input.returnUrl) } : {}) });
      sameId(raw.customer, input.customerId); return { url: secureUrl(raw.url) };
    },
    async retrieveInvoice(id) {
      const raw = await options.client.invoices.retrieve(requiredId(id)); sameId(raw.id, id); mode(raw);
      const status = raw.status === 'paid' ? 'paid' : raw.status === 'void' ? 'void' : raw.status === 'uncollectible' ? 'uncollectible'
        : raw.status === 'draft' || raw.status === 'open' ? 'pending' : 'unknown';
      return { id: raw.id, subscriptionId: stripeResourceId(raw.parent?.subscription_details?.subscription),
        customerId: stripeResourceId(raw.customer), status, url: raw.hosted_invoice_url ? secureUrl(raw.hosted_invoice_url) : undefined,
        paidMoney: raw.status === 'paid' ? money(raw) : undefined };
    },
    async verifyWebhook(request) {
      if (!options.webhookSecret) throw new SubscriptionProtocolError('invalid_input', 'Stripe webhook secret is required');
      const signatures = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === 'stripe-signature');
      if (signatures.length !== 1 || !signatures[0]?.[1]) throw new SubscriptionProtocolError('verification_failed', 'Stripe signature is required');
      const event = verifyStripeWebhookEvent(options.client, typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody), signatures[0][1], options.webhookSecret);
      mode(event);
      if (event.type.startsWith('customer.subscription.')) return { eventId: event.id, subscriptionId: (event.data.object as Stripe.Subscription).id };
      if (!event.type.startsWith('invoice.')) return null;
      const subscriptionId = stripeResourceId((event.data.object as Stripe.Invoice).parent?.subscription_details?.subscription);
      return subscriptionId ? { eventId: event.id, subscriptionId } : null;
    },
  };
}
