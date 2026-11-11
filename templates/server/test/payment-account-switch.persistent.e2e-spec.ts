import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Logger } from '@nestjs/common';
import { HostedCheckoutError, RefundProtocolError, type HostedCheckoutAdapter, type HostedCheckoutOffer, type HostedCheckoutOrder, type RefundAdapter,
  type RefundWebhookEvent, type SubscriptionAdapter, type SubscriptionDetails, type WebhookRequest } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingService } from '../src/billing/billing.service';
import { PaymentCredentialResolver } from '../src/billing/payment-credentials';
import type { PaymentProviderSet } from '../src/billing/providers';
import { bindCheckoutSubscription } from '../src/billing/subscription-persistence';
import { FakePaymentLedger } from '../src/billing/test-fakes/fake-payment-provider';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';
import { readCreditBalance } from '../src/credits/credits.service';

/**
 * WP 4.1c (money): behaviour of existing orders, subscriptions and refunds after the payment profile is
 * rotated, switched to another provider account, or disabled. One fake ledger per provider account; API
 * keys can be revoked provider-side; webhooks are signed with the revision's own secret. Every provider
 * call records the account and key that made it. Synthetic data only; no network.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_payment_switch_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-for-switch-tests',
  JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters', BILLING_STRIPE_ENABLED: 'false' };
const catalogJson = JSON.stringify([{ id: 'credits', title: 'Synthetic 100 credits', version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD',
  credits: 100, expiresInDays: null, providers: { stripe: 'sku-credits' } }]);
const SIGNATURE = 'x-synthetic-signature', SENTINELS = ['sk_test_', 'whsec_'];
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const start = '2026-10-01T00:00:00.000Z', end = '2026-11-01T00:00:00.000Z';

interface Call { op: string; scope: string; key: string; orderId?: string }
interface Fact { details: SubscriptionDetails }

run('existing payments after a credential rotation, account switch or disable (PostgreSQL)', () => {
  let pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService, billing: BillingService, resolver: PaymentCredentialResolver;
  const operator = 'synthetic-operator';
  let accounts: Map<string, { ledger: FakePaymentLedger; keys: Set<string> }>, calls: Call[], ownerId: string, logs: string[];
  let subscriptionFacts: Map<string, Fact>;

  const account = (scope: string) => {
    if (!accounts.has(scope)) accounts.set(scope, { ledger: new FakePaymentLedger(`${origin}/api/billing/test-checkout`), keys: new Set() });
    return accounts.get(scope)!;
  };
  const verified = (secret: string, request: WebhookRequest, fail: (message: string) => never) => {
    const header = request.headers?.[SIGNATURE], raw = typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody ?? '').toString('utf8');
    const expected = Buffer.from(sign(secret, raw));
    if (typeof header !== 'string' || header.length !== expected.length || !timingSafeEqual(Buffer.from(header), expected)) return fail('Synthetic signature is invalid');
    return JSON.parse(raw) as { id: string; type: string; data: Record<string, unknown> };
  };
  const factory = (environment: NodeJS.ProcessEnv, providerId: string): PaymentProviderSet | undefined => {
    if (providerId !== 'stripe' || environment.BILLING_STRIPE_ENABLED !== 'true') return undefined;
    const scope = environment.BILLING_STRIPE_ACCOUNT_SCOPE!.trim(), key = environment.STRIPE_SECRET_KEY!, secret = environment.STRIPE_WEBHOOK_SECRET!;
    // A builder that echoes the configuration in its message, as a real SDK might.
    if (key.startsWith('sk_test_BROKEN')) throw new Error(`cannot build with ${key} and ${secret}`);
    const provider = account(scope);
    const auth = (op: string, orderId?: string) => {
      if (!provider.keys.has(key)) throw new Error('Synthetic provider: API key revoked');
      calls.push({ op, scope, key, ...(orderId ? { orderId } : {}) });
    };
    const checkout: HostedCheckoutAdapter = { id: 'stripe', accountScope: scope, modes: ['payment'], validate() {},
      async create(order) { auth('create', order.id); return provider.ledger.create(order); },
      async retrieve(checkoutId) { auth('retrieve'); return provider.ledger.retrieve(checkoutId); },
      async verifyWebhook(request) {
        const event = verified(secret, request, message => { throw new HostedCheckoutError('verification_failed', message); });
        return event.type === 'checkout.completed' ? { eventId: event.id, checkoutId: String(event.data.checkoutId), reference: String(event.data.reference) } : null;
      } };
    const refund: RefundAdapter = { id: 'stripe', accountScope: scope,
      capabilities: { paymentKinds: ['payment-intent', 'invoice'], partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: true },
      async retrievePayment(payment) { auth('refund-facts'); return provider.ledger.paymentFacts(payment); },
      async create(command) { auth('refund'); return provider.ledger.createRefund(command); },
      async retrieve(refundId) { auth('refund-retrieve'); return provider.ledger.refund(refundId); },
      async listRefunds(payment) { auth('refund-list'); return { data: provider.ledger.refundsFor(payment) }; },
      async verifyWebhook(request) {
        const event = verified(secret, request, message => { throw new RefundProtocolError('verification_failed', message, 'rejected'); });
        return event.type === 'refund.updated' ? event.data as unknown as RefundWebhookEvent : null;
      } };
    const subscription: SubscriptionAdapter = { id: 'stripe', accountScope: scope,
      capabilities: { cancel: ['immediate', 'period_end'], billingPortal: true, invoices: false, paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' },
      async retrieve(id) { auth('sub-retrieve'); return structuredClone(subscriptionFacts.get(`${scope}/${id}`)!.details); },
      async listPaidPeriods() { auth('sub-periods'); return { data: [] }; },
      async cancel(id, options) {
        auth('sub-cancel'); const fact = subscriptionFacts.get(`${scope}/${id}`)!;
        fact.details = options.mode === 'period_end' ? { ...fact.details, cancelAtPeriodEnd: true } : { ...fact.details, status: 'canceled', providerStatus: 'canceled' };
        return structuredClone(fact.details);
      },
      async createBillingPortal() { auth('sub-portal'); return { url: `https://billing.synthetic.invalid/${scope}` }; },
      async verifyWebhook(request) {
        const event = verified(secret, request, message => { throw new HostedCheckoutError('verification_failed', message); });
        return event.type === 'subscription.updated' ? { eventId: event.id, subscriptionId: String(event.data.subscriptionId) } : null;
      } };
    return { checkout, refund, subscription };
  };
  const save = async (expectedRevision: number, scope: string, key: string, secret: string, enabled = 'true') => {
    account(scope).keys.add(key);
    return settings.save(operator, 'payment-stripe', { expectedRevision, values: { BILLING_STRIPE_ENABLED: enabled, BILLING_STRIPE_MODE: 'test', BILLING_STRIPE_ACCOUNT_SCOPE: scope },
      secrets: { STRIPE_SECRET_KEY: { action: 'replace', value: key }, STRIPE_WEBHOOK_SECRET: { action: 'replace', value: secret } } });
  };
  const webhook = (secret: string, data: Record<string, unknown>, type = 'checkout.completed') => {
    const rawBody = JSON.stringify({ id: `evt_${randomUUID().replaceAll('-', '')}`, type, data });
    return { rawBody, headers: { [SIGNATURE]: sign(secret, rawBody) } };
  };
  const order = async () => billing.create(ownerId, `synthetic-key-${randomUUID()}`, { offerId: 'credits', providerId: 'stripe' });
  const row = async (id: string) => (await pool.query(`SELECT "configRevision", "accountScope", "fulfilledAt", "checkoutId", "paymentId", "paymentKind" FROM "${schema}"."billing_orders" WHERE id = $1`, [id])).rows[0];
  const balance = async () => (await readCreditBalance(database, ownerId)).available;
  const grants = async () => Number((await pool.query(`SELECT count(*) FROM "${schema}"."billing_fulfillments" WHERE "orderId" IN (SELECT id FROM "${schema}"."billing_orders" WHERE "ownerId" = $1)`, [ownerId])).rows[0].count);
  const build = () => {
    settings = new ConnectionSettingsService(database, env);
    resolver = new PaymentCredentialResolver(settings, { factory });
    billing = new BillingService(database, { providers: [], webUrl: origin, catalogJson, credentials: resolver });
  };
  const sweep = (...texts: string[]) => { for (const text of texts) for (const secret of SENTINELS) expect(text).not.toContain(secret); };
  /** A paid, fulfilled account-A order whose revision-1 credentials were then rotated and the profile moved to account B. */
  const paidThenSwitch = async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    account('acct-a').ledger.pay(checkoutId);
    await billing.confirm(created.id, ownerId);
    await save(1, 'acct-a', 'sk_test_A2', 'whsec_A2'); account('acct-a').keys.delete('sk_test_A1');
    await save(2, 'acct-b', 'sk_test_B1', 'whsec_B1');
    return created;
  };
  const subscriptionOf = async (scope: string) => {
    const id = randomUUID(), providerSubscriptionId = `sub-${id}`, customerId = `customer-${id}`;
    const offer: HostedCheckoutOffer = { version: 'v1', catalogReference: 'catalog-stripe', mode: 'subscription', money: { amount: '12.00', currency: 'USD' },
      description: 'Synthetic subscription', fulfillmentData: { credits: 100, expiresInDays: null, grantBasis: 'period' } };
    const data = { id, ownerId, offerId: 'subscription-credits', providerId: 'stripe', accountScope: scope, offer, successUrl: `${origin}/billing`, cancelUrl: `${origin}/billing`,
      createKey: `create-${id}`, captureKey: `capture-${id}`, creationState: 'created', captureState: 'idle', state: 'paid', checkoutId: `checkout-${id}`, subscriptionId: providerSubscriptionId,
      paymentId: `payment-${id}`, paymentKind: 'invoice', fulfilledAt: new Date() };
    const created = await database.model('billingOrders').create({ data }) as HostedCheckoutOrder;
    await database.transaction(tx => bindCheckoutSubscription(tx, created));
    await pool.query(`UPDATE "${schema}"."billing_subscriptions" SET "customerId" = $1, revision = revision + 1 WHERE id = $2`, [customerId, id]);
    subscriptionFacts.set(`${scope}/${providerSubscriptionId}`, { details: { provider: 'stripe', subscriptionId: providerSubscriptionId, customerId, catalogReference: offer.catalogReference,
      status: 'active', providerStatus: 'active', period: { start, end }, payment: { settlement: 'unknown' } } });
    return { id, providerSubscriptionId };
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
    accounts = new Map(); calls = []; logs = []; subscriptionFacts = new Map();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(arg => arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)).join(' ')); });
    ownerId = randomUUID();
    await database.model('users').create({ data: { id: ownerId, username: `sw_${ownerId.replaceAll('-', '')}`, name: 'Synthetic buyer', typeId: 'member',
      email: `${ownerId}@example.invalid`, emailVerified: true, status: true } });
    build();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await database?.disconnect(); await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool?.end(); });

  it('an unconfirmed old order is confirmed once through its own account after a switch, even with confirm and webhook racing', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    await save(1, 'acct-a', 'sk_test_A2', 'whsec_A2'); account('acct-a').keys.delete('sk_test_A1');
    await save(2, 'acct-b', 'sk_test_B1', 'whsec_B1');
    account('acct-a').ledger.pay(checkoutId);
    calls.length = 0;
    const event = webhook('whsec_A1', { checkoutId, reference: created.id });
    await Promise.allSettled([billing.confirm(created.id, ownerId), billing.confirm(created.id, ownerId), billing.webhook('stripe', event), billing.webhook('stripe', event)]);
    await billing.confirm(created.id, ownerId);
    expect(await balance()).toBe(100);
    expect(await grants()).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.scope === 'acct-a' && call.key === 'sk_test_A2')).toBe(true);
    expect((await row(created.id)).accountScope).toBe('acct-a');
  });

  it('webhook signature matrix: retained old secret verifies, a foreign account secret cannot settle, random secrets fail', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    await save(1, 'acct-b', 'sk_test_B1', 'whsec_B1');
    account('acct-a').ledger.pay(checkoutId);
    for (const secret of ['whsec_B1', 'whsec_nope', '']) {
      await expect(billing.webhook('stripe', webhook(secret, { checkoutId, reference: created.id }))).rejects.toThrow();
    }
    expect(await balance()).toBe(0);
    expect((await row(created.id)).fulfilledAt).toBeNull();
    expect(calls.some(call => call.scope === 'acct-b')).toBe(false);
    await billing.webhook('stripe', webhook('whsec_A1', { checkoutId, reference: created.id }));
    expect(await balance()).toBe(100);
  });

  it('a provider disabled in the current revision still settles and refunds old orders but refuses new ones', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    const paid = await order();
    account('acct-a').ledger.pay(paid ? (await row(paid.id)).checkoutId : checkoutId);
    await billing.confirm(paid.id, ownerId);
    expect(await balance()).toBe(100);
    // Disabled in revision 2 (same account, credentials kept).
    await save(1, 'acct-a', 'sk_test_A1', 'whsec_A1', 'false');
    expect(await resolver.ids()).not.toContain('stripe');
    await expect(order()).rejects.toThrow();
    // The unfinished order settles through the retained revision, by confirm and by a webhook, exactly once.
    account('acct-a').ledger.pay(checkoutId);
    await billing.confirm(created.id, ownerId);
    await billing.webhook('stripe', webhook('whsec_A1', { checkoutId, reference: created.id }));
    await billing.confirm(created.id, ownerId);
    expect(await balance()).toBe(200);
    expect(await grants()).toBe(2);
    // An old paid order can still be refunded through its own account.
    calls.length = 0;
    await billing.refunds.create(operator, `refund-${randomUUID()}`, { targetType: 'order', targetId: paid.id, amount: '10.00' });
    expect(calls.some(call => call.op === 'refund' && call.scope === 'acct-a')).toBe(true);
    expect(await balance()).toBe(100);
    // Still no new orders after the disabled revision is current.
    await expect(order()).rejects.toThrow();
  });

  it('a purged-away account (no retained revision at all) fails closed for old orders instead of using another account', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    await save(1, 'acct-b', 'sk_test_B1', 'whsec_B1');
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions" WHERE "profileId" = 'payment-stripe' AND revision = 1`);
    account('acct-a').ledger.pay(checkoutId); calls.length = 0;
    await expect(billing.confirm(created.id, ownerId)).rejects.toMatchObject({ code: 'verification_failed' });
    expect(calls).toEqual([]);
    expect(await balance()).toBe(0);
  });

  it('refunds and refund reconciliation after an account switch use the order account only, one credit revocation', async () => {
    const created = await paidThenSwitch();
    calls.length = 0;
    account('acct-a').ledger.setRefundMode('pending');
    const requested = await billing.refunds.create(operator, `refund-${randomUUID()}`, { targetType: 'order', targetId: created.id, amount: '10.00' });
    const refundId = (await pool.query(`SELECT "providerRefundId" FROM "${schema}"."billing_refund_requests" WHERE id = $1`, [requested.id])).rows[0].providerRefundId as string;
    expect(refundId).toBeTruthy();
    account('acct-a').ledger.settleRefund(refundId, 'succeeded');
    await billing.refunds.reconcile(requested.id);
    await billing.refunds.reconcile(requested.id);
    const refundCalls = calls.filter(call => call.op.startsWith('refund'));
    expect(refundCalls.length).toBeGreaterThan(0);
    expect(refundCalls.every(call => call.scope === 'acct-a' && call.key === 'sk_test_A2')).toBe(true);
    expect(accounts.get('acct-b')?.ledger.refundsFor).toBeDefined();
    expect(await balance()).toBe(0);
    expect(Number((await pool.query(`SELECT count(*) FROM "${schema}"."billing_refund_receipts" WHERE "refundId" = $1`, [refundId])).rows[0].count)).toBe(1);
  });

  it('refund webhooks: the retained old secret of the order account is accepted, a foreign account secret changes nothing', async () => {
    const created = await paidThenSwitch();
    const { paymentId } = await row(created.id);
    const payment = account('acct-a').ledger.paymentFacts({ paymentId, paymentKind: 'payment-intent', paidMoney: { amount: '10.00', currency: 'USD' } });
    const event = (eventId: string): Record<string, unknown> => ({ eventId, source: payment.source, state: 'pending', money: { amount: '1.00', currency: 'USD' } });
    const events = async (scope: string) => Number((await pool.query(`SELECT count(*) FROM "${schema}"."billing_refund_events" WHERE "accountScope" = $1 AND "sourceId" = $2`, [scope, payment.source.id])).rows[0].count);
        // Foreign account signs a refund event for account A's payment source: it verifies only as account B, finds no B-owned target.
    await billing.webhook('stripe', webhook('whsec_B1', event('evt-foreign'), 'refund.updated')).catch(() => undefined);
    expect(await events('acct-a')).toBe(0);
    expect((await pool.query(`SELECT count(*) FROM "${schema}"."billing_refund_payments" WHERE "accountScope" = 'acct-b' AND "sourceId" = $1`, [payment.source.id])).rows[0].count).toBe('0');
    // Nobody can verify a random secret.
    await expect(billing.refunds.handleWebhook('stripe', webhook('whsec_nope', event('evt-random'), 'refund.updated'))).rejects.toThrow();
    // Make the target exist, then the retained secret of account A verifies and is journaled under A.
    account('acct-a').ledger.setRefundMode('pending');
    await billing.refunds.create(operator, `refund-${randomUUID()}`, { targetType: 'order', targetId: created.id, amount: '1.00' });
    const accepted = await billing.refunds.handleWebhook('stripe', webhook('whsec_A1', event('evt-own'), 'refund.updated'));
    expect(accepted).toBe(true);
    expect(Number((await pool.query(`SELECT count(*) FROM "${schema}"."billing_refund_events" WHERE "accountScope" = 'acct-a' AND "eventId" = 'evt-own' AND "targetId" IS NOT NULL`)).rows[0].count)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) FROM "${schema}"."billing_refund_events" WHERE "eventId" IN ('evt-foreign', 'evt-random') AND "accountScope" = 'acct-a'`)).rows[0].count)).toBe(0);
    expect((await pool.query(`SELECT count(*) FROM "${schema}"."billing_refund_events" WHERE "accountScope" = 'acct-b' AND "sourceId" = $1 AND "targetId" IS NOT NULL`, [payment.source.id])).rows[0].count).toBe('0');
  });

  it('subscription portal, cancel, refresh and webhook after a switch use the subscription account (never the new one)', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const sub = await subscriptionOf('acct-a');
    await save(1, 'acct-a', 'sk_test_A2', 'whsec_A2'); account('acct-a').keys.delete('sk_test_A1');
    await save(2, 'acct-b', 'sk_test_B1', 'whsec_B1');
    calls.length = 0;
    expect(await billing.subscriptions.get(sub.id, ownerId)).toMatchObject({ capabilities: { billingPortal: true, cancel: ['immediate', 'period_end'] } });
    expect((await billing.subscriptions.portal(sub.id, ownerId)).url).toBe('https://billing.synthetic.invalid/acct-a');
    await billing.subscriptions.refresh(sub.id, ownerId);
    expect(await billing.subscriptions.handleWebhook('stripe', webhook('whsec_A1', { subscriptionId: sub.providerSubscriptionId }, 'subscription.updated'))).toBe(true);
    // The new account's secret finds no subscription of its own: nothing is refreshed.
    const before = calls.length;
    expect(await billing.subscriptions.handleWebhook('stripe', webhook('whsec_B1', { subscriptionId: sub.providerSubscriptionId }, 'subscription.updated'))).toBe(false);
    expect(calls.length).toBe(before);
    await expect(billing.subscriptions.handleWebhook('stripe', webhook('whsec_nope', { subscriptionId: sub.providerSubscriptionId }, 'subscription.updated'))).rejects.toThrow();
    const cancelled = await billing.subscriptions.cancel(sub.id, ownerId, 'period_end');
    expect(cancelled.cancelState).not.toBe('idle');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.scope === 'acct-a' && call.key === 'sk_test_A2')).toBe(true);
    expect(accounts.get('acct-b')?.keys.size).toBe(1);
  });

  it('a subscription whose account has no retained credentials is unavailable, not served by the new account', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const sub = await subscriptionOf('acct-a');
    await save(1, 'acct-b', 'sk_test_B1', 'whsec_B1');
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions" WHERE "profileId" = 'payment-stripe' AND revision = 1`);
    calls.length = 0;
    expect(await billing.subscriptions.get(sub.id, ownerId)).toMatchObject({ capabilities: { billingPortal: false, cancel: [], refresh: false } });
    await expect(billing.subscriptions.portal(sub.id, ownerId)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(billing.subscriptions.cancel(sub.id, ownerId, 'immediate')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(billing.subscriptions.refresh(sub.id, ownerId)).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toEqual([]);
  });

  it('secrets never reach logs, errors, audit rows or order rows, even when a builder echoes them', async () => {
    const created = await paidThenSwitch();
    // A revision whose builder throws with the secret in its message is skipped, logged by class name only.
    await save(3, 'acct-c', 'sk_test_BROKEN', 'whsec_BROKEN');
    const seen: string[] = [];
    const attempt = async (work: () => Promise<unknown>) => { try { seen.push(JSON.stringify(await work())); } catch (error) { seen.push(`${(error as Error).name}: ${(error as Error).message}`); } };
    await attempt(() => order());
    await attempt(() => billing.webhook('stripe', webhook('whsec_forged', { checkoutId: 'x', reference: created.id })));
    await attempt(() => resolver.candidateSets('stripe'));
    await attempt(() => billing.confirm(created.id, ownerId));
    const tables = ['billing_orders', 'operation_logs', 'billing_refund_events', 'billing_outbox'];
    for (const table of tables) seen.push(JSON.stringify((await pool.query(`SELECT * FROM "${schema}"."${table}"`)).rows));
    expect(logs.some(line => line.includes('payment-stripe@4') || line.includes('cannot be assembled'))).toBe(true);
    sweep(...seen, ...logs);
    expect(JSON.stringify(await settings.revisions('payment-stripe'))).not.toMatch(/sk_test_|whsec_/);
  });
});
