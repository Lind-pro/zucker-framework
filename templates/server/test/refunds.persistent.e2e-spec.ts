import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { RefundProtocolError } from '@zucker-framework/payment';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOrder, RefundAdapter, RefundCommand, RefundObservation,
  RefundPaymentObservation, RefundWebhookEvent, SubscriptionAdapter, SubscriptionPaidPeriod } from '@zucker-framework/payment';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '@zucker-framework/back-office/accounts';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { BILLING_OPTIONS, BillingService, type BillingOptions } from '../src/billing/billing.service';
import { BillingController } from '../src/billing/billing.controller';
import { BillingRefundsController } from '../src/billing/refunds/refunds.controller';
import { createCreditLedger } from '../src/billing/ledger';
import { readCreditBalance } from '../src/credits/credits.service';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_refunds_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const money = (amount: string) => ({ amount, currency: 'USD' });
const cents = (amount: string) => Math.round(Number(amount) * 100);
const major = (amount: number) => (amount / 100).toFixed(2);
run('refund cash, receipt and exact credit-hold PostgreSQL HTTP contract', () => {
  let app: INestApplication, database: ApplicationDatabase, pool: Pool, billing: BillingService, scopedUrl: string;
  let admin: { id: string; token: string }, member: { id: string; token: string };
  const deliveries = new Map<string, string>(), orders = new Map<string, HostedCheckoutOrder>(), checkouts = new Map<string, HostedCheckoutObservation>();
  const payments = new Map<string, RefundPaymentObservation>(), refunds = new Map<string, RefundObservation>(), creates: RefundCommand[] = [];
  const modes = new Map<string, 'pending' | 'lost' | 'rejected' | 'status-only'>(), periods = new Map<string, SubscriptionPaidPeriod[]>();
  const sourceId = (id: string, provider: string) => provider === 'stripe' ? `charge-${id}` : id;
  const paymentId = (order: HostedCheckoutOrder) => `${order.offer.mode === 'subscription' && order.providerId === 'stripe' ? 'invoice' : 'payment'}-${order.id}`;
  function hosted(id: string): HostedCheckoutAdapter {
    return { id, accountScope: `synthetic-${id}`, modes: ['payment', 'subscription'], validate() {},
      async create(order) {
        orders.set(order.id, structuredClone(order)); const checkoutId = `checkout-${order.id}`;
        const initial = { checkoutId, reference: order.id, catalogReference: order.offer.catalogReference, quantity: 1, mode: order.offer.mode, state: 'pending' as const, url: 'https://synthetic.invalid/checkout' };
        checkouts.set(checkoutId, initial); return initial;
      },
      async retrieve(id) { return structuredClone(checkouts.get(id)!); }, async verifyWebhook() { return null; } };
  }
  function refundAdapter(id: string): RefundAdapter {
    return { id, accountScope: `synthetic-${id}`, capabilities: { paymentKinds: id === 'stripe' ? ['payment-intent', 'invoice'] : ['transaction'], partial: id !== 'creem', requestIdempotency: id === 'creem' ? 'none' : 'provider', retrieveRefund: id !== 'creem', listRefunds: id === 'stripe' },
      async retrievePayment(payment) { const value = payments.get(payment.paymentId); if (!value) throw new Error('Synthetic payment unavailable'); return structuredClone(value); },
      ...(id === 'stripe' ? { async listRefunds(payment) { return { data: [...refunds.values()].filter(row => row.paymentId === payment.paymentId).map(row => structuredClone(row)) }; } } : {}),
      ...(id !== 'creem' ? { async retrieve(refundId) { return structuredClone(refunds.get(refundId)!); } } : {}),
      async create(command) {
        creates.push(structuredClone(command)); const paid = payments.get(command.payment.paymentId)!;
        if (modes.get(command.payment.paymentId) === 'rejected') throw new RefundProtocolError('transport_error', 'Synthetic rejected refund', 'rejected');
        const state = modes.get(command.payment.paymentId) === 'pending' ? 'pending' : 'succeeded';
        const refund: RefundObservation = { refundId: `refund-${command.commandKey}`, paymentId: command.payment.paymentId, paymentKind: command.payment.paymentKind,
          source: paid.source, state, providerStatus: state, money: command.money, commandKey: command.commandKey, occurredAt: new Date().toISOString() };
        refunds.set(refund.refundId!, refund);
        if (state === 'succeeded') paid.refundedMoney = { ...paid.paidMoney, amount: major(cents(paid.refundedMoney?.amount ?? '0') + cents(command.money.amount)) };
        else paid.pendingRefundMoney = { ...paid.paidMoney, amount: major(cents(paid.pendingRefundMoney?.amount ?? '0') + cents(command.money.amount)) };
        paid.settlement = cents(paid.refundedMoney?.amount ?? '0') === cents(paid.paidMoney.amount) ? 'refunded' : cents(paid.refundedMoney?.amount ?? '0') ? 'partially_refunded' : 'paid';
        if (modes.get(command.payment.paymentId) === 'lost') throw new RefundProtocolError('transport_error', 'Synthetic accepted response lost');
        if (modes.get(command.payment.paymentId) === 'status-only') return { ...refund, refundId: undefined, state: 'unknown', money: undefined, providerStatus: 'succeeded' };
        return structuredClone(refund);
      },
      async verifyWebhook(input) {
        if (input.headers['x-synthetic-signature'] !== 'valid') throw new RefundProtocolError('verification_failed', 'Synthetic signature rejected');
        return JSON.parse(Buffer.from(input.rawBody).toString('utf8')) as RefundWebhookEvent;
      } };
  }
  const providers = ['stripe', 'paypal', 'creem'].map(hosted), refundProviders = ['stripe', 'paypal', 'creem'].map(refundAdapter);
  const subscriptions: SubscriptionAdapter = { id: 'stripe', accountScope: 'synthetic-stripe', capabilities: { cancel: [], billingPortal: false, invoices: false, paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' },
    async retrieve(id) { const order = [...orders.values()].find(row => `subscription-${row.id}` === id)!; return { provider: 'stripe', subscriptionId: id, customerId: `customer-${order.ownerId}`, catalogReference: order.offer.catalogReference, status: 'active', providerStatus: 'active', payment: { settlement: 'paid' } }; },
    async listPaidPeriods(id) { return { data: structuredClone(periods.get(id) ?? []) }; }, async cancel() { throw new Error('Unused'); } };
  const options: BillingOptions = { providers, refundProviders, subscriptionProviders: [subscriptions], webUrl: origin, catalogJson: JSON.stringify([
    { id: 'credits', title: 'Synthetic 101 credits', version: 'v1', mode: 'payment', amount: '29.00', currency: 'USD', credits: 101, expiresInDays: null, providers: { stripe: 'sku', paypal: 'sku', creem: 'sku' } },
    { id: 'zero-decimal', title: 'Synthetic zero-decimal payment', version: 'v1', mode: 'payment', amount: '29', currency: 'JPY', credits: 101, expiresInDays: null, providers: { creem: 'jpy-sku' } },
    { id: 'subscription', title: 'Synthetic recurring 101 credits', version: 'v1', mode: 'subscription', amount: '29.00', currency: 'USD', credits: 101, expiresInDays: null, providers: { stripe: 'plan' } },
  ]) };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  async function startApp() {
    const db = new ApplicationDatabase(scopedUrl);
    const module = await Test.createTestingModule({ imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => db }), ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-refunds-contract-only-long-secret', registerControllers: false }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 3000, duration: 60 }, 'session-refresh': { points: 3000, duration: 60 }, 'session-refresh-network': { points: 3000, duration: 60 }, 'session-read': { points: 3000, duration: 60 }, 'api-default': { points: 3000, duration: 60 }, billing: { points: 3000, duration: 60 } } }), AccountModule],
      controllers: [BillingController, BillingRefundsController], providers: [BillingService, { provide: BILLING_OPTIONS, useValue: options }, { provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).compile();
    const instance = module.createNestApplication({ rawBody: true }); instance.setGlobalPrefix('api'); instance.useGlobalFilters(new HttpExceptionFilter()); await instance.listen(0, '127.0.0.1');
    return { app: instance, billing: instance.get(BillingService) };
  }
  async function account(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticRefund9!';
    const action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username, email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200); return { id: logged.body.userId as string, token: logged.body.token as string };
  }
  const get = (path = '', token = admin.token) => request(app.getHttpServer()).get(`/api/billing/refunds${path}`).set('Authorization', `Bearer ${token}`);
  const post = (path: string, body: object = {}, token = admin.token) => request(app.getHttpServer()).post(`/api/billing/refunds${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send(body);
  const create = (targetId: string, amount = '29.00', key = randomUUID(), targetType = 'order') => post('', { targetType, targetId, amount, reason: 'Synthetic refund' }).set('Idempotency-Key', key);
  async function fixture(providerId = 'stripe', mode: 'payment' | 'subscription' = 'payment', confirm = true, offerId?: string) {
    const ownerId = randomUUID(); await database.model('users').create({ data: { id: ownerId, username: `refund${ownerId.replaceAll('-', '')}`, name: 'Synthetic refund owner', typeId: 'member', status: true } });
    const order = await billing.create(ownerId, randomUUID(), { offerId: offerId ?? (mode === 'subscription' ? 'subscription' : 'credits'), providerId });
    const pid = paymentId(order), kind = providerId === 'stripe' ? mode === 'subscription' ? 'invoice' : 'payment-intent' : 'transaction';
    const fact: RefundPaymentObservation = { paymentId: pid, paymentKind: kind, paidMoney: order.offer.money, source: { kind: providerId === 'stripe' ? 'charge' : 'transaction', id: sourceId(pid, providerId) }, settlement: 'paid', refundedMoney: { ...order.offer.money, amount: '0' }, pendingRefundMoney: { ...order.offer.money, amount: '0' } };
    payments.set(pid, fact);
    const period: SubscriptionPaidPeriod = { recordId: pid, paymentId: pid, paymentKind: kind, subscriptionId: `subscription-${order.id}`, catalogReference: order.offer.catalogReference,
      paidMoney: order.offer.money, paidAt: new Date().toISOString(), period: { start: new Date().toISOString(), end: new Date(Date.now() + 30 * 86400000).toISOString() } };
    periods.set(period.subscriptionId, [period]);
    checkouts.set(order.checkoutId!, { ...checkouts.get(order.checkoutId!)!, state: 'paid', paidMoney: order.offer.money, paymentId: pid, paymentKind: kind,
      ...(mode === 'subscription' ? { subscriptionId: period.subscriptionId } : {}) });
    if (confirm) await billing.confirm(order.id, ownerId);
    return { order, ownerId, pid, fact, period, confirm: () => billing.confirm(order.id, ownerId) };
  }
  async function targetOrder(orderId: string) { return (await post(`/targets/order/${orderId}/check`).expect(200)).body; }
  async function pendingFor(orderId: string) { const list = await get().expect(200); return list.body.data.find((row: { orderId: string }) => row.orderId === orderId); }
  function webhook(providerId: string, event: RefundWebhookEvent) {
    return request(app.getHttpServer()).post(`/api/billing/webhooks/${providerId}`).set('Content-Type', 'application/json').set('X-Synthetic-Signature', 'valid').send(JSON.stringify(event));
  }
  async function failConfirm(work: () => Promise<void>, status = 'CONFIRMED') {
    await pool.query(`CREATE FUNCTION "${schema}".reject_refund_hold_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='${status}' THEN RAISE EXCEPTION 'Synthetic hold settle failure'; END IF; RETURN NEW; END $$`);
    try { await pool.query(`CREATE TRIGGER reject_refund_hold_confirmation BEFORE UPDATE ON "${schema}".credit_holds FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_refund_hold_confirmation()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER reject_refund_hold_confirmation ON "${schema}".credit_holds`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".reject_refund_hold_confirmation()`); }
  }
  async function failHoldCreation(work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".reject_refund_hold_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic hold creation failure'; END $$`);
    try { await pool.query(`CREATE TRIGGER reject_refund_hold_creation BEFORE INSERT ON "${schema}".credit_holds FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_refund_hold_creation()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER reject_refund_hold_creation ON "${schema}".credit_holds`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".reject_refund_hold_creation()`); }
  }
  afterEach(() => vi.restoreAllMocks());
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      } await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href; database = new ApplicationDatabase(scopedUrl);
    ({ app, billing } = await startApp()); admin = await account('refundadmin'); member = await account('refundmember');
    await database.model('permissions').create({ data: { id: 'billing:refund', name: 'Synthetic refund permission' } });
    await database.model('userPermissions').create({ data: { userId: admin.id, permissionId: 'billing:refund', grantType: 'grant' } });
  });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  it('enforces refund permission, origin and server-derived target identity before dispatch', async () => {
    const f = await fixture(), before = creates.length;
    await request(app.getHttpServer()).get('/api/billing/refunds').expect(401); await get('', member.token).expect(403);
    await create(f.order.id).set('Origin', 'https://foreign.invalid').expect(403); await create(f.order.id).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await post('', { targetType: 'order', targetId: f.order.id, amount: '1.00' }).expect(400);
    for (const extra of [{ ownerId: member.id }, { providerId: 'foreign' }, { paymentId: 'foreign' }, { currency: 'EUR' }]) await post('', { targetType: 'order', targetId: f.order.id, amount: '1.00', ...extra }).set('Idempotency-Key', randomUUID()).expect(400);
    expect(creates).toHaveLength(before);
  });
  it('uses cumulative floor credit policy and recovers the final rounding remainder exactly', async () => {
    const f = await fixture(); expect((await readCreditBalance(database, f.ownerId)).available).toBe(101);
    const first = await create(f.order.id, '14.50').expect(200); expect(first.body).toMatchObject({ cashState: 'succeeded', creditState: 'settled', creditImpact: { revoked: 50, shortfall: 0 } });
    expect((await readCreditBalance(database, f.ownerId)).available).toBe(51);
    const second = await create(f.order.id, '14.50').expect(200); expect(second.body.creditImpact.revoked).toBe(51);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
    const target = await targetOrder(f.order.id); expect(target).toMatchObject({ refundedMoney: money('29.00'), recoveredCredits: 101, capabilities: { canCreate: false } });
    const original = await billing.checkout.get(f.order.id, f.ownerId); expect(original.state).toBe('paid'); expect(original.fulfilledAt).toBeTruthy();
  });
  it('does not duplicate a command across concurrent same-key submissions or key replay', async () => {
    const f = await fixture(), key = randomUUID(), before = creates.length;
    const responses = await Promise.all([create(f.order.id, '10.00', key), create(f.order.id, '10.00', key)]);
    expect(responses.every(result => [200, 409].includes(result.status))).toBe(true);
    await create(f.order.id, '10.00', key).expect(200); expect(creates).toHaveLength(before + 1);
    await create(f.order.id, '11.00', key).expect(409); expect(creates).toHaveLength(before + 1);
    const recovered = await get(`/requests/${key}`).expect(200); expect(recovered.body.money).toEqual(money('10.00'));
    expect(recovered.headers['cache-control']).toBe('private, no-store');
    await get(`/requests/${randomUUID()}`).expect(404); await get('/requests/short').expect(400);
    await get(`/requests/${key}`, member.token).expect(403);
    await expect(billing.refunds.getByClientKey(member.id, key)).rejects.toThrow('was not found');
    expect(creates).toHaveLength(before + 1);
    expect((await readCreditBalance(database, f.ownerId)).available).toBe(67);
  });
  it('rejects spent source credits and excessive cash before an external refund', async () => {
    const f = await fixture(), before = creates.length;
    await database.transaction(tx => createCreditLedger(database).consume(tx, { accountId: f.ownerId, amount: 80,
      transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic', resourceId: f.order.id } }));
    await create(f.order.id).expect(409); await create(f.order.id, '30.00').expect(400); expect(creates).toHaveLength(before);
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 21, frozen: 0 });
  });
  it('freezes only the original lots and prevents spending the held credits while pending', async () => {
    const f = await fixture(); modes.set(f.pid, 'pending'); const response = await create(f.order.id).expect(200);
    expect(response.body).toMatchObject({ cashState: 'pending', creditState: 'held', creditImpact: { held: 101 } });
    await expect(database.transaction(tx => createCreditLedger(database).consume(tx, { accountId: f.ownerId, amount: 1,
      transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }))).rejects.toThrow('Insufficient');
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 101 });
    const target = await get(`/targets/order/${f.order.id}`).expect(200); expect(target.body).toMatchObject({ pendingMoney: money('29.00'), remainingMoney: money('0.00'), capabilities: { canCreate: false } });
  });
  it('recovers a lost successful response after restart without another create', async () => {
    const f = await fixture(); modes.set(f.pid, 'lost'); const key = randomUUID(), before = creates.length;
    await create(f.order.id, '10.00', key).expect(503); const pending = await pendingFor(f.order.id); expect(pending.cashState).toBe('unknown');
    await app.close(); ({ app, billing } = await startApp()); await create(f.order.id, '10.00', key).expect(200);
    const checked = await post(`/${pending.id}/check`).expect(200); expect(checked.body.cashState).toBe('succeeded');
    expect(creates).toHaveLength(before + 1); expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 67, frozen: 0 });
  });
  it('retains successful cash proof and provider refund identity when the hold settlement transaction fails', async () => {
    const f = await fixture(), before = creates.length; let id = '';
    await failConfirm(async () => {
      await create(f.order.id).expect(503); const pending = await pendingFor(f.order.id); id = pending.id;
      expect(pending).toMatchObject({ cashState: 'succeeded', creditState: 'attention', state: 'attention' });
      const row = await database.model('billingRefundRequests').findUnique({ where: { id } }) as { providerRefundId: string };
      expect(row.providerRefundId).toBeTruthy();
      expect(await database.model('billingRefundEvents').count()).toBeGreaterThan(0);
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 101 });
      const order = await billing.checkout.get(f.order.id, f.ownerId);
      expect(await billing.present(order)).toMatchObject({ state: 'paid', refund: {
        state: 'full', refundedMoney: money('29.00'), needsAttention: true, recoveredCredits: 0,
      } });
    });
    await post(`/${id}/check`).expect(200); expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
    // The same provider ID exists in the durable journal and applied receipts; count it only once.
    expect(await billing.present(await billing.checkout.get(f.order.id, f.ownerId))).toMatchObject({ refund: {
      state: 'full', refundedMoney: money('29.00'), needsAttention: false, recoveredCredits: 101,
    } });
    expect(creates).toHaveLength(before + 1);
  });
  it('releases a rejected refund hold without issuing cash', async () => {
    const f = await fixture(); modes.set(f.pid, 'rejected'); const response = await create(f.order.id).expect(200);
    expect(response.body).toMatchObject({ cashState: 'failed', creditState: 'released' });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 101, frozen: 0 });
  });
  it('keeps definitive cash rejection when releasing the hold fails and recovers without another command', async () => {
    const f = await fixture(), before = creates.length; modes.set(f.pid, 'rejected'); let id = '';
    await failConfirm(async () => {
      await create(f.order.id).expect(503); const pending = await pendingFor(f.order.id); id = pending.id;
      expect(pending).toMatchObject({ cashState: 'failed', creditState: 'attention', state: 'attention' });
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 101 });
    }, 'RELEASED');
    const checked = await post(`/${id}/check`).expect(200); expect(checked.body).toMatchObject({ cashState: 'failed', creditState: 'released' });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 101, frozen: 0 }); expect(creates).toHaveLength(before + 1);
  });
  for (const state of ['failed', 'succeeded'] as const) it(`settles a ${state} refund after source expiry without restoring or charging expired credits twice`, async () => {
    const f = await fixture(); modes.set(f.pid, 'pending'); const created = await create(f.order.id).expect(200);
    await database.model('creditLots').updateMany({ where: { userId: f.ownerId }, data: { expiresAt: new Date(Date.now() - 60000) } });
    const receipt = [...refunds.values()].find(row => row.paymentId === f.pid)!; receipt.state = state;
    f.fact.pendingRefundMoney = money('0.00'); if (state === 'succeeded') { f.fact.refundedMoney = money('29.00'); f.fact.settlement = 'refunded'; }
    const checked = await post(`/${created.body.id}/check`).expect(200);
    expect(checked.body).toMatchObject({ cashState: state, creditState: state === 'succeeded' ? 'settled' : 'released', creditImpact: { held: 0, revoked: 0, expired: 101 } });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body.recoveredCredits).toBe(state === 'succeeded' ? 101 : 0);
    await post(`/${created.body.id}/check`).expect(200); expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
  });
  it('suppresses a full early verified refund before the first credit grant', async () => {
    const f = await fixture('stripe', 'payment', false);
    const event: RefundWebhookEvent = { eventId: `early-${f.order.id}`, refundId: `external-${f.order.id}`, source: f.fact.source, state: 'succeeded', money: money('29.00') };
    await webhook('stripe', event).expect(200); expect((await get('/events').expect(200)).body.data.length).toBeGreaterThan(0);
    await f.confirm(); expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
    expect(await database.model('creditLots').count({ where: { userId: f.ownerId } })).toBe(0);
    expect(await database.model('billingFulfillments').findUnique({ where: { orderId: f.order.id } })).toMatchObject({ credits: 0 });
    expect((await targetOrder(f.order.id)).recoveredCredits).toBe(101);
  });
  it('suppresses an early partial refund and later recovers only the remaining granted credits', async () => {
    const f = await fixture('stripe', 'payment', false);
    const external: RefundObservation = { refundId: `external-${f.order.id}`, paymentId: f.pid, paymentKind: 'payment-intent', source: f.fact.source, state: 'succeeded', providerStatus: 'succeeded', money: money('14.50') };
    refunds.set(external.refundId!, external); f.fact.refundedMoney = money('14.50'); f.fact.settlement = 'partially_refunded';
    await f.confirm(); expect((await readCreditBalance(database, f.ownerId)).available).toBe(51);
    expect((await targetOrder(f.order.id)).recoveredCredits).toBe(50);
    await create(f.order.id, '14.50').expect(200); expect((await readCreditBalance(database, f.ownerId)).available).toBe(0);
  });
  it('records external dashboard refunds, deduplicates event replay and reports a true credit shortfall', async () => {
    const f = await fixture(); await database.transaction(tx => createCreditLedger(database).consume(tx, { accountId: f.ownerId, amount: 80,
      transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }));
    const event: RefundWebhookEvent = { eventId: `external-${f.order.id}`, refundId: `external-ref-${f.order.id}`, source: f.fact.source, state: 'succeeded', money: money('29.00'), totalRefundedMoney: money('29.00') };
    await webhook('stripe', event).expect(200); await webhook('stripe', { ...event, money: { currency: 'USD', amount: '29' } }).expect(200);
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ refundedMoney: money('29.00'), recoveredCredits: 21, attention: true });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
    await webhook('stripe', { ...event, commandKey: 'changed-meaning' }).expect(409);
  });
  for (const failure of ['create', 'confirm'] as const) it(`blocks only the refunded source after external cash proof even when hold ${failure} fails`, async () => {
    const f = await fixture(), ledger = createCreditLedger(database), otherSource = `other-purchase-${randomUUID()}`;
    await database.transaction(tx => ledger.grant(tx, { accountId: f.ownerId, amount: 40, source: 'purchase', sourceId: otherSource, transactionData: { type: 'GRANT' } }));
    const sourceLots = await database.model('creditLots').findMany({ where: { userId: f.ownerId, source: 'purchase', sourceId: f.order.id } }) as Array<{ id: string; remainingAmount: number }>;
    const event: RefundWebhookEvent = { eventId: `failed-hold-${failure}-${f.order.id}`, refundId: `external-${f.order.id}`, source: f.fact.source, state: 'succeeded', money: money('29.00') };
    await (failure === 'create' ? failHoldCreation : failConfirm)(async () => {
      await webhook('stripe', event).expect(503);
      expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ refundedMoney: money('29.00'), recoveredCredits: 0, attention: true });
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 40, frozen: 0, refundBlocked: 101 });
      await expect(database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount: 80, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }))).rejects.toThrow('Insufficient');
      await expect(database.transaction(tx => ledger.hold(tx, { id: randomUUID(), accountId: f.ownerId, amount: 1, lotIds: sourceLots.map(row => row.id), resourceType: 'synthetic-job', operationKey: randomUUID(), transactionData: { type: 'FREEZE' } }))).rejects.toThrow();
      await database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount: 30, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }));
      const original = await database.model('creditLots').findUnique({ where: { id: sourceLots[0].id } }) as { remainingAmount: number }; expect(original.remainingAmount).toBe(101);
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 10, frozen: 0, refundBlocked: 101 });
      expect(await database.model('billingRefundEvents').count({ where: { eventId: event.eventId } })).toBe(1);
      expect(await billing.present(await billing.checkout.get(f.order.id, f.ownerId))).toMatchObject({ refund: { state: 'full', refundedMoney: money('29.00') } });
    });
    await webhook('stripe', event).expect(200); await webhook('stripe', event).expect(200);
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ recoveredCredits: 101, attention: false });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 10, frozen: 0, refundBlocked: 0 });
  });
  it('unblocks the unrefunded remainder only after a partial external refund finishes exact credit recovery', async () => {
    const f = await fixture(), ledger = createCreditLedger(database);
    const event: RefundWebhookEvent = { eventId: `partial-block-${f.order.id}`, refundId: `partial-block-ref-${f.order.id}`, source: f.fact.source, state: 'succeeded', money: money('14.50') };
    await failConfirm(async () => {
      await webhook('stripe', event).expect(503);
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0, refundBlocked: 101 });
      await expect(database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount: 1, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }))).rejects.toThrow('Insufficient');
    });
    await webhook('stripe', event).expect(200);
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ refundedMoney: money('14.50'), recoveredCredits: 50, attention: false });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 51, frozen: 0, refundBlocked: 0 });
    await database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount: 51, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }));
    expect((await readCreditBalance(database, f.ownerId)).available).toBe(0);
  });
  it('settles verified cumulative-only cash without fabricating a receipt or permanently blocking a partial remainder', async () => {
    const f = await fixture(), ledger = createCreditLedger(database);
    const event: RefundWebhookEvent = { eventId: `cumulative-only-${f.order.id}`, source: f.fact.source, state: 'succeeded', totalRefundedMoney: money('14.50') };
    await failConfirm(async () => {
      await webhook('stripe', event).expect(503);
      expect((await get(`/targets/order/${f.order.id}`).expect(200)).body.refundedMoney).toEqual(money('14.50'));
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, refundBlocked: 101 });
    });
    f.fact.refundedMoney = money('14.50'); f.fact.settlement = 'partially_refunded';
    expect(await targetOrder(f.order.id)).toMatchObject({ recoveredCredits: 50, attention: false });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 51, frozen: 0, refundBlocked: 0 });
    const saved = await database.model('billingRefundEvents').findMany({ where: { eventId: event.eventId } }) as Array<{ status: string; targetId: string }>;
    expect(saved[0].status).toBe('processed'); expect(await database.model('billingRefundReceipts').count({ where: { targetId: saved[0].targetId } })).toBe(0);
    await webhook('stripe', event).expect(200);
    await database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount: 51, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }));
    expect((await readCreditBalance(database, f.ownerId)).available).toBe(0);
  });
  it('blocks consumption after the raw successful journal commits before cash merge or any hold is attempted', async () => {
    const f = await fixture(), db = app.get<ApplicationDatabase>(DATABASE_ADAPTER), original = db.transaction.bind(db), ledger = createCreditLedger(database);
    let release!: () => void, committed!: () => void, intercepted = false;
    const resume = new Promise<void>(resolve => { release = resolve; }), proofCommitted = new Promise<void>(resolve => { committed = resolve; });
    vi.spyOn(db, 'transaction').mockImplementation(async work => {
      let proof = false;
      const result = await original(async tx => {
        const query = tx.query.bind(tx);
        tx.query = async <T = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          const result = await query<T>(sql, values); if (/INSERT INTO "?billing_refund_events"?/.test(sql)) proof = true; return result;
        };
        return work(tx);
      });
      if (proof && !intercepted) { intercepted = true; committed(); await resume; }
      return result;
    });
    const event: RefundWebhookEvent = { eventId: `commit-gap-${f.order.id}`, refundId: `commit-gap-ref-${f.order.id}`, source: f.fact.source, state: 'succeeded', money: money('29.00') };
    const pending = webhook('stripe', event).then(result => result);
    try {
      await Promise.race([proofCommitted, pending.then(result => { throw new Error(`Webhook completed before checkpoint: ${result.status}`); })]);
      expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ refundedMoney: money('0.00'), cashEvidencePending: true, attention: true, capabilities: { canCreate: false, canCheck: true } });
      expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0, refundBlocked: 101 });
      const attempts = await Promise.allSettled([1, 80].map(amount => database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }))));
      expect(attempts.every(result => result.status === 'rejected')).toBe(true);
    } finally { release(); expect((await pending).status).toBe(200); }
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, refundBlocked: 0 });
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body.recoveredCredits).toBe(101);
  });
  it('prevents an ordinary pre-existing hold from confirming refunded credits and permits release for refund recovery', async () => {
    const f = await fixture(), ledger = createCreditLedger(database), id = randomUUID();
    const lots = await database.model('creditLots').findMany({ where: { userId: f.ownerId } }) as Array<{ id: string }>;
    await database.transaction(tx => ledger.hold(tx, { id, accountId: f.ownerId, amount: 30, lotIds: lots.map(row => row.id), resourceType: 'synthetic-job', operationKey: `job-hold-${id}`, transactionData: { type: 'FREEZE' } }));
    const event: RefundWebhookEvent = { eventId: `business-hold-${f.order.id}`, refundId: `business-refund-${f.order.id}`, source: f.fact.source, state: 'succeeded', money: money('29.00') };
    await webhook('stripe', event).expect(200);
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ recoveredCredits: 71, attention: true });
    await expect(database.transaction(tx => ledger.confirmHold(tx, { id, accountId: f.ownerId, operationKey: `job-confirm-${id}`, transactionData: { type: 'CONSUME' } }))).rejects.toThrow();
    await database.transaction(tx => ledger.releaseHold(tx, { id, accountId: f.ownerId, operationKey: `job-release-${id}`, transactionData: { type: 'UNFREEZE' } }));
    await expect(database.transaction(tx => ledger.consume(tx, { accountId: f.ownerId, amount: 1, transactionData: { type: 'CONSUME' }, consumptionData: { resourceType: 'synthetic' } }))).rejects.toThrow('Insufficient');
    await webhook('stripe', event).expect(200); expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ recoveredCredits: 101, attention: false });
  });
  it('does not count one pending refund twice across the local request, receipt and provider aggregate', async () => {
    const f = await fixture(); modes.set(f.pid, 'pending'); const created = await create(f.order.id, '10.00').expect(200);
    await post(`/${created.body.id}/check`).expect(200);
    expect((await get(`/targets/order/${f.order.id}`).expect(200)).body).toMatchObject({ pendingMoney: money('10.00'), remainingMoney: money('19.00'), capabilities: { canCreate: false } });
  });
  it('recovers Creem full remaining totals without fabricating a provider receipt or repeating the command', async () => {
    const f = await fixture('creem'); modes.set(f.pid, 'status-only'); const before = creates.length;
    const created = await create(f.order.id).expect(200); expect(created.body.cashState).toBe('unknown');
    const checked = await post(`/${created.body.id}/check`).expect(200);
    expect(checked.body).toMatchObject({ cashState: 'succeeded', confirmationBasis: 'payment_total', creditState: 'settled' });
    expect(creates).toHaveLength(before + 1); expect((await readCreditBalance(database, f.ownerId)).available).toBe(0);
  });
  it('preserves exact zero-decimal payment amounts and provider full-refund limits', async () => {
    const f = await fixture('creem', 'payment', true, 'zero-decimal');
    await create(f.order.id, '14').expect(400);
    const created = await create(f.order.id, '29').expect(200);
    expect(created.body).toMatchObject({ money: { currency: 'JPY', amount: '29' }, cashState: 'succeeded', creditImpact: { revoked: 101 } });
    expect(await readCreditBalance(database, f.ownerId)).toMatchObject({ available: 0, frozen: 0 });
  });
  it('scopes renewal refunds to the selected local cycle and never cancels the subscription', async () => {
    const f = await fixture('stripe', 'subscription');
    const next: SubscriptionPaidPeriod = { ...f.period, paymentId: `renewal-${f.order.id}`, recordId: `renewal-${f.order.id}`,
      period: { start: f.period.period.end, end: new Date(Date.now() + 60 * 86400000).toISOString() } };
    periods.get(f.period.subscriptionId)!.push(next);
    payments.set(next.paymentId, { ...structuredClone(f.fact), paymentId: next.paymentId, source: { kind: 'charge', id: sourceId(next.paymentId, 'stripe') } });
    await billing.subscriptions.refresh(f.order.id, f.ownerId);
    const list = await get(`/subscriptions/${f.order.id}/cycles`).expect(200), cycle = list.body.data.find((row: { initial: boolean }) => !row.initial);
    const key = randomUUID(), response = await create(cycle.id, '29.00', key, 'cycle').expect(200); expect(response.body.cycleId).toBe(cycle.id);
    await create(f.order.id, '29.00', key).expect(409);
    expect((await readCreditBalance(database, f.ownerId)).available).toBe(101);
    expect((await billing.subscriptions.get(f.order.id, f.ownerId)).status).toBe('active');
  });
});
