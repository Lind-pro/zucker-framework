import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { CreditController } from '@zucker-framework/admin';
import { CreditService, PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { HostedCheckoutService, SubscriptionCycleService } from '@zucker-framework/payment';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOffer, HostedCheckoutOrder, WebhookRequest } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { CHECKOUT_FULFILLED_OUTBOX_KIND, createCheckoutPersistence } from '../src/billing/checkout-persistence';
import { checkoutCreditOperation, createCreditLedger, validateCreditFulfillmentPolicy } from '../src/billing/ledger';
import { createSubscriptionCyclePersistence } from '../src/billing/subscription-persistence';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_billing_${randomUUID().replaceAll('-', '')}`;

/** Synthetic provider facts only. No provider SDK, HTTP request or real payment is used. */
function fakeProvider() {
  const observations = new Map<string, HostedCheckoutObservation>();
  let creations = 0;
  let loseCreateResponse = false;
  const provider: HostedCheckoutAdapter = {
    id: 'synthetic', accountScope: 'synthetic-test-account', modes: ['payment', 'subscription'],
    validate() {},
    async create(order) {
      creations++;
      const observed: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id,
        catalogReference: order.offer.catalogReference, mode: order.offer.mode, quantity: 1,
        state: 'pending', url: `https://synthetic.invalid/checkout/${order.id}` };
      observations.set(observed.checkoutId, observed);
      if (loseCreateResponse) throw new Error('Synthetic create response lost');
      return structuredClone(observed);
    },
    async retrieve(id) {
      const observation = observations.get(id);
      if (!observation) throw new Error('Synthetic checkout missing');
      return structuredClone(observation);
    },
    async verifyWebhook(request) {
      if (request.headers['x-synthetic-signature'] !== 'valid') return null;
      const event = JSON.parse(Buffer.from(request.rawBody).toString('utf8')) as { eventId: string; checkoutId: string; reference: string };
      return event;
    },
  };
  return { provider, observations, creations: () => creations,
    loseResponse: () => { loseCreateResponse = true; },
    paid(order: HostedCheckoutOrder, changes: Partial<HostedCheckoutObservation> = {}) {
      const id = order.checkoutId ?? `checkout-${order.id}`;
      observations.set(id, { ...observations.get(id)!, state: 'paid', paidMoney: order.offer.money,
        paymentId: `payment-${order.id}`, paymentKind: 'payment-intent', ...changes });
    },
    webhook(order: HostedCheckoutOrder): WebhookRequest {
      return { headers: { 'x-synthetic-signature': 'valid' }, rawBody: Buffer.from(JSON.stringify({
        eventId: `event-${order.id}`, checkoutId: order.checkoutId, reference: order.id,
      })) };
    },
  };
}

run('hosted checkout with actual PostgreSQL credit fulfillment', () => {
  let pool: Pool;
  let first: ApplicationDatabase;
  let second: ApplicationDatabase;
  let scopedUrl: string;

  function service(database: ApplicationDatabase, provider: HostedCheckoutAdapter, offer: () => HostedCheckoutOffer) {
    return new HostedCheckoutService({ persistence: createCheckoutPersistence(database), providers: [provider],
      resolveOffer: async () => offer(), returnUrls: id => ({
        successUrl: `https://synthetic.invalid/billing/${id}`, cancelUrl: 'https://synthetic.invalid/billing',
      }) });
  }
  async function fixture(mode: 'payment' | 'subscription' = 'payment') {
    const ownerId = randomUUID();
    await first.model('users').create({ data: { id: ownerId, username: `billing_${ownerId.replaceAll('-', '')}`,
      name: 'Synthetic billing owner', typeId: 'member', email: `${ownerId}@example.invalid`, status: true } });
    const fake = fakeProvider();
    let offer: HostedCheckoutOffer = { version: 'v1', catalogReference: 'synthetic-credits', mode,
      money: { amount: '12.00', currency: 'USD' }, description: 'Synthetic 100 credits',
      fulfillmentData: { credits: 100, expiresInDays: 30, ...(mode === 'subscription' ? { grantBasis: 'period' } : {}) } };
    const a = service(first, fake.provider, () => offer);
    const b = service(second, fake.provider, () => offer);
    const selection = { orderId: randomUUID(), ownerId, offerId: 'credits', providerId: fake.provider.id };
    return { fake, a, b, ownerId, selection, offer: () => offer,
      changeCatalog: () => { offer = { ...offer, version: 'v2', fulfillmentData: { credits: 999, expiresInDays: 1 } }; } };
  }
  async function facts(ownerId: string, orderId: string) {
    const [account, lots, journals, fulfillment, outbox, receipt] = await Promise.all([
      first.model('creditAccount').findUnique({ where: { userId: ownerId } }),
      first.model('creditLots').findMany({ where: { userId: ownerId } }),
      first.model('creditTransaction').findMany({ where: { userId: ownerId }, orderBy: { createdAt: 'asc' } }),
      first.model('billingFulfillments').findUnique({ where: { orderId } }),
      first.model('billingOutbox').findMany({ where: { aggregateId: orderId } }),
      first.model('creditOperationReceipts').findMany({ where: { accountId: ownerId } }),
    ]);
    return { account, lots, journals, fulfillment, outbox, receipt };
  }
  async function failWrites(table: string, work: () => Promise<void>) {
    const allowed = ['credit_operation_receipts', 'credit_lots', 'credit_account', 'credit_transaction',
      'billing_fulfillments', 'billing_outbox', 'credit_allocations'];
    if (!allowed.includes(table)) throw new Error('Unexpected synthetic failure table');
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_billing_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic billing write failure'; END; $$`);
    try {
      await pool.query(`CREATE TRIGGER synthetic_billing_failure BEFORE INSERT OR UPDATE ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_billing_failure()`);
      try { await work(); }
      finally { await pool.query(`DROP TRIGGER synthetic_billing_failure ON "${schema}"."${table}"`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_billing_failure()`); }
  }

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(parsed.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: parsed.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const sql = readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    parsed.searchParams.set('schema', schema);
    scopedUrl = parsed.href;
    first = new ApplicationDatabase(scopedUrl);
    second = new ApplicationDatabase(scopedUrl);
  });

  afterAll(async () => {
    try { await Promise.all([first?.disconnect(), second?.disconnect()]); }
    finally {
      if (pool) {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  });

  it('fulfills once across concurrent webhook/return calls and keeps the frozen policy and Admin read model', async () => {
    const f = await fixture();
    const order = await f.a.create(f.selection);
    f.fake.paid(order);
    f.changeCatalog();
    const results = await Promise.all([
      f.a.confirm({ orderId: order.id, ownerId: f.ownerId }),
      f.b.webhook(f.fake.provider.id, f.fake.webhook(order)),
      f.b.confirm({ orderId: order.id, ownerId: f.ownerId }),
    ]);
    expect(results.every(result => result?.fulfilledAt)).toBe(true);
    const evidence = await facts(f.ownerId, order.id);
    expect(evidence.account).toMatchObject({ balance: 100, frozenBalance: 0 });
    expect(evidence.lots).toHaveLength(1);
    expect(evidence.lots[0]).toMatchObject({ amount: 100, remainingAmount: 100, source: 'purchase', sourceId: order.id });
    expect((evidence.lots[0] as { expiresAt: Date }).expiresAt.getTime())
      .toBe(results[0]!.fulfilledAt!.getTime() + 30 * 86_400_000);
    expect(evidence.journals).toHaveLength(1);
    expect(evidence.journals[0]).toMatchObject({ amount: 100, balance: 100, balanceBefore: 0, balanceAfter: 100,
      ledgerIds: [expect.any(String)] });
    expect(evidence.fulfillment).toMatchObject({ credits: 100, policy: { credits: 100, expiresInDays: 30 } });
    expect(evidence.outbox).toHaveLength(1);
    expect(evidence.receipt).toHaveLength(1);
    const legacyReads = new CreditService(first);
    expect(await legacyReads.getBalance(f.ownerId)).toEqual({ balance: 100, frozenBalance: 0 });
    const admin = new CreditController(legacyReads);
    expect(await admin.queryTransactions({ filter: { userId: f.ownerId } })).toMatchObject({ total: 1,
      data: [expect.objectContaining({ amount: 100, balance: 100 })] });
    expect(await first.model('credits').count()).toBe(0);
    expect(await first.model('creditTransactions').count()).toBe(0);
  });

  it('recovers a lost create response after replacing the database/service, without creating another checkout', async () => {
    const f = await fixture();
    f.fake.loseResponse();
    await expect(f.a.create(f.selection)).rejects.toThrow('Synthetic create response lost');
    const persisted = await f.a.get(f.selection.orderId, f.ownerId);
    expect(persisted).toMatchObject({ creationState: 'submitting', checkoutId: null, fulfilledAt: null });
    f.fake.paid(persisted);
    const replacement = new ApplicationDatabase(scopedUrl);
    try {
      const restarted = service(replacement, f.fake.provider, f.offer);
      const result = await restarted.confirm({ orderId: persisted.id, ownerId: f.ownerId, checkoutId: `checkout-${persisted.id}` });
      expect(result.fulfilledAt).toBeInstanceOf(Date);
      await restarted.confirm({ orderId: persisted.id, ownerId: f.ownerId });
      expect(f.fake.creations()).toBe(1);
      expect((await facts(f.ownerId, persisted.id)).lots).toHaveLength(1);
    } finally { await replacement.disconnect(); }
  });

  it('recovers durable checkout state in new Node processes after the creating process exits', async () => {
    const f = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'zucker-billing-process-'));
    const script = join(directory, 'worker.cjs');
    writeFileSync(script, String.raw`
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const load = createRequire(resolve('package.json'));
load('tsx/cjs'); load('reflect-metadata');
const { ApplicationDatabase } = load('./src/database.ts');
const { createCheckoutPersistence } = load('./src/billing/checkout-persistence.ts');
const { HostedCheckoutService } = load('@zucker-framework/payment');
(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const command = JSON.parse(input);
  const database = new ApplicationDatabase(process.env.TEST_DATABASE_URL);
  const selection = command.selection;
  const provider = { id: selection.providerId, accountScope: 'synthetic-test-account', modes: ['payment'],
    validate() {}, async create() { throw new Error('Synthetic response lost after provider dispatch'); },
    async retrieve(checkoutId) { return { checkoutId, reference: selection.orderId,
      catalogReference: command.offer.catalogReference, mode: 'payment', quantity: 1, state: 'paid',
      paidMoney: command.offer.money, paymentId: 'payment-' + selection.orderId, paymentKind: 'payment-intent' }; },
    async verifyWebhook() { return null; } };
  const service = new HostedCheckoutService({ persistence: createCheckoutPersistence(database), providers: [provider],
    resolveOffer: async () => { if(command.mode !== 'create') throw new Error('Frozen catalog must not be re-read'); return command.offer; },
    returnUrls: () => ({ successUrl:'https://synthetic.invalid/return', cancelUrl:'https://synthetic.invalid/cancel' }) });
  try {
    let order;
    if(command.mode === 'create') {
      try { await service.create(selection); } catch(error) {
        if(error.message !== 'Synthetic response lost after provider dispatch') throw error;
      }
      order = await service.get(selection.orderId, selection.ownerId);
    } else order = await service.confirm({ orderId:selection.orderId, ownerId:selection.ownerId, checkoutId:'checkout-' + selection.orderId });
    process.stdout.write(JSON.stringify({ pid:process.pid, state:order.state, creationState:order.creationState, fulfilled:!!order.fulfilledAt }));
  } finally { await database.disconnect(); }
})().catch(() => { process.stderr.write('Synthetic billing worker failed'); process.exitCode=1; });
`);
    async function worker(mode: 'create' | 'confirm'): Promise<{ pid: number; state: string; creationState: string; fulfilled: boolean }> {
      return new Promise((done, reject) => {
        const child = spawn(process.execPath, [script], { cwd: process.cwd(),
          env: { ...process.env, TEST_DATABASE_URL: scopedUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        // Worker errors are intentionally generic and contain no database configuration.
        child.stderr.resume();
        const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error('Synthetic billing worker did not complete'));
          try { done(JSON.parse(output)); } catch { reject(new Error('Synthetic billing worker returned invalid evidence')); }
        });
        child.stdin.end(JSON.stringify({ mode, selection: f.selection, offer: f.offer() }));
      });
    }
    try {
      const created = await worker('create');
      expect(created).toMatchObject({ creationState: 'submitting', fulfilled: false });
      const resumed = await worker('confirm');
      expect(resumed.pid).not.toBe(created.pid);
      expect(resumed).toMatchObject({ state: 'paid', fulfilled: true });
      const evidence = await facts(f.ownerId, f.selection.orderId);
      expect(evidence.account).toMatchObject({ balance: 100 });
      expect(evidence.lots).toHaveLength(1);
      expect(evidence.receipt).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['credit_operation_receipts', 'credit_lots', 'credit_account', 'credit_transaction', 'billing_fulfillments', 'billing_outbox'])(
    'rolls back paid order, receipt and real credit effects when %s rejects, then retries once', async table => {
      const f = await fixture();
      const order = await f.a.create(f.selection);
      f.fake.paid(order);
      await failWrites(table, async () => {
        await expect(f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toThrow();
        expect(await f.a.get(order.id, f.ownerId)).toMatchObject({ fulfilledAt: null, revision: order.revision });
        expect(await facts(f.ownerId, order.id)).toEqual({ account: null, lots: [], journals: [], fulfillment: null, outbox: [], receipt: [] });
      });
      await f.b.confirm({ orderId: order.id, ownerId: f.ownerId });
      const evidence = await facts(f.ownerId, order.id);
      expect(evidence.account).toMatchObject({ balance: 100 });
      expect(evidence.lots).toHaveLength(1);
      expect(evidence.outbox).toHaveLength(1);
      expect(evidence.receipt).toHaveLength(1);
    });

  it('rejects an orphan operation receipt instead of marking an unfulfilled order successful', async () => {
    const f = await fixture();
    const order = await f.a.create(f.selection);
    await first.transaction(tx => new PostgresCreditOperationCoordinator().prepare(tx, checkoutCreditOperation(order.id, f.ownerId, 100)));
    f.fake.paid(order);
    await expect(f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.a.get(order.id, f.ownerId)).toMatchObject({ fulfilledAt: null, revision: order.revision });
    const evidence = await facts(f.ownerId, order.id);
    expect(evidence.receipt).toHaveLength(1);
    expect(evidence.account).toBeNull();
    expect(evidence.lots).toHaveLength(0);
    expect(evidence.fulfillment).toBeNull();
  });

  it('rejects partial fulfillment evidence rather than issuing a second lot', async () => {
    const f = await fixture();
    const order = await f.a.create(f.selection);
    await first.model('billingOutbox').create({ data: { kind: CHECKOUT_FULFILLED_OUTBOX_KIND, aggregateId: order.id, payload: { synthetic: true } } });
    f.fake.paid(order);
    await expect(f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.a.get(order.id, f.ownerId)).fulfilledAt).toBeNull();
    const evidence = await facts(f.ownerId, order.id);
    expect(evidence.account).toBeNull();
    expect(evidence.lots).toHaveLength(0);
    expect(evidence.receipt).toHaveLength(0);
  });

  it('rejects owner, paid money, checkout reference and credential-scope mismatches without a grant', async () => {
    const f = await fixture();
    const order = await f.a.create(f.selection);
    await expect(f.a.confirm({ orderId: order.id, ownerId: 'another-owner' })).rejects.toMatchObject({ code: 'forbidden' });
    f.fake.paid(order, { paidMoney: { amount: '0.01', currency: 'USD' } });
    await expect(f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toMatchObject({ code: 'verification_failed' });
    f.fake.paid(order, { reference: 'another-order' });
    await expect(f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toMatchObject({ code: 'verification_failed' });
    f.fake.paid(order, { reference: order.id });
    const otherCredentials = service(second, { ...f.fake.provider, accountScope: 'different-account' }, f.offer);
    await expect(otherCredentials.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toMatchObject({ code: 'verification_failed' });
    expect((await facts(f.ownerId, order.id)).lots).toHaveLength(0);
  });

  it('does not fulfill unknown/unpaid observations or invalid notifications', async () => {
    const f = await fixture();
    const order = await f.a.create(f.selection);
    expect((await f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).fulfilledAt).toBeNull();
    const notification = f.fake.webhook(order);
    notification.headers['x-synthetic-signature'] = 'invalid';
    expect(await f.a.webhook(f.fake.provider.id, notification)).toBeNull();
    expect((await facts(f.ownerId, order.id)).receipt).toHaveLength(0);
  });

  it('requires subscription payment evidence and preserves subscription lot provenance', async () => {
    const f = await fixture('subscription'); const order = await f.a.create(f.selection);
    f.fake.paid(order);
    expect((await f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).fulfilledAt).toBeNull();
    expect((await facts(f.ownerId, order.id)).lots).toHaveLength(0);
    f.fake.paid(order, { subscriptionId: 'synthetic-subscription' });
    await f.a.confirm({ orderId: order.id, ownerId: f.ownerId });
    expect((await facts(f.ownerId, order.id)).lots).toHaveLength(0);
    expect(await first.model('billingSubscriptions').findUnique({ where: { id: order.id } })).toMatchObject({
      ownerId: f.ownerId, providerSubscriptionId: 'synthetic-subscription', initialFulfilledAt: null,
    });
    await new SubscriptionCycleService(createSubscriptionCyclePersistence(first)).apply({ bindingId: order.id,
      ownerId: f.ownerId, providerId: f.fake.provider.id, accountScope: f.fake.provider.accountScope,
      payment: { recordId: `payment-${order.id}`, subscriptionId: 'synthetic-subscription',
        catalogReference: order.offer.catalogReference, paidMoney: order.offer.money,
        paymentId: `payment-${order.id}`, paymentKind: 'payment-intent', paidAt: '2026-10-01T00:00:00Z',
        period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } },
    });
    expect((await facts(f.ownerId, order.id)).lots).toEqual([expect.objectContaining({ source: 'subscription', amount: 100 })]);
  });

  it('preserves ownership predicates in CAS and refuses frozen identity changes', async () => {
    const f = await fixture(); const order = await f.a.create(f.selection);
    const orders = createCheckoutPersistence(first).orders;
    expect(await orders.compareAndSet(order.id, { revision: order.revision, ownerId: 'different-owner' },
      { state: 'unpaid', revision: order.revision + 1 })).toBe(false);
    await expect(orders.compareAndSet(order.id, { revision: order.revision }, { ownerId: 'different-owner' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await f.a.get(order.id, f.ownerId)).toMatchObject({ ownerId: f.ownerId, revision: order.revision });
  });

  it('records historical subscription credit expiry atomically instead of reviving expired purchasing power', async () => {
    const f = await fixture('subscription'), order = await f.a.create(f.selection), subscriptionId = `historical-${randomUUID()}`;
    f.fake.paid(order, { subscriptionId });
    await f.a.confirm({ orderId: order.id, ownerId: f.ownerId });
    const service = new SubscriptionCycleService(createSubscriptionCyclePersistence(first));
    const payment = { recordId: `payment-${order.id}`, subscriptionId, catalogReference: order.offer.catalogReference,
      paidMoney: order.offer.money, paymentId: `payment-${order.id}`, paymentKind: 'payment-intent' as const,
      paidAt: '2000-01-01T00:00:00Z', period: { start: '2000-01-01T00:00:00Z', end: '2000-02-01T00:00:00Z' } };
    const input = { bindingId: order.id, ownerId: f.ownerId, providerId: f.fake.provider.id,
      accountScope: f.fake.provider.accountScope, payment };
    expect((await service.apply(input)).granted).toBe(true);
    const settled = await facts(f.ownerId, order.id);
    expect(settled.account).toMatchObject({ balance: 0 });
    expect(settled.lots).toEqual([expect.objectContaining({ amount: 100, remainingAmount: 0, isExpired: true })]);
    expect(settled.journals).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'GRANT', amount: 100 }), expect.objectContaining({ type: 'EXPIRE', amount: -100 }),
    ]));
    expect((await service.apply(input)).granted).toBe(false);
    expect((await facts(f.ownerId, order.id)).journals).toHaveLength(2);
  });

  it('enforces unique provider payment identity across orders before a second fulfillment', async () => {
    const a = await fixture(); const b = await fixture();
    const orderA = await a.a.create(a.selection); const orderB = await b.a.create(b.selection);
    a.fake.paid(orderA, { paymentId: 'same-synthetic-payment' });
    b.fake.paid(orderB, { paymentId: 'same-synthetic-payment' });
    await a.a.confirm({ orderId: orderA.id, ownerId: a.ownerId });
    await expect(b.a.confirm({ orderId: orderB.id, ownerId: b.ownerId })).rejects.toThrow();
    expect((await facts(b.ownerId, orderB.id)).lots).toHaveLength(0);
    expect((await b.a.get(orderB.id, b.ownerId)).fulfilledAt).toBeNull();
  });

  it('spends actual granted lots under the same lock and prevents concurrent overdraft', async () => {
    const f = await fixture(); const order = await f.a.create(f.selection);
    f.fake.paid(order); await f.a.confirm({ orderId: order.id, ownerId: f.ownerId });
    const request = { accountId: f.ownerId, amount: 70, transactionData: { type: 'CONSUME', description: 'Synthetic spend' },
      consumptionData: { resourceType: 'synthetic', resourceId: order.id } };
    const outcomes = await Promise.allSettled([
      first.transaction(tx => createCreditLedger(first).consume(tx, request)),
      second.transaction(tx => createCreditLedger(second).consume(tx, request)),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { required: 70, available: 30 } });
    const evidence = await facts(f.ownerId, order.id);
    expect(evidence.account).toMatchObject({ balance: 30 });
    expect(evidence.lots).toEqual([expect.objectContaining({ remainingAmount: 30 })]);
    expect(evidence.journals).toHaveLength(2);
    expect(await first.model('creditConsumptions').count({ where: { userId: f.ownerId } })).toBe(1);
  });

  it('rolls back lot deductions, canonical balance and consumption when allocation persistence fails', async () => {
    const f = await fixture(); const order = await f.a.create(f.selection);
    f.fake.paid(order); await f.a.confirm({ orderId: order.id, ownerId: f.ownerId });
    await failWrites('credit_allocations', async () => {
      await expect(first.transaction(tx => createCreditLedger(first).consume(tx, {
        accountId: f.ownerId, amount: 10, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' },
      }))).rejects.toThrow();
    });
    const evidence = await facts(f.ownerId, order.id);
    expect(evidence.account).toMatchObject({ balance: 100 });
    expect(evidence.lots).toEqual([expect.objectContaining({ remainingAmount: 100 })]);
    expect(evidence.journals).toHaveLength(1);
    expect(await first.model('creditConsumptions').count({ where: { userId: f.ownerId } })).toBe(0);
  });

  it('validates the consumer credit policy and rejects a corrupt frozen policy transactionally', async () => {
    for (const policy of [{ credits: 0 }, { credits: 1.5 }, { credits: 100, expiresInDays: 0 }, { credits: 100, other: true }])
      expect(() => validateCreditFulfillmentPolicy(policy)).toThrow();
    const f = await fixture(); const order = await f.a.create(f.selection);
    await first.model('billingOrders').update({ where: { id: order.id }, data: { offer: { ...order.offer, fulfillmentData: { credits: -1 } } } });
    f.fake.paid(order);
    await expect(f.a.confirm({ orderId: order.id, ownerId: f.ownerId })).rejects.toThrow('Invalid credit fulfillment policy');
    expect((await facts(f.ownerId, order.id)).receipt).toHaveLength(0);
    expect((await f.a.get(order.id, f.ownerId)).fulfilledAt).toBeNull();
  });
});
