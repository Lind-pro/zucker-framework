import { createHash } from 'node:crypto';
import type { WebhookRequest } from '../contract/payment-contract';
import { isDefinitePaymentRejection } from '../contract/rejection';
import type { OrderPersistence } from '../order-persistence';
import {
  HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES, HostedCheckoutError, type HostedCheckoutAdapter, type HostedCheckoutEvent,
  type HostedCheckoutObservation, type HostedCheckoutOptions, type HostedCheckoutOrder, type HostedCheckoutProviderResolver,
  type HostedCheckoutSelection,
} from './types';
import { canonicalMoney, checkoutPayable, checkoutUrl, nonempty, snapshotFulfillmentData, snapshotPromotion, snapshotProviderMetadata } from './validation';

/**
 * Resolver over a fixed adapter list (credentials fixed for the process lifetime): one adapter per
 * provider id, used for new and existing orders alike; an order of another account scope is refused.
 */
export function staticHostedCheckoutProviders(adapters: readonly HostedCheckoutAdapter[]): HostedCheckoutProviderResolver {
  const providers = new Map<string, HostedCheckoutAdapter>();
  for (const provider of adapters) {
    nonempty(provider.id, 'Provider'); nonempty(provider.accountScope, 'Account scope');
    if (providers.has(provider.id)) throw new HostedCheckoutError('invalid_input', 'Duplicate provider');
    providers.set(provider.id, provider);
  }
  return {
    ids: async () => [...providers.keys()],
    current: async providerId => { const adapter = providers.get(providerId); return adapter ? { adapter } : undefined; },
    forOrder: async order => providers.get(order.providerId),
    webhookCandidates: async providerId => { const adapter = providers.get(providerId); return adapter ? [adapter] : []; },
  };
}

const CONFIG_REVISION_LIMIT = 255;

/**
 * Durable dispatch claims + read-only reconciliation + atomic initial fulfillment.
 *
 * Adapters come from a fixed list or a {@link HostedCheckoutProviderResolver}. Each operation
 * resolves its adapter once and keeps it: a new order uses `current()` and records its configuration
 * revision before the dispatch claim; an existing order always uses `forOrder()` and must stay on its
 * own account scope.
 */
export class HostedCheckoutService {
  private readonly providers: HostedCheckoutProviderResolver;
  private readonly now: () => Date;

  constructor(private readonly options: HostedCheckoutOptions) {
    if (!options.persistence?.orders || !options.persistence.transaction) {
      throw new HostedCheckoutError('invalid_input', 'Durable transactional persistence is required');
    }
    const providers = options.providers;
    if (Array.isArray(providers)) this.providers = staticHostedCheckoutProviders(providers);
    else {
      const resolver = providers as HostedCheckoutProviderResolver;
      if (!resolver || typeof resolver.current !== 'function' || typeof resolver.forOrder !== 'function'
        || typeof resolver.webhookCandidates !== 'function' || typeof resolver.ids !== 'function') {
        throw new HostedCheckoutError('invalid_input', 'Checkout providers must be an adapter list or a provider resolver');
      }
      this.providers = resolver;
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
    const promotionCode = input.promotionCode;
    if (promotionCode !== undefined && (typeof promotionCode !== 'string' || !promotionCode.trim() || promotionCode.length > 128)) {
      throw new HostedCheckoutError('invalid_input', 'Promotion code is invalid');
    }
    const selection = Object.freeze({ orderId: input.orderId, ownerId: input.ownerId,
      offerId: input.offerId, providerId: input.providerId, ...(metadata ? { providerMetadata: metadata } : {}),
      ...(promotionCode !== undefined ? { promotionCode } : {}) });
    for (const key of ['orderId', 'ownerId', 'offerId', 'providerId'] as const) nonempty(selection[key], key);
    const store = this.options.persistence.orders;
    let order = await store.findUnique({ where: { id: selection.orderId } });
    // The adapter this call created the order with; it is used for this order's dispatch, so a save
    // that lands meanwhile cannot make the recorded revision and the dispatching account differ.
    let created: { adapter: HostedCheckoutAdapter; order: HostedCheckoutOrder } | undefined;
    if (!order) {
      const current = await this.providers.current(selection.providerId);
      if (!current) throw new HostedCheckoutError('unsupported', 'Checkout provider is not configured');
      const provider = current.adapter;
      nonempty(provider?.id, 'Provider'); nonempty(provider.accountScope, 'Account scope');
      if (provider.id !== selection.providerId) throw new HostedCheckoutError('unsupported', 'Checkout provider is not configured');
      const configRevision = current.configRevision;
      if (configRevision !== undefined && configRevision !== null && (typeof configRevision !== 'string' || !configRevision || configRevision.length > CONFIG_REVISION_LIMIT)) {
        throw new HostedCheckoutError('invalid_input', 'Provider configuration revision is invalid');
      }
      if (metadata && provider.supportsMetadata !== true) throw new HostedCheckoutError('unsupported', 'Provider does not support arbitrary checkout metadata');
      const resolved = await this.options.resolveOffer(selection);
      const fulfillmentData = snapshotFulfillmentData(resolved.fulfillmentData);
      const promotion = snapshotPromotion(resolved);
      const offer = structuredClone({ version: resolved.version, catalogReference: resolved.catalogReference,
        mode: resolved.mode, money: resolved.money, description: resolved.description,
        ...(fulfillmentData === undefined ? {} : { fulfillmentData }), ...(promotion ? { promotion } : {}) });
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
      if (offer.promotion) await this.checkPromotion(provider, providerOffer);
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
        ...(configRevision !== undefined ? { configRevision } : {}),
      };
      try { order = await store.create({ data }); created = { adapter: provider, order }; }
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
    const provider = created?.order === order ? this.bind(order, created.adapter) : await this.boundProvider(order);
    if (order.creationState !== 'prepared') return order;
    const claimed = await store.compareAndSet(order.id, { revision: order.revision, creationState: 'prepared' }, {
      creationState: 'submitting', revision: order.revision + 1, updatedAt: this.now(),
    });
    if (!claimed) return this.load(order.id);
    order = { ...order, creationState: 'submitting', revision: order.revision + 1 };
    // Any unknown exception after this point leaves a durable unknown dispatch. Never retry create automatically.
    const providerOrder = structuredClone(order);
    delete providerOrder.offer.fulfillmentData;
    let observed: HostedCheckoutObservation;
    try {
      observed = await provider.create(providerOrder);
    } catch (error) {
      // A definite provider rejection (4xx validation) created nothing: release the claim so the
      // same order ID can be dispatched again (with the same idempotency key) instead of being parked.
      if (isDefinitePaymentRejection(error)) {
        await store.compareAndSet(order.id, { revision: order.revision, creationState: 'submitting', checkoutId: null }, {
          creationState: 'prepared', revision: order.revision + 1, updatedAt: this.now(),
        }).catch(() => false);
      }
      throw error;
    }
    this.verify(order, observed, false);
    // Reject a known catalog/configuration mismatch before releasing a payable URL.
    // A settled checkout may report zero outstanding money; its actual paid money is checked on reconciliation.
    if (observed.state !== 'paid' && observed.dueMoney && canonicalMoney(observed.dueMoney) !== canonicalMoney(checkoutPayable(order.offer))) {
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
    const provider = await this.boundProvider(order);
    return this.reconcile(order, await provider.retrieve(id));
  }

  /** Explicit user-approved capture. Repeated calls only read after the first dispatch claim. */
  async capture(input: { orderId: string; ownerId: string }): Promise<HostedCheckoutOrder> {
    let order = await this.get(input.orderId, input.ownerId);
    const provider = await this.boundProvider(order);
    if (!provider.capture) throw new HostedCheckoutError('unsupported', 'Provider has no explicit capture operation');
    if (!order.checkoutId) throw new HostedCheckoutError('conflict', 'Checkout identity is not yet known');
    const checkoutId = order.checkoutId;
    if (order.fulfilledAt) return order;
    const observed = await provider.retrieve(order.checkoutId);
    this.verify(order, observed, true);
    if (observed.state !== 'requires_capture' || order.captureState !== 'idle') return this.reconcile(order, observed);
    if (!observed.dueMoney || canonicalMoney(observed.dueMoney) !== canonicalMoney(checkoutPayable(order.offer))) {
      throw new HostedCheckoutError('verification_failed', 'Approved capture amount differs from the frozen offer');
    }
    const claimed = await this.options.persistence.orders.compareAndSet(order.id, {
      revision: order.revision, captureState: 'idle', fulfilledAt: null,
    }, { captureState: 'submitting', revision: order.revision + 1, updatedAt: this.now() });
    if (!claimed) return this.load(order.id);
    order = { ...order, captureState: 'submitting', revision: order.revision + 1 };
    let captured: HostedCheckoutObservation;
    try {
      captured = await provider.capture(checkoutId, order.captureKey);
    } catch (error) {
      // e.g. PayPal 422 INSTRUMENT_DECLINED: the buyer may fix the instrument and capture again.
      // The claim is released only after a read-only check shows nothing was captured.
      if (isDefinitePaymentRejection(error)) await this.resetDispatch(order.id).catch(() => undefined);
      throw error;
    }
    return this.reconcile(order, captured);
  }

  /**
   * Operator/consumer escape hatch for a dispatch claim parked by an exception.
   *
   * - Capture claim: re-reads the checkout (read-only). A paid checkout is reconciled; a checkout
   *   that is verifiably not captured (`requires_capture` / `pending` / `unpaid`) returns to
   *   `captureState: 'idle'` so `capture()` may run again. An unknown observation keeps the claim.
   * - Creation claim without a known checkout ID: returns to `prepared`, so the next `create()`
   *   dispatches again with the SAME idempotency key. Call this only for providers with request
   *   idempotency (Stripe, PayPal) or after confirming in the provider that no checkout exists.
   */
  async resetDispatch(orderId: string): Promise<HostedCheckoutOrder> {
    const order = await this.load(orderId);
    if (order.fulfilledAt) return order;
    const store = this.options.persistence.orders;
    const provider = await this.boundProvider(order);
    if (order.captureState === 'submitting' && order.checkoutId) {
      const observed = await provider.retrieve(order.checkoutId);
      this.verify(order, observed, true);
      if (observed.state === 'paid') return this.reconcile(order, observed);
      if (observed.state === 'unknown') throw new HostedCheckoutError('conflict', 'Capture outcome is still unknown; retry later');
      await store.compareAndSet(order.id, { revision: order.revision, captureState: 'submitting', fulfilledAt: null }, {
        captureState: 'idle', state: observed.state, revision: order.revision + 1, updatedAt: this.now(),
      });
      return this.load(order.id);
    }
    if (order.creationState === 'submitting' && !order.checkoutId) {
      await store.compareAndSet(order.id, { revision: order.revision, creationState: 'submitting', checkoutId: null }, {
        creationState: 'prepared', revision: order.revision + 1, updatedAt: this.now(),
      });
      return this.load(order.id);
    }
    return order;
  }

  /**
   * Authenticity precedes lookup. Verified event payloads are not payment evidence. With rotated
   * credentials the candidates are tried newest first; an order is only acted on through a candidate
   * of its own account scope that verified the request, and its state is then re-read through the
   * order's own adapter. A request verified only by another account's credentials changes nothing.
   */
  async webhook(providerId: string, request: WebhookRequest): Promise<HostedCheckoutOrder | null> {
    const candidates = (await this.providers.webhookCandidates(providerId)).filter(candidate => candidate?.id === providerId && !!candidate.accountScope)
      .slice(0, HOSTED_CHECKOUT_MAX_WEBHOOK_CANDIDATES);
    if (!candidates.length) throw new HostedCheckoutError('unsupported', 'Checkout provider is not configured');
    let failure: unknown, otherAccount = false, unknownCheckout = false;
    for (const verifier of candidates) {
      let event: HostedCheckoutEvent | null;
      try { event = await verifier.verifyWebhook(request); }
      catch (error) { failure ??= error; continue; }
      if (!event) return null;
      let order = event.reference ? await this.options.persistence.orders.findUnique({ where: { id: event.reference } }) : null;
      if (!order) {
        const found = await this.options.persistence.orders.findMany({
          where: { providerId, accountScope: verifier.accountScope, checkoutId: event.checkoutId }, take: 2,
        });
        if (found.length > 1) throw new HostedCheckoutError('conflict', 'Checkout has multiple local orders');
        order = found[0] ?? null;
      }
      if (!order) { unknownCheckout = true; continue; }
      if (order.providerId !== providerId) throw new HostedCheckoutError('verification_failed', 'Webhook provider mismatch');
      if (order.accountScope !== verifier.accountScope) { otherAccount = true; continue; }
      const provider = await this.boundProvider(order);
      this.checkoutId(order, event.checkoutId);
      return this.reconcile(order, await provider.retrieve(event.checkoutId));
    }
    if (otherAccount) throw new HostedCheckoutError('verification_failed', 'Webhook account does not match the order');
    if (unknownCheckout) throw new HostedCheckoutError('not_found', 'Verified checkout has no local order');
    // Report the newest candidate's refusal (the current credentials).
    throw failure;
  }

  private async reconcile(order: HostedCheckoutOrder, observed: HostedCheckoutObservation): Promise<HostedCheckoutOrder> {
    observed = structuredClone(observed);
    this.verify(order, observed, true);
    // Trial/free/no-money and incomplete evidence never grant the purchased entitlement.
    const paid = observed.state === 'paid' && observed.mode === order.offer.mode && !!observed.paidMoney && !!observed.paymentId && !!observed.paymentKind &&
      (order.offer.mode !== 'subscription' || !!observed.subscriptionId);
    const mismatch = observed.paidMoney ? this.moneyMismatch(order, observed) : null;
    if (mismatch) {
      // Money was taken but cannot be fulfilled (e.g. a provider added tax to a tax-exclusive price,
      // or applied a discount the order was not frozen with). Surface it so the consumer can persist
      // it for refund/review instead of only seeing an error loop.
      await this.options.onPaymentMismatch?.(structuredClone(order), structuredClone(observed));
      throw new HostedCheckoutError('verification_failed', mismatch);
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
      if (paid) await transaction.fulfill(structuredClone(next), structuredClone(observed));
      return next;
    });
  }

  /**
   * Paid money must equal the frozen payable amount. An order frozen with a promotion also needs the
   * provider's subtotal (= the offer) and discount (= the frozen discount), and any reported discount
   * reference must be exactly the frozen provider code. A discount on an order frozen without a
   * promotion is never accepted. The browser's input never reaches this comparison.
   */
  private moneyMismatch(order: HostedCheckoutOrder, observed: HostedCheckoutObservation): string | null {
    const paid = observed.paidMoney;
    if (!paid || canonicalMoney(paid) !== canonicalMoney(checkoutPayable(order.offer))) return 'Paid amount or currency differs from the frozen offer';
    const promotion = order.offer.promotion;
    if (!promotion) {
      const discount = observed.discountMoney;
      if (discount && !canonicalMoney(discount).endsWith(':0')) return 'A discount was applied to an order without a promotion';
      if (observed.discountReferences?.length) return 'A discount was applied to an order without a promotion';
      return null;
    }
    if (!observed.subtotalMoney || !observed.discountMoney) return 'Promotion evidence (subtotal and discount) is missing';
    if (canonicalMoney(observed.subtotalMoney) !== canonicalMoney(order.offer.money)) return 'Provider subtotal differs from the frozen offer';
    if (canonicalMoney(observed.discountMoney) !== canonicalMoney(promotion.discount)) return 'Provider discount differs from the frozen promotion';
    const references = observed.discountReferences;
    if (references && (references.length !== 1 || references[0] !== promotion.providerCode)) return 'Provider discount reference differs from the frozen promotion';
    return null;
  }

  /** Before an order exists: capability, provider promotion amount and (subscriptions) once-only duration. */
  private async checkPromotion(provider: HostedCheckoutAdapter, offer: HostedCheckoutOrder['offer']): Promise<void> {
    const promotion = offer.promotion;
    if (!promotion) return;
    if (!provider.promotions?.modes.includes(offer.mode)) throw new HostedCheckoutError('unsupported', 'Provider does not support promotions for this checkout mode');
    const quote = provider.quotePromotion ? await provider.quotePromotion(structuredClone(offer)) : null;
    if (offer.mode === 'subscription' && quote?.duration !== 'once') {
      // Later cycles keep exact list-price equality, so only a first-invoice-only provider coupon fits.
      throw new HostedCheckoutError('unsupported', 'Subscription promotions require a provider discount that applies once');
    }
    if (quote && canonicalMoney(quote.discount) !== canonicalMoney(promotion.discount)) {
      throw new HostedCheckoutError('conflict', 'The provider promotion differs from the frozen discount; this promotion is unavailable until it is corrected');
    }
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
  /** The adapter of an existing order: always its own provider and account scope. */
  private async boundProvider(order: HostedCheckoutOrder): Promise<HostedCheckoutAdapter> {
    const provider = await this.providers.forOrder(structuredClone(order));
    if (!provider) throw new HostedCheckoutError('unsupported', 'Checkout provider is not configured');
    return this.bind(order, provider);
  }
  private bind(order: HostedCheckoutOrder, provider: HostedCheckoutAdapter): HostedCheckoutAdapter {
    if (provider.id !== order.providerId) throw new HostedCheckoutError('unsupported', 'Checkout provider is not configured');
    if (provider.accountScope !== order.accountScope) throw new HostedCheckoutError('verification_failed', 'Provider account scope changed');
    return provider;
  }
  private async load(id: string, store: OrderPersistence<HostedCheckoutOrder> = this.options.persistence.orders): Promise<HostedCheckoutOrder> {
    const order = await store.findUnique({ where: { id } });
    if (!order) throw new HostedCheckoutError('not_found', 'Checkout order was not found');
    return order;
  }
}
