// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SubscriptionAssignmentService } from '@zucker-framework/payment';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { createUserSubscriptionStore } from './user-subscription.store';
import { createSqlBillingLink } from './billing-link';
import { createPlanFulfillmentHooks, PLAN_TERM_CHANGED_OUTBOX_KIND } from './payment-writeback';
import { advisoryLocks, resolveSubscriptionsStorage, type SqlCapableTransaction } from './storage';
import { createPaymentHistory, PLAN_PAYMENT_APPLICATION_KIND, PLAN_PAYMENT_HISTORY_KINDS, PLAN_PAYMENT_REFUND_KIND } from './payment-history';
import { PgTestAdapter, type PgQueryable } from './testing/pg-test-adapter';
import { transactionalSqlRuntime, type TestSqlConnection, type TestSqlRuntime } from '../testing/transactional-sql-runtime';

/** Defaults to embedded SQL; TEST_DATABASE_URL opts into a real loopback PostgreSQL pool. */
describe('plan payment history PostgreSQL contract', () => {
  let pg: TestSqlRuntime;
  let db: DatabaseAdapter & SqlCapableTransaction;
  const clock = { now: new Date('2026-06-01T00:00:00Z') };
  const storage = resolveSubscriptionsStorage({
    models: { users: 'account', plans: 'plan', subscriptions: 'term', subscriptionPayments: 'evidence', billingOutbox: 'ledger' },
    fields: { billingOutbox: { aggregateId: 'reference_key' } }, locks: advisoryLocks(), billingLink: createSqlBillingLink(),
  });
  const service = () => new SubscriptionAssignmentService(createUserSubscriptionStore(db, storage, { now: () => clock.now, paymentHistory: createPaymentHistory(storage) }), {
    now: () => clock.now, activeTerm: (term, at) => ['ACTIVE', 'CANCELED', 'TRIALING'].includes(term.status)
      && !!term.startDate && term.startDate <= at && (!term.endDate || term.endDate > at),
  });
  const pay = (reference: string) => service().recordPayment({ userId: 'u', planId: 'p', billingCycle: 'ONE_TIME', reference,
    periodStart: clock.now, periodEnd: new Date('2026-07-01T00:00:00Z') });
  beforeAll(async () => {
    pg = await transactionalSqlRuntime('zf_payment_history', process.env.TEST_DATABASE_URL);
    const wrap = (connection: TestSqlConnection): PgQueryable => ({ async query(sql, params) {
      const result = await connection.query<Record<string, unknown>>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    } });
    const adapter = new PgTestAdapter(wrap(pg), true);
    db = { model: adapter.model.bind(adapter), query: adapter.query.bind(adapter),
      $transaction: work => pg.transaction(tx => work(new PgTestAdapter(wrap(tx), true))) };
    await pg.exec(`
      CREATE TABLE account (id text PRIMARY KEY, status boolean NOT NULL);
      CREATE TABLE plan (id text PRIMARY KEY, slug text NOT NULL UNIQUE, status boolean NOT NULL);
      CREATE TABLE term (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "userId" text NOT NULL UNIQUE REFERENCES account(id),
        "planId" text NOT NULL REFERENCES plan(id), status text NOT NULL, "billingCycle" text NOT NULL, "startDate" timestamptz NOT NULL,
        "endDate" timestamptz, "cancelAtPeriodEnd" boolean NOT NULL, "canceledAt" timestamptz, source text NOT NULL, "paymentReference" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE evidence (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, reference text NOT NULL UNIQUE, "userId" text NOT NULL,
        "planId" text NOT NULL REFERENCES plan(id), "billingCycle" text NOT NULL, "periodStart" timestamptz NOT NULL, "periodEnd" timestamptz, "orderId" text);
      CREATE TABLE ledger (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, kind text NOT NULL, reference_key text NOT NULL,
        payload jsonb NOT NULL, UNIQUE(kind,reference_key));
      CREATE TABLE billing_orders (id text PRIMARY KEY, "ownerId" text, offer jsonb, state text, "createdAt" timestamptz);
      CREATE TABLE billing_subscriptions (id text PRIMARY KEY, "ownerId" text, offer jsonb, status text, "currentPeriodEnd" timestamptz, "createdAt" timestamptz);
      INSERT INTO account VALUES ('u',true); INSERT INTO plan VALUES ('p','pro',true);`);
  });
  beforeEach(async () => {
    clock.now = new Date('2026-06-01T00:00:00Z');
    await pg.exec('TRUNCATE term,evidence,ledger,billing_orders,billing_subscriptions');
  });
  afterAll(async () => { await pg?.close(); });

  it.each([['a', 'b'], ['b', 'a']])('persists ancestry and refunds in order %s,%s across service restart', async (first, second) => {
    await pay('a'); await pay('b');
    const shortened = await service().revokePayment({ userId: 'u', reference: first });
    expect(shortened.subscription).toMatchObject({ paymentReference: second, endDate: new Date('2026-07-01T00:00:00Z') });
    expect((await service().revokePayment({ userId: 'u', reference: first })).change).toBeNull();
    expect((await service().revokePayment({ userId: 'u', reference: second })).subscription?.status).toBe('EXPIRED');
    expect((await pg.query('SELECT kind, count(*)::int AS n FROM ledger GROUP BY kind ORDER BY kind')).rows)
      .toEqual([{ kind: PLAN_PAYMENT_APPLICATION_KIND, n: 2 }, { kind: PLAN_PAYMENT_REFUND_KIND, n: 2 }]);
  });

  it('serialises simultaneous refunds of stacked payments without retaining refunded entitlement', async () => {
    await pay('a'); await pay('b');
    await Promise.all(['a', 'b'].map(reference => service().revokePayment({ userId: 'u', reference })));
    expect((await pg.query('SELECT status FROM term')).rows).toEqual([{ status: 'EXPIRED' }]);
    expect((await pg.query('SELECT reference_key FROM ledger WHERE kind=$1 ORDER BY reference_key', [PLAN_PAYMENT_REFUND_KIND])).rows)
      .toEqual([{ reference_key: 'a' }, { reference_key: 'b' }]);
    expect((await service().revokePayment({ userId: 'u', reference: 'a' })).change).toBeNull();
  });

  it('persists full checkout/refund hooks and emits each refund event once in the caller transaction', async () => {
    const hooks = createPlanFulfillmentHooks(db, storage);
    const start = new Date();
    const plan = { planId: 'p', slug: 'pro', revision: 0, interval: 'one_time', currency: 'USD', amount: '10.00',
      termDays: 30, providerId: 'synthetic', providerRef: 'price', credits: 0, creditExpiry: null };
    for (const id of ['a', 'b']) {
      const order: Parameters<typeof hooks.checkoutFulfilled>[1] = { id, ownerId: 'u', createdAt: start, fulfilledAt: start,
        offer: { mode: 'payment', version: '1', catalogReference: 'synthetic', money: { amount: '10.00', currency: 'USD' }, description: 'Synthetic plan', fulfillmentData: { plan } } };
      await db.$transaction(tx => hooks.checkoutFulfilled(tx, order));
    }
    const refund = (reference: string) => db.$transaction(tx => hooks.paymentRefunded!(tx, { ownerId: 'u', reference, fulfillmentData: { plan } }));
    await refund('order:b'); await refund('order:b'); await refund('order:a');
    expect((await pg.query('SELECT status FROM term')).rows).toEqual([{ status: 'EXPIRED' }]);
    expect((await pg.query('SELECT reference_key FROM ledger WHERE kind=$1 AND reference_key LIKE $2 ORDER BY reference_key',
      [PLAN_TERM_CHANGED_OUTBOX_KIND, 'refund:%'])).rows).toEqual([{ reference_key: 'refund:order:a' }, { reference_key: 'refund:order:b' }]);
  });

  it('keeps a legacy direct payment writer independent of an outbox model', async () => {
    // CC Phase 2 uses the default store directly in its own billing transaction; no billingOutbox
    // alias/table exists until Phase 3. The optional history port must not be resolved eagerly.
    const legacy = resolveSubscriptionsStorage({ models: { users: 'account', plans: 'plan', subscriptions: 'term',
      subscriptionPayments: 'evidence', billingOutbox: 'absent_outbox' }, locks: advisoryLocks() });
    await db.$transaction(async tx => {
      const writer = new SubscriptionAssignmentService(createUserSubscriptionStore(db, legacy, { transaction: tx }), {
        now: () => clock.now, activeTerm: () => false,
      });
      expect((await writer.recordPayment({ userId: 'u', planId: 'p', billingCycle: 'MONTHLY', reference: 'legacy-cycle',
        periodStart: clock.now, periodEnd: new Date('2026-07-01T00:00:00Z') })).outcome).toBe('applied');
      expect((await writer.recordPayment({ userId: 'u', planId: 'p', billingCycle: 'MONTHLY', reference: 'legacy-cycle',
        periodStart: clock.now, periodEnd: new Date('2026-07-01T00:00:00Z') })).outcome).toBe('replayed');
    });
    expect((await pg.query('SELECT count(*)::int AS n FROM evidence')).rows).toEqual([{ n: 1 }]);
    expect((await pg.query('SELECT count(*)::int AS n FROM ledger')).rows).toEqual([{ n: 0 }]);
  });

  it('rolls evidence, application and term back together when fulfillment fails', async () => {
    await expect(db.$transaction(async tx => {
      const bound = new SubscriptionAssignmentService(createUserSubscriptionStore(db, storage, { transaction: tx, paymentHistory: createPaymentHistory(storage) }), {
        now: () => clock.now, activeTerm: () => false,
      });
      await bound.recordPayment({ userId: 'u', planId: 'p', billingCycle: 'ONE_TIME', reference: 'a', periodStart: clock.now,
        periodEnd: new Date('2026-07-01T00:00:00Z') });
      throw new Error('fulfillment failed');
    })).rejects.toThrow('fulfillment failed');
    for (const table of ['evidence', 'ledger', 'term']) expect((await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    expect((await pay('a')).outcome).toBe('applied');
  });

  it('fails closed and rolls back the refund marker for legacy missing history, then accepts an audited repair', async () => {
    await pay('a'); await pay('b');
    const snapshot = (await pg.query<{ payload: unknown }>('DELETE FROM ledger WHERE kind=$1 AND reference_key=$2 RETURNING payload',
      [PLAN_PAYMENT_APPLICATION_KIND, 'a'])).rows[0].payload;
    await expect(service().revokePayment({ userId: 'u', reference: 'b' })).rejects.toMatchObject({ reason: 'unavailable' });
    expect((await pg.query('SELECT count(*)::int AS n FROM ledger WHERE kind=$1', [PLAN_PAYMENT_REFUND_KIND])).rows).toEqual([{ n: 0 }]);
    expect((await pg.query('SELECT "endDate" FROM term')).rows).toEqual([{ endDate: new Date('2026-07-31T00:00:00Z') }]);
    await pg.query('INSERT INTO ledger(kind,reference_key,payload) VALUES ($1,$2,$3)', [PLAN_PAYMENT_APPLICATION_KIND, 'a', JSON.stringify(snapshot)]);
    expect((await service().revokePayment({ userId: 'u', reference: 'b' })).subscription?.paymentReference).toBe('a');
  });

  it('keeps ledger history when delivery events are cleaned and still handles a later refund', async () => {
    await pay('a'); await pay('b');
    await pg.query("INSERT INTO ledger(kind,reference_key,payload) VALUES ('billing.plan-term-changed','a','{}')");
    // Consumers must scope delivery cleanup to event kinds; permanent accounting kinds are excluded.
    await pg.query('DELETE FROM ledger WHERE kind <> ALL($1::text[])', [PLAN_PAYMENT_HISTORY_KINDS]);
    expect((await service().revokePayment({ userId: 'u', reference: 'b' })).subscription?.paymentReference).toBe('a');
    expect((await service().revokePayment({ userId: 'u', reference: 'a' })).subscription?.status).toBe('EXPIRED');
  });

  it('selects provider subscription over simultaneous pending checkout for all callers', async () => {
    await pg.query(`INSERT INTO billing_orders VALUES ('checkout','u','{"fulfillmentData":{"plan":{"planId":"p"}}}','pending',$1)`, [clock.now]);
    await pg.query(`INSERT INTO billing_subscriptions VALUES ('provider','u','{"fulfillmentData":{"plan":{"planId":"p"}}}','active',$1,$2)`,
      [new Date('2026-07-01T00:00:00Z'), clock.now]);
    expect(await storage.billingLink?.pendingPlanPayment(db, 'u', clock.now)).toEqual({ kind: 'subscription', id: 'provider', state: 'active' });
    await expect(service().admitPurchase('u', { planId: 'other', billingCycle: 'MONTHLY' })).rejects.toMatchObject({ reason: 'pending_payment' });
    await expect(service().assign('u', { planSlug: 'pro', billingCycle: 'MONTHLY', status: 'EXPIRED' })).rejects.toMatchObject({ reason: 'pending_payment' });
    await pg.query("UPDATE billing_subscriptions SET status='canceled'");
    expect(await storage.billingLink?.pendingPlanPayment(db, 'u', clock.now)).toEqual({ kind: 'order', id: 'checkout', state: 'pending' });
    await expect(service().admitPurchase('u', { planId: 'other', billingCycle: 'MONTHLY' })).resolves.toBeUndefined();
    await expect(service().assign('u', { planSlug: 'pro', billingCycle: 'MONTHLY' })).rejects.toMatchObject({ reason: 'pending_payment' });
    await expect(service().assign('u', { planSlug: 'pro', billingCycle: 'MONTHLY', status: 'EXPIRED' })).resolves.toMatchObject({ status: 'EXPIRED' });
    clock.now = new Date('2026-06-03T00:00:00Z');
    expect(await storage.billingLink?.pendingPlanPayment(db, 'u', clock.now)).toBeNull();
  });
});
