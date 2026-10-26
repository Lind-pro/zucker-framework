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
import type { HostedCheckoutAdapter, HostedCheckoutObservation, SubscriptionAdapter, SubscriptionDetails, SubscriptionPaidPeriod } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingRuntime, BillingRuntimeModule, SUBSCRIPTION_RECONCILE_JOB } from '../src/billing/billing-runtime';
import { BillingService, BILLING_OPTIONS, type BillingOptions } from '../src/billing/billing.service';
import { JOBS_OPTIONS } from '../src/jobs/jobs.config';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { DELIVERY_OPTIONS } from '../src/delivery/delivery.config';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_billing_runtime_${randomUUID().replaceAll('-', '')}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

run('subscription outbox and execution authority with real PostgreSQL', () => {
  let pool: Pool, directory: string, scopedUrl: string, a: INestApplication, b: INestApplication;
  const checkouts = new Map<string, HostedCheckoutObservation>();
  const facts = new Map<string, SubscriptionDetails>();
  const payments = new Map<string, SubscriptionPaidPeriod[]>();
  const failures = new Set<string>();
  const gates = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const checkout: HostedCheckoutAdapter = { id: 'stripe', accountScope: 'synthetic-runtime', modes: ['subscription'], validate() {},
    async create(order) {
      const subscriptionId = `sub-${order.id}`;
      const payment: SubscriptionPaidPeriod = { recordId: `invoice-${order.id}`, paymentId: `invoice-${order.id}`, paymentKind: 'invoice',
        subscriptionId, catalogReference: order.offer.catalogReference, paidMoney: order.offer.money, paidAt: '2026-09-01T00:00:00Z',
        period: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' } };
      payments.set(subscriptionId, [payment]);
      facts.set(subscriptionId, { provider: 'stripe', subscriptionId, catalogReference: order.offer.catalogReference,
        status: 'active', providerStatus: 'active', period: payment.period, payment: { settlement: 'paid' } });
      const observed: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id, mode: 'subscription',
        catalogReference: order.offer.catalogReference, quantity: 1, state: 'paid', subscriptionId,
        paidMoney: order.offer.money, paymentId: payment.paymentId, paymentKind: payment.paymentKind };
      checkouts.set(observed.checkoutId, observed); return structuredClone(observed);
    },
    async retrieve(id) { return structuredClone(checkouts.get(id)!); }, async verifyWebhook() { return null; },
  };
  const subscriptions: SubscriptionAdapter = { id: checkout.id, accountScope: checkout.accountScope,
    capabilities: { paidPeriodProof: 'provider', paidReceiptProof: 'unavailable', cancel: [], billingPortal: false, invoices: false },
    async retrieve(id) {
      const gate = gates.get(id); if (gate) { gate.entered.resolve(); await gate.release.promise; }
      if (failures.has(id)) throw new Error('Synthetic provider outage');
      return structuredClone(facts.get(id)!);
    },
    async listPaidPeriods(id) { return { data: structuredClone(payments.get(id) ?? []) }; },
    async cancel() { throw new Error('Not used'); },
  };
  const options: BillingOptions = { providers: [checkout], subscriptionProviders: [subscriptions], webUrl: 'http://localhost:4202',
    catalogJson: JSON.stringify([{ id: 'membership', title: 'Synthetic membership', version: 'v1', mode: 'subscription',
      amount: '12.00', currency: 'USD', credits: 100, expiresInDays: null, providers: { stripe: 'synthetic-plan' } }]) };

  async function application() {
    const database = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-runtime-test-secret-long-only', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { billing: { points: 1000, duration: 60 }, 'api-default': { points: 1000, duration: 60 } } }),
      ZuckerStorageModule.forRoot({ provider: 'local', basePath: directory }), BillingRuntimeModule,
    ] }).overrideProvider(BILLING_OPTIONS).useValue(options)
      .overrideProvider(JOBS_OPTIONS).useValue({ enabled: false, workerId: `test-${randomUUID()}`, concurrency: 1,
        scanIntervalMs: 1000, leaseMs: 30_000, heartbeatMs: 5_000, shutdownWaitMs: 2000 })
      .overrideProvider(DELIVERY_OPTIONS).useValue({ accountScope: '', leaseMs: 30_000, heartbeatMs: 5_000 }).compile();
    const app = module.createNestApplication(); await app.init(); return app;
  }
  const database = () => a.get<JobsService>(JobsService).database;
  async function fixture() {
    const ownerId = randomUUID();
    await database().model('users').create({ data: { id: ownerId, username: `runtime_${ownerId.replaceAll('-', '')}`,
      name: 'Synthetic runtime user', typeId: 'member', status: true } });
    const billing = a.get(BillingService);
    const order = await billing.create(ownerId, randomUUID(), { offerId: 'membership', providerId: 'stripe' });
    // The crash checkpoint is after durable checkout handoff, before HTTP-triggered subscription reconciliation.
    const handedOff = await billing.checkout.confirm({ orderId: order.id, ownerId });
    expect(handedOff.fulfilledAt).toBeTruthy(); expect((await billing.present(handedOff)).fulfilledAt).toBeNull();
    return { id: order.id, ownerId, providerId: `sub-${order.id}` };
  }
  async function taskFor(id: string) {
    const records = await database().model('asyncJob').findMany({ where: { kind: SUBSCRIPTION_RECONCILE_JOB,
      resourceId: id }, orderBy: { createdAt: 'desc' }, take: 1 }) as Array<{ id: string; status: string; leaseToken: string }>;
    expect(records).toHaveLength(1); return records[0];
  }
  async function balance(ownerId: string) { return database().model('creditAccount').findUnique({ where: { userId: ownerId } }); }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.pathname !== '/cnipa_dev' && !/(?:_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-billing-runtime-'));
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`); await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((x, y) => x.name.localeCompare(y.name)))
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href;
    a = await application(); b = await application();
  });
  afterAll(async () => {
    for (const gate of gates.values()) gate.release.resolve();
    try { await Promise.all([a?.close(), b?.close()]); }
    finally {
      try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    }
  });

  it('bridges one durable task across two schedulers and fulfills without a browser return', async () => {
    const f = await fixture();
    await Promise.all([a.get(BillingRuntime).scheduleDue(), b.get(BillingRuntime).scheduleDue()]);
    expect(await database().model('asyncJob').count({ where: { resourceId: f.id } })).toBe(1);
    expect(await balance(f.ownerId)).toBeNull();
    const job = await taskFor(f.id); await a.get(JobsHost).runTask(job.id);
    expect(await balance(f.ownerId)).toMatchObject({ balance: 100 });
    expect(await database().model('billingSubscriptions').findUnique({ where: { id: f.id } })).toMatchObject({ reconcileStatus: 'idle', lastReconcileTaskId: null });
    expect(await database().model('billingOutbox').findMany({ where: { aggregateId: f.id } })).toEqual([expect.objectContaining({ status: 'delivered' })]);
    const order = await a.get(BillingService).checkout.get(f.id, f.ownerId);
    expect((await a.get(BillingService).present(order)).fulfilledAt).toBeTruthy();
    await a.get(BillingRuntime).scheduleDue(); expect(await database().model('asyncJob').count({ where: { resourceId: f.id } })).toBe(1);
  });

  it('rolls back a failed outbox handoff and resumes the persisted work in a reconstructed application', async () => {
    const f = await fixture();
    await pool.query(`CREATE FUNCTION "${schema}".reject_billing_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic handoff failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_billing_handoff BEFORE UPDATE ON "${schema}".billing_outbox FOR EACH ROW WHEN (NEW.status='scheduled') EXECUTE FUNCTION "${schema}".reject_billing_handoff()`);
    try { await expect(a.get(BillingRuntime).scheduleDue()).rejects.toThrow(); }
    finally { await pool.query(`DROP TRIGGER reject_billing_handoff ON "${schema}".billing_outbox`); await pool.query(`DROP FUNCTION "${schema}".reject_billing_handoff()`); }
    expect(await database().model('asyncJob').count({ where: { resourceId: f.id } })).toBe(0);
    expect(await database().model('billingSubscriptions').findUnique({ where: { id: f.id } })).toMatchObject({ lastReconcileTaskId: null });
    await a.close(); a = await application();
    await a.get(BillingRuntime).scheduleDue(); const job = await taskFor(f.id); await a.get(JobsHost).runTask(job.id);
    expect(await balance(f.ownerId)).toMatchObject({ balance: 100 });
  });

  it('rejects late financial writes after the original worker loses its lease', async () => {
    const f = await fixture(); await a.get(BillingRuntime).scheduleDue(); const job = await taskFor(f.id);
    const gate = { entered: deferred(), release: deferred() }; gates.set(f.providerId, gate);
    const running = a.get(JobsHost).runTask(job.id); const stopped = running.catch(() => undefined);
    await gate.entered.promise;
    const repo = b.get(JobsService).repository, before = await repo.findById(job.id);
    expect(before?.status).toBe('PROCESSING');
    await pool.query(`UPDATE "${schema}".async_jobs SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.id]);
    await repo.recoverExpiredLease({ id: job.id, leaseToken: before!.leaseToken!, now: new Date(), availableAt: new Date(),
      error: { code: 'LEASE_TEST', category: 'INTERNAL', retryable: true, summary: 'Synthetic worker loss' } });
    await repo.transition({ id: job.id, from: 'RETRYING', to: 'QUEUED', now: new Date() });
    await repo.claim({ id: job.id, workerId: 'new-worker', leaseToken: 'new-lease', now: new Date(), leaseExpiresAt: new Date(Date.now() + 30_000) });
    gate.release.resolve(); await stopped; gates.delete(f.providerId);
    expect(await balance(f.ownerId)).toBeNull(); expect(await database().model('billingSubscriptionCycles').count({ where: { bindingId: f.id } })).toBe(0);
    expect((await repo.findById(job.id))?.leaseToken).toBe('new-lease');
    await repo.cancel(job.id, new Date());
  });

  it('stops automatic replacement after retries exhaust and lets explicit reconciliation recover', async () => {
    const f = await fixture(); failures.add(f.providerId);
    await a.get(BillingRuntime).scheduleDue(); const job = await taskFor(f.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await a.get(JobsHost).runTask(job.id).catch(() => undefined);
      await pool.query(`UPDATE "${schema}".async_jobs SET "availableAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.id]);
    }
    expect((await a.get(JobsService).repository.findById(job.id))?.status).toBe('FAILED');
    expect(await database().model('billingSubscriptions').findUnique({ where: { id: f.id } })).toMatchObject({ reconcileStatus: 'attention' });
    await a.get(BillingRuntime).scheduleDue(); expect(await database().model('asyncJob').count({ where: { resourceId: f.id } })).toBe(1);
    failures.delete(f.providerId); await a.get(BillingService).subscriptions.refresh(f.id, f.ownerId);
    expect(await balance(f.ownerId)).toMatchObject({ balance: 100 });
    expect(await database().model('billingSubscriptions').findUnique({ where: { id: f.id } })).toMatchObject({ reconcileStatus: 'idle', lastReconcileTaskId: null });
  });
});
