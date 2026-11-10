import { describe, expect, it, vi } from 'vitest';
import {
  PlanCatalogError,
  PlanCatalogService,
  SubscriptionAssignmentError,
  SubscriptionAssignmentService,
  addBillingCycle,
  parsePlanOfferId,
  planCheckoutMode,
  planOfferId,
  readPlanPriceSnapshot,
  validatePlanWrite,
  type PlanCatalogStore,
  type PlanPrice,
  type SubscriptionPaymentEvidence,
  type SubscriptionPlanRecord,
  type UserSubscriptionRecord,
  type UserSubscriptionStore,
} from '../index';

/** Stand-in for the consumer catalog's validatePlanGrant. */
function validateGrant(grant: { features: unknown; quotas: unknown }) {
  const features = grant.features as Record<string, unknown>;
  const quotas = grant.quotas as Record<string, unknown>;
  const issues = [
    ...Object.entries(features).filter(([k, v]) => k !== 'reports' || typeof v !== 'boolean').map(([k]) => `feature ${k}`),
    ...Object.entries(quotas).filter(([k, v]) => k !== 'reports_per_month' || typeof v !== 'number').map(([k]) => `quota ${k}`),
  ];
  if (issues.length) throw Object.assign(new Error('invalid grant'), { issues });
  return { features: features as Record<string, boolean>, quotas: quotas as Record<string, number> };
}

function memoryPlans() {
  const rows = new Map<string, SubscriptionPlanRecord>();
  const referenced = new Set<string>();
  let sequence = 0;
  const refsOf = (prices: PlanPrice[]) => prices.flatMap((price) => Object.entries(price.providerRefs).map(([provider, ref]) => `${provider}:${ref}`));
  const assertRefs = (id: string | null, prices: PlanPrice[]) => {
    const taken = new Set([...rows.values()].filter((row) => row.id !== id).flatMap((row) => refsOf(row.prices)));
    if (refsOf(prices).some((ref) => taken.has(ref))) throw new PlanCatalogError('conflict', 'Provider reference already sells another price');
  };
  const store: PlanCatalogStore = {
    async list(options) {
      return [...rows.values()].filter((row) => !options?.listedOnly || row.status).sort((a, b) => a.order - b.order);
    },
    async findById(id) { return rows.get(id) ?? null; },
    async findBySlug(slug) { return [...rows.values()].find((row) => row.slug === slug) ?? null; },
    async create(data) {
      assertRefs(null, data.prices);
      const row = { ...data, id: `plan-${++sequence}`, revision: 0, createdAt: new Date(), updatedAt: new Date() };
      rows.set(row.id, row);
      return row;
    },
    async update(id, data, options) {
      const row = rows.get(id);
      if (!row) return null;
      if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision)
        throw new PlanCatalogError('conflict', 'Plan changed since it was read');
      if (data.prices) assertRefs(id, data.prices);
      const next = { ...row, ...data, revision: row.revision + 1, updatedAt: new Date() };
      rows.set(id, next);
      return next;
    },
    async delete(id) {
      if (referenced.has(id)) throw new PlanCatalogError('referenced', 'Plan is referenced');
      return rows.delete(id);
    },
  };
  return { store, rows, referenced, service: new PlanCatalogService(store, { validateGrant }) };
}
const monthly = { interval: 'month', currency: 'USD', amount: '9.90', providerRefs: { stripe: 'price_M1', paypal: 'P-1' } };
const basic = { slug: 'basic', name: 'Basic', features: { reports: true }, quotas: { reports_per_month: 5 }, prices: [monthly] };

function reason(promise: Promise<unknown>) {
  return promise.then(() => 'resolved', (error: { reason?: string }) => error.reason);
}

describe('plan write validation', () => {
  it('normalizes a complete plan with defaults and currency-formatted amounts', () => {
    expect(validatePlanWrite({ ...basic, prices: [{ ...monthly, amount: '9.9' }, { interval: 'one_time', currency: 'JPY', amount: '500', termDays: 30 }] },
      { validateGrant, partial: false })).toEqual({
      ...basic, description: null, status: false, order: 0,
      featured: false, badge: null, highlights: [], nameI18n: {}, descriptionI18n: {}, badgeI18n: {}, highlightsI18n: {},
      prices: [{ ...monthly, termDays: null, credits: 0, creditExpiry: null },
        { interval: 'one_time', currency: 'JPY', amount: '500', termDays: 30, providerRefs: {}, credits: 0, creditExpiry: null }],
    });
  });
  it('collects every invalid field', () => {
    try {
      validatePlanWrite({ slug: 'Bad Slug', name: '', status: 'yes', order: 1.5, extra: 1, features: { other: true }, description: 7,
        prices: [
          { interval: 'week', currency: 'usd', amount: '1' },
          { interval: 'month', currency: 'USD', amount: 9.9 },
          { interval: 'month', currency: 'JPY', amount: '1.5' },
          { interval: 'year', currency: 'USD', amount: '99', providerRefs: { stripe: 'prod_1' } },
          { interval: 'one_time', currency: 'USD', amount: '5' },
          { interval: 'lifetime', currency: 'USD', amount: '5', termDays: 3 },
          { interval: 'year', currency: 'USD', amount: '98', providerRefs: { paypal: 'P-9' } },
        ] }, { validateGrant, partial: false });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PlanCatalogError);
      expect((error as PlanCatalogError).reason).toBe('invalid');
      expect((error as PlanCatalogError).issues).toEqual([
        'unsupported field extra',
        'slug must be lowercase letters, digits, _ or -',
        'name must be 1-100 characters',
        'description must be at most 2000 characters',
        'status must be a boolean',
        'order must be an integer',
        'prices[0].interval must be one of month, year, one_time, lifetime',
        'prices[0].currency must be a three-letter uppercase code',
        // Numbers are refused so a float never becomes a price.
        'prices[1].amount must be a non-negative decimal string for USD',
        'prices[2].amount must be a non-negative decimal string for JPY',
        'prices[3].providerRefs.stripe is not a valid stripe reference',
        'prices[4].termDays must be an integer from 1 to 36500',
        'prices[5].termDays applies only to one_time prices',
        'prices[6] duplicates the year USD price',
        'feature other',
      ]);
    }
    expect(() => validatePlanWrite(null, { validateGrant, partial: true })).toThrow('Plan data must be an object');
    expect(() => validatePlanWrite({}, { validateGrant, partial: false })).toThrow('slug is required');
    // One provider reference cannot sell two prices of the same plan.
    expect(() => validatePlanWrite({ prices: [monthly, { ...monthly, interval: 'year' }] }, { validateGrant, partial: true }))
      .toThrow('used by another price');
  });
  it('looks up provider reference formats by own key only', () => {
    // A provider id that names an Object.prototype member is an opaque provider, not a format.
    expect(validatePlanWrite({ ...basic, prices: [{ ...monthly, providerRefs: { constructor: 'ref-1', tostring: 'ref-2' } }] },
      { validateGrant, partial: false }).prices?.[0].providerRefs).toEqual({ constructor: 'ref-1', tostring: 'ref-2' });
  });
  it('validates only supplied fields for partial writes', () => {
    expect(validatePlanWrite({ status: true }, { validateGrant, partial: true })).toEqual({ status: true });
    expect(validatePlanWrite({ quotas: { reports_per_month: -1 }, prices: [] }, { validateGrant, partial: true }))
      .toEqual({ quotas: { reports_per_month: -1 }, prices: [] });
  });
});

describe('PlanCatalogService', () => {
  it('creates, updates, toggles and deletes plans', async () => {
    const { service, rows } = memoryPlans();
    const plan = await service.create(basic);
    expect(plan).toMatchObject({ slug: 'basic', status: false, revision: 0, prices: [{ amount: '9.90', interval: 'month' }] });
    expect(await service.findBySlug('basic')).toMatchObject({ id: plan.id });
    expect(await service.findBySlug('NOT VALID')).toBeNull();
    expect((await service.update(plan.id, { name: 'Basic+', quotas: { reports_per_month: 9 } }))).toMatchObject({
      name: 'Basic+', quotas: { reports_per_month: 9 }, features: { reports: true }, revision: 1 });
    expect((await service.setStatus(plan.id, true)).status).toBe(true);
    expect(await service.list({ listedOnly: true })).toHaveLength(1);
    await service.delete(plan.id);
    expect(rows.size).toBe(0);
  });
  it('rejects stale revisions and maps conflicts, missing plans and references to reasons', async () => {
    const { service, referenced } = memoryPlans();
    const one = await service.create(basic);
    const two = await service.create({ ...basic, slug: 'pro', prices: [] });
    expect(await reason(service.create(basic))).toBe('conflict');
    expect(await reason(service.update(two.id, { slug: 'basic' }))).toBe('conflict');
    // A provider reference that already sells another plan's price.
    expect(await reason(service.update(two.id, { prices: [monthly] }))).toBe('conflict');
    expect(await reason(service.update('missing', { name: 'x' }))).toBe('not_found');
    expect(await reason(service.findById('missing'))).toBe('not_found');
    expect(await reason(service.delete('missing'))).toBe('not_found');
    expect(await reason(service.setStatus(one.id, 'true'))).toBe('invalid');
    expect(await reason(service.update(one.id, { expectedRevision: -1, name: 'x' }))).toBe('invalid');
    expect((await service.update(one.id, { expectedRevision: 0, name: 'First' })).revision).toBe(1);
    // A second editor still holding revision 0 must not overwrite the first edit.
    expect(await reason(service.update(one.id, { expectedRevision: 0, name: 'Second' }))).toBe('conflict');
    // Keeping its own provider references is not a conflict.
    expect((await service.update(one.id, { prices: [{ ...monthly, amount: '12.00' }] })).prices[0].amount).toBe('12.00');
    referenced.add(one.id);
    expect(await reason(service.delete(one.id))).toBe('referenced');
  });
  it('resolves plan offers from the current plan price and freezes a snapshot', async () => {
    const { service } = memoryPlans();
    const plan = await service.create({ ...basic, prices: [monthly, { interval: 'lifetime', currency: 'EUR', amount: '0', providerRefs: { stripe: 'price_Free' } },
      { interval: 'one_time', currency: 'USD', amount: '30', termDays: 30, providerRefs: { stripe: 'price_Pass' } }] });
    const offer = planOfferId(plan.id, 'month', 'USD');
    expect(parsePlanOfferId(offer)).toEqual({ planId: plan.id, interval: 'month', currency: 'USD' });
    expect(parsePlanOfferId('credits-100')).toBeNull();
    expect(parsePlanOfferId(`plan:${plan.id}:week:USD`)).toBeNull();
    // Draft plans are not sold.
    expect(await service.resolveOffer(offer, 'stripe')).toBeNull();
    await service.setStatus(plan.id, true);
    expect(await service.resolveOffer(offer, 'stripe')).toMatchObject({ mode: 'subscription',
      snapshot: { planId: plan.id, slug: 'basic', revision: 1, interval: 'month', currency: 'USD', amount: '9.90', termDays: null, providerId: 'stripe', providerRef: 'price_M1', credits: 0, creditExpiry: null } });
    expect(await service.resolveOffer(offer, 'creem')).toBeNull();
    // A zero amount is never a checkout offer.
    expect(await service.resolveOffer(planOfferId(plan.id, 'lifetime', 'EUR'), 'stripe')).toBeNull();
    expect((await service.resolveOffer(planOfferId(plan.id, 'one_time', 'USD'), 'stripe'))?.mode).toBe('payment');
    // An edited price is what the next checkout charges.
    await service.update(plan.id, { prices: [{ ...monthly, amount: '11.00', providerRefs: { stripe: 'price_M2' } }] });
    expect((await service.resolveOffer(offer, 'stripe'))?.snapshot).toMatchObject({ amount: '11.00', providerRef: 'price_M2', revision: 2 });
    const snapshot = (await service.resolveOffer(offer, 'stripe'))!.snapshot;
    expect(readPlanPriceSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(readPlanPriceSnapshot({ ...snapshot, amount: 11 })).toBeNull();
    // Orders frozen before plans granted credits read as granting none; corrupt credit fields are refused.
    const { credits: _credits, creditExpiry: _expiry, ...legacy } = snapshot;
    expect(readPlanPriceSnapshot(legacy)).toEqual({ ...legacy, credits: 0, creditExpiry: null });
    expect(readPlanPriceSnapshot({ ...snapshot, credits: -1 })).toBeNull();
    expect(readPlanPriceSnapshot({ ...snapshot, creditExpiry: 'forever' })).toBeNull();
    expect(planCheckoutMode('year')).toBe('subscription');
  });
});

describe('addBillingCycle', () => {
  it('adds calendar months and clamps to month end', () => {
    expect(addBillingCycle(new Date('2026-01-31T10:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addBillingCycle(new Date('2028-02-29T00:00:00Z'), 'YEARLY').toISOString()).toBe('2029-02-28T00:00:00.000Z');
    expect(addBillingCycle(new Date('2026-03-15T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-04-15T00:00:00.000Z');
  });
});

function memorySubscriptions() {
  const now = new Date('2026-06-01T00:00:00Z');
  const clock = { now };
  const users = new Map([['u1', true], ['disabled', false]]);
  const plans = [{ id: 'p-basic', slug: 'basic', status: true }, { id: 'p-pro', slug: 'pro', status: false }];
  let rows = new Map<string, UserSubscriptionRecord>();
  const pending = new Set<string>();
  const subscribed = new Set<string>();
  const evidence = new Map<string, SubscriptionPaymentEvidence>();
  const locks: string[] = [];
  const store: UserSubscriptionStore<'tx'> = {
    async transaction(userId, work) {
      locks.push(userId);
      const before = new Map(rows);
      try { return await work('tx'); } catch (error) { rows = before; throw error; }
    },
    async userAssignable(_tx, id) { return users.get(id) === true; },
    async find(_tx, id) { return rows.get(id) ?? null; },
    async findPlanBySlug(_tx, slug) { return plans.find((plan) => plan.slug === slug) ?? null; },
    async findPlanById(_tx, id) { return plans.find((plan) => plan.id === id) ?? null; },
    async pendingPayment(_tx, id) {
      if (subscribed.has(id)) return { kind: 'subscription', id: `sub-${id}`, state: 'active' };
      return pending.has(id) ? { kind: 'order', id: `order-${id}`, state: 'pending' } : null;
    },
    async recordPaymentEvidence(_tx, item) {
      if (evidence.has(item.reference)) return false;
      evidence.set(item.reference, item);
      return true;
    },
    async findPaymentEvidence(_tx, reference) { return evidence.get(reference) ?? null; },
    async save(_tx, userId, data) {
      const prior = rows.get(userId);
      const row = { ...data, id: prior?.id ?? `sub-${userId}`, userId, createdAt: prior?.createdAt ?? now, updatedAt: clock.now };
      rows.set(userId, row);
      return row;
    },
  };
  const activeTerm = vi.fn((term: { status: string; startDate: Date | null; endDate: Date | null; billingCycle?: string | null }, at: Date) =>
    (term.status === 'ACTIVE' || term.status === 'CANCELED') && !!term.startDate && term.startDate <= at
      && (term.endDate ? term.endDate > at : term.billingCycle === 'LIFETIME'));
  const changed = vi.fn();
  const onNotifyError = vi.fn();
  const service = new SubscriptionAssignmentService(store, { activeTerm, now: () => clock.now, changed, onNotifyError });
  return { service, rows: () => rows, pending, subscribed, evidence, locks, changed, onNotifyError, now, clock };
}

describe('SubscriptionAssignmentService', () => {
  it('assigns a plan with a derived term and keeps the term on plan-only edits', async () => {
    const f = memorySubscriptions();
    const first = await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' }, 'admin');
    expect(first).toMatchObject({ planId: 'p-basic', status: 'ACTIVE', source: 'admin', startDate: f.now,
      endDate: new Date('2026-07-01T00:00:00Z'), cancelAtPeriodEnd: false });
    expect(f.service.isActive(first)).toBe(true);
    expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'assigned', before: null, actorId: 'admin' }));
    const same = await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    expect(same.endDate).toEqual(first.endDate);
    // Draft plans may be assigned manually.
    const pro = await f.service.assign('u1', { planSlug: 'pro', billingCycle: 'YEARLY', startDate: '2026-05-01T00:00:00Z' });
    expect(pro).toMatchObject({ planId: 'p-pro', endDate: new Date('2027-05-01T00:00:00Z') });
    const lifetime = await f.service.assign('u1', { planSlug: 'pro', billingCycle: 'LIFETIME' });
    expect(lifetime.endDate).toBeNull();
    expect(f.service.isActive(lifetime)).toBe(true);
    const explicit = await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', status: 'CANCELED', endDate: '2026-06-10T00:00:00Z' });
    expect(explicit).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: true, canceledAt: f.now });
  });
  it('rejects invalid input, missing users/plans and pending payment', async () => {
    const f = memorySubscriptions();
    const r = (p: Promise<unknown>) => reason(p);
    expect(await r(f.service.assign('', { planSlug: 'basic', billingCycle: 'MONTHLY' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: '', billingCycle: 'MONTHLY' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'WEEKLY' as 'MONTHLY' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', status: 'PAUSED' as 'ACTIVE' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', startDate: 'nope' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', endDate: '2026-05-01T00:00:00Z' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', endDate: null }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'LIFETIME', endDate: '2027-01-01T00:00:00Z' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', startDate: '2026-01-01T00:00:00Z', endDate: '2026-02-01T00:00:00Z' }))).toBe('invalid');
    expect(await r(f.service.assign('disabled', { planSlug: 'basic', billingCycle: 'MONTHLY' }))).toBe('not_found');
    expect(await r(f.service.assign('u1', { planSlug: 'missing', billingCycle: 'MONTHLY' }))).toBe('not_found');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'LIFETIME', status: 'CANCELED' }))).toBe('invalid');
    expect(await r(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'ONE_TIME' }))).toBe('invalid');
    f.pending.add('u1');
    await expect(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' })).rejects.toMatchObject({
      reason: 'pending_payment', details: { blocking: { kind: 'order', id: 'order-u1', state: 'pending' } } });
    expect(f.rows().size).toBe(0);
    expect(f.changed).not.toHaveBeenCalled();
  });
  it('cancels at period end idempotently and guards provider billing', async () => {
    const f = memorySubscriptions();
    expect(await reason(f.service.cancel('u1'))).toBe('not_found');
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    f.subscribed.add('u1');
    expect(await reason(f.service.cancel('u1'))).toBe('pending_payment');
    f.subscribed.delete('u1');
    f.changed.mockClear();
    const canceled = await f.service.cancel('u1', 'admin');
    expect(canceled).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: true, endDate: new Date('2026-07-01T00:00:00Z') });
    expect(f.service.isActive(canceled)).toBe(true);
    expect(await f.service.cancel('u1')).toEqual(canceled);
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
  it('lets an administrator revoke or cancel despite an unsettled checkout, never despite a provider subscription', async () => {
    const f = memorySubscriptions();
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    f.pending.add('u1');
    // A change of the term still waits for the checkout; revocation and cancel do not.
    expect(await reason(f.service.assign('u1', { planSlug: 'pro', billingCycle: 'MONTHLY' }))).toBe('pending_payment');
    expect(await f.service.cancel('u1')).toMatchObject({ status: 'CANCELED' });
    expect(await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', status: 'EXPIRED' })).toMatchObject({ status: 'EXPIRED' });
    f.subscribed.add('u1');
    expect(await reason(f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', status: 'EXPIRED' }))).toBe('pending_payment');
  });
  it('never resurrects a term revoked after the purchase; a later purchase applies', async () => {
    const f = memorySubscriptions();
    const purchasedAt = new Date('2026-05-31T23:00:00Z');
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    f.pending.add('u1');
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', status: 'EXPIRED' });
    const paid = { userId: 'u1', planId: 'p-basic', billingCycle: 'ONE_TIME' as const, reference: 'order:late',
      periodStart: f.now, periodEnd: new Date('2026-07-01T00:00:00Z'), purchasedAt };
    const late = await f.service.recordPayment(paid);
    expect(late).toMatchObject({ outcome: 'revoked', change: null });
    expect(f.evidence.has('order:late')).toBe(true);
    expect(f.rows().get('u1')).toMatchObject({ status: 'EXPIRED' });
    // A purchase made after the revocation is a new decision of the user.
    f.clock.now = new Date('2026-06-02T00:00:00Z');
    const fresh = await f.service.recordPayment({ ...paid, reference: 'order:fresh', periodStart: f.clock.now,
      periodEnd: new Date('2026-07-02T00:00:00Z'), purchasedAt: f.clock.now });
    expect(fresh).toMatchObject({ outcome: 'applied', subscription: { status: 'ACTIVE', source: 'payment' } });
  });
  it('admits at checkout only purchases whose payment would improve the term', async () => {
    const f = memorySubscriptions();
    const refusal = (promise: Promise<unknown>) => promise.then(() => 'admitted',
      (error: { reason?: string; details?: { refusal?: string } }) => `${error.reason}:${error.details?.refusal ?? ''}`);
    const admit = (planId: string, billingCycle: 'MONTHLY' | 'YEARLY' | 'ONE_TIME' | 'LIFETIME', termDays?: number) =>
      refusal(f.service.admitPurchase('u1', { planId, billingCycle, termDays }));
    expect(await admit('p-basic', 'MONTHLY')).toBe('admitted');
    expect(await reason(f.service.admitPurchase('u1', { planId: 'p-basic', billingCycle: 'ONE_TIME' }))).toBe('invalid');
    // Administrator-granted year on basic.
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'YEARLY' });
    expect(await admit('p-basic', 'MONTHLY')).toBe('conflict:term_covers_purchase');
    expect(await admit('p-basic', 'ONE_TIME', 30)).toBe('admitted');
    expect(await admit('p-pro', 'MONTHLY')).toBe('conflict:longer_admin_term');
    expect(await admit('p-pro', 'ONE_TIME', 400)).toBe('admitted');
    expect(await admit('p-pro', 'LIFETIME')).toBe('admitted');
    // A pending checkout does not block another purchase; a provider plan subscription does.
    f.pending.add('u1');
    expect(await admit('p-basic', 'ONE_TIME', 30)).toBe('admitted');
    f.subscribed.add('u1');
    expect(await admit('p-basic', 'ONE_TIME', 30)).toBe('pending_payment:provider_subscription');
    f.subscribed.delete('u1');
    f.pending.delete('u1');
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'LIFETIME' });
    for (const cycle of ['MONTHLY', 'ONE_TIME', 'LIFETIME'] as const)
      expect(await admit(cycle === 'LIFETIME' ? 'p-pro' : 'p-basic', cycle, 30)).toBe('conflict:lifetime_active');
  });
  it('stacks a same-plan one-time term and keeps write-back consistent with checkout admission', async () => {
    const f = memorySubscriptions();
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' }); // ends 2026-07-01
    const day = 86_400_000;
    const pass = { userId: 'u1', planId: 'p-basic', billingCycle: 'ONE_TIME' as const, reference: 'order:pass',
      periodStart: f.now, periodEnd: new Date(f.now.getTime() + 30 * day) };
    const stacked = await f.service.recordPayment(pass);
    expect(stacked.outcome).toBe('applied');
    expect(stacked.subscription).toMatchObject({ startDate: f.now, billingCycle: 'ONE_TIME', source: 'payment',
      endDate: new Date(new Date('2026-07-01T00:00:00Z').getTime() + 30 * day) });
    // The ledger keeps the paid period itself.
    expect(f.evidence.get('order:pass')).toMatchObject({ periodStart: pass.periodStart, periodEnd: pass.periodEnd });
    const again = await f.service.recordPayment({ ...pass, reference: 'order:pass-2' });
    expect(again.subscription?.endDate).toEqual(new Date(new Date('2026-07-01T00:00:00Z').getTime() + 60 * day));
    // An administrator then grants a longer term on another plan: a payment admitted earlier for a
    // shorter term of a third plan is recorded only (and must be refunded by the caller).
    await f.service.assign('u1', { planSlug: 'pro', billingCycle: 'YEARLY' });
    const shorter = await f.service.recordPayment({ userId: 'u1', planId: 'p-basic', billingCycle: 'MONTHLY', reference: 'cycle:x',
      periodStart: f.now, periodEnd: new Date('2026-07-01T00:00:00Z') });
    expect(shorter.outcome).toBe('kept');
    expect(f.rows().get('u1')).toMatchObject({ planId: 'p-pro', source: 'admin' });
  });
  it('refuses to cancel a lifetime term and revokes it with EXPIRED instead', async () => {
    const f = memorySubscriptions();
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'LIFETIME' });
    expect(await reason(f.service.cancel('u1'))).toBe('invalid');
    expect(f.service.isActive(f.rows().get('u1')!)).toBe(true);
    const revoked = await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'LIFETIME', status: 'EXPIRED' });
    expect(revoked).toMatchObject({ status: 'EXPIRED', endDate: null });
    expect(f.service.isActive(revoked)).toBe(false);
  });
  it('starts a new term when re-assigning the same plan after it lapsed', async () => {
    const f = memorySubscriptions();
    await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY', status: 'CANCELED',
      startDate: '2026-01-01T00:00:00Z', endDate: '2026-02-01T00:00:00Z' });
    const renewed = await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    expect(renewed).toMatchObject({ startDate: f.now, endDate: new Date('2026-07-01T00:00:00Z'), status: 'ACTIVE' });
    const pass = await f.service.assign('u1', { planSlug: 'pro', billingCycle: 'ONE_TIME', endDate: '2026-06-15T00:00:00Z' });
    expect(pass).toMatchObject({ billingCycle: 'ONE_TIME', endDate: new Date('2026-06-15T00:00:00Z') });
  });
  it('writes back paid periods, extends the same plan and records every reference once', async () => {
    const f = memorySubscriptions();
    const paid = { userId: 'u1', planId: 'p-basic', billingCycle: 'MONTHLY' as const, reference: 'cycle-1',
      periodStart: new Date('2026-06-01T00:00:00Z'), periodEnd: new Date('2026-07-01T00:00:00Z'), orderId: 'order-1' };
    // Pending payment never blocks the payment's own write-back.
    f.pending.add('u1');
    const first = await f.service.recordPayment(paid);
    expect(first.outcome).toBe('applied');
    expect(first.subscription).toMatchObject({ source: 'payment', status: 'ACTIVE', paymentReference: 'cycle-1' });
    expect(first.change).toMatchObject({ kind: 'paid', before: null });
    expect(f.evidence.get('cycle-1')).toMatchObject({ orderId: 'order-1', planId: 'p-basic' });
    expect(await f.service.recordPayment(paid)).toEqual({ outcome: 'replayed', subscription: first.subscription, change: null });
    const renewed = await f.service.recordPayment({ ...paid, reference: 'cycle-2', periodStart: new Date('2026-07-01T00:00:00Z'), periodEnd: new Date('2026-08-01T00:00:00Z') });
    expect(renewed.subscription).toMatchObject({ startDate: first.subscription!.startDate, endDate: new Date('2026-08-01T00:00:00Z'), paymentReference: 'cycle-2' });
    // An older period of the same plan is recorded but never shortens the term.
    const late = await f.service.recordPayment({ ...paid, reference: 'cycle-0', periodStart: new Date('2026-05-15T00:00:00Z'), periodEnd: new Date('2026-06-15T00:00:00Z') });
    expect(late).toMatchObject({ outcome: 'superseded', change: null });
    expect(f.rows().get('u1')?.endDate).toEqual(new Date('2026-08-01T00:00:00Z'));
    // `changed` is for assign/cancel only; payment changes are returned to the caller's transaction.
    expect(f.changed).not.toHaveBeenCalled();
    const lifetime = await f.service.recordPayment({ ...paid, reference: 'once', billingCycle: 'LIFETIME', periodEnd: null });
    expect(lifetime.subscription).toMatchObject({ endDate: null, billingCycle: 'LIFETIME' });
    // A finite payment for the same plan never downgrades a lifetime term (B6).
    const monthlyAfterLifetime = await f.service.recordPayment({ ...paid, reference: 'cycle-3', periodStart: new Date('2026-06-01T00:00:00Z'), periodEnd: new Date('2026-09-01T00:00:00Z') });
    expect(monthlyAfterLifetime.outcome).toBe('kept');
    expect(f.rows().get('u1')).toMatchObject({ billingCycle: 'LIFETIME', endDate: null });
  });
  it('records ended, out-of-order and replayed-after-admin-edit payments without changing the term', async () => {
    const f = memorySubscriptions();
    // Current term: plan pro, paid by cycle B (Jun 1 → Jul 1).
    await f.service.recordPayment({ userId: 'u1', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'B',
      periodStart: new Date('2026-06-01T00:00:00Z'), periodEnd: new Date('2026-07-01T00:00:00Z') });
    // A catch-up of an old, already ended cycle on basic is evidence only (B2).
    const ended = await f.service.recordPayment({ userId: 'u1', planId: 'p-basic', billingCycle: 'MONTHLY', reference: 'A-old',
      periodStart: new Date('2026-04-01T00:00:00Z'), periodEnd: new Date('2026-05-01T00:00:00Z') });
    expect(ended.outcome).toBe('ended');
    // A delayed receipt on basic whose period started before the current evidence: superseded.
    const delayed = await f.service.recordPayment({ userId: 'u1', planId: 'p-basic', billingCycle: 'MONTHLY', reference: 'A',
      periodStart: new Date('2026-05-20T00:00:00Z'), periodEnd: new Date('2026-06-20T00:00:00Z') });
    expect(delayed.outcome).toBe('superseded');
    expect(f.rows().get('u1')).toMatchObject({ planId: 'p-pro', paymentReference: 'B' });
    // An upgrade paid now replaces the other plan.
    const upgrade = await f.service.recordPayment({ userId: 'u1', planId: 'p-basic', billingCycle: 'YEARLY', reference: 'C',
      periodStart: new Date('2026-06-01T00:00:00Z'), periodEnd: new Date('2027-06-01T00:00:00Z') });
    expect(upgrade.subscription).toMatchObject({ planId: 'p-basic', billingCycle: 'YEARLY', paymentReference: 'C' });
    // An administrator edit clears the reference; replaying an applied receipt stays a no-op.
    await f.service.assign('u1', { planSlug: 'pro', billingCycle: 'MONTHLY' });
    expect(f.rows().get('u1')?.paymentReference).toBeNull();
    expect((await f.service.recordPayment({ userId: 'u1', planId: 'p-pro', billingCycle: 'MONTHLY', reference: 'B',
      periodStart: new Date('2026-06-01T00:00:00Z'), periodEnd: new Date('2026-07-01T00:00:00Z') })).outcome).toBe('replayed');
    expect(f.rows().get('u1')).toMatchObject({ source: 'admin', planId: 'p-pro' });
  });
  it('rejects invalid paid periods and unknown plans', async () => {
    const f = memorySubscriptions();
    const paid = { userId: 'u1', planId: 'p-basic', billingCycle: 'MONTHLY' as const, reference: 'r',
      periodStart: new Date('2026-06-01T00:00:00Z'), periodEnd: new Date('2026-07-01T00:00:00Z') };
    expect(await reason(f.service.recordPayment({ ...paid, periodEnd: paid.periodStart }))).toBe('invalid');
    expect(await reason(f.service.recordPayment({ ...paid, periodEnd: null }))).toBe('invalid');
    expect(await reason(f.service.recordPayment({ ...paid, billingCycle: 'LIFETIME' }))).toBe('invalid');
    expect(await reason(f.service.recordPayment({ ...paid, reference: '' }))).toBe('invalid');
    expect(await reason(f.service.recordPayment({ ...paid, periodStart: new Date(Number.NaN) }))).toBe('invalid');
    expect(await reason(f.service.recordPayment({ ...paid, planId: 'missing' }))).toBe('not_found');
    expect(await reason(f.service.recordPayment({ ...paid, billingCycle: 'DAILY' as 'MONTHLY' }))).toBe('invalid');
  });
  it('returns the committed result when the change hook fails', async () => {
    const f = memorySubscriptions();
    f.changed.mockRejectedValueOnce(new Error('bus down'));
    const saved = await f.service.assign('u1', { planSlug: 'basic', billingCycle: 'MONTHLY' });
    expect(saved.planId).toBe('p-basic');
    expect(f.onNotifyError).toHaveBeenCalledWith(expect.objectContaining({ message: 'bus down' }), expect.objectContaining({ kind: 'assigned' }));
    expect(new SubscriptionAssignmentError('invalid', 'x').name).toBe('SubscriptionAssignmentError');
  });
});

describe('readPlanPriceSnapshot amounts (N17)', () => {
  const snap = (currency: string, amount: string) => ({
    planId: 'p1', slug: 'basic', revision: 1, interval: 'one_time', currency, amount, termDays: 30, providerId: 'stripe', providerRef: 'price_1',
  });
  it('accepts two- and three-decimal stored snapshots for three-decimal currencies and keeps the stored string', () => {
    expect(readPlanPriceSnapshot(snap('KWD', '12.50'))).toMatchObject({ currency: 'KWD', amount: '12.50' });
    expect(readPlanPriceSnapshot(snap('KWD', '12.500'))).toMatchObject({ currency: 'KWD', amount: '12.500' });
  });
  it('rejects non-canonical amounts', () => {
    expect(readPlanPriceSnapshot(snap('KWD', '12.5'))).toBeNull();
    expect(readPlanPriceSnapshot(snap('KWD', '12.5000'))).toBeNull();
    expect(readPlanPriceSnapshot(snap('USD', '12.5'))).toBeNull();
    expect(readPlanPriceSnapshot(snap('USD', '12.50'))).toMatchObject({ amount: '12.50' });
  });
});
