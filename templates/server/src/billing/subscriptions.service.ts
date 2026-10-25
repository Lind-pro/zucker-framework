import { BadRequestException } from '@nestjs/common';
import { HostedCheckoutError, SubscriptionCycleService, subscriptionPeriodKey } from '@zucker-framework/payment';
import type { Money, SubscriptionAdapter, SubscriptionCancelMode, SubscriptionCycleReceipt,
  SubscriptionDetails, SubscriptionPaidPeriod, SubscriptionPaidReceipt, WebhookRequest } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../database';
import type { BillingRefundsService } from './refunds/refunds.service';
import { createSubscriptionCyclePersistence, SUBSCRIPTION_RECONCILE_EVENT, type BillingSubscription, type SubscriptionExecutionFence } from './subscription-persistence';

const PAGE_SIZE = 20, MAX_PROVIDER_PAGES = 100, MAX_PROVIDER_RECEIPTS = 10000;
function invalid(message: string): never { throw new HostedCheckoutError('verification_failed', message); }
function pageNumber(value?: string): number {
  const page = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Invalid page');
  return page;
}
function moneyKey(money: Money): string {
  if (!money || !/^[A-Z]{3}$/.test(money.currency) || typeof money.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(money.amount)) invalid('Invalid paid money');
  const [whole, fraction = ''] = money.amount.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${money.currency}:${whole.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
}
function factDate(value: string): Date {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('Invalid subscription timestamp');
  return new Date(value);
}
function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch { return invalid('Invalid provider billing URL'); }
}

/** Provider IO stays outside transactions; only explicit, frozen policies can grant credits. */
export class BillingSubscriptionsService {
  private readonly providers = new Map<string, SubscriptionAdapter>();
  private readonly cycles: SubscriptionCycleService;
  private readonly returnUrl: string;
  constructor(private readonly database: ApplicationDatabase, adapters: readonly SubscriptionAdapter[], webUrl: string,
    private readonly refunds?: Pick<BillingRefundsService, 'prepareCycle'>) {
    const base = new URL(webUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid subscription site URL');
    this.returnUrl = new URL('/billing/subscriptions', base).href;
    for (const adapter of adapters) {
      if (!adapter.id || !adapter.accountScope || this.providers.has(adapter.id)) throw new Error('Subscription providers require unique IDs and account scopes');
      this.providers.set(adapter.id, adapter);
    }
    this.cycles = new SubscriptionCycleService(createSubscriptionCyclePersistence(database));
  }
  private async owned(id: string, ownerId: string): Promise<BillingSubscription> {
    if (!id || !ownerId) throw new HostedCheckoutError('invalid_input', 'Subscription and owner are required');
    const row = await this.database.model('billingSubscriptions').findUnique({ where: { id } }) as BillingSubscription | null;
    if (!row) throw new HostedCheckoutError('not_found', 'Subscription not found');
    if (row.ownerId !== ownerId) throw new HostedCheckoutError('forbidden', 'Subscription owner mismatch');
    return row;
  }
  private adapter(row: BillingSubscription): SubscriptionAdapter {
    const adapter = this.providers.get(row.providerId);
    if (!adapter) throw new HostedCheckoutError('unsupported', 'Subscription provider is unavailable');
    if (adapter.accountScope !== row.accountScope) invalid('Subscription provider account changed');
    return adapter;
  }
  private update(where: Record<string, unknown>, data: Record<string, unknown>, fence?: SubscriptionExecutionFence) {
    // Besides atomic CAS, ApplicationDatabase pins the tenant/test schema used by database triggers.
    return this.database.transaction(async tx => {
      await fence?.(tx);
      const changed = await tx.model('billingSubscriptions').updateMany({ where, data });
      await fence?.(tx);
      return changed;
    });
  }
  private view(row: BillingSubscription) {
    const configured = this.providers.get(row.providerId);
    const adapter = configured?.accountScope === row.accountScope ? configured : undefined;
    const refresh = !!adapter && (row.grantBasis === 'period' ? adapter.capabilities.paidPeriodProof !== 'unavailable'
      : row.providerId === 'paypal' && adapter.capabilities.paidReceiptProof === 'provider' && !!adapter.listPaidReceipts);
    return { id: row.id, title: row.offer.description, providerId: row.providerId, status: row.status,
      providerStatus: row.providerStatus, grantBasis: row.grantBasis, money: row.offer.money,
      currentPeriod: row.currentPeriodStart && row.currentPeriodEnd ? { start: row.currentPeriodStart, end: row.currentPeriodEnd } : null,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd, canceledAt: row.canceledAt, cancelState: row.cancelState,
      cancelMode: row.cancelMode, initialFulfilledAt: row.initialFulfilledAt, observedAt: row.observedAt, createdAt: row.createdAt,
      reconcileStatus: row.reconcileStatus,
      capabilities: { refresh, cancel: row.cancelState === 'idle' ? adapter?.capabilities.cancel ?? [] : [],
        billingPortal: !!row.customerId && !!adapter?.capabilities.billingPortal && !!adapter.createBillingPortal,
        invoices: !!adapter?.capabilities.invoices && !!adapter.retrieveInvoice,
        paidPeriodProof: adapter?.capabilities.paidPeriodProof ?? 'unavailable', paidReceiptProof: adapter?.capabilities.paidReceiptProof ?? 'unavailable' } };
  }
  async get(id: string, ownerId: string) { return this.view(await this.owned(id, ownerId)); }
  async list(ownerId: string, pageValue?: string) {
    if (!ownerId) throw new HostedCheckoutError('forbidden', 'Subscription owner is required');
    const page = pageNumber(pageValue), where = { ownerId };
    const [data, total] = await Promise.all([
      this.database.model('billingSubscriptions').findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      this.database.model('billingSubscriptions').count({ where }),
    ]);
    return { data: (data as BillingSubscription[]).map(row => this.view(row)), total, page, pageSize: PAGE_SIZE };
  }
  private validateObservation(row: BillingSubscription, observation: SubscriptionDetails): void {
    if (observation.provider !== row.providerId || observation.subscriptionId !== row.providerSubscriptionId || observation.catalogReference !== row.catalogReference
      || row.customerId && observation.customerId !== row.customerId) invalid('Subscription provider identity mismatch');
    if (!['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled', 'unknown'].includes(observation.status)
      || typeof observation.providerStatus !== 'string' || !observation.providerStatus || observation.providerStatus.length > 100) invalid('Invalid subscription status');
    if (observation.customerId !== undefined && (!observation.customerId.trim() || observation.customerId.length > 255)) invalid('Invalid subscription customer');
    if (observation.period) {
      try { subscriptionPeriodKey({ provider: row.providerId, accountScope: row.accountScope, subscriptionId: row.providerSubscriptionId, period: observation.period }); }
      catch { invalid('Invalid subscription period'); }
    }
    if (observation.canceledAt) factDate(observation.canceledAt);
  }
  private async observe(row: BillingSubscription, observation: SubscriptionDetails, fence?: SubscriptionExecutionFence): Promise<number> {
    this.validateObservation(row, observation);
    const canceled = row.cancelState !== 'idle' && (observation.status === 'canceled'
      || row.cancelMode === 'period_end' && observation.cancelAtPeriodEnd === true);
    const now = new Date();
    const changed = await this.update({ id: row.id, ownerId: row.ownerId, revision: row.revision }, {
      customerId: observation.customerId ?? row.customerId, status: observation.status, providerStatus: observation.providerStatus,
      currentPeriodStart: observation.period ? factDate(observation.period.start) : null,
      currentPeriodEnd: observation.period ? factDate(observation.period.end) : null,
      cancelAtPeriodEnd: observation.cancelAtPeriodEnd ?? null, canceledAt: observation.canceledAt ? factDate(observation.canceledAt) : null,
      cancelState: canceled ? 'confirmed' : row.cancelState, observedAt: now, nextReconcileAt: now,
      reconcileStatus: 'pending', reconcileErrorCode: null,
      updatedAt: now, revision: { increment: 1 },
    }, fence);
    if (changed.count !== 1) throw new HostedCheckoutError('conflict', 'Subscription changed during verification; refresh again');
    return row.revision + 1;
  }
  private validatePayment(row: BillingSubscription, payment: SubscriptionPaidPeriod | SubscriptionPaidReceipt): void {
    if (payment.subscriptionId !== row.providerSubscriptionId || payment.catalogReference !== row.catalogReference) invalid('Subscription payment identity mismatch');
    if (moneyKey(payment.paidMoney) !== moneyKey(row.offer.money)) invalid('Subscription payment differs from the frozen offer');
    if (!payment.recordId || !payment.paymentId || !['invoice', 'transaction', 'capture', 'payment-intent'].includes(payment.paymentKind)) invalid('Invalid subscription payment identity');
    factDate(payment.paidAt);
    if (row.grantBasis === 'period') {
      if (!('period' in payment)) invalid('Subscription service period is missing');
      try { subscriptionPeriodKey({ provider: row.providerId, accountScope: row.accountScope, subscriptionId: row.providerSubscriptionId, period: payment.period }); }
      catch { invalid('Invalid subscription payment period'); }
    }
  }
  private async payments(row: BillingSubscription, adapter: SubscriptionAdapter) {
    if (row.grantBasis === 'payment' && (row.providerId !== 'paypal' || adapter.capabilities.paidReceiptProof !== 'provider' || !adapter.listPaidReceipts)) {
      throw new HostedCheckoutError('unsupported', 'Per-payment subscription policy requires explicit PayPal receipt support');
    }
    if (row.grantBasis === 'period' && adapter.capabilities.paidPeriodProof === 'unavailable') throw new HostedCheckoutError('unsupported', 'Subscription period evidence is unavailable');
    const result: Array<SubscriptionPaidPeriod | SubscriptionPaidReceipt> = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PROVIDER_PAGES; pageIndex++) {
      const page = row.grantBasis === 'payment'
        ? await adapter.listPaidReceipts?.(row.providerSubscriptionId, { cursor })
        : await adapter.listPaidPeriods(row.providerSubscriptionId, { cursor });
      if (!page || !Array.isArray(page.data) || page.issues?.length) invalid('Subscription payment evidence is incomplete');
      for (const payment of page.data) { this.validatePayment(row, payment); result.push(payment); }
      if (result.length > MAX_PROVIDER_RECEIPTS) invalid('Subscription reconciliation exceeded the receipt limit');
      if (page.nextCursor === undefined) return result;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 8192 || cursors.has(page.nextCursor)) invalid('Subscription pagination did not advance');
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    return invalid('Subscription reconciliation exceeded the page limit');
  }
  async refresh(id: string, ownerId: string, fence?: SubscriptionExecutionFence) {
    const row = await this.owned(id, ownerId), adapter = this.adapter(row);
    const observation = await adapter.retrieve(row.providerSubscriptionId);
    this.validateObservation(row, observation);
    const payments = await this.payments(row, adapter);
    // Refund funding/receipt evidence is read outside the financial transaction; the grant port
    // rechecks its persisted allowance under the account lock immediately before delivering credits.
    for (const payment of payments) await this.refunds?.prepareCycle(row.id, ownerId, payment, fence);
    // A slow read cannot overwrite a later cancellation/refresh. No provider IO remains after this CAS.
    let expectedRevision = await this.observe(row, observation, fence);
    const cycles = fence ? new SubscriptionCycleService(createSubscriptionCyclePersistence(this.database, fence)) : this.cycles;
    for (const payment of payments) {
      const applied = await cycles.apply({ bindingId: row.id, ownerId, providerId: adapter.id, accountScope: adapter.accountScope, payment });
      if (applied.granted && applied.receipt.initial) expectedRevision++;
    }
    await this.database.transaction(async tx => {
      await fence?.(tx);
      const changed = await tx.model('billingSubscriptions').updateMany({ where: { id, ownerId, revision: expectedRevision },
        data: { nextReconcileAt: new Date(Date.now() + 15 * 60_000), reconcileStatus: 'idle', reconcileErrorCode: null,
          lastReconcileTaskId: null, updatedAt: new Date(), revision: { increment: 1 } } });
      if (changed.count !== 1) throw new HostedCheckoutError('conflict', 'Subscription changed while applying receipts; refresh again');
      await tx.model('billingOutbox').updateMany({ where: { kind: SUBSCRIPTION_RECONCILE_EVENT, aggregateId: id,
        status: { in: ['pending', 'scheduled'] } }, data: { status: 'delivered', deliveredAt: new Date() } });
      await fence?.(tx);
    });
    return this.get(id, ownerId);
  }
  async cancel(id: string, ownerId: string, mode: SubscriptionCancelMode) {
    const row = await this.owned(id, ownerId), adapter = this.adapter(row);
    if (!adapter.capabilities.cancel.includes(mode)) throw new HostedCheckoutError('unsupported', 'Subscription cancellation mode is unsupported');
    if (row.cancelState !== 'idle') {
      if (row.cancelMode !== mode) throw new HostedCheckoutError('conflict', 'A different subscription cancellation is already in progress');
      await this.observe(row, await adapter.retrieve(row.providerSubscriptionId));
      return this.get(id, ownerId);
    }
    const now = new Date();
    const changed = await this.update({ id, ownerId, revision: row.revision, cancelState: 'idle' },
      { cancelState: 'submitting', cancelMode: mode, cancelRequestedAt: now, nextReconcileAt: now, updatedAt: now, revision: { increment: 1 } });
    if (changed.count !== 1) throw new HostedCheckoutError('conflict', 'Subscription cancellation was already claimed');
    const claimed: BillingSubscription = { ...row, cancelState: 'submitting', cancelMode: mode, cancelRequestedAt: now, revision: row.revision + 1 };
    // Unknown outcomes retain submitting across restart. Subsequent requests only retrieve facts.
    const observation = await adapter.cancel(row.providerSubscriptionId, { mode });
    await this.observe(claimed, observation);
    return this.get(id, ownerId);
  }
  async invoices(id: string, ownerId: string, pageValue?: string) {
    const row = await this.owned(id, ownerId), page = pageNumber(pageValue), adapter = this.adapter(row);
    const where = { bindingId: id, ownerId };
    const [receipts, total] = await Promise.all([
      this.database.model('billingSubscriptionCycles').findMany({ where, orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      this.database.model('billingSubscriptionCycles').count({ where }),
    ]);
    const data = await Promise.all((receipts as SubscriptionCycleReceipt[]).map(async receipt => {
      let url: string | null = null;
      if (adapter.capabilities.invoices && adapter.retrieveInvoice && receipt.paymentKind === 'invoice') {
        const invoice = await adapter.retrieveInvoice(receipt.paymentId);
        if (invoice.id !== receipt.paymentId || invoice.subscriptionId !== row.providerSubscriptionId
          || !row.customerId || invoice.customerId !== row.customerId || invoice.paidMoney && moneyKey(invoice.paidMoney) !== moneyKey(receipt.paidMoney)) invalid('Subscription invoice identity mismatch');
        url = invoice.url ? publicUrl(invoice.url) : null;
      }
      return { id: receipt.id, paidMoney: receipt.paidMoney, paidAt: receipt.paidAt,
        period: receipt.periodStart && receipt.periodEnd ? { start: receipt.periodStart, end: receipt.periodEnd } : null,
        initial: receipt.initial, url };
    }));
    return { data, total, page, pageSize: PAGE_SIZE };
  }
  async portal(id: string, ownerId: string) {
    const row = await this.owned(id, ownerId), adapter = this.adapter(row);
    if (!row.customerId || !adapter.capabilities.billingPortal || !adapter.createBillingPortal) throw new HostedCheckoutError('unsupported', 'Subscription billing portal is unavailable');
    const result = await adapter.createBillingPortal({ customerId: row.customerId,
      // Creem's API has no return URL parameter; never claim it supports one.
      ...(adapter.id === 'stripe' ? { returnUrl: this.returnUrl } : {}) });
    return { url: publicUrl(result.url) };
  }
  async handleWebhook(providerId: string, request: WebhookRequest): Promise<boolean> {
    const adapter = this.providers.get(providerId);
    if (!adapter?.verifyWebhook) return false;
    const event = await adapter.verifyWebhook(request);
    if (!event) return false;
    if (!event.eventId || !event.subscriptionId) invalid('Subscription webhook identity is missing');
    const matches = await this.database.model('billingSubscriptions').findMany({ where: { providerId: adapter.id,
      accountScope: adapter.accountScope, providerSubscriptionId: event.subscriptionId }, take: 2 }) as BillingSubscription[];
    if (!matches.length) return false;
    if (matches.length !== 1) invalid('Subscription webhook identity is ambiguous');
    await this.refresh(matches[0].id, matches[0].ownerId); return true;
  }
}
