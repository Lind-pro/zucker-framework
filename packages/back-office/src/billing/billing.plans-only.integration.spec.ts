// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Module, ForbiddenException, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, IS_PUBLIC_KEY } from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { RefundProtocolError, planOfferId, type RefundAdapter, type Money } from '@zucker-framework/payment';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgTestAdapter, type PgPoolLike } from '../subscriptions/testing/pg-test-adapter';
import {
  BILLING_SERVICE, BackOfficeBillingModule, BillingService, advisoryAccountLock, billingPersistenceConfig, BillingStorage, createFakePaymentProvider,
  type BillingFulfillmentHooks, type BillingRefundHooks,
} from './index';

/**
 * PostgreSQL contract of the billing host in plans-only mode: custom model AND table names, no credit
 * tables at all, advisory account lock. Money and security paths of plan-order refunds, order recovery
 * and the product refund hooks. Needs TEST_DATABASE_URL (an isolated *_test database).
 */
const { Pool } = createRequire(resolve(__dirname, '../../../task/package.json'))('pg') as {
  Pool: new (config: Record<string, unknown>) => PgPoolLike & { end(): Promise<void> };
};
const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

const NAMES = {
  models: { billingOrders: 'sub_checkout', billingSubscriptions: 'sub_binding', billingSubscriptionCycles: 'sub_cycle',
    billingFulfillments: 'sub_fulfillment', billingOutbox: 'sub_outbox' },
  tables: { orders: 'sub_checkout', subscriptions: 'sub_binding', subscriptionCycles: 'sub_cycle', refundPayments: 'rf_payment',
    refundAliases: 'rf_alias', refundRequests: 'rf_request', refundReceipts: 'rf_receipt', refundEvents: 'rf_event' },
} as const;

const SCHEMA_SQL = `
CREATE TABLE sub_checkout (
  id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "offerId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "accountScope" TEXT NOT NULL,
  offer JSONB NOT NULL, "providerMetadata" JSONB, "successUrl" TEXT NOT NULL, "cancelUrl" TEXT NOT NULL, "createKey" TEXT NOT NULL,
  "captureKey" TEXT NOT NULL, "creationState" TEXT NOT NULL, "captureState" TEXT NOT NULL, state TEXT NOT NULL, "checkoutId" TEXT,
  "checkoutUrl" TEXT, "paymentId" TEXT, "paymentKind" TEXT, "subscriptionId" TEXT, "fulfilledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revision INTEGER NOT NULL DEFAULT 0, "configRevision" TEXT);
CREATE TABLE sub_fulfillment ("orderId" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, policy JSONB NOT NULL, credits INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sub_outbox (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, kind TEXT NOT NULL, "aggregateId" TEXT NOT NULL, payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sub_binding (id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "initialOrderId" TEXT NOT NULL UNIQUE, "providerId" TEXT NOT NULL,
  "accountScope" TEXT NOT NULL, "providerSubscriptionId" TEXT NOT NULL, "catalogReference" TEXT NOT NULL, offer JSONB NOT NULL, "grantBasis" TEXT NOT NULL,
  "initialPaymentId" TEXT NOT NULL, "initialPaymentKind" TEXT NOT NULL, "initialFulfilledAt" TIMESTAMP(3), "customerId" TEXT,
  status TEXT NOT NULL DEFAULT 'unknown', "providerStatus" TEXT NOT NULL DEFAULT 'unknown', "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3), "cancelAtPeriodEnd" BOOLEAN, "canceledAt" TIMESTAMP(3), "cancelState" TEXT NOT NULL DEFAULT 'idle',
  "cancelMode" TEXT, "cancelRequestedAt" TIMESTAMP(3), "observedAt" TIMESTAMP(3), "nextReconcileAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconcileStatus" TEXT NOT NULL DEFAULT 'pending', "reconcileErrorCode" TEXT, "lastReconcileTaskId" TEXT, revision INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sub_cycle (id TEXT PRIMARY KEY, "cycleKey" TEXT NOT NULL UNIQUE, "bindingId" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "providerId" TEXT NOT NULL,
  "accountScope" TEXT NOT NULL, "subscriptionId" TEXT NOT NULL, "catalogReference" TEXT NOT NULL, basis TEXT NOT NULL, "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3), "paymentId" TEXT NOT NULL, "paymentKind" TEXT NOT NULL, "recordId" TEXT NOT NULL, "paidMoney" JSONB NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL, "policyVersion" TEXT NOT NULL, policy JSONB NOT NULL, initial BOOLEAN NOT NULL, "fulfilledAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("providerId","accountScope","paymentKind","paymentId"));
CREATE TABLE rf_payment (
  id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "orderId" TEXT NOT NULL REFERENCES sub_checkout(id), "cycleId" TEXT REFERENCES sub_cycle(id),
  "providerId" TEXT NOT NULL, "accountScope" TEXT NOT NULL, "paymentKind" TEXT NOT NULL, "paymentId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL, "sourceId" TEXT NOT NULL, title TEXT NOT NULL, "paidMoney" JSONB NOT NULL,
  "paidMinor" TEXT NOT NULL CHECK ("paidMinor" ~ '^[0-9]+$' AND "paidMinor"::numeric>0),
  "minorScale" INTEGER NOT NULL CHECK ("minorScale" BETWEEN 0 AND 3), "totalCredits" INTEGER NOT NULL CHECK ("totalCredits">=0),
  "refundedMinor" TEXT NOT NULL DEFAULT '0' CHECK ("refundedMinor" ~ '^[0-9]+$'),
  "providerPendingMinor" TEXT CHECK ("providerPendingMinor" IS NULL OR "providerPendingMinor" ~ '^[0-9]+$'),
  "recoveredCredits" INTEGER NOT NULL DEFAULT 0, "revokedCredits" INTEGER NOT NULL DEFAULT 0,
  "expiredCredits" INTEGER NOT NULL DEFAULT 0, "suppressedCredits" INTEGER NOT NULL DEFAULT 0,
  "grantRecorded" BOOLEAN NOT NULL DEFAULT false, "grantSource" TEXT, "grantSourceId" TEXT,
  "activeRequestId" TEXT, attention BOOLEAN NOT NULL DEFAULT false, revision INTEGER NOT NULL DEFAULT 0,
  "observedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("providerId","accountScope","paymentKind","paymentId"), UNIQUE("providerId","accountScope","sourceKind","sourceId"),
  CHECK ("refundedMinor"::numeric <= "paidMinor"::numeric));
CREATE TABLE rf_alias ("providerId" TEXT NOT NULL,"accountScope" TEXT NOT NULL,"paymentKind" TEXT NOT NULL,"paymentId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL REFERENCES rf_payment(id), PRIMARY KEY("providerId","accountScope","paymentKind","paymentId"));
CREATE TABLE rf_request (
  id TEXT PRIMARY KEY,"targetId" TEXT NOT NULL REFERENCES rf_payment(id),"ownerId" TEXT NOT NULL,"actorId" TEXT NOT NULL,"clientKey" TEXT NOT NULL,
  "commandKey" TEXT NOT NULL UNIQUE,"requestedMinor" TEXT NOT NULL CHECK ("requestedMinor"::numeric>0),"beforeRefundedMinor" TEXT NOT NULL,
  "expectedRefundedMinor" TEXT NOT NULL, money JSONB NOT NULL, reason TEXT, state TEXT NOT NULL DEFAULT 'prepared',"creditState" TEXT NOT NULL DEFAULT 'held',
  "creditAmount" INTEGER NOT NULL CHECK ("creditAmount">=0),"holdId" TEXT,
  "expiredCredits" INTEGER NOT NULL DEFAULT 0,"suppressedCredits" INTEGER NOT NULL DEFAULT 0,"revokedCredits" INTEGER NOT NULL DEFAULT 0,
  "shortfallCredits" INTEGER NOT NULL DEFAULT 0,"providerRefundId" TEXT,"confirmationBasis" TEXT,"checkedAt" TIMESTAMP(3),revision INTEGER NOT NULL DEFAULT 0,
  "lastReconcileTaskId" TEXT,"reconcileStatus" TEXT NOT NULL DEFAULT 'idle',"reconcileErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("actorId","clientKey"));
CREATE UNIQUE INDEX rf_one_active ON rf_request("targetId") WHERE state IN ('prepared','submitting','pending','requires_action','unknown');
CREATE TABLE rf_receipt ("providerId" TEXT NOT NULL,"accountScope" TEXT NOT NULL,"refundId" TEXT NOT NULL,"targetId" TEXT NOT NULL REFERENCES rf_payment(id),
  "sourceKind" TEXT NOT NULL,"sourceId" TEXT NOT NULL,"commandKey" TEXT,state TEXT NOT NULL,money JSONB,"amountMinor" TEXT,"totalRefundedMinor" TEXT,
  "occurredAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("providerId","accountScope","refundId"));
CREATE TABLE rf_event ("providerId" TEXT NOT NULL,"accountScope" TEXT NOT NULL,"eventId" TEXT NOT NULL,"sourceKind" TEXT NOT NULL,"sourceId" TEXT NOT NULL,
  "refundId" TEXT,"commandKey" TEXT,evidence JSONB NOT NULL,"targetId" TEXT REFERENCES rf_payment(id),status TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"processedAt" TIMESTAMP(3), PRIMARY KEY("providerId","accountScope","eventId"));
-- Product side effects written by the plan hooks in the same transaction as the billing rows.
CREATE TABLE plan_term_events (n SERIAL PRIMARY KEY, kind TEXT NOT NULL, reference TEXT NOT NULL);
`;
const ORIGIN = 'http://localhost:4202';
const PLAN_OFFER = planOfferId('plan1', 'one_time', 'USD');
const snapshot = { planId: 'plan1', slug: 'pro', revision: 1, interval: 'one_time', currency: 'USD', amount: '29.00', termDays: 30,
  providerId: 'fake', providerRef: 'price_fake_pro', credits: 0, creditExpiry: null };
const planOffers = {
  async resolve(offerId: string, providerId: string) {
    if (offerId !== PLAN_OFFER || providerId !== 'fake') return null;
    return { plan: { name: 'Pro' }, price: {}, mode: 'payment' as const, snapshot } as never;
  },
  async claims() { return false; },
};
const money = (amount: string): Money => ({ amount, currency: 'USD' });

/** Wraps the fake refund adapter: counts provider mutations and can lose the response after the provider accepted it. */
function refundAdapterWith(fake: RefundAdapter) {
  const state = { creates: 0, mode: 'normal' as 'normal' | 'lost' | 'rejected' };
  const adapter: RefundAdapter = { ...fake,
    async create(command) {
      state.creates += 1;
      if (state.mode === 'rejected') throw new RefundProtocolError('invalid_input', 'Synthetic provider rejection', 'rejected');
      const observation = await fake.create(command);
      if (state.mode === 'lost') throw new RefundProtocolError('transport_error', 'Synthetic accepted response lost');
      return observation;
    } };
  return { adapter, state };
}

/** Test-only guard: `x-user` is the caller, `x-perms` its comma separated permissions; honours @Public and @Permissions. */
@Injectable()
class HeaderGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const user = request.headers['x-user'];
    if (typeof user !== 'string') throw new ForbiddenException('anonymous');
    request.user = { id: user };
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const held = String(request.headers['x-perms'] ?? '').split(',').filter(Boolean);
    if (required.some(permission => !held.includes(permission))) throw new ForbiddenException('missing permission');
    return true;
  }
}

run('billing host, plans-only on custom model and table names (PostgreSQL)', () => {
  const schema = `zf_billing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: PgPoolLike & { end(): Promise<void> };
  let pool: PgPoolLike & { end(): Promise<void> };
  let db: PgTestAdapter;
  const count = async (table: string, where = 'TRUE', values: unknown[] = []) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, values)).rows[0].n);
  const events = async (kind: string, aggregateId?: string) => (await pool.query(
    'SELECT kind, "aggregateId", payload FROM sub_outbox WHERE kind=$1 AND ($2::text IS NULL OR "aggregateId"=$2)', [kind, aggregateId ?? null])).rows;
  const targetOf = async (orderId: string) => (await pool.query('SELECT id FROM rf_payment WHERE "orderId"=$1', [orderId])).rows[0]?.id as string | undefined;
  const termEvents = async () => (await pool.query('SELECT kind, reference FROM plan_term_events ORDER BY n')).rows as Array<{ kind: string; reference: string }>;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    admin = new Pool({ connectionString: url.href, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, max: 8, options: `-c search_path=${schema}` });
    await pool.query(SCHEMA_SQL);
    db = new PgTestAdapter(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  /** A billing service over the custom schema with a fresh fake provider. */
  function harness(options: { planHook?: Partial<BillingFulfillmentHooks> | false; refunds?: BillingRefundHooks; database?: PgTestAdapter } = {}) {
    const fake = createFakePaymentProvider({ checkoutBaseUrl: 'https://checkout.example.invalid/pay' });
    const wrapped = refundAdapterWith(fake.refund);
    const persistence = billingPersistenceConfig({ credits: null,
      storage: new BillingStorage({ ...NAMES, models: { ...NAMES.models }, tables: { ...NAMES.tables }, lockAccount: advisoryAccountLock('f45') }) });
    const service = new BillingService(options.database ?? db, { providers: [fake.checkout], subscriptionProviders: [fake.subscription], refundProviders: [wrapped.adapter],
      webUrl: 'https://app.example.invalid' }, { persistence, refunds: options.refunds });
    service.usePlanOffers(planOffers);
    const calls = { fulfilled: 0, refunded: [] as unknown[] };
    if (options.planHook !== false) service.useFulfillmentHooks({ plans: true,
      async checkoutFulfilled(tx, order) { calls.fulfilled += 1; await tx.query("INSERT INTO plan_term_events(kind, reference) VALUES ('granted', $1)", [`order:${order.id}`]); },
      async paymentRefunded(tx, input) {
        calls.refunded.push(input);
        await tx.query("INSERT INTO plan_term_events(kind, reference) VALUES ('revoked', $1)", [input.reference]);
      },
      ...options.planHook });
    return { fake, wrapped, service, calls };
  }
  async function buy(h: ReturnType<typeof harness>, ownerId = `owner-${randomUUID()}`, confirm = true) {
    const order = await h.service.create(ownerId, randomUUID().replaceAll('-', ''), { offerId: PLAN_OFFER, providerId: 'fake' });
    h.fake.ledger.pay(order.checkoutId!);
    if (confirm) await h.service.confirm(order.id, ownerId);
    return { order, ownerId };
  }
  const refundKey = () => randomUUID().replaceAll('-', '');
  const admin1 = 'admin-1';

  it('sells and fulfills a plan order with zero credits and touches no default or credit table', async () => {
    const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()")).rows.map(row => row.table_name as string);
    expect(tables.filter(name => /^(billing_|credit)/.test(name))).toEqual([]);
    const h = harness();
    const { order } = await buy(h);
    const row = (await pool.query('SELECT state, "fulfilledAt", "offerId" FROM sub_checkout WHERE id=$1', [order.id])).rows[0];
    expect(row).toMatchObject({ state: 'paid', offerId: PLAN_OFFER });
    expect(row.fulfilledAt).toBeInstanceOf(Date);
    expect((await pool.query('SELECT credits FROM sub_fulfillment WHERE "orderId"=$1', [order.id])).rows).toEqual([{ credits: 0 }]);
    expect(h.calls.fulfilled).toBe(1);
    expect(await termEvents()).toContainEqual({ kind: 'granted', reference: `order:${order.id}` });
    expect(await events('billing.credit-fulfilled')).toHaveLength(1);
    // Replaying the confirmation neither double-fulfills nor writes another event.
    await h.service.confirm(order.id, order.ownerId);
    expect(h.calls.fulfilled).toBe(1);
    expect(await count('sub_outbox', 'kind=$1 AND "aggregateId"=$2', ['billing.credit-fulfilled', order.id])).toBe(1);
  });

  it('refuses to fulfill a plan order when no plan hook is registered (paid order stays retryable)', async () => {
    const h = harness({ planHook: false });
    const { order } = await buy(h, undefined, false);
    await expect(h.service.confirm(order.id, order.ownerId)).rejects.toMatchObject({ code: 'conflict' });
    expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(0);
    expect(await count('sub_outbox', '"aggregateId"=$1', [order.id])).toBe(0);
  });

  it('full refund of a plan order: provider refund once, term revoked once, payment-refunded written once', async () => {
    const h = harness();
    const { order } = await buy(h);
    const key = refundKey();
    const view = await h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '29.00', reason: 'Synthetic full' });
    expect(view).toMatchObject({ cashState: 'succeeded', state: 'succeeded', creditState: 'settled', money: money('29.00'), creditImpact: { held: 0, revoked: 0 } });
    expect(h.wrapped.state.creates).toBe(1);
    expect(h.calls.refunded).toHaveLength(1);
    expect(h.calls.refunded[0]).toMatchObject({ ownerId: order.ownerId, orderId: order.id, cycleId: null, reference: `order:${order.id}`, full: true,
      paidMoney: money('29.00'), refundedMoney: money('29.00') });
    expect((await termEvents()).filter(event => event.kind === 'revoked')).toContainEqual({ kind: 'revoked', reference: `order:${order.id}` });
    const targetId = (await targetOf(order.id))!;
    expect(await events('billing.payment-refunded', targetId)).toEqual([expect.objectContaining({ aggregateId: targetId })]);
    expect(await events('billing.plan-refund-unapplied', targetId)).toHaveLength(0);
    // A plan refund is by paid amount: no credit rows exist and the refund row carries zero credits.
    expect((await pool.query('SELECT "totalCredits","refundedMinor","paidMinor" FROM rf_payment WHERE id=$1', [targetId])).rows[0])
      .toEqual({ totalCredits: 0, refundedMinor: '2900', paidMinor: '2900' });
    // Replay (same key) and re-check never re-dispatch and never re-run the hook.
    const again = await h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '29.00', reason: 'Synthetic full' });
    expect(again.id).toBe(view.id);
    await h.service.refunds.reconcile(view.id);
    await h.service.refunds.checkTarget('order', order.id);
    expect(h.wrapped.state.creates).toBe(1);
    expect(h.calls.refunded).toHaveLength(1);
    expect(await events('billing.payment-refunded', targetId)).toHaveLength(1);
    // Nothing more can be refunded.
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '1.00' })).rejects.toBeTruthy();
    expect(h.wrapped.state.creates).toBe(1);
  });

  it('partial refund keeps the term; the refund that completes the payment revokes it exactly once', async () => {
    const h = harness();
    const { order } = await buy(h);
    const first = await h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '10.00' });
    expect(first).toMatchObject({ cashState: 'succeeded', money: money('10.00') });
    expect(h.calls.refunded).toHaveLength(0);
    const partialTarget = (await targetOf(order.id))!;
    expect(await events('billing.payment-refunded', partialTarget)).toHaveLength(0);
    expect(await termEvents()).not.toContainEqual({ kind: 'revoked', reference: `order:${order.id}` });
    const target = await h.service.refunds.getTarget('order', order.id);
    expect(target).toMatchObject({ refundedMoney: money('10.00'), remainingMoney: money('19.00'), totalCredits: 0, capabilities: { canCreate: true } });
    // More than what remains is refused before the provider is called.
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '19.01' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.wrapped.state.creates).toBe(1);
    const second = await h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '19.00' });
    expect(second.cashState).toBe('succeeded');
    expect(h.calls.refunded).toHaveLength(1);
    expect(h.calls.refunded[0]).toMatchObject({ refundedMoney: money('29.00') });
    expect(await events('billing.payment-refunded', partialTarget)).toHaveLength(1);
    expect(h.wrapped.state.creates).toBe(2);
  });

  it('reports plan-refund-unapplied when a plan was fully refunded but no hook revokes terms', async () => {
    const h = harness({ planHook: { paymentRefunded: undefined } });
    const { order } = await buy(h);
    await h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '29.00' });
    const targetId = (await targetOf(order.id))!;
    expect(await events('billing.payment-refunded', targetId)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ plan: true }) })]);
    expect(await events('billing.plan-refund-unapplied', targetId)).toHaveLength(1);
  });

  it('a failing revocation hook leaves no payment-refunded marker and is applied once when reconciled', async () => {
    let fail = true;
    const h = harness({ planHook: { async paymentRefunded(tx, input) {
      if (fail) throw new Error('Synthetic revoke failure');
      await tx.query("INSERT INTO plan_term_events(kind, reference) VALUES ('revoked', $1)", [input.reference]);
    } } });
    const { order } = await buy(h);
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '29.00' })).rejects.toThrow('Synthetic revoke failure');
    // Money moved at the provider; the local marker did not commit, so the revocation is still owed.
    expect(h.wrapped.state.creates).toBe(1);
    const targetId = (await pool.query('SELECT id FROM rf_payment WHERE "orderId"=$1', [order.id])).rows[0].id as string;
    expect(await count('sub_outbox', 'kind=$1 AND "aggregateId"=$2', ['billing.payment-refunded', targetId])).toBe(0);
    expect((await termEvents()).filter(event => event.reference === `order:${order.id}` && event.kind === 'revoked')).toHaveLength(0);
    expect((await pool.query('SELECT attention FROM rf_payment WHERE id=$1', [targetId])).rows[0].attention).toBe(true);
    fail = false;
    const requestId = (await pool.query('SELECT id FROM rf_request WHERE "targetId"=$1', [targetId])).rows[0].id as string;
    await h.service.refunds.reconcile(requestId);
    await h.service.refunds.reconcile(requestId);
    expect(h.wrapped.state.creates).toBe(1);
    expect((await termEvents()).filter(event => event.reference === `order:${order.id}` && event.kind === 'revoked')).toHaveLength(1);
    expect(await count('sub_outbox', 'kind=$1 AND "aggregateId"=$2', ['billing.payment-refunded', targetId])).toBe(1);
  });

  it('a lost refund response is never re-dispatched: replay and reconcile only read the provider', async () => {
    const h = harness();
    const { order } = await buy(h);
    h.wrapped.state.mode = 'lost';
    const key = refundKey();
    const body = { targetType: 'order', targetId: order.id, amount: '29.00' };
    await expect(h.service.refunds.create(admin1, key, body)).rejects.toMatchObject({ code: 'transport_error' });
    expect(h.wrapped.state.creates).toBe(1);
    const row = (await pool.query('SELECT id, state FROM rf_request WHERE "actorId"=$1 AND "clientKey"=$2', [admin1, key])).rows[0];
    expect(row.state).toBe('unknown');
    // The provider already holds the refund. A same-key replay must not call create again.
    h.wrapped.state.mode = 'normal';
    const replay = await h.service.refunds.create(admin1, key, body);
    expect(replay).toMatchObject({ id: row.id, cashState: 'unknown' });
    expect(h.wrapped.state.creates).toBe(1);
    // A different key cannot start a second refund while the first one is unresolved.
    await expect(h.service.refunds.create(admin1, refundKey(), body)).rejects.toBeTruthy();
    expect(h.wrapped.state.creates).toBe(1);
    const reconciled = await h.service.refunds.reconcile(row.id as string);
    expect(reconciled).toMatchObject({ cashState: 'succeeded' });
    expect(h.wrapped.state.creates).toBe(1);
    expect(h.calls.refunded).toHaveLength(1);
    expect((await h.service.refunds.getTarget('order', order.id)).refundedMoney).toEqual(money('29.00'));
  });

  it('a provider rejection fails the request without a refund, then a new key may retry', async () => {
    const settled: unknown[] = [];
    const h = harness({ refunds: { async settled(_tx, input) { settled.push(input); } } });
    const { order } = await buy(h);
    h.wrapped.state.mode = 'rejected';
    const view = await h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '29.00' }).catch(error => error);
    expect(view).toBeDefined();
    const row = (await pool.query('SELECT state FROM rf_request')).rows.find(candidate => candidate.state === 'failed');
    expect(row).toBeDefined();
    expect(settled).toEqual([expect.objectContaining({ state: 'failed', orderId: order.id, ownerId: order.ownerId })]);
    expect(h.calls.refunded).toHaveLength(0);
    h.wrapped.state.mode = 'normal';
    const retry = await h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '29.00' });
    expect(retry.cashState).toBe('succeeded');
    expect(h.calls.refunded).toHaveLength(1);
  });

  it('admit refusal leaves no row and no provider call; settled runs once with the final state', async () => {
    const admitted: unknown[] = [], settled: Array<Record<string, unknown>> = [];
    let refuse = true;
    const h = harness({ refunds: {
      async admit(input) { admitted.push(input); if (refuse) throw new ForbiddenException('No approved request'); },
      async settled(_tx, input) { settled.push({ ...input }); },
    } });
    const { order } = await buy(h);
    const before = { requests: await count('rf_request'), targets: await count('rf_payment'), outbox: await count('sub_outbox'), aliases: await count('rf_alias') };
    const key = refundKey();
    await expect(h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '15.00', reason: 'Synthetic' })).rejects.toBeInstanceOf(ForbiddenException);
    expect({ requests: await count('rf_request'), targets: await count('rf_payment'), outbox: await count('sub_outbox'), aliases: await count('rf_alias') }).toEqual(before);
    expect(h.wrapped.state.creates).toBe(0);
    expect(settled).toHaveLength(0);
    expect(admitted).toEqual([expect.objectContaining({ actorId: admin1, clientKey: key, ownerId: order.ownerId, orderId: order.id, cycleId: null,
      targetType: 'order', targetId: order.id, money: money('15.00'), reason: 'Synthetic', plan: true })]);
    refuse = false;
    const done = await h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '15.00', reason: 'Synthetic' });
    expect(done.cashState).toBe('succeeded');
    expect(settled).toEqual([expect.objectContaining({ state: 'succeeded', clientKey: key, actorId: admin1, orderId: order.id, money: money('15.00'),
      providerRefundId: expect.stringMatching(/^fakere_/) })]);
    // Replay, reconcile and re-check do not call settled or admit again.
    await h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '15.00', reason: 'Synthetic' });
    await h.service.refunds.reconcile(done.id);
    await h.service.refunds.checkTarget('order', order.id);
    expect(settled).toHaveLength(1);
    expect(admitted).toHaveLength(2);
    expect(await events('billing.refund-settled', done.id)).toHaveLength(1);
  });

  it('rejects a reused Idempotency-Key with different content and malformed bodies', async () => {
    const h = harness();
    const { order } = await buy(h);
    const key = refundKey();
    await h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '5.00' });
    await expect(h.service.refunds.create(admin1, key, { targetType: 'order', targetId: order.id, amount: '6.00' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.service.refunds.create(admin1, 'short', { targetType: 'order', targetId: order.id, amount: '1.00' })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '1.00', extra: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '0.00' })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: 'missing', amount: '1.00' })).rejects.toMatchObject({ code: 'not_found' });
    expect(h.wrapped.state.creates).toBe(1);
  });

  it('concurrent refunds of one payment reach the provider once, whether the keys differ or are the same', async () => {
    const h = harness();
    const { order } = await buy(h);
    const body = { targetType: 'order', targetId: order.id, amount: '29.00' };
    const differentKeys = await Promise.allSettled([h.service.refunds.create(admin1, refundKey(), body), h.service.refunds.create(admin1, refundKey(), body),
      h.service.refunds.create(admin1, refundKey(), body)]);
    expect(differentKeys.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.wrapped.state.creates).toBe(1);
    expect(h.calls.refunded).toHaveLength(1);
    const targetId = (await targetOf(order.id))!;
    expect(await events('billing.payment-refunded', targetId)).toHaveLength(1);
    const second = await buy(h);
    const key = refundKey();
    const sameKey = await Promise.allSettled([h.service.refunds.create(admin1, key, { ...body, targetId: second.order.id }),
      h.service.refunds.create(admin1, key, { ...body, targetId: second.order.id }), h.service.refunds.create(admin1, key, { ...body, targetId: second.order.id })]);
    expect(sameKey.some(result => result.status === 'fulfilled')).toBe(true);
    expect(h.wrapped.state.creates).toBe(2);
    expect(await count('rf_request', '"actorId"=$1 AND "clientKey"=$2', [admin1, key])).toBe(1);
    expect(h.calls.refunded).toHaveLength(2);
  });

  it('a refund whose success is recorded but whose cash is not yet merged still blocks a second dispatch (deterministic interleaving)', async () => {
    // Pins the window between the dispatching request's two transactions: its provider response
    // ("succeeded") is committed first, the receipt and cumulative cash are merged in the next one. A
    // concurrent request that observed the provider before the first refund must not treat that
    // request as settled and send a second refund of money that was already returned.
    const flow = new AsyncLocalStorage<'first' | 'second'>();
    let release!: () => void, recorded!: () => void, observed!: () => void, resumeSecond!: () => void;
    const firstResumes = new Promise<void>(resolve => { release = resolve; });
    const firstRecorded = new Promise<void>(resolve => { recorded = resolve; });
    const secondObserved = new Promise<void>(resolve => { observed = resolve; });
    const secondResumes = new Promise<void>(resolve => { resumeSecond = resolve; });
    let paused = false, held = false;
    const gated = Object.assign(Object.create(db) as PgTestAdapter, {
      async $transaction<T>(work: (tx: PgTestAdapter) => Promise<T>): Promise<T> {
        if (flow.getStore() === 'first' && paused) await firstResumes;
        let response = false, registered = false;
        const result = await db.$transaction(raw => { const tx = raw as PgTestAdapter; return work(Object.assign(Object.create(tx) as PgTestAdapter, {
          query: (sql: string, values?: readonly unknown[]) => {
            if (sql.includes('INSERT INTO "rf_event"')) response = true;
            if (sql.includes('INSERT INTO "rf_alias"')) registered = true;
            return tx.query(sql, values);
          },
        })); });
        if (response && flow.getStore() === 'first' && !paused) { paused = true; recorded(); }
        if (registered && flow.getStore() === 'second' && !held) { held = true; observed(); await secondResumes; }
        return result;
      },
    });
    const h = harness({ database: gated });
    const { order } = await buy(h);
    const body = { targetType: 'order', targetId: order.id, amount: '29.00' };
    // The second request merges the provider's cash (no refund yet) and is held before settling the active request.
    const second = flow.run('second', () => h.service.refunds.create(admin1, refundKey(), body));
    await secondObserved;
    // The first request dispatches and commits the provider response, then is held before its cash merge.
    const first = flow.run('first', () => h.service.refunds.create(admin1, refundKey(), body));
    await firstRecorded;
    resumeSecond();
    const secondResult = await Promise.allSettled([second]);
    release();
    const results = [...secondResult, ...await Promise.allSettled([first])];
    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: expect.objectContaining({ state: 'succeeded' }) });
    expect(h.wrapped.state.creates).toBe(1);
    const targetId = (await targetOf(order.id))!;
    expect(await count('rf_request', '"targetId"=$1', [targetId])).toBe(1);
    expect((await pool.query('SELECT "refundedMinor","activeRequestId" FROM rf_payment WHERE id=$1', [targetId])).rows[0]).toEqual({ refundedMinor: '2900', activeRequestId: null });
    expect(h.calls.refunded).toHaveLength(1);
    expect(await events('billing.payment-refunded', targetId)).toHaveLength(1);
  });

  it('concurrent confirmations fulfill a plan order once', async () => {
    const h = harness();
    const { order } = await buy(h, undefined, false);
    await Promise.allSettled([1, 2, 3, 4].map(() => h.service.confirm(order.id, order.ownerId)));
    expect(h.calls.fulfilled).toBe(1);
    expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(1);
    expect(await count('sub_outbox', 'kind=$1 AND "aggregateId"=$2', ['billing.credit-fulfilled', order.id])).toBe(1);
  });

  it('refuses to refund an unpaid order', async () => {
    const h = harness();
    const { order } = await buy(h, undefined, false);
    await expect(h.service.refunds.create(admin1, refundKey(), { targetType: 'order', targetId: order.id, amount: '1.00' })).rejects.toMatchObject({ code: 'conflict' });
    expect(h.wrapped.state.creates).toBe(0);
  });

  describe('HTTP: order recovery and disabled features', () => {
    let app: INestApplication, base: string, service: BillingService, calls: ReturnType<typeof harness>;
    const verified: string[] = [];
    let verifyFails = false;

    class RecoveryHooks { async verifyRecovery(checkoutId: string) { verified.push(checkoutId); if (verifyFails) throw new ForbiddenException('foreign session'); } }

    async function boot(features: Record<string, boolean> = {}) {
      calls = harness();
      @Module({
        imports: [
          { module: class DatabaseModule {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: db }], exports: [DATABASE_ADAPTER] },
          BackOfficeBillingModule.forRoot({
            ...NAMES, models: { ...NAMES.models }, tables: { ...NAMES.tables }, lockAccount: advisoryAccountLock('f45'),
            runtime: { useFactory: () => ({ providers: [calls.fake.checkout], subscriptionProviders: [calls.fake.subscription], refundProviders: [calls.wrapped.adapter],
              webUrl: 'https://app.example.invalid' }) },
            ports: { checkout: RecoveryHooks }, guards: [HeaderGuard], rateLimit: false, webhookRateLimit: false,
            trustedOrigins: () => [ORIGIN], features,
          }),
        ],
        providers: [Reflector],
      })
      class RootModule {}
      app = await NestFactory.create(RootModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
      service = app.get(BILLING_SERVICE);
      service.usePlanOffers(planOffers);
      service.useFulfillmentHooks({ plans: true, async checkoutFulfilled(tx, order) { await tx.query("INSERT INTO plan_term_events(kind, reference) VALUES ('granted', $1)", [`order:${order.id}`]); } });
    }
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-user': 'admin-1', 'x-perms': 'billing:refund', ...headers }, body: JSON.stringify(body) });
    afterAll(async () => { await app?.close(); });

    it('recovers a paid order from the provider session id: 200, idempotent', async () => {
      await boot();
      const ownerId = `owner-${randomUUID()}`;
      const order = await service.create(ownerId, randomUUID().replaceAll('-', ''), { offerId: PLAN_OFFER, providerId: 'fake' });
      calls.fake.ledger.pay(order.checkoutId!);
      const response = await post(`/management/orders/${order.id}/recover`, { checkoutId: order.checkoutId });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toMatchObject({ id: order.id, state: 'paid' });
      expect(verified).toContain(order.checkoutId);
      expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(1);
      expect(await events('billing.credit-fulfilled')).toContainEqual(expect.objectContaining({ aggregateId: order.id }));
      const again = await post(`/management/orders/${order.id}/recover`, { checkoutId: order.checkoutId });
      expect(again.status).toBe(200);
      expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(1);
      expect(await count('sub_outbox', 'kind=$1 AND "aggregateId"=$2', ['billing.credit-fulfilled', order.id])).toBe(1);
    });

    it('409 for a session bound to another checkout or unpaid evidence; 404 for an unknown order', async () => {
      const ownerId = `owner-${randomUUID()}`;
      const order = await service.create(ownerId, randomUUID().replaceAll('-', ''), { offerId: PLAN_OFFER, providerId: 'fake' });
      const other = await service.create(ownerId, randomUUID().replaceAll('-', ''), { offerId: PLAN_OFFER, providerId: 'fake' });
      calls.fake.ledger.pay(other.checkoutId!);
      const foreign = await post(`/management/orders/${order.id}/recover`, { checkoutId: other.checkoutId });
      expect(foreign.status).toBe(409);
      expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(0);
      expect(await count('sub_fulfillment', '"orderId"=$1', [other.id])).toBe(0);
      const unpaid = await post(`/management/orders/${order.id}/recover`, { checkoutId: order.checkoutId });
      // Unpaid evidence does not fulfill: the order is returned as it is.
      expect(unpaid.status === 200 ? ((await unpaid.json()) as { state: string }).state : 'refused').not.toBe('paid');
      expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(0);
      expect((await post('/management/orders/does-not-exist/recover', { checkoutId: 'fakecs_x' })).status).toBe(404);
    });

    it('400 for malformed bodies and hints, 403 without permission, origin or caller; product verification can refuse', async () => {
      const ownerId = `owner-${randomUUID()}`;
      const order = await service.create(ownerId, randomUUID().replaceAll('-', ''), { offerId: PLAN_OFFER, providerId: 'fake' });
      calls.fake.ledger.pay(order.checkoutId!);
      const path = `/management/orders/${order.id}/recover`;
      expect((await post(path, {})).status).toBe(400);
      expect((await post(path, { checkoutId: order.checkoutId, extra: true })).status).toBe(400);
      expect((await post(path, { checkoutId: 42 })).status).toBe(400);
      expect((await post(path, { checkoutId: 'has space' })).status).toBe(400);
      expect((await post(path, { checkoutId: '' })).status).toBe(400);
      expect((await post(path, [order.checkoutId])).status).toBe(400);
      expect((await post(path, { checkoutId: order.checkoutId }, { 'x-perms': 'billing:query' })).status).toBe(403);
      expect((await post(path, { checkoutId: order.checkoutId }, { 'x-perms': '' })).status).toBe(403);
      expect((await post(path, { checkoutId: order.checkoutId }, { origin: 'https://evil.example.invalid' })).status).toBe(403);
      const anonymous = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ checkoutId: order.checkoutId }) });
      expect(anonymous.status).toBe(403);
      expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(0);
      verifyFails = true;
      expect((await post(path, { checkoutId: order.checkoutId })).status).toBe(403);
      expect(await count('sub_fulfillment', '"orderId"=$1', [order.id])).toBe(0);
      verifyFails = false;
      expect((await post(path, { checkoutId: order.checkoutId })).status).toBe(200);
    });

    it('a disabled feature registers no route', async () => {
      await app.close();
      await boot({ recovery: false, refunds: false, subscriptions: false });
      const recovery = await post('/management/orders/x/recover', { checkoutId: 'fakecs_x' });
      expect(recovery.status).toBe(404);
      const refunds = await fetch(`${base}/billing/refunds`, { headers: { 'x-user': 'admin-1', 'x-perms': 'billing:refund' } });
      expect(refunds.status).toBe(404);
      const subscriptions = await fetch(`${base}/billing/subscriptions`, { headers: { 'x-user': 'admin-1' } });
      expect(subscriptions.status).toBe(404);
      // Orders stay on.
      const catalog = await fetch(`${base}/billing/catalog`);
      expect(catalog.status).toBe(200);
    });
  });
});
