import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import type { HostedCheckoutOffer, HostedCheckoutOrder, SubscriptionAdapter, SubscriptionDetails,
  SubscriptionPaidPeriod, SubscriptionPaidPeriodPage, SubscriptionPaidReceiptPage } from '@zucker-framework/payment';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { BillingService } from '../src/billing/billing.service';
import { BillingSubscriptionsService } from '../src/billing/subscriptions.service';
import { BillingSubscriptionsController } from '../src/billing/subscriptions.controller';
import { bindCheckoutSubscription, type BillingSubscription } from '../src/billing/subscription-persistence';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_subscription_http_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4202', password = 'SyntheticUser9!';
const start = '2026-10-01T00:00:00.000Z', end = '2026-11-01T00:00:00.000Z';

/** Actual PostgreSQL, Nest HTTP, guards and credit ledger; provider IO is synthetic only. */
run('subscription HTTP and durable reconciliation contract', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, second: ApplicationDatabase, scopedUrl: string;
  let service: BillingSubscriptionsService;
  let owner: { id: string; token: string }, other: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const facts = new Map<string, SubscriptionDetails>();
  const pages = new Map<string, SubscriptionPaidPeriodPage[]>();
  const receiptPages = new Map<string, SubscriptionPaidReceiptPage[]>();
  const cancelCalls: string[] = [], retrieveCalls: string[] = [], invoiceCalls: string[] = [], portalCalls: string[] = [];
  const invoiceFacts = new Map<string, { subscriptionId: string; customerId: string }>();
  const cancelErrors = new Set<string>();
  let invoiceForeign = false, receivedBytes: string | undefined;
  let retrieveOverride: ((id: string) => Promise<SubscriptionDetails> | undefined) | undefined;
  const makeAdapter = (id: 'stripe' | 'paypal'): SubscriptionAdapter => ({ id, accountScope: `synthetic-${id}`,
    capabilities: { cancel: id === 'stripe' ? ['immediate', 'period_end'] : ['immediate'], billingPortal: id === 'stripe', invoices: id === 'stripe',
      paidPeriodProof: id === 'stripe' ? 'provider' : 'unavailable', paidReceiptProof: id === 'paypal' ? 'provider' : 'unavailable' },
    async retrieve(subscriptionId) {
      retrieveCalls.push(subscriptionId);
      const overridden = retrieveOverride?.(subscriptionId); if (overridden) return overridden;
      const value = facts.get(subscriptionId); if (!value) throw new Error('SYNTHETIC_PRIVATE_PROVIDER_SECRET'); return structuredClone(value);
    },
    async listPaidPeriods(subscriptionId, options) {
      const index = options?.cursor ? Number(options.cursor) : 0;
      return structuredClone(pages.get(subscriptionId)?.[index] ?? { data: [] });
    },
    async listPaidReceipts(subscriptionId, options) {
      const index = options?.cursor ? Number(options.cursor) : 0;
      return structuredClone(receiptPages.get(subscriptionId)?.[index] ?? { data: [] });
    },
    async cancel(subscriptionId, options) {
      cancelCalls.push(subscriptionId);
      if (cancelErrors.has(subscriptionId)) throw new Error('SYNTHETIC_PRIVATE_PROVIDER_SECRET');
      const current = facts.get(subscriptionId)!;
      const updated = options.mode === 'period_end' ? { ...current, cancelAtPeriodEnd: true } : { ...current, status: 'canceled' as const, providerStatus: 'canceled' };
      facts.set(subscriptionId, updated); return structuredClone(updated);
    },
    async createBillingPortal(input) { portalCalls.push(input.customerId); return { url: 'https://billing.synthetic.invalid/customer' }; },
    async retrieveInvoice(paymentId) {
      invoiceCalls.push(paymentId); const identity = invoiceFacts.get(paymentId)!;
      return { id: paymentId, subscriptionId: invoiceForeign ? 'foreign' : identity.subscriptionId, customerId: identity.customerId,
        status: 'paid', paidMoney: { amount: '12.00', currency: 'USD' }, url: 'https://invoice.synthetic.invalid/receipt' };
    },
    async verifyWebhook(input) {
      receivedBytes = Buffer.from(input.rawBody).toString('utf8');
      if (input.headers['x-synthetic-signature'] !== 'valid') return null;
      return JSON.parse(receivedBytes) as { eventId: string; subscriptionId: string };
    },
  });
  const adapters = [makeAdapter('stripe'), makeAdapter('paypal')];
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  async function startApp() {
    const db = new ApplicationDatabase(scopedUrl);
    const subscriptions = new BillingSubscriptionsService(db, adapters, origin);
    const module = await Test.createTestingModule({ imports: [
      ZuckerCrudModule.forRootAsync({ useFactory: () => db }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-subscription-http-secret-long-only', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 2000, duration: 60 }, 'session-refresh': { points: 2000, duration: 60 }, 'session-refresh-network': { points: 2000, duration: 60 }, 'session-read': { points: 2000, duration: 60 }, 'api-default': { points: 2000, duration: 60 }, billing: { points: 2000, duration: 60 } } }), AccountModule,
    ], controllers: [BillingSubscriptionsController], providers: [{ provide: BillingService, useValue: { subscriptions } },
      { provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    const instance = module.createNestApplication({ rawBody: true }); instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init(); return { app: instance, service: subscriptions };
  }
  async function member(username: string) {
    const email = `${username}@example.invalid`;
    const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await post('register', { username, email, password }).expect(201);
    await post('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const login = await post('login', { username, password }).expect(200);
    return { id: login.body.userId as string, token: login.body.token as string };
  }
  const get = (path = '', token = owner.token) => request(app.getHttpServer()).get(`/api/billing/subscriptions${path}`).set('Authorization', `Bearer ${token}`);
  const post = (path: string, body: object = {}, token = owner.token) => request(app.getHttpServer()).post(`/api/billing/subscriptions/${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send(body);
  async function fixture(providerId: 'stripe' | 'paypal' = 'stripe', selectedOwner = owner.id) {
    const id = randomUUID(), providerSubscriptionId = `sub-${id}`, customerId = `customer-${id}`;
    const offer: HostedCheckoutOffer = { version: 'v1', catalogReference: `catalog-${providerId}`, mode: 'subscription', money: { amount: '12.00', currency: 'USD' },
      description: 'Synthetic subscription', fulfillmentData: { credits: 100, expiresInDays: null, grantBasis: providerId === 'paypal' ? 'payment' : 'period' } };
    const data = { id, ownerId: selectedOwner, offerId: 'subscription-credits', providerId, accountScope: `synthetic-${providerId}`, offer,
      successUrl: `${origin}/billing`, cancelUrl: `${origin}/billing`, createKey: `create-${id}`, captureKey: `capture-${id}`,
      creationState: 'created', captureState: 'idle', state: 'paid', checkoutId: `checkout-${id}`, subscriptionId: providerSubscriptionId,
      paymentId: `payment-${id}-1`, paymentKind: providerId === 'stripe' ? 'invoice' : 'transaction', fulfilledAt: new Date() };
    const order = await database.model('billingOrders').create({ data }) as HostedCheckoutOrder;
    await database.transaction(tx => bindCheckoutSubscription(tx, order));
    const observation: SubscriptionDetails = { provider: providerId, subscriptionId: providerSubscriptionId, customerId, catalogReference: offer.catalogReference,
      status: 'active', providerStatus: 'active', ...(providerId === 'stripe' ? { period: { start, end } } : {}), payment: { settlement: 'unknown' } };
    facts.set(providerSubscriptionId, observation);
    const paid: SubscriptionPaidPeriod = { recordId: `receipt-${id}-1`, subscriptionId: providerSubscriptionId, catalogReference: offer.catalogReference,
      period: { start, end }, paidMoney: offer.money, paymentId: data.paymentId, paymentKind: providerId === 'stripe' ? 'invoice' : 'transaction', paidAt: start };
    invoiceFacts.set(paid.paymentId, { subscriptionId: providerSubscriptionId, customerId });
    pages.set(providerSubscriptionId, [{ data: [paid] }]);
    const { period: _period, ...receipt } = paid;
    receiptPages.set(providerSubscriptionId, [{ data: [receipt] }]);
    return { id, providerSubscriptionId, customerId, observation, paid, receipt, ownerId: selectedOwner };
  }
  async function cycleFacts(id: string) {
    const cycles = await database.model('billingSubscriptionCycles').findMany({ where: { bindingId: id } }) as Array<{ id: string; initial: boolean; periodStart: Date | null }>;
    const ids = cycles.map(cycle => cycle.id);
    return { cycles, lots: await database.model('creditLots').findMany({ where: { source: 'subscription', sourceId: { in: ids } } }),
      fulfillment: await database.model('billingFulfillments').findUnique({ where: { orderId: id } }),
      events: await database.model('billingOutbox').findMany({ where: { kind: 'billing.subscription-credit-fulfilled', aggregateId: { in: ids } } }) };
  }
  async function failedWrite(work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_subscription_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic subscription ledger failure'; END; $$`);
    try {
      await pool.query(`CREATE TRIGGER synthetic_subscription_failure BEFORE INSERT ON "${schema}".credit_lots FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_subscription_failure()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER synthetic_subscription_failure ON "${schema}".credit_lots`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_subscription_failure()`); }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href;
    database = new ApplicationDatabase(scopedUrl); second = new ApplicationDatabase(scopedUrl);
    ({ app, service } = await startApp()); owner = await member('subscriptionowner'); other = await member('subscriptionother');
  });
  afterAll(async () => {
    try { await app?.close(); await Promise.all([database?.disconnect(), second?.disconnect()]); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('authenticates all private endpoints and rejects foreign ownership before provider IO', async () => {
    const f = await fixture(), before = retrieveCalls.length;
    for (const suffix of ['', `/${f.id}`, `/${f.id}/invoices`]) await request(app.getHttpServer()).get(`/api/billing/subscriptions${suffix}`).expect(401);
    await get(`/${f.id}`, other.token).expect(403); await get(`/${f.id}/invoices`, other.token).expect(403);
    for (const path of ['refresh', 'portal']) await post(`${f.id}/${path}`, {}, other.token).expect(403);
    await post(`${f.id}/cancel`, { mode: 'immediate' }, other.token).expect(403);
    expect(retrieveCalls.length).toBe(before); expect(cancelCalls).not.toContain(f.providerSubscriptionId);
  });
  it('rejects cross-site requests and arbitrary customer/invoice/owner/money parameters', async () => {
    const f = await fixture();
    await post(`${f.id}/refresh`).set('Origin', 'https://evil.invalid').expect(403);
    await post(`${f.id}/cancel`, { mode: 'immediate' }).set('Sec-Fetch-Site', 'cross-site').expect(403);
    for (const body of [{ customerId: 'foreign' }, { invoiceId: 'foreign' }, { ownerId: other.id }, { money: '0.01' }]) await post(`${f.id}/portal`, body).expect(400);
    await post(`${f.id}/cancel`, {}).expect(400); await post(`${f.id}/cancel`, { mode: 'immediate', ownerId: other.id }).expect(400);
    expect(cancelCalls).not.toContain(f.providerSubscriptionId);
  });
  it('lists only owned bindings and publishes capabilities without private provider/policy fields', async () => {
    const mine = await fixture(), theirs = await fixture('stripe', other.id);
    const page = await get().expect(200); expect(page.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(page.body.data.some((row: { id: string }) => row.id === mine.id)).toBe(true);
    expect(page.body.data.some((row: { id: string }) => row.id === theirs.id)).toBe(false);
    expect(JSON.stringify(page.body)).not.toMatch(/accountScope|providerSubscriptionId|customerId|initialPaymentId|fulfillmentData/);
    expect((await get(`/${mine.id}`).expect(200)).body.capabilities).toMatchObject({ refresh: true, billingPortal: false, cancel: ['immediate', 'period_end'] });
    await get('?page=0').expect(400); await get('?page=1.5').expect(400);
  });
  it('grants initial and offline renewal periods once and records initial fulfillment from matching payment identity', async () => {
    const f = await fixture(); expect((await cycleFacts(f.id)).cycles).toHaveLength(0);
    const renewal = { ...f.paid, recordId: `renewal-${f.id}`, paymentId: `renewal-${f.id}`, paidAt: end,
      period: { start: end, end: '2026-12-01T00:00:00.000Z' } };
    invoiceFacts.set(renewal.paymentId, { subscriptionId: f.providerSubscriptionId, customerId: f.customerId });
    pages.set(f.providerSubscriptionId, [{ data: [renewal], nextCursor: '1' }, { data: [f.paid] }]);
    const confirmed = await post(`${f.id}/refresh`).expect(200); expect(confirmed.body.initialFulfilledAt).toBeTruthy();
    await post(`${f.id}/refresh`).expect(200);
    const evidence = await cycleFacts(f.id); expect(evidence.cycles).toHaveLength(2); expect(evidence.lots).toHaveLength(2); expect(evidence.events).toHaveLength(2);
    expect(evidence.cycles.filter(row => row.initial)).toHaveLength(1); expect(evidence.fulfillment).toMatchObject({ credits: 100 });
  });
  it('does not mark the initial order fulfilled merely because a later paid period was recovered', async () => {
    const f = await fixture(); pages.set(f.providerSubscriptionId, [{ data: [{ ...f.paid, paymentId: `later-${f.id}`, recordId: `later-${f.id}`, period: { start: end, end: '2026-12-01T00:00:00.000Z' }, paidAt: end }] }]);
    expect((await post(`${f.id}/refresh`).expect(200)).body.initialFulfilledAt).toBeNull();
    expect((await cycleFacts(f.id)).fulfillment).toBeNull();
  });
  it('uses explicit PayPal per-payment receipt policy without fabricating periods or double-granting replays', async () => {
    const f = await fixture('paypal');
    receiptPages.set(f.providerSubscriptionId, [{ data: [f.receipt], nextCursor: '1' }, { data: [f.receipt, { ...f.receipt, paymentId: `sale-2-${f.id}`, recordId: `sale-2-${f.id}`, paidAt: end }] }]);
    const result = await post(`${f.id}/refresh`).expect(200); expect(result.body).toMatchObject({ grantBasis: 'payment', currentPeriod: null });
    await post(`${f.id}/refresh`).expect(200);
    const evidence = await cycleFacts(f.id); expect(evidence.cycles).toHaveLength(2); expect(evidence.cycles.every(row => row.periodStart === null)).toBe(true);
    expect(evidence.lots).toHaveLength(2); await post(`${f.id}/cancel`, { mode: 'period_end' }).expect(400);
  });
  it('refuses incomplete evidence, cyclic pages and wrong money before any receipt grant', async () => {
    const f = await fixture();
    pages.set(f.providerSubscriptionId, [{ data: [f.paid], issues: [{ recordId: 'missing', code: 'missing_period' }] }]);
    await post(`${f.id}/refresh`).expect(409);
    pages.set(f.providerSubscriptionId, [{ data: [f.paid], nextCursor: '1' }, { data: [], nextCursor: '1' }]);
    await post(`${f.id}/refresh`).expect(409);
    pages.set(f.providerSubscriptionId, [{ data: [f.paid], nextCursor: '1' }, { data: [{ ...f.paid, paymentId: 'wrong-money', paidMoney: { amount: '0.01', currency: 'USD' } }] }]);
    await post(`${f.id}/refresh`).expect(409); expect((await cycleFacts(f.id)).cycles).toHaveLength(0);
  });
  it('rolls back receipt, lot and fulfillment on actual PostgreSQL write failure and retries safely', async () => {
    const f = await fixture();
    await failedWrite(async () => { await post(`${f.id}/refresh`).expect(503); expect(await cycleFacts(f.id)).toEqual({ cycles: [], lots: [], fulfillment: null, events: [] }); });
    await post(`${f.id}/refresh`).expect(200); await post(`${f.id}/refresh`).expect(200);
    expect((await cycleFacts(f.id)).lots).toHaveLength(1);
  });
  it('concurrent refreshed pages cannot duplicate ledger effects', async () => {
    const f = await fixture(), concurrent = new BillingSubscriptionsService(second, adapters, origin);
    const outcomes = await Promise.allSettled([service.refresh(f.id, owner.id), concurrent.refresh(f.id, owner.id)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    await concurrent.refresh(f.id, owner.id); expect((await cycleFacts(f.id)).lots).toHaveLength(1);
  });
  it('a slow provider read cannot replace newer lifecycle state', async () => {
    const f = await fixture(); pages.set(f.providerSubscriptionId, [{ data: [] }]);
    let release!: (value: SubscriptionDetails) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    retrieveOverride = id => { if (id !== f.providerSubscriptionId) return undefined; retrieveOverride = undefined; entered(); return new Promise(resolve => { release = resolve; }); };
    const stale = service.refresh(f.id, owner.id).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await started; facts.set(f.providerSubscriptionId, { ...f.observation, status: 'paused', providerStatus: 'paused' });
    try { await new BillingSubscriptionsService(second, adapters, origin).refresh(f.id, owner.id); }
    finally { release(f.observation); }
    expect((await stale).error).toMatchObject({ code: 'conflict' });
    expect((await get(`/${f.id}`).expect(200)).body.status).toBe('paused');
  });
  it('persists unknown cancellation across restart and only reads on retry', async () => {
    const f = await fixture(); cancelErrors.add(f.providerSubscriptionId);
    const failure = await post(`${f.id}/cancel`, { mode: 'immediate' }).expect(503); expect(JSON.stringify(failure.body)).not.toContain('SYNTHETIC_PRIVATE');
    expect((await get(`/${f.id}`).expect(200)).body.cancelState).toBe('submitting');
    await app.close(); ({ app, service } = await startApp());
    await post(`${f.id}/cancel`, { mode: 'immediate' }).expect(200);
    expect((await get(`/${f.id}`).expect(200)).body.cancelState).toBe('submitting');
    facts.set(f.providerSubscriptionId, { ...f.observation, status: 'canceled', providerStatus: 'canceled' });
    const confirmed = await post(`${f.id}/cancel`, { mode: 'immediate' }).expect(200); expect(confirmed.body.cancelState).toBe('confirmed');
    expect(cancelCalls.filter(id => id === f.providerSubscriptionId)).toHaveLength(1);
  });
  it('one concurrent cancellation owns the external mutation and scheduled facts stay explicit', async () => {
    const f = await fixture();
    const results = await Promise.all([post(`${f.id}/cancel`, { mode: 'period_end' }), post(`${f.id}/cancel`, { mode: 'period_end' })]);
    expect(results.every(result => [200, 409].includes(result.status))).toBe(true);
    expect(cancelCalls.filter(id => id === f.providerSubscriptionId)).toHaveLength(1);
    expect((await get(`/${f.id}`).expect(200)).body).toMatchObject({ cancelAtPeriodEnd: true, cancelState: 'confirmed', status: 'active' });
  });
  it('serves only bound invoice/customer portal links and rejects cross-subscription invoice evidence', async () => {
    const f = await fixture(); await post(`${f.id}/refresh`).expect(200);
    const invoicePage = await get(`/${f.id}/invoices`).expect(200); expect(invoicePage.body.data[0].url).toBe('https://invoice.synthetic.invalid/receipt');
    expect(invoiceCalls).toContain(f.paid.paymentId);
    await post(`${f.id}/portal`).expect(200); expect(portalCalls).toContain(f.customerId);
    invoiceForeign = true; try { await get(`/${f.id}/invoices`).expect(409); } finally { invoiceForeign = false; }
    await get(`/${f.id}/invoices?page=-1`).expect(400);
  });
  it('verifies raw webhook correlation in the configured namespace and deduplicates replayed payments', async () => {
    const f = await fixture(); const bytes = `{ "eventId": "event-${f.id}", "subscriptionId": "${f.providerSubscriptionId}" }\n`;
    expect(await service.handleWebhook('stripe', { rawBody: bytes, headers: {} })).toBe(false);
    expect((await cycleFacts(f.id)).cycles).toHaveLength(0);
    expect(await service.handleWebhook('paypal', { rawBody: bytes, headers: { 'x-synthetic-signature': 'valid' } })).toBe(false);
    expect(await service.handleWebhook('stripe', { rawBody: bytes, headers: { 'x-synthetic-signature': 'valid' } })).toBe(true);
    expect(receivedBytes).toBe(bytes);
    expect(await service.handleWebhook('stripe', { rawBody: bytes, headers: { 'x-synthetic-signature': 'valid' } })).toBe(true);
    expect((await cycleFacts(f.id)).lots).toHaveLength(1);
  });
  it('enforces database immutability and requires advancing revisions', async () => {
    const f = await fixture();
    await expect(database.transaction(tx => tx.model('billingSubscriptions').update({ where: { id: f.id }, data: { ownerId: other.id, revision: { increment: 1 } } }))).rejects.toThrow('immutable');
    await expect(database.transaction(tx => tx.model('billingSubscriptions').update({ where: { id: f.id }, data: { status: 'active' } }))).rejects.toThrow('revision');
    const binding = await database.model('billingSubscriptions').findUnique({ where: { id: f.id } }) as BillingSubscription;
    expect(binding.ownerId).toBe(owner.id); expect(binding.revision).toBe(0);
  });
  it('runs schema-qualified ORM writes outside transactions and rejects a foreign direct binding at the database boundary', async () => {
    const f = await fixture();
    // Prisma qualifies the target table; the trigger must resolve its own tables independently of search_path.
    const changed = await database.model('billingSubscriptions').updateMany({ where: { id: f.id, revision: 0 },
      data: { status: 'active', revision: { increment: 1 } } });
    expect(changed.count).toBe(1);
    const binding = await database.model('billingSubscriptions').findUnique({ where: { id: f.id } }) as BillingSubscription;
    expect(binding.revision).toBe(1);
    await expect(database.model('billingSubscriptions').create({ data: { ...binding, id: randomUUID(), ownerId: other.id } })).rejects.toThrow('original verified order');
    await expect(database.model('billingSubscriptions').updateMany({ where: { id: f.id, revision: 1 },
      data: { ownerId: other.id, revision: { increment: 1 } } })).rejects.toThrow('immutable');
    expect((await database.model('billingSubscriptions').findUnique({ where: { id: f.id } }) as BillingSubscription).ownerId).toBe(owner.id);
  });
});
