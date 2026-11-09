import { createHash } from 'node:crypto';
import type { WebhookRequest } from '../contract/payment-contract';
import type { OrderPersistence } from '../order-persistence';
import {
  HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutObservation,
  type HostedCheckoutOptions, type HostedCheckoutOrder, type HostedCheckoutSelection,
} from './types';
import { canonicalMoney, checkoutUrl, nonempty, snapshotFulfillmentData, snapshotProviderMetadata } from './validation';

/** Durable dispatch claims + read-only reconciliation + atomic initial fulfillment. */
export class HostedCheckoutService {
  private readonly providers: Map<string, HostedCheckoutAdapter>;
  private readonly now: () => Date;

  constructor(private readonly options: HostedCheckoutOptions) {
    if (!options.persistence?.orders || !options.persistence.transaction) {
      throw new HostedCheckoutError('invalid_input', 'Durable transactional persistence is required');
    }
    this.providers = new Map();
    for (const provider of options.providers) {
      nonempty(provider.id, 'Provider'); nonempty(provider.accountScope, 'Account scope');
      if (this.providers.has(provider.id)) throw new HostedCheckoutError('invalid_input', 'Duplicate provider');
      this.providers.set(provider.id, provider);
    }
    this.now = options.now ?? (() => new Date());
  }

  async get(orderId: string, ownerId: string): Promise<HostedCheckoutOrder> {
    const order = await this.load(orderId);
    this.owner(order, ownerId);
    return order;
  }

  async create(input: HostedCheckoutSelection): Promise<HostedCheckoutOrder> {
    // Runtime snapshot: neither the caller nor an async catalog callback may rebind ownership.
    const metadata = snapshotProviderMetadata(input.providerMetadata);
    const selection = Object.freeze({ orderId: input.orderId, ownerId: input.ownerId,
      offerId: input.offerId, providerId: input.providerId, ...(metadata ? { providerMetadata: metadata } : {}) });
    for (const key of ['orderId', 'ownerId', 'offerId', 'providerId'] as const) nonempty(selection[key], key);
    const store = this.options.persistence.orders;
    let order = await store.findUnique({ where: { id: selection.orderId } });
    if (!order) {
      const provider = this.provider(selection.providerId);
      if (metadata && provider.supportsMetadata !== true) throw new HostedCheckoutError('unsupported', 'Provider does not support arbitrary checkout metadata');
      const resolved = await this.options.resolveOffer(selection);
      const fulfillmentData = snapshotFulfillmentData(resolved.fulfillmentData);
      const offer = structuredClone({ version: resolved.version, catalogReference: resolved.catalogReference,
        mode: resolved.mode, money: resolved.money, description: resolved.description,
        ...(fulfillmentData === undefined ? {} : { fulfillmentData }) });
      nonempty(offer.version, 'Offer version'); nonempty(offer.catalogReference, 'Catalog reference');
      nonempty(offer.description, 'Offer description');
      if (!provider.modes.includes(offer.mode)) throw new HostedCheckoutError('unsupported', 'Checkout mode is unsupported');
      if (canonicalMoney(offer.money).endsWith(':0')) throw new HostedCheckoutError('unsupported', 'Initial checkout requires a positive amount');
      const providerOffer = structuredClone(offer);
      delete providerOffer.fulfillmentData;
      provider.validate(providerOffer);
      // Provider price drift (an administrator edited the catalog amount) fails before anything is payable.
      const quoted = provider.quote ? await provider.quote(structuredClone(providerOffer)) : null;
      if (quoted && (canonicalMoney(quoted.money) !== canonicalMoney(offer.money) || (quoted.mode !== undefined && quoted.mode !== offer.mode))) {
        throw new HostedCheckoutError('conflict', 'The provider price differs from the offer; this offer is unavailable until the catalog is corrected');
      }
      const urls = this.options.returnUrls(selection.orderId);
      const key = createHash('sha256').update(JSON.stringify([provider.id, provider.accountScope, selection.orderId])).digest('hex').slice(0, 32);
      const time = this.now();
      const data: HostedCheckoutOrder = {
        id: selection.orderId, ownerId: selection.ownerId, offerId: selection.offerId, providerId: provider.id,
        providerMetadata: metadata ? structuredClone(metadata) : null,
        accountScope: provider.accountScope, offer, successUrl: checkoutUrl(urls.successUrl), cancelUrl: checkoutUrl(urls.cancelUrl),
        createKey: `zf-c-${key}`, captureKey: `zf-p-${key}`, creationState: 'prepared', captureState: 'idle',
        state: 'unknown', checkoutId: null, checkoutUrl: null, paymentId: null, paymentKind: null,
        subscriptionId: null, fulfilledAt: null, createdAt: time, updatedAt: time, revision: 0,
      };
      try { order = await store.create({ data }); }
      catch (error) {
        // A concurrent insert (or a lost insert response) is recoverable before external dispatch.
        order = await store.findUnique({ where: { id: selection.orderId } });
        if (!order) throw error;
      }
    }
    this.owner(order, selection.ownerId);
    if (order.offerId !== selection.offerId || order.providerId !== selection.providerId) {
      throw new HostedCheckoutError('conflict', 'Order ID already belongs to another selection');
    }
    const provider = this.boundProvider(order);
    if (order.creationState !== 'prepared') return order;
    const claimed = await store.compareAndSet(order.id, { revision: order.revision, creationState: 'prepared' }, {
      creationState: 'submitting', revision: order.revision + 1, updatedAt: this.now(),
    });
    if (!claimed) return this.load(order.id);
    order = { ...order, creationState: 'submitting', revision: order.revision + 1 };
    // Any exception after this point leaves a durable unknown dispatch. Never retry create automatically.
    const providerOrder = structuredClone(order);
    delete providerOrder.offer.fulfillmentData;
    const observed = await provider.create(providerOrder);
    this.verify(order, observed, false);
    // Reject a known catalog/configuration mismatch before releasing a payable URL.
    // A settled checkout may report zero outstanding money; its actual paid money is checked on reconciliation.
    if (observed.state !== 'paid' && observed.dueMoney && canonicalMoney(observed.dueMoney) !== canonicalMoney(order.offer.money)) {
      throw new HostedCheckoutError('verification_failed', 'Checkout amount differs from the frozen offer');
    }
    const saved = await store.compareAndSet(order.id, { revision: order.revision, creationState: 'submitting' }, {
      checkoutId: observed.checkoutId, checkoutUrl: observed.url ? checkoutUrl(observed.url) : null,
      creationState: 'created', revision: order.revision + 1, updatedAt: this.now(),
    });
    if (!saved) {
      const current = await this.load(order.id);
      if (current.checkoutId !== observed.checkoutId) throw new HostedCheckoutError('conflict', 'Checkout identity was not persisted');
      return current;
    }
    return this.load(order.id);
  }

  /** Return parameters are hints only. This never captures a payment. */
  async confirm(input: { orderId: string; ownerId: string; checkoutId?: string }): Promise<HostedCheckoutOrder> {
    const order = await this.get(input.orderId, input.ownerId);
    const id = this.checkoutId(order, input.checkoutId);
    if (!id || order.fulfilledAt) return order;
    return this.reconcile(order, await this.boundProvider(order).retrieve(id));
  }

  /** Explicit user-approved capture. Repeated calls only read after the first dispatch claim. */
  async capture(input: { orderId: string; ownerId: string }): Promise<HostedCheckoutOrder> {
    let order = await this.get(input.orderId, input.ownerId);
    const provider = this.boundProvider(order);
    if (!provider.capture) throw new HostedCheckoutError('unsupported', 'Provider has no explicit capture operation');
    if (!order.checkoutId) throw new HostedCheckoutError('conflict', 'Checkout identity is not yet known');
    const checkoutId = order.checkoutId;
    if (order.fulfilledAt) return order;
    const observed = await provider.retrieve(order.checkoutId);
    this.verify(order, observed, true);
    if (observed.state !== 'requires_capture' || order.captureState !== 'idle') return this.reconcile(order, observed);
    if (!observed.dueMoney || canonicalMoney(observed.dueMoney) !== canonicalMoney(order.offer.money)) {
      throw new HostedCheckoutError('verification_failed', 'Approved capture amount differs from the frozen offer');
    }
    const claimed = await this.options.persistence.orders.compareAndSet(order.id, {
      revision: order.revision, captureState: 'idle', fulfilledAt: null,
    }, { captureState: 'submitting', revision: order.revision + 1, updatedAt: this.now() });
    if (!claimed) return this.load(order.id);
    order = { ...order, captureState: 'submitting', revision: order.revision + 1 };
    return this.reconcile(order, await provider.capture(checkoutId, order.captureKey));
  }

  /** Authenticity precedes lookup. Verified event payloads are not payment evidence. */
  async webhook(providerId: string, request: WebhookRequest): Promise<HostedCheckoutOrder | null> {
    const provider = this.provider(providerId);
    const event = await provider.verifyWebhook(request);
    if (!event) return null;
    let order = event.reference ? await this.options.persistence.orders.findUnique({ where: { id: event.reference } }) : null;
    if (!order) {
      const found = await this.options.persistence.orders.findMany({
        where: { providerId, accountScope: provider.accountScope, checkoutId: event.checkoutId }, take: 2,
      });
      if (found.length > 1) throw new HostedCheckoutError('conflict', 'Checkout has multiple local orders');
      order = found[0] ?? null;
    }
    if (!order) throw new HostedCheckoutError('not_found', 'Verified checkout has no local order');
    if (order.providerId !== providerId) throw new HostedCheckoutError('verification_failed', 'Webhook provider mismatch');
    this.boundProvider(order);
    this.checkoutId(order, event.checkoutId);
    return this.reconcile(order, await provider.retrieve(event.checkoutId));
  }

  private async reconcile(order: HostedCheckoutOrder, observed: HostedCheckoutObservation): Promise<HostedCheckoutOrder> {
    observed = structuredClone(observed);
    this.verify(order, observed, true);
    // Trial/free/no-money and incomplete evidence never grant the purchased entitlement.
    const paid = observed.state === 'paid' && observed.mode === order.offer.mode && !!observed.paidMoney && !!observed.paymentId && !!observed.paymentKind &&
      (order.offer.mode !== 'subscription' || !!observed.subscriptionId);
    if (observed.paidMoney && canonicalMoney(observed.paidMoney) !== canonicalMoney(order.offer.money)) {
      throw new HostedCheckoutError('verification_failed', 'Paid amount or currency differs from the frozen offer');
    }
    if (paid && !order.fulfilledAt) await this.options.prepareFulfillment?.(structuredClone(order), structuredClone(observed));
    return this.options.persistence.transaction(async (transaction) => {
      const current = await this.load(order.id, transaction.orders);
      this.verify(current, observed, true);
      if (current.fulfilledAt) return current;
      const time = this.now();
      const next: HostedCheckoutOrder = { ...current,
        checkoutId: observed.checkoutId, creationState: 'created',
        checkoutUrl: observed.url ? checkoutUrl(observed.url) : current.checkoutUrl,
        state: paid ? 'paid' : observed.state === 'paid' ? 'unknown' : observed.state,
        paymentId: paid ? observed.paymentId ?? null : current.paymentId,
        paymentKind: paid ? observed.paymentKind ?? null : current.paymentKind,
        subscriptionId: observed.subscriptionId ?? current.subscriptionId,
        captureState: paid && current.captureState === 'submitting' ? 'confirmed' : current.captureState,
        fulfilledAt: paid ? time : null, updatedAt: time, revision: current.revision + 1,
      };
      const changed = await transaction.orders.compareAndSet(current.id, { revision: current.revision, fulfilledAt: null }, {
        checkoutId: next.checkoutId, checkoutUrl: next.checkoutUrl, creationState: next.creationState,
        state: next.state, paymentId: next.paymentId, paymentKind: next.paymentKind,
        subscriptionId: next.subscriptionId, captureState: next.captureState,
        fulfilledAt: next.fulfilledAt, updatedAt: next.updatedAt, revision: next.revision,
      });
      if (!changed) {
        const latest = await this.load(current.id, transaction.orders);
        if (latest.fulfilledAt) return latest;
        throw new HostedCheckoutError('conflict', 'Concurrent checkout update; retry read-only confirmation');
      }
      if (paid) await transaction.fulfill(structuredClone(next));
      return next;
    });
  }

  private verify(order: HostedCheckoutOrder, observed: HostedCheckoutObservation, complete: boolean): void {
    nonempty(observed.checkoutId, 'Provider checkout ID');
    this.checkoutId(order, observed.checkoutId);
    const pairs = [[observed.reference, order.id], [observed.catalogReference, order.offer.catalogReference], [observed.quantity, 1]];
    if (pairs.some(([actual, expected]) => (complete || actual !== undefined) && actual !== expected)) {
      throw new HostedCheckoutError('verification_failed', 'Checkout reference, catalog, mode or quantity mismatch');
    }
    if (observed.mode !== undefined && observed.mode !== order.offer.mode) {
      throw new HostedCheckoutError('verification_failed', 'Checkout mode mismatch');
    }
    for (const [existing, incoming] of [[order.subscriptionId, observed.subscriptionId],
      [order.paymentId, observed.paymentId], [order.paymentKind, observed.paymentKind]]) {
      if (existing && incoming && existing !== incoming) {
        throw new HostedCheckoutError('verification_failed', 'Bound payment or subscription identity changed');
      }
    }
  }

  private checkoutId(order: HostedCheckoutOrder, hint?: string): string | null {
    if (hint && order.checkoutId && hint !== order.checkoutId) throw new HostedCheckoutError('verification_failed', 'Checkout ID mismatch');
    if (!order.checkoutId && hint && order.creationState !== 'submitting') {
      throw new HostedCheckoutError('verification_failed', 'No dispatched checkout can be recovered');
    }
    return order.checkoutId ?? hint ?? null;
  }
  private owner(order: HostedCheckoutOrder, ownerId: string): void {
    if (!ownerId || order.ownerId !== ownerId) throw new HostedCheckoutError('forbidden', 'Order ownership mismatch');
  }
  private provider(id: string): HostedCheckoutAdapter {
    const provider = this.providers.get(id);
    if (!provider) throw new HostedCheckoutError('unsupported', 'Checkout provider is not configured');
    return provider;
  }
  private boundProvider(order: HostedCheckoutOrder): HostedCheckoutAdapter {
    const provider = this.provider(order.providerId);
    if (provider.accountScope !== order.accountScope) throw new HostedCheckoutError('verification_failed', 'Provider account scope changed');
    return provider;
  }
  private async load(id: string, store: OrderPersistence<HostedCheckoutOrder> = this.options.persistence.orders): Promise<HostedCheckoutOrder> {
    const order = await store.findUnique({ where: { id } });
    if (!order) throw new HostedCheckoutError('not_found', 'Checkout order was not found');
    return order;
  }
}
