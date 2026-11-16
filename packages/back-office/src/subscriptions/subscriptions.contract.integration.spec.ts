// @vitest-environment node
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLAN_PAYMENT_APPLICATION_KIND, PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND, PLAN_TERM_CHANGED_OUTBOX_KIND, SubscriptionsService, advisoryLocks, createPlanFulfillmentHooks,
  createSqlBillingLink, planSeedsFromOffers, recordPlanTerm, resolveSubscriptionsOptions, resolveSubscriptionsSettings, seedPlans,
  type BackOfficeSubscriptionsOptions, type PresentedEntitlementCatalog,
} from './index';
import { PgTestAdapter, type PgPoolLike } from './testing/pg-test-adapter';
import { planOfferId } from '@zucker-framework/payment';

/**
 * Concurrency and legacy-shape contract on a ccopyright-like schema: camelCase Prisma model names as
 * tables, `userId`/`quotaType` instead of `subjectId`/`counter`, PostgreSQL enum status columns, a foreign
 * key from subscriptions to plans, a partial unique index on `activeResourceKey`, legacy `dossier` rows
 * and a legacy NOT NULL plan `price`. Needs TEST_DATABASE_URL (an isolated *_test database).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

const SCHEMA_SQL = `
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE','CANCELED','EXPIRED','TRIALING');
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY','YEARLY','LIFETIME','ONE_TIME');
CREATE TYPE "QuotaReservationStatus" AS ENUM ('RESERVED','CONFIRMED','RELEASED','EXPIRED');
CREATE TABLE "user" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, username text NOT NULL UNIQUE, email text, status boolean NOT NULL DEFAULT true);
CREATE TABLE "subscriptionPlan" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, slug text NOT NULL UNIQUE, name text NOT NULL, description text,
  status boolean NOT NULL DEFAULT false, "order" int NOT NULL DEFAULT 0, features jsonb NOT NULL DEFAULT '{}', quotas jsonb NOT NULL DEFAULT '{}',
  revision int NOT NULL DEFAULT 0, featured boolean NOT NULL DEFAULT false, badge text, highlights jsonb NOT NULL DEFAULT '[]',
  "nameI18n" jsonb NOT NULL DEFAULT '{}', "descriptionI18n" jsonb NOT NULL DEFAULT '{}', "badgeI18n" jsonb NOT NULL DEFAULT '{}',
  "highlightsI18n" jsonb NOT NULL DEFAULT '{}', price numeric(10,2) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "subscriptionPlanPrice" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "planId" text NOT NULL REFERENCES "subscriptionPlan"(id),
  "interval" text NOT NULL, currency text NOT NULL, amount text NOT NULL, "termDays" int, credits int NOT NULL DEFAULT 0,
  "creditExpiryPeriod" boolean NOT NULL DEFAULT false, "creditExpiryDays" int,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("planId", "interval", currency));
CREATE TABLE "subscriptionPlanPriceRef" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "priceId" text NOT NULL REFERENCES "subscriptionPlanPrice"(id),
  provider text NOT NULL, reference text NOT NULL, UNIQUE (provider, reference), UNIQUE ("priceId", provider));
CREATE TABLE "userSubscription" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL UNIQUE REFERENCES "user"(id), "planId" text NOT NULL REFERENCES "subscriptionPlan"(id),
  status "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE', "billingCycle" "BillingCycle", "startDate" timestamptz NOT NULL, "endDate" timestamptz,
  "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false, "canceledAt" timestamptz, source text NOT NULL DEFAULT 'admin', "paymentReference" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "userSubscriptionPayment" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, reference text NOT NULL UNIQUE, "userId" text NOT NULL,
  "planId" text NOT NULL REFERENCES "subscriptionPlan"(id), "billingCycle" "BillingCycle" NOT NULL, "periodStart" timestamptz NOT NULL, "periodEnd" timestamptz,
  "orderId" text, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "userQuotaUsage" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL, "quotaType" text NOT NULL, period text NOT NULL,
  "limit" int NOT NULL, used int NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL,
  UNIQUE ("userId", "quotaType", period));
CREATE TABLE "quotaReservation" (id text PRIMARY KEY, "userId" text NOT NULL, "quotaType" text NOT NULL, period text, amount int NOT NULL, "limit" int,
  "policyVersion" text NOT NULL DEFAULT 'legacy', "resourceType" text, "resourceId" text, status "QuotaReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "finishedAt" timestamptz, reason text, "activeResourceKey" text, metadata jsonb, "releasedAt" timestamptz);
CREATE UNIQUE INDEX "quotaReservation_live_key" ON "quotaReservation" ("activeResourceKey") WHERE status IN ('RESERVED','CONFIRMED');
CREATE TABLE "billingOutbox" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, kind text NOT NULL, "aggregateId" text NOT NULL, payload jsonb NOT NULL,
  UNIQUE (kind, "aggregateId"));
CREATE TABLE "billingOrders" (id text PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT now());
-- Framework billing schema read by createSqlBillingLink.
CREATE TABLE billing_orders (id text PRIMARY KEY, "ownerId" text NOT NULL, offer jsonb NOT NULL, state text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "fulfilledAt" timestamptz);
CREATE TABLE billing_subscriptions (id text PRIMARY KEY, "ownerId" text NOT NULL, offer jsonb NOT NULL, status text NOT NULL, "currentPeriodEnd" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
`;

const catalog = {
  features: [
    { key: 'projects', category: 'metered', counter: 'projects_per_month' },
    { key: 'exports', category: 'metered', counter: 'exports_per_day' },
  ],
  counters: [{ key: 'projects_per_month', period: 'month' }, { key: 'exports_per_day', period: 'day' }],
} as const satisfies PresentedEntitlementCatalog;

/** The ccopyright mapping (C2.3): Prisma-style model names, userId/quotaType, a legacy price column. */
const mapping: Omit<BackOfficeSubscriptionsOptions, 'catalog'> = {
  models: { users: 'user', plans: 'subscriptionPlan', planPrices: 'subscriptionPlanPrice', planPriceRefs: 'subscriptionPlanPriceRef',
    subscriptions: 'userSubscription', subscriptionPayments: 'userSubscriptionPayment', quotaUsage: 'userQuotaUsage',
    quotaReservations: 'quotaReservation', billingOutbox: 'billingOutbox', billingOrders: 'billingOrders' },
  fields: {
    quotaUsage: { subjectId: 'userId', counter: 'quotaType' },
    quotaReservations: { subjectId: 'userId', counter: 'quotaType' },
  },
  locks: advisoryLocks(),
  billingLink: createSqlBillingLink(),
  planRowExtras: (write, mode) => {
    const month = write.prices?.find(price => price.interval === 'month');
    return month ? { price: month.amount } : mode === 'create' ? { price: '0' } : {};
  },
  quota: {
    chargeOnce: identity => identity.resourceType === 'project',
    clearKeyOnFinish: false,
    legacyResourceTypes: { project: ['dossier'] },
  },
};

run('subscriptions host concurrency on a ccopyright-shaped PostgreSQL schema', () => {
  const schema = `zf_subs_contract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: Pool;
  let pool: Pool;
  let db: PgTestAdapter;
  let service: SubscriptionsService;
  const options = resolveSubscriptionsOptions({ catalog, ...mapping });
  const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
  const user = async (name: string) =>
    (await q('INSERT INTO "user" (username, email) VALUES ($1, $2) RETURNING id', [name, `${name}@example.invalid`])).rows[0].id as string;
  const prices = [
    { interval: 'month', currency: 'USD', amount: '9', providerRefs: { stripe: 'price_synthetic_month' } },
    { interval: 'one_time', currency: 'USD', amount: '15', termDays: 30, providerRefs: { paypal: 'synthetic-pass' } },
  ];
  const makePlan = (slug: string, quotas: Record<string, number> = { projects_per_month: 3, exports_per_day: -1 }) =>
    service.plans.create({ slug, name: slug, status: true, order: 1, features: { projects: true, exports: true }, quotas,
      prices: prices.map(price => ({ ...price, providerRefs: price.interval === 'month'
        ? { stripe: `price_${slug.replace(/[^A-Za-z0-9]/g, '')}` } : { paypal: `synthetic-${slug}` } })) });
  const assign = (userId: string, slug: string) => service.assign(userId, { planSlug: slug, billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor');

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    admin = new Pool({ connectionString: url.href, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, max: 12, options: `-c search_path=${schema}` });
    await pool.query(SCHEMA_SQL);
    db = new PgTestAdapter(pool as unknown as PgPoolLike);
    service = new SubscriptionsService(db, options, () => resolveSubscriptionsSettings({}));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it('charges a resource once when eight requests race for it', async () => {
    await makePlan('racer');
    const member = await user('racer');
    await assign(member, 'racer');
    let worked = 0;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      service.chargeResource(member, 'projects', { type: 'project', id: 'shared' }, async charge => { worked++; return charge.free; })));
    // Never two live charges: the partial unique index and the quota lock admit one.
    const live = (await q(`SELECT count(*)::int AS n FROM "quotaReservation" WHERE "userId"=$1 AND "resourceId"='shared' AND status IN ('RESERVED','CONFIRMED')`, [member])).rows[0].n;
    expect(live).toBe(1);
    expect((await q('SELECT used FROM "userQuotaUsage" WHERE "userId"=$1', [member])).rows).toEqual([{ used: 1 }]);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException); // in_progress, retry later
    }
    // Exactly one request paid; the rest were free (already charged) or told to retry.
    expect(results.filter(result => result.status === 'fulfilled' && result.value === false)).toHaveLength(1);
    expect(worked).toBe(results.filter(result => result.status === 'fulfilled').length);
    // After everything settled, the resource is charged and further work is free.
    expect(await service.chargeResource(member, 'projects', { type: 'project', id: 'shared' }, async charge => charge.free)).toBe(true);
    expect((await q('SELECT used FROM "userQuotaUsage" WHERE "userId"=$1', [member])).rows).toEqual([{ used: 1 }]);
  });

  it('never exceeds the plan limit under concurrent charges for different resources', async () => {
    await makePlan('limited', { projects_per_month: 3, exports_per_day: -1 });
    const member = await user('limited');
    await assign(member, 'limited');
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
      service.chargeResource(member, 'projects', { type: 'project', id: `p${index}` }, async () => index)));
    const ok = results.filter(result => result.status === 'fulfilled');
    expect(ok).toHaveLength(3);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException);
    expect((await q('SELECT used, "limit" FROM "userQuotaUsage" WHERE "userId"=$1', [member])).rows).toEqual([{ used: 3, limit: 3 }]);
    expect((await q(`SELECT count(*)::int AS n FROM "quotaReservation" WHERE "userId"=$1 AND status='CONFIRMED'`, [member])).rows[0].n).toBe(3);
    // No reservation is left holding capacity.
    expect((await q(`SELECT count(*)::int AS n FROM "quotaReservation" WHERE "userId"=$1 AND status='RESERVED'`, [member])).rows[0].n).toBe(0);
  });

  it('counts a resource already paid under the legacy dossier type as free, concurrently too', async () => {
    const member = await user('legacy');
    await assign(member, 'limited');
    await q(`INSERT INTO "quotaReservation" (id, "userId", "quotaType", amount, "resourceType", "resourceId", status, "expiresAt")
      VALUES ('legacy-1', $1, 'documents_per_month', 1, 'dossier', 'old', 'CONFIRMED', now())`, [member]);
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      service.chargeResource(member, 'projects', { type: 'project', id: 'old' }, async charge => charge.free)));
    expect(results).toEqual([true, true, true, true]);
    expect((await q('SELECT count(*)::int AS n FROM "userQuotaUsage" WHERE "userId"=$1', [member])).rows[0].n).toBe(0);
  });

  it('serialises a plan delete against a concurrent assignment: no subscription ever points at a deleted plan', async () => {
    let deleted = 0;
    let assigned = 0;
    for (let round = 0; round < 12; round++) {
      const slug = `doomed-${round}`;
      const plan = await makePlan(slug);
      const member = await user(`doomed-${round}`);
      const [removal, assignment] = await Promise.allSettled([service.plans.delete(plan.id), assign(member, slug)]);
      const dangling = (await q(`SELECT count(*)::int AS n FROM "userSubscription" s LEFT JOIN "subscriptionPlan" p ON p.id = s."planId" WHERE p.id IS NULL`)).rows[0].n;
      expect(dangling).toBe(0);
      const planLeft = (await q('SELECT count(*)::int AS n FROM "subscriptionPlan" WHERE id=$1', [plan.id])).rows[0].n;
      const subscribed = (await q('SELECT count(*)::int AS n FROM "userSubscription" WHERE "userId"=$1', [member])).rows[0].n;
      if (removal.status === 'fulfilled') {
        deleted++;
        expect(planLeft).toBe(0);
        // The assignment lost: it was refused, never half-applied.
        expect(assignment.status).toBe('rejected');
        expect(subscribed).toBe(0);
      } else {
        // The assignment won: the delete is refused as referenced and the plan stays.
        assigned++;
        expect(removal.status).toBe('rejected');
        expect((removal as PromiseRejectedResult).reason).toMatchObject({ reason: 'referenced' });
        expect(planLeft).toBe(1);
        expect(subscribed).toBe(1);
        expect(assignment.status).toBe('fulfilled');
      }
    }
    expect(deleted + assigned).toBe(12);
  });

  // Without a database foreign key (ccopyright has no relations) only the host's plan lock orders an assignment
  // that already read the plan against a concurrent delete.
  it('plan delete interleaved after an assignment read the plan (no foreign key, as in ccopyright): never leaves a dangling term', async () => {
    // ccopyright has no database relations, so only the host's own ordering can protect the term.
    await q('ALTER TABLE "userSubscription" DROP CONSTRAINT "userSubscription_planId_fkey"');
    try {
      const plan = await makePlan('interleaved');
      const member = await user('interleaved');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let planRead!: () => void;
      const read = new Promise<void>(resolve => { planRead = resolve; });
      // The assignment pauses right after it read the plan; the delete then runs to completion.
      const pausing = new Proxy(db, { get: (target, prop, receiver) => {
        if (prop === '$transaction') return (work: (tx: PgTestAdapter) => Promise<unknown>) => target.$transaction(async tx => work(new Proxy(tx as PgTestAdapter, { get: (inner, key) => {
          if (key !== 'model') return Reflect.get(inner, key).bind?.(inner) ?? Reflect.get(inner, key);
          return (name: string) => {
            const ops = inner.model(name);
            if (name !== 'subscriptionPlan') return ops;
            return { ...ops, findUnique: async (args: never) => { const row = await ops.findUnique(args); planRead(); await gate; return row; } };
          };
        } })));
        return Reflect.get(target, prop, receiver);
      } }) as PgTestAdapter;
      const slow = new SubscriptionsService(pausing, options, () => resolveSubscriptionsSettings({}));
      const assignment = slow.assign(member, { planSlug: 'interleaved', billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor').then(() => 'assigned', () => 'refused');
      await read;
      const removal = Promise.race([service.plans.delete(plan.id).then(() => 'deleted', () => 'refused'), new Promise(resolve => setTimeout(() => resolve('waiting'), 300))]);
      const removed = await removal;
      release();
      const assigned = await assignment;
      const settled = removed === 'waiting' ? await service.plans.delete(plan.id).then(() => 'deleted', () => 'refused') : removed;
      const dangling = (await q(`SELECT count(*)::int AS n FROM "userSubscription" s LEFT JOIN "subscriptionPlan" p ON p.id = s."planId" WHERE p.id IS NULL`)).rows[0].n;
      expect({ assigned, settled, dangling }).toMatchObject({ dangling: 0 });
    } finally {
      await q('DELETE FROM "userSubscription" WHERE "planId" NOT IN (SELECT id FROM "subscriptionPlan")');
      await q('ALTER TABLE "userSubscription" ADD CONSTRAINT "userSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscriptionPlan"(id)');
    }
  });

  it('blocks administrator changes while a recent plan checkout is unsettled, and the plan cannot be deleted', async () => {
    const plan = await makePlan('pending-plan');
    const buyer = await user('pending-buyer');
    const snapshot = { planId: plan.id, interval: 'month' };
    await q(`INSERT INTO billing_orders (id, "ownerId", offer, state, "createdAt") VALUES ('o-fresh', $1, $2::jsonb, 'pending', now())`,
      [buyer, JSON.stringify({ fulfillmentData: { plan: snapshot } })]);
    await expect(assign(buyer, 'pending-plan')).rejects.toMatchObject({ reason: 'pending_payment' });
    expect((await q('SELECT count(*)::int AS n FROM "userSubscription" WHERE "userId"=$1', [buyer])).rows[0].n).toBe(0);
    await expect(service.plans.delete(plan.id)).rejects.toMatchObject({ reason: 'referenced' });
    // A stale pending checkout (older than the 24h block) no longer decides the term.
    await q(`UPDATE billing_orders SET "createdAt" = now() - interval '25 hours' WHERE id='o-fresh'`);
    expect(await assign(buyer, 'pending-plan')).toMatchObject({ userId: buyer, active: true });
    // A credit-only order (no plan snapshot) never blocks.
    const other = await user('credit-only');
    await q(`INSERT INTO billing_orders (id, "ownerId", offer, state) VALUES ('o-credit', $1, '{"fulfillmentData":{}}'::jsonb, 'pending')`, [other]);
    expect(await assign(other, 'pending-plan')).toMatchObject({ userId: other });
    // An active provider subscription for the plan blocks as well.
    const subscriber = await user('provider-sub');
    await q(`INSERT INTO billing_subscriptions (id, "ownerId", offer, status) VALUES ('s-live', $1, $2::jsonb, 'active')`,
      [subscriber, JSON.stringify({ fulfillmentData: { plan: snapshot } })]);
    await expect(assign(subscriber, 'pending-plan')).rejects.toMatchObject({ reason: 'pending_payment' });
    await q(`UPDATE billing_subscriptions SET status='canceled' WHERE id='s-live'`);
    expect(await assign(subscriber, 'pending-plan')).toMatchObject({ userId: subscriber });
  });

  it('applies one payment reference once when evidence is recorded concurrently, with one outbox event per kind', async () => {
    const plan = await makePlan('paid');
    const buyer = await user('paid-buyer');
    const snapshot = (await service.plans.resolveOffer(planOfferId(plan.id, 'one_time', 'USD'), 'paypal'))!.snapshot;
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 86_400_000);
    const attempt = () => db.$transaction(tx => recordPlanTerm(db, options.storage, tx, { userId: buyer, plan: snapshot, periodStart: start, periodEnd: end,
      reference: 'order:race-1', orderId: 'race-1', purchasedAt: start, checkout: true }));
    const results = await Promise.all(Array.from({ length: 6 }, attempt));
    expect((await q(`SELECT count(*)::int AS n FROM "userSubscriptionPayment" WHERE reference='order:race-1'`)).rows[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM "userSubscription" WHERE "userId"=$1`, [buyer])).rows[0].n).toBe(1);
    const kinds = (await q(`SELECT kind FROM "billingOutbox" WHERE "aggregateId"='order:race-1' ORDER BY kind`)).rows.map(row => row.kind);
    expect(kinds).toEqual([PLAN_TERM_CHANGED_OUTBOX_KIND, PLAN_PAYMENT_APPLICATION_KIND]);
    expect(results.filter(result => result.change)).toHaveLength(1);
    expect(kinds).not.toContain(PLAN_PAYMENT_UNAPPLIED_OUTBOX_KIND);
    const row = (await q(`SELECT status::text, "billingCycle"::text AS cycle, "paymentReference" FROM "userSubscription" WHERE "userId"=$1`, [buyer])).rows[0];
    expect(row).toMatchObject({ status: 'ACTIVE', cycle: 'ONE_TIME' });
  });

  it('applies distinct payments of one account concurrently without losing either ledger row', async () => {
    const plan = await makePlan('two-payments');
    const buyer = await user('two-payments');
    const snapshot = (await service.plans.resolveOffer(planOfferId(plan.id, 'one_time', 'USD'), 'paypal'))!.snapshot;
    const hooks = createPlanFulfillmentHooks(db, options.storage);
    const now = new Date();
    const order = (id: string) => ({ id, ownerId: buyer, createdAt: now, fulfilledAt: now,
      offer: { mode: 'payment', fulfillmentData: { plan: snapshot } } }) as unknown as Parameters<typeof hooks.checkoutFulfilled>[1];
    await Promise.all(['a', 'b', 'c'].map(id => db.$transaction(tx => hooks.checkoutFulfilled(tx, order(id)))));
    expect((await q(`SELECT reference FROM "userSubscriptionPayment" WHERE "userId"=$1 ORDER BY reference`, [buyer])).rows.map(row => row.reference))
      .toEqual(['order:a', 'order:b', 'order:c']);
    expect((await q(`SELECT count(*)::int AS n FROM "userSubscription" WHERE "userId"=$1`, [buyer])).rows[0].n).toBe(1);
  });

  it('seeds plans idempotently and reports what it created', async () => {
    const seeds = planSeedsFromOffers([
      { id: 'seed-basic', mode: 'subscription', title: 'Basic', currency: 'USD', amount: '3', providers: { stripe: 'price_seed_basic' } },
      { id: 'seed-pass', mode: 'payment', title: 'Pass', currency: 'USD', amount: '4', providers: {} },
    ]);
    const first = await db.$transaction(tx => seedPlans(tx, seeds, { catalog, storage: options.storage }));
    const second = await db.$transaction(tx => seedPlans(tx, seeds, { catalog, storage: options.storage }));
    const third = await Promise.allSettled([1, 2].map(() => db.$transaction(tx => seedPlans(tx, seeds, { catalog, storage: options.storage }))));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
    for (const result of third) if (result.status === 'fulfilled') expect(result.value).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM "subscriptionPlan" WHERE slug LIKE 'seed-%'`)).rows[0].n).toBe(first);
    // The legacy NOT NULL price column was filled by planRowExtras.
    expect((await q(`SELECT price::text AS p FROM "subscriptionPlan" WHERE slug='seed-basic'`)).rows).toEqual([{ p: '3.00' }]);
  });

  it('keeps enum status and cycle values and the FK-checked plan reference on admin writes', async () => {
    const member = await user('enum-user');
    await assign(member, 'racer');
    expect((await q(`SELECT status::text, "billingCycle"::text AS cycle FROM "userSubscription" WHERE "userId"=$1`, [member])).rows)
      .toEqual([{ status: 'ACTIVE', cycle: 'MONTHLY' }]);
    expect(await service.cancel(member, 'actor')).toMatchObject({ status: 'CANCELED' });
    await expect(service.assign(member, { planSlug: 'does-not-exist', billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor')).rejects.toMatchObject({ reason: 'not_found' });
    expect((await q(`SELECT status::text FROM "userSubscription" WHERE "userId"=$1`, [member])).rows).toEqual([{ status: 'CANCELED' }]);
  });
});
