import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { ZuckerStorageModule } from '@zucker-framework/storage';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, RefundAdapter, RefundObservation, RefundPaymentObservation } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingRuntimeModule } from '../src/billing/billing-runtime';
import { BillingRefundRuntime, REFUND_RECONCILE_JOB } from '../src/billing/refunds/refunds.runtime';
import { BillingService, BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { DELIVERY_OPTIONS } from '../src/delivery/delivery.config';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_refund_runtime_${randomUUID().replaceAll('-', '')}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

run('refund task authority and customer payment projection with PostgreSQL', () => {
  let pool: Pool, directory: string, scopedUrl: string, a: INestApplication, b: INestApplication;
  let dispatchCount = 0;
  const checkouts = new Map<string, HostedCheckoutObservation>(), facts = new Map<string, RefundPaymentObservation>();
  const receipts = new Map<string, RefundObservation>(), failures = new Set<string>();
  const gates = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const checkout: HostedCheckoutAdapter = { id: 'paypal', accountScope: 'synthetic-refund-merchant', modes: ['payment'], validate() {},
    async create(order) {
      const paymentId = `capture-${order.id}`;
      facts.set(paymentId, { paymentId, paymentKind: 'capture', paidMoney: order.offer.money, source: { kind: 'capture', id: paymentId },
        settlement: 'paid', refundedMoney: { amount: '0.00', currency: 'USD' }, pendingRefundMoney: { amount: '0.00', currency: 'USD' } });
      const observation: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id, mode: 'payment',
        catalogReference: order.offer.catalogReference, quantity: 1, state: 'paid', paidMoney: order.offer.money, paymentId, paymentKind: 'capture' };
      checkouts.set(observation.checkoutId, observation); return structuredClone(observation);
    }, async retrieve(id) { return structuredClone(checkouts.get(id)!); }, async verifyWebhook() { return null; },
  };
  const refunds: RefundAdapter = { id: checkout.id, accountScope: checkout.accountScope,
    capabilities: { paymentKinds: ['capture'], partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: true },
    async retrievePayment(payment) { return structuredClone(facts.get(payment.paymentId)!); },
    async create(command) {
      dispatchCount++;
      const observation: RefundObservation = { refundId: `refund-${command.commandKey}`, paymentId: command.payment.paymentId,
        paymentKind: command.payment.paymentKind, source: { kind: 'capture', id: command.payment.paymentId }, state: 'pending', providerStatus: 'pending',
        money: command.money, commandKey: command.commandKey };
      receipts.set(observation.refundId!, observation); facts.get(command.payment.paymentId)!.pendingRefundMoney = command.money;
      return structuredClone(observation);
    }, async retrieve(id) {
      const gate = gates.get(id); if (gate) { gate.entered.resolve(); await gate.release.promise; }
      if (failures.has(id)) throw new Error('Synthetic refund provider unavailable');
      return structuredClone(receipts.get(id)!);
    }, async listRefunds(payment) { return { data: structuredClone([...receipts.values()].filter(row => row.paymentId === payment.paymentId)) }; },
    async verifyWebhook() { return null; },
  };
  const options: BillingOptions = { providers: [checkout], refundProviders: [refunds], webUrl: 'http://localhost:4202',
    catalogJson: JSON.stringify([{ id: 'credits', title: 'Synthetic credits', version: 'v1', mode: 'payment', amount: '10.00',
      currency: 'USD', credits: 100, expiresInDays: null, providers: { paypal: 'synthetic-price' } }]) };
  async function application() {
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => new ApplicationDatabase(scopedUrl) }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-refund-runtime-secret-long-enough', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { billing: { points: 1000, duration: 60 }, 'api-default': { points: 1000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), BillingRuntimeModule,
    ] }).overrideProvider(BILLING_OPTIONS).useValue(options)
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: `synthetic-${randomUUID()}`, concurrency: 1,
        scanIntervalMs: 1000, leaseMs: 30_000, heartbeatMs: 5000, shutdownWaitMs: 1000 })
      .overrideProvider(DELIVERY_OPTIONS).useValue({ accountScope: '', leaseMs: 30_000, heartbeatMs: 5000 }).compile();
    const app = module.createNestApplication(); await app.init(); return app;
  }
  const database = () => a.get(JobsService).database;
  async function purchase(confirm = true) {
    const ownerId = randomUUID(); await database().model('users').create({ data: { id: ownerId,
      username: `refund_${ownerId.replaceAll('-', '')}`, name: 'Synthetic refund user', typeId: 'member', status: true } });
    const order = await a.get(BillingService).create(ownerId, randomUUID(), { offerId: 'credits', providerId: checkout.id });
    if (confirm) await a.get(BillingService).confirm(order.id, ownerId);
    return { orderId: order.id, ownerId, paymentId: `capture-${order.id}` };
  }
  async function pending() {
    const order = await purchase();
    const request = await a.get(BillingService).refunds.create(order.ownerId, randomUUID(), { targetType: 'order', targetId: order.orderId, amount: '4.00' });
    const row = await database().model('billingRefundRequests').findUnique({ where: { id: request.id } }) as { providerRefundId: string };
    await pool.query(`UPDATE "${schema}".billing_refund_requests SET "checkedAt"=timezone('UTC',CURRENT_TIMESTAMP)-interval '16 minutes',revision=revision+1 WHERE id=$1`, [request.id]);
    return { ...order, refundId: request.id, providerRefundId: row.providerRefundId };
  }
  function succeeded(paymentId: string, refundId: string) {
    const row = receipts.get(refundId)!; row.state = 'succeeded'; row.providerStatus = 'succeeded';
    facts.get(paymentId)!.refundedMoney = row.money; facts.get(paymentId)!.pendingRefundMoney = { amount: '0.00', currency: 'USD' };
    facts.get(paymentId)!.settlement = 'partially_refunded';
  }
  async function taskFor(refundId: string) {
    const rows = await database().model('asyncJob').findMany({ where: { kind: REFUND_RECONCILE_JOB, resourceId: refundId } }) as Array<{ id: string }>;
    expect(rows).toHaveLength(1); return rows[0];
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.pathname !== '/cnipa_dev' && !/(?:_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-refund-runtime-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`); await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; a = await application(); b = await application();
  });
  afterAll(async () => {
    for (const gate of gates.values()) gate.release.resolve();
    try { await Promise.all([a?.close(), b?.close()]); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  it('deduplicates two schedulers and settles the existing request without another refund command', async () => {
    const f = await pending(), before = dispatchCount;
    await Promise.all([a.get(BillingRefundRuntime).scheduleDue(), b.get(BillingRefundRuntime).scheduleDue()]);
    const task = await taskFor(f.refundId); succeeded(f.paymentId, f.providerRefundId);
    await a.get(JobsHost).runTask(task.id);
    expect(dispatchCount).toBe(before);
    expect(await a.get(BillingService).refunds.get(f.refundId)).toMatchObject({ cashState: 'succeeded', creditState: 'settled', reconcileStatus: 'idle' });
    expect(await database().model('creditAccount').findUnique({ where: { userId: f.ownerId } })).toMatchObject({ balance: 60, frozenBalance: 0 });
    expect(await a.get(BillingService).present(await a.get(BillingService).checkout.get(f.orderId, f.ownerId))).toMatchObject({ state: 'paid',
      refund: { state: 'partial', refundedMoney: { amount: '4.00', currency: 'USD' }, recoveredCredits: 40 } });
  });

  it('rejects a late refund settlement after the original worker loses its lease', async () => {
    const f = await pending(); await a.get(BillingRefundRuntime).scheduleDue(); const task = await taskFor(f.refundId);
    const gate = { entered: deferred(), release: deferred() }; gates.set(f.providerRefundId, gate);
    const running = a.get(JobsHost).runTask(task.id).catch(() => undefined); await gate.entered.promise;
    const repository = b.get(JobsService).repository, before = await repository.findById(task.id);
    await pool.query(`UPDATE "${schema}".async_jobs SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [task.id]);
    await repository.recoverExpiredLease({ id: task.id, leaseToken: before!.leaseToken!, now: new Date(), availableAt: new Date(), error: { code: 'SYNTHETIC_LEASE_LOSS', category: 'INTERNAL', retryable: true, summary: 'Synthetic executor loss' } });
    await repository.transition({ id: task.id, from: 'RETRYING', to: 'QUEUED', now: new Date() });
    await repository.claim({ id: task.id, workerId: 'replacement', leaseToken: 'new-lease', now: new Date(), leaseExpiresAt: new Date(Date.now() + 30_000) });
    succeeded(f.paymentId, f.providerRefundId); gate.release.resolve(); await running; gates.delete(f.providerRefundId);
    expect(await a.get(BillingService).refunds.get(f.refundId)).toMatchObject({ cashState: 'pending', creditState: 'held' });
    expect(await database().model('creditAccount').findUnique({ where: { userId: f.ownerId } })).toMatchObject({ balance: 60, frozenBalance: 40 });
    expect((await repository.findById(task.id))?.leaseToken).toBe('new-lease'); await repository.cancel(task.id, new Date());
  });

  it('stops after exhausted read attempts without relabeling cash and recovers by explicit checking', async () => {
    const f = await pending(), before = dispatchCount; failures.add(f.providerRefundId);
    await a.get(BillingRefundRuntime).scheduleDue(); const task = await taskFor(f.refundId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await a.get(JobsHost).runTask(task.id).catch(() => undefined);
      await pool.query(`UPDATE "${schema}".async_jobs SET "availableAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [task.id]);
    }
    expect(await a.get(BillingService).refunds.get(f.refundId)).toMatchObject({ cashState: 'pending', creditState: 'held', reconcileStatus: 'attention' });
    await a.get(BillingRefundRuntime).scheduleDue(); await taskFor(f.refundId); expect(dispatchCount).toBe(before);
    failures.delete(f.providerRefundId); succeeded(f.paymentId, f.providerRefundId);
    await a.get(BillingService).refunds.reconcile(f.refundId);
    expect(await database().model('billingRefundRequests').findUnique({ where: { id: f.refundId } })).toMatchObject({ state: 'succeeded', reconcileStatus: 'idle', lastReconcileTaskId: null });
  });

  it('preserves a fully refunded payment but grants zero credits when the refund preceded fulfillment', async () => {
    const f = await purchase(false), fact = facts.get(f.paymentId)!;
    fact.settlement = 'refunded'; fact.refundedMoney = { amount: '10.00', currency: 'USD' };
    const order = await a.get(BillingService).confirm(f.orderId, f.ownerId);
    expect(order).toMatchObject({ state: 'paid', refund: { state: 'full', refundedMoney: fact.refundedMoney, suppressedCredits: 100 } });
    expect(order.fulfilledAt).toBeTruthy();
    expect(await database().model('billingFulfillments').findUnique({ where: { orderId: f.orderId } })).toMatchObject({ credits: 0 });
    expect(await database().model('creditLots').count({ where: { userId: f.ownerId } })).toBe(0);
    const outbox = await database().model('billingOutbox').findMany({ where: { aggregateId: f.orderId } }) as Array<{ payload: { credits: number } }>;
    expect(outbox[0].payload.credits).toBe(0);
    const original = await a.get(BillingService).checkout.get(f.orderId, f.ownerId);
    await expect(a.get(BillingService).present({ ...original, ownerId: 'another-owner' })).rejects.toThrow('does not belong');
  });
});
