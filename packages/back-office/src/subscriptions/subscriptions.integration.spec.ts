// @vitest-environment node
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planOfferId } from '@zucker-framework/payment';
import { PgTestAdapter, type PgPoolLike } from './testing/pg-test-adapter';
import {
  PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, PLAN_TERM_CHANGED_OUTBOX_KIND, SubscriptionsService, advisoryLocks, createPlanFulfillmentHooks,
  createResourceChargeLookup, createQuotaReservationStore, planSeedsFromOffers, resolveSubscriptionsOptions,
  resolveSubscriptionsSettings, seedPlans, type BackOfficeSubscriptionsOptions, type PresentedEntitlementCatalog,
} from './index';

/**
 * PostgreSQL contract: the host runs on a schema whose tables, columns and status types differ from
 * the Framework template (ccopyright-like `userId`/`quotaType`, PostgreSQL enum status and cycle
 * columns, other table names), through a plain DatabaseAdapter, with advisory locks and no SQL of
 * its own. Needs TEST_DATABASE_URL (an isolated *_test database).
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

const SCHEMA_SQL = `
CREATE TYPE term_status AS ENUM ('ACTIVE','CANCELED','EXPIRED','TRIALING');
CREATE TYPE term_cycle AS ENUM ('MONTHLY','YEARLY','LIFETIME','ONE_TIME');
CREATE TYPE hold_state AS ENUM ('RESERVED','CONFIRMED','RELEASED','EXPIRED');
CREATE TABLE acct_members (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, handle text NOT NULL UNIQUE, mail text, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE catalog_tiers (
  tier_id text PRIMARY KEY DEFAULT gen_random_uuid()::text, code text NOT NULL UNIQUE, title text NOT NULL, summary text,
  listed boolean NOT NULL DEFAULT false, position int NOT NULL DEFAULT 0, grant_features jsonb NOT NULL DEFAULT '{}',
  grant_quotas jsonb NOT NULL DEFAULT '{}', version int NOT NULL DEFAULT 0, featured boolean NOT NULL DEFAULT false, badge text,
  highlights jsonb NOT NULL DEFAULT '[]', "nameI18n" jsonb NOT NULL DEFAULT '{}', "descriptionI18n" jsonb NOT NULL DEFAULT '{}',
  "badgeI18n" jsonb NOT NULL DEFAULT '{}', "highlightsI18n" jsonb NOT NULL DEFAULT '{}',
  legacy_price numeric(10,2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tier_prices (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, tier_id text NOT NULL REFERENCES catalog_tiers(tier_id), "interval" text NOT NULL,
  currency text NOT NULL, amount text NOT NULL, "termDays" int, credits int NOT NULL DEFAULT 0,
  "creditExpiryPeriod" boolean NOT NULL DEFAULT false, "creditExpiryDays" int,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE (tier_id, "interval", currency));
CREATE TABLE tier_price_refs (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, price_id text NOT NULL REFERENCES tier_prices(id),
  provider text NOT NULL, reference text NOT NULL, UNIQUE (provider, reference), UNIQUE (price_id, provider));
CREATE TABLE member_terms (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, member_id text NOT NULL UNIQUE, tier_id text NOT NULL,
  status term_status NOT NULL DEFAULT 'ACTIVE', cycle term_cycle, "startDate" timestamptz NOT NULL, "endDate" timestamptz,
  "trialEndDate" timestamptz, "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false, "canceledAt" timestamptz,
  source text NOT NULL DEFAULT 'admin', "paymentReference" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE term_payments (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, reference text NOT NULL UNIQUE, member_id text NOT NULL,
  tier_id text NOT NULL, cycle term_cycle NOT NULL, "periodStart" timestamptz NOT NULL, "periodEnd" timestamptz, "orderId" text,
  "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE usage_counters (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, member_id text NOT NULL, quota_type text NOT NULL,
  period text NOT NULL, cap int NOT NULL, consumed int NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL, UNIQUE (member_id, quota_type, period));
CREATE TABLE usage_holds (id text PRIMARY KEY, member_id text NOT NULL, quota_type text NOT NULL, period text, amount int NOT NULL,
  "limit" int, "policyVersion" text NOT NULL DEFAULT 'legacy', "resourceType" text, "resourceId" text,
  state hold_state NOT NULL DEFAULT 'RESERVED', "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz, reason text, "activeResourceKey" text,
  metadata jsonb, "releasedAt" timestamptz);
-- ccopyright shape: one live charge per key; finished rows may keep their key as history.
CREATE UNIQUE INDEX usage_holds_live_key ON usage_holds ("activeResourceKey") WHERE state IN ('RESERVED','CONFIRMED');
CREATE TABLE billing_events_out (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, kind text NOT NULL, aggregate_id text NOT NULL,
  payload jsonb NOT NULL, UNIQUE (kind, aggregate_id));
CREATE TABLE checkout_orders (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
`;

const catalog = {
  features: [
    { key: 'projects', label: 'Projects', description: 'Create a project', category: 'metered', counter: 'projects_per_month' },
    { key: 'exports', category: 'metered', counter: 'exports_per_day' },
    { key: 'adFree', label: 'Ad-free', category: 'benefit' },
  ],
  counters: [
    { key: 'projects_per_month', label: 'Projects', unit: 'per month', period: 'month' },
    { key: 'exports_per_day', period: 'day' },
  ],
} as const satisfies PresentedEntitlementCatalog;

/** Mapping of the second schema; status/cycle columns are PostgreSQL enums, values stay the Framework's. */
const mapping: Omit<BackOfficeSubscriptionsOptions, 'catalog'> = {
  models: { users: 'acct_members', plans: 'catalog_tiers', planPrices: 'tier_prices', planPriceRefs: 'tier_price_refs',
    subscriptions: 'member_terms', subscriptionPayments: 'term_payments', quotaUsage: 'usage_counters', quotaReservations: 'usage_holds',
    billingOutbox: 'billing_events_out', billingOrders: 'checkout_orders' },
  fields: {
    users: { username: 'handle', email: 'mail', status: 'enabled' },
    plans: { id: 'tier_id', slug: 'code', name: 'title', description: 'summary', status: 'listed', order: 'position',
      features: 'grant_features', quotas: 'grant_quotas', revision: 'version', createdAt: 'created_at', updatedAt: 'updated_at' },
    planPrices: { planId: 'tier_id' },
    planPriceRefs: { priceId: 'price_id' },
    subscriptions: { userId: 'member_id', planId: 'tier_id', billingCycle: 'cycle' },
    subscriptionPayments: { userId: 'member_id', planId: 'tier_id', billingCycle: 'cycle' },
    quotaUsage: { subjectId: 'member_id', counter: 'quota_type', limit: 'cap', used: 'consumed' },
    quotaReservations: { subjectId: 'member_id', counter: 'quota_type', status: 'state' },
    billingOutbox: { aggregateId: 'aggregate_id' },
    billingOrders: { createdAt: 'created_at' },
  },
  locks: advisoryLocks(),
  // Keeps a legacy NOT NULL price column in step with the monthly price.
  planRowExtras: (write, mode) => {
    const month = write.prices?.find(price => price.interval === 'month');
    return month ? { legacy_price: month.amount } : mode === 'create' ? { legacy_price: '0' } : {};
  },
};

run('subscriptions host on a differently named PostgreSQL schema', () => {
  const schema = `zf_subscriptions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: PgPoolLike & { end(): Promise<void> };
  let pool: PgPoolLike & { end(): Promise<void> };
  let db: PgTestAdapter;
  let service: SubscriptionsService;
  const options = resolveSubscriptionsOptions({ catalog, ...mapping });
  const user = async (handle: string, enabled = true) =>
    (await pool.query('INSERT INTO acct_members (handle, mail, enabled) VALUES ($1, $2, $3) RETURNING id', [handle, `${handle}@example.invalid`, enabled])).rows[0].id as string;
  const pro = { slug: 'pro', name: 'Pro', status: true, order: 1, features: { projects: true, adFree: true }, quotas: { projects_per_month: 1, exports_per_day: -1 },
    prices: [{ interval: 'month', currency: 'USD', amount: '19.9', providerRefs: { stripe: 'price_ProMonthly' } },
      { interval: 'one_time', currency: 'USD', amount: '30', termDays: 30, providerRefs: { paypal: 'synthetic-pro-pass' } }] };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    admin = new Pool({ connectionString: url.href, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, max: 6, options: `-c search_path=${schema}` });
    await pool.query(SCHEMA_SQL);
    db = new PgTestAdapter(pool);
    service = new SubscriptionsService(db, options, () => resolveSubscriptionsSettings({}));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it('writes plans with prices, revisions and legacy columns through the field map', async () => {
    const created = await service.plans.create(pro);
    expect(created).toMatchObject({ slug: 'pro', revision: 0, prices: [
      { interval: 'month', amount: '19.90', providerRefs: { stripe: 'price_ProMonthly' } },
      { interval: 'one_time', termDays: 30, providerRefs: { paypal: 'synthetic-pro-pass' } }] });
    expect(created).not.toHaveProperty('legacy_price');
    expect((await pool.query('SELECT legacy_price::text AS p, code FROM catalog_tiers')).rows).toEqual([{ p: '19.90', code: 'pro' }]);
    await expect(service.plans.create(pro)).rejects.toMatchObject({ reason: 'conflict' });
    await expect(service.plans.create({ ...pro, slug: 'pro-2', prices: [pro.prices[0]] })).rejects.toMatchObject({ reason: 'conflict' });
    const updated = await service.plans.update(created.id, { name: 'Pro plan', expectedRevision: 0,
      prices: [{ ...pro.prices[0], amount: '21' }, pro.prices[1]] });
    expect(updated).toMatchObject({ name: 'Pro plan', revision: 1, prices: [{ amount: '21.00' }, { amount: '30.00' }] });
    expect((await pool.query('SELECT legacy_price::text AS p FROM catalog_tiers')).rows[0].p).toBe('21.00');
    await expect(service.plans.update(created.id, { name: 'Lost', expectedRevision: 0 })).rejects.toMatchObject({ reason: 'conflict' });
    // Concurrent editors with the same revision: exactly one wins.
    const races = await Promise.allSettled([1, 2].map(n => service.plans.update(created.id, { name: `Race ${n}`, expectedRevision: 1 })));
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await service.plans.list({ listedOnly: true })).map(plan => plan.slug)).toEqual(['pro']);
  });

  it('assigns, lists and cancels terms on enum status and cycle columns', async () => {
    const member = await user('member'), disabled = await user('disabled', false);
    const detail = await service.assign(member, { planSlug: 'pro', billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor');
    expect(detail).toMatchObject({ userId: member, status: 'ACTIVE', billingCycle: 'MONTHLY', active: true,
      user: { username: 'member', email: 'member@example.invalid' }, plan: { slug: 'pro' }, features: { projects: true, adFree: true } });
    expect((await pool.query('SELECT status::text, cycle::text FROM member_terms WHERE member_id=$1', [member])).rows[0])
      .toEqual({ status: 'ACTIVE', cycle: 'MONTHLY' });
    await expect(service.assign(disabled, { planSlug: 'pro', billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor')).rejects.toBeTruthy();
    const page = { page: 1, pageSize: 10 };
    expect((await service.list({ ...page, planSlug: 'pro', activity: 'active' })).data.map(row => row.userId)).toEqual([member]);
    expect((await service.list({ ...page, activity: 'inactive' })).total).toBe(0);
    expect((await service.list({ ...page, planSlug: 'missing' })).total).toBe(0);
    await expect(service.plans.delete((await service.plans.findBySlug('pro'))!.id)).rejects.toMatchObject({ reason: 'referenced' });
    expect(await service.cancel(member, 'actor')).toMatchObject({ status: 'CANCELED' });
    expect(service.catalog().features[1]).toEqual({ key: 'exports', label: 'exports', labelKey: 'entitlements.feature.exports',
      description: '', category: 'metered', counter: 'exports_per_day' });
  });

  it('charges metered features once per resource on userId/quotaType counters with enum holds', async () => {
    const member = await user('meter');
    await service.assign(member, { planSlug: 'pro', billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor');
    const first = await service.chargeResource(member, 'projects', { type: 'project', id: 'p1' }, async charge => charge.free);
    const again = await service.chargeResource(member, 'projects', { type: 'project', id: 'p1' }, async charge => charge.free);
    expect([first, again]).toEqual([false, true]);
    await expect(service.chargeResource(member, 'projects', { type: 'project', id: 'p2' }, async () => 'x')).rejects.toBeInstanceOf(ConflictException);
    const usage = (await pool.query('SELECT quota_type, cap, consumed FROM usage_counters WHERE member_id=$1', [member])).rows;
    expect(usage).toEqual([{ quota_type: 'projects_per_month', cap: 1, consumed: 1 }]);
    expect((await pool.query("SELECT state::text FROM usage_holds WHERE member_id=$1 ORDER BY \"createdAt\"", [member])).rows.map(row => row.state))
      .toEqual(['CONFIRMED']); // an exhausted counter refuses before any hold is written
    const me = await service.me(member);
    expect(me.quotas.projects_per_month).toMatchObject({ limit: 1, used: 1, reserved: 0, remaining: 0 });
    // Not in the plan: refused before any hold.
    await expect(service.chargeResource(member, 'exports', { type: 'export', id: 'e1' }, async () => 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records unlimited counters and expires stale holds through the lookup', async () => {
    const member = await user('unlimited');
    const plan = await service.plans.create({ slug: 'max', name: 'Max', status: true, order: 2, features: { projects: true, exports: true },
      quotas: { projects_per_month: 1, exports_per_day: -1 }, prices: [{ interval: 'month', currency: 'USD', amount: '0', providerRefs: {} }] });
    await service.assign(member, { planSlug: plan.slug, billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor');
    for (const id of ['e1', 'e2', 'e3']) await service.chargeResource(member, 'exports', { type: 'export', id }, async () => undefined);
    expect((await pool.query("SELECT cap, consumed FROM usage_counters WHERE member_id=$1 AND quota_type='exports_per_day'", [member])).rows)
      .toEqual([{ cap: -1, consumed: 3 }]);
    // A failed work releases its hold and frees the resource key, so a retry is charged.
    await expect(service.chargeResource(member, 'exports', { type: 'export', id: 'e4' }, async () => { throw new Error('work failed'); }))
      .rejects.toThrow('work failed');
    expect(await service.chargeResource(member, 'exports', { type: 'export', id: 'e4' }, async charge => charge.free)).toBe(false);
    expect((await pool.query(`SELECT state::text FROM usage_holds WHERE member_id=$1 AND "resourceId"='e4' ORDER BY "createdAt"`, [member])).rows
      .map(row => row.state)).toEqual(['RELEASED', 'CONFIRMED']);
    const store = createQuotaReservationStore(db, options.storage);
    const lookup = createResourceChargeLookup(options.storage);
    const now = new Date();
    await pool.query(`INSERT INTO usage_holds (id, member_id, quota_type, period, amount, "limit", "resourceType", "resourceId", state, "expiresAt", "activeResourceKey")
      VALUES ('stale-1', $1, 'projects_per_month', 'x', 1, 1, 'project', 'old', 'RESERVED', $2, 'k')`, [member, new Date(now.getTime() - 1000)]);
    await pool.query(`UPDATE usage_holds SET "activeResourceKey"=$1 WHERE id='stale-1'`,
      [(await import('./quota.store')).activeResourceKey({ subjectId: member, counter: 'projects_per_month', resourceType: 'project', resourceId: 'old' })]);
    const identity = { subjectId: member, counter: 'projects_per_month', resourceType: 'project', resourceId: 'old', now };
    expect(await store.transaction(tx => lookup.findActiveCharge(tx, identity))).toBeNull();
    expect(await store.transaction(tx => lookup.expireStale(tx, identity))).toBe(1);
    expect((await pool.query("SELECT state::text, \"activeResourceKey\" FROM usage_holds WHERE id='stale-1'")).rows[0]).toEqual({ state: 'EXPIRED', activeResourceKey: null });
    // Administrator release goes through the reservation state machine.
    await pool.query(`INSERT INTO usage_holds (id, member_id, quota_type, period, amount, "limit", "resourceType", "resourceId", state, "expiresAt")
      VALUES ('live-1', $1, 'projects_per_month', 'x', 1, 1, 'project', 'live', 'RESERVED', $2)`, [member, new Date(now.getTime() + 60_000)]);
    expect(await service.reservations.release('live-1', 'admin')).toBe(true);
    expect(await service.reservations.release('live-1', 'admin')).toBe(false);
  });

  it('writes paid plan terms back once per payment reference with outbox events', async () => {
    const buyer = await user('buyer');
    const plan = (await service.plans.findBySlug('pro'))!;
    const resolved = (await service.plans.resolveOffer(planOfferId(plan.id, 'one_time', 'USD'), 'paypal'))!;
    expect(resolved.snapshot).toMatchObject({ planId: plan.id, interval: 'one_time', providerRef: 'synthetic-pro-pass' });
    const hooks = createPlanFulfillmentHooks(db, options.storage);
    const order = { id: 'order-1', ownerId: buyer, createdAt: new Date(), fulfilledAt: new Date(),
      offer: { mode: 'payment', fulfillmentData: { plan: resolved.snapshot } } } as unknown as Parameters<typeof hooks.checkoutFulfilled>[1];
    await db.$transaction(tx => hooks.checkoutFulfilled(tx, order));
    await db.$transaction(tx => hooks.checkoutFulfilled(tx, order));
    expect((await pool.query('SELECT cycle::text, reference FROM term_payments WHERE member_id=$1', [buyer])).rows).toEqual([{ cycle: 'ONE_TIME', reference: 'order:order-1' }]);
    expect(await service.detail(buyer)).toMatchObject({ source: 'payment', billingCycle: 'ONE_TIME', active: true });
    const events = (await pool.query('SELECT kind FROM billing_events_out WHERE aggregate_id=$1', ['order:order-1'])).rows.map(row => row.kind);
    expect(events).toContain(PLAN_TERM_CHANGED_OUTBOX_KIND);
    expect(events).not.toContain(PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND);
    // Renewal cycles look up the purchase time on the mapped orders table.
    await pool.query('INSERT INTO checkout_orders (id) VALUES ($1)', ['order-2']);
    const monthly = (await service.plans.resolveOffer(planOfferId(plan.id, 'month', 'USD'), 'stripe'))!;
    const paidAt = new Date();
    await db.$transaction(tx => hooks.cycleFulfilled(tx, { ownerId: buyer, subscription: { initialOrderId: 'order-2', offer: { fulfillmentData: { plan: monthly.snapshot } } },
      receipt: { id: 'cycle-1', periodStart: paidAt, periodEnd: new Date(paidAt.getTime() + 30 * 86_400_000), paidAt, initial: true } }));
    expect((await pool.query('SELECT count(*)::int AS n FROM term_payments WHERE reference=$1', ['cycle:cycle-1'])).rows[0].n).toBe(1);
  });

  it('seeds missing plans from offers without touching existing slugs', async () => {
    const seeds = planSeedsFromOffers([
      { id: 'pro', mode: 'subscription', title: 'Pro again', currency: 'USD', amount: '1', providers: {} },
      { id: 'starter', mode: 'subscription', title: 'Starter', currency: 'USD', amount: '5', providers: { stripe: 'price_Starter', paypal: null } },
      { id: 'pack', mode: 'payment', title: 'Pack', currency: 'USD', amount: '5', providers: {} },
    ]);
    const skipped: string[] = [];
    const created = await db.$transaction(tx => seedPlans(tx, [...seeds, { ...seeds[0], slug: 'Bad Slug' }],
      { catalog, storage: options.storage, onSkip: slug => skipped.push(slug) }));
    expect(created).toBe(1);
    expect(skipped).toEqual(['Bad Slug']);
    expect((await service.plans.findBySlug('pro'))?.name).not.toBe('Pro again');
    expect(await service.plans.findBySlug('starter')).toMatchObject({ prices: [{ amount: '5.00', providerRefs: { stripe: 'price_Starter' } }] });
  });

  it('applies a product reservation policy: charge-once types, kept keys, legacy types, rows and periods', async () => {
    const legacyOptions = resolveSubscriptionsOptions({ catalog, ...mapping, quota: {
      chargeOnce: identity => identity.resourceType === 'project',
      clearKeyOnFinish: false,
      legacyResourceTypes: { project: ['dossier'] },
      insertExtras: input => ({ metadata: { period: input.period, quotaLimit: input.limit } }),
      transitionExtras: input => (input.to === 'CONFIRMED' ? {} : { releasedAt: input.at }),
      legacyPolicy: async (_tx, row) => ({ period: 'legacy-period', limit: Number((row.metadata as { quotaLimit?: number } | null)?.quotaLimit ?? 5) }),
    } });
    const legacy = new SubscriptionsService(db, legacyOptions, () => resolveSubscriptionsSettings({}));
    const member = await user('policy');
    const plan = await legacy.plans.create({ slug: 'policy', name: 'Policy', status: true, order: 3, features: { projects: true, exports: true },
      quotas: { projects_per_month: 5, exports_per_day: 5 }, prices: [{ interval: 'month', currency: 'USD', amount: '0', providerRefs: {} }] });
    await legacy.assign(member, { planSlug: plan.slug, billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor');
    // A historical 'dossier' charge (another counter, no key) already paid for project p9.
    await pool.query(`INSERT INTO usage_holds (id, member_id, quota_type, amount, "resourceType", "resourceId", state, "expiresAt")
      VALUES ('legacy-dossier', $1, 'documents_per_month', 1, 'dossier', 'p9', 'CONFIRMED', now())`, [member]);
    expect(await legacy.chargeResource(member, 'projects', { type: 'project', id: 'p9' }, async charge => charge.free)).toBe(true);
    // A failed project charge keeps its key as history; the partial index still admits the retry.
    await expect(legacy.chargeResource(member, 'projects', { type: 'project', id: 'p10' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await legacy.chargeResource(member, 'projects', { type: 'project', id: 'p10' }, async charge => charge.free)).toBe(false);
    const p10 = (await pool.query(`SELECT state::text, "activeResourceKey" IS NOT NULL AS keyed, metadata, "releasedAt" IS NOT NULL AS released
      FROM usage_holds WHERE "resourceId"='p10' ORDER BY "createdAt"`)).rows;
    expect(p10).toEqual([{ state: 'RELEASED', keyed: true, metadata: { period: expect.any(String), quotaLimit: 5 }, released: true },
      { state: 'CONFIRMED', keyed: true, metadata: { period: expect.any(String), quotaLimit: 5 }, released: false }]);
    // Per-use rows are never keyed.
    await legacy.chargeResource(member, 'exports', { type: 'export', id: 'x1' }, async () => undefined);
    expect((await pool.query(`SELECT "activeResourceKey" FROM usage_holds WHERE "resourceId"='x1'`)).rows).toEqual([{ activeResourceKey: null }]);
    // A row stored before policy capture is charged with the product's legacy policy.
    await pool.query(`INSERT INTO usage_holds (id, member_id, quota_type, amount, "resourceType", "resourceId", state, "expiresAt", metadata)
      VALUES ('pre-capture', $1, 'projects_per_month', 1, 'project', 'old', 'RESERVED', now() + interval '1 hour', '{"quotaLimit": 7}')`, [member]);
    expect(await legacy.reservations.confirm('pre-capture')).toBe(true);
    expect((await pool.query(`SELECT cap, consumed FROM usage_counters WHERE member_id=$1 AND period='legacy-period'`, [member])).rows)
      .toEqual([{ cap: 7, consumed: 1 }]);
  });

  it('deletes an unreferenced plan with its prices', async () => {
    const plan = await service.plans.create({ ...pro, slug: 'temp', prices: [{ interval: 'month', currency: 'EUR', amount: '1', providerRefs: { stripe: 'price_Temp' } }] });
    await service.plans.delete(plan.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM tier_price_refs WHERE reference='price_Temp'")).rows[0].n).toBe(0);
    expect(await service.plans.findBySlug('temp')).toBeNull();
  });
});
