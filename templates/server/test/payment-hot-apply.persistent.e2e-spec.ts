import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { HostedCheckoutError, RefundProtocolError, type HostedCheckoutAdapter, type RefundAdapter, type WebhookRequest } from '@zucker-framework/payment';
import { ApplicationDatabase } from '../src/database';
import { BillingService } from '../src/billing/billing.service';
import { PaymentCredentialResolver } from '../src/billing/payment-credentials';
import { PaymentCredentialRetention } from '../src/billing/payment-credential-retention';
import type { PaymentProviderSet } from '../src/billing/providers';
import { FakePaymentLedger } from '../src/billing/test-fakes/fake-payment-provider';
import { ConnectionSettingsService, CONNECTION_SETTINGS_SCOPE } from '../src/runtime-settings/connection-settings.service';
import { readCreditBalance } from '../src/credits/credits.service';

/**
 * WP 4.1c: payment credentials applied hot. The provider side is the test-only fake ledger, one per
 * provider account, wrapped in adapters built from each saved `payment-stripe` revision: API keys can
 * be revoked on the provider side and webhooks are signed with the revision's own signing secret.
 * Every provider call is recorded with the account and key that made it.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_payment_hot_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-for-hot-payments',
  JWT_SECRET: 'synthetic-different-jwt-at-least-32-characters', BILLING_STRIPE_ENABLED: 'false' };
const catalogJson = JSON.stringify([{ id: 'credits', title: 'Synthetic 100 credits', version: 'v1', mode: 'payment', amount: '10.00', currency: 'USD',
  credits: 100, expiresInDays: null, providers: { stripe: 'sku-credits' } }]);
const SIGNATURE = 'x-synthetic-signature';
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

interface Call { op: string; scope: string; key: string; orderId?: string }

run('payment hot-apply with credentials resolved by account (PostgreSQL)', () => {
  let pool: Pool, database: ApplicationDatabase, settings: ConnectionSettingsService, billing: BillingService, resolver: PaymentCredentialResolver;
  const operator = 'synthetic-operator';
  let accounts: Map<string, { ledger: FakePaymentLedger; keys: Set<string> }>, calls: Call[], ownerId: string;

  const account = (scope: string) => {
    if (!accounts.has(scope)) accounts.set(scope, { ledger: new FakePaymentLedger(`${origin}/api/billing/test-checkout`), keys: new Set() });
    return accounts.get(scope)!;
  };
  /** Verification as a provider SDK does it: the signature must match this revision's signing secret. */
  const verified = (secret: string, request: WebhookRequest, fail: (message: string) => never) => {
    const header = request.headers?.[SIGNATURE], raw = typeof request.rawBody === 'string' ? request.rawBody : Buffer.from(request.rawBody ?? '').toString('utf8');
    const expected = Buffer.from(sign(secret, raw));
    if (typeof header !== 'string' || header.length !== expected.length || !timingSafeEqual(Buffer.from(header), expected)) return fail('Synthetic signature is invalid');
    return JSON.parse(raw) as { id: string; type: string; data: Record<string, unknown> };
  };
  const factory = (environment: NodeJS.ProcessEnv, providerId: string): PaymentProviderSet | undefined => {
    if (providerId !== 'stripe' || environment.BILLING_STRIPE_ENABLED !== 'true') return undefined;
    const scope = environment.BILLING_STRIPE_ACCOUNT_SCOPE!.trim(), key = environment.STRIPE_SECRET_KEY!, secret = environment.STRIPE_WEBHOOK_SECRET!;
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
        return event.type === 'refund.updated' ? null : null;
      } };
    return { checkout, refund };
  };
  const save = async (expectedRevision: number, scope: string, key: string, secret: string) => {
    account(scope).keys.add(key);
    return settings.save(operator, 'payment-stripe', { expectedRevision, values: { BILLING_STRIPE_ENABLED: 'true', BILLING_STRIPE_MODE: 'test', BILLING_STRIPE_ACCOUNT_SCOPE: scope },
      secrets: { STRIPE_SECRET_KEY: { action: 'replace', value: key }, STRIPE_WEBHOOK_SECRET: { action: 'replace', value: secret } } });
  };
  const webhook = (secret: string, data: Record<string, unknown>, type = 'checkout.completed') => {
    const rawBody = JSON.stringify({ id: `evt_${randomUUID().replaceAll('-', '')}`, type, data });
    return { rawBody, headers: { [SIGNATURE]: sign(secret, rawBody) } };
  };
  const order = async () => billing.create(ownerId, `synthetic-key-${randomUUID()}`, { offerId: 'credits', providerId: 'stripe' });
  const row = async (id: string) => (await pool.query(`SELECT "configRevision", "accountScope", "fulfilledAt", "checkoutId" FROM "${schema}"."billing_orders" WHERE id = $1`, [id])).rows[0];
  const balance = async () => (await readCreditBalance(database, ownerId)).available;
  const build = () => {
    settings = new ConnectionSettingsService(database, env);
    resolver = new PaymentCredentialResolver(settings, { factory });
    billing = new BillingService(database, { providers: [], webUrl: origin, catalogJson, credentials: resolver });
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
    // Archived revisions are never discarded implicitly; every test starts from an empty configuration.
    await pool.query(`DELETE FROM "${schema}"."config" WHERE "scope" = $1`, [CONNECTION_SETTINGS_SCOPE]);
    await pool.query(`DELETE FROM "${schema}"."connection_profile_revisions"`);
    accounts = new Map(); calls = [];
    ownerId = randomUUID();
    await database.model('users').create({ data: { id: ownerId, username: `hot_${ownerId.replaceAll('-', '')}`, name: 'Synthetic buyer', typeId: 'member',
      email: `${ownerId}@example.invalid`, emailVerified: true, status: true } });
    build();
  });
  afterAll(async () => { await database?.disconnect(); await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool?.end(); });

  it('rotating keys mid-checkout: the order records its revision, is confirmed with the new key and fulfilled once', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order();
    expect(await row(created.id)).toMatchObject({ configRevision: 'payment-stripe@1', accountScope: 'acct-a' });
    expect(calls).toEqual([{ op: 'create', scope: 'acct-a', key: 'sk_test_A1', orderId: created.id }]);
    // Same-account rotation; the provider revokes the old key.
    await save(1, 'acct-a', 'sk_test_A2', 'whsec_A2'); account('acct-a').keys.delete('sk_test_A1');
    const { checkoutId } = await row(created.id);
    account('acct-a').ledger.pay(checkoutId);
    await billing.confirm(created.id, ownerId);
    await billing.confirm(created.id, ownerId);
    await billing.webhook('stripe', webhook('whsec_A2', { checkoutId, reference: created.id }));
    expect(await balance()).toBe(100);
    expect((await row(created.id)).configRevision).toBe('payment-stripe@1');
    expect(calls.filter(call => call.op === 'retrieve').every(call => call.key === 'sk_test_A2')).toBe(true);
    // A new order uses the current revision without any restart.
    const next = await order();
    expect((await row(next.id)).configRevision).toBe('payment-stripe@2');
    expect(calls.find(call => call.op === 'create' && call.orderId === next.id)?.key).toBe('sk_test_A2');
  });

  it('a webhook signed with the previous secret after a rotation verifies through the retained revision, once', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    await save(1, 'acct-a', 'sk_test_A2', 'whsec_A2');
    account('acct-a').ledger.pay(checkoutId);
    const old = webhook('whsec_A1', { checkoutId, reference: created.id });
    await billing.webhook('stripe', old);
    await billing.webhook('stripe', old);
    expect(await balance()).toBe(100);
    expect((await row(created.id)).fulfilledAt).toBeTruthy();
    // A signature no retained revision produced is refused.
    await expect(billing.webhook('stripe', webhook('whsec_forged', { checkoutId, reference: created.id }))).rejects.toThrow();
  });

  it('a refund of an order created before a rotation and an account switch uses the newest key of the order account', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    account('acct-a').ledger.pay(checkoutId);
    await billing.confirm(created.id, ownerId);
    expect(await balance()).toBe(100);
    await save(1, 'acct-a', 'sk_test_A2', 'whsec_A2'); account('acct-a').keys.delete('sk_test_A1');
    await save(2, 'acct-b', 'sk_test_B1', 'whsec_B1');
    calls.length = 0;
    await billing.refunds.create(operator, `refund-${randomUUID()}`, { targetType: 'order', targetId: created.id, amount: '10.00' });
    const refundCalls = calls.filter(call => call.op.startsWith('refund'));
    expect(refundCalls.length).toBeGreaterThan(0);
    expect(refundCalls.every(call => call.scope === 'acct-a' && call.key === 'sk_test_A2')).toBe(true);
    expect(await balance()).toBe(0);
    // New orders go to the new account.
    const next = await order();
    expect(await row(next.id)).toMatchObject({ configRevision: 'payment-stripe@3', accountScope: 'acct-b' });
  });

  it('switching to another provider account never lets the new account settle or read old orders', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    const created = await order(); const { checkoutId } = await row(created.id);
    await save(1, 'acct-b', 'sk_test_B1', 'whsec_B1');
    account('acct-a').ledger.pay(checkoutId);
    // A webhook verified only by account B's secret cannot settle account A's order.
    await expect(billing.webhook('stripe', webhook('whsec_B1', { checkoutId, reference: created.id }))).rejects.toThrow('Webhook account does not match the order');
    expect((await row(created.id)).fulfilledAt).toBeNull();
    expect(calls.some(call => call.scope === 'acct-b' && call.op === 'retrieve')).toBe(false);
    // Account A's own (retained) secret settles it, through account A's key.
    await billing.webhook('stripe', webhook('whsec_A1', { checkoutId, reference: created.id }));
    expect(await balance()).toBe(100);
    expect(calls.filter(call => call.op === 'retrieve').every(call => call.scope === 'acct-a' && call.key === 'sk_test_A1')).toBe(true);
    // A recorded revision altered in the database to the other account, a missing one or garbage is refused, with no provider call.
    const fresh = await order();
    expect(await row(fresh.id)).toMatchObject({ configRevision: 'payment-stripe@2', accountScope: 'acct-b' });
    calls.length = 0;
    for (const forged of ['payment-stripe@1', 'payment-stripe@99', 'payment-stripe@x', 'payment-creem@2', 'payment-stripe@2,payment-stripe@2']) {
      await pool.query(`UPDATE "${schema}"."billing_orders" SET "configRevision" = $1 WHERE id = $2`, [forged, fresh.id]);
      await expect(billing.confirm(fresh.id, ownerId)).rejects.toMatchObject({ code: 'verification_failed' });
    }
    expect(calls).toEqual([]);
  });

  it('saves racing concurrent creates: every recorded revision exists and matches the key that created the checkout', async () => {
    await save(0, 'acct-a', 'sk_test_A1', 'whsec_A1');
    account('acct-a').keys.add('sk_test_A2');
    const [orders] = await Promise.all([Promise.all(Array.from({ length: 10 }, () => order())), save(1, 'acct-a', 'sk_test_A2', 'whsec_A2')]);
    const keys: Record<string, string> = { 'payment-stripe@1': 'sk_test_A1', 'payment-stripe@2': 'sk_test_A2' };
    for (const created of orders) {
      const recorded = (await row(created.id)).configRevision as string;
      expect(Object.keys(keys)).toContain(recorded);
      expect(calls.find(call => call.op === 'create' && call.orderId === created.id)?.key).toBe(keys[recorded]);
    }
    // A second process sees the new revision on its next order.
    build();
    const later = await order();
    expect((await row(later.id)).configRevision).toBe('payment-stripe@2');
  });

  it('purge: superadmin only, dry run by default, refuses held revisions, audits every call', async () => {
    const admin = randomUUID();
    await database.model('users').create({ data: { id: admin, username: `root_${admin.replaceAll('-', '')}`, name: 'Synthetic root', typeId: 'admin', email: `${admin}@example.invalid`, status: true } });
    const role = await database.model('roles').upsert({ where: { name: 'superadmin' }, update: {}, create: { name: 'superadmin', description: 'Administrator' } }) as { id: string };
    await database.model('userRoles').create({ data: { userId: admin, roleId: role.id } });
    const retention = new PaymentCredentialRetention(database, billing, settings);
    const context = { method: 'POST', path: '/management/payment-credentials/purge' };
    // Own account scopes: orders of the other tests (same schema) belong to other accounts and hold nothing here.
    // Revision numbers restart in each test (archives are cleaned): age the other tests' orders out of the retention window.
    await pool.query(`UPDATE "${schema}"."billing_orders" SET "createdAt" = now() - interval '450 days'`);
    await save(0, 'acct-purge-a', 'sk_test_A1', 'whsec_A1');
    const created = await order();
    await save(1, 'acct-purge-a', 'sk_test_A2', 'whsec_A2'); await save(2, 'acct-purge-b', 'sk_test_B1', 'whsec_B1');
    await expect(retention.purge(ownerId, { profileId: 'payment-stripe', dryRun: true }, context)).rejects.toBeInstanceOf(ForbiddenException);
    // Every revision is recent: nothing is purgeable.
    expect((await retention.purge(admin, { profileId: 'payment-stripe', dryRun: true }, context)).selected).toEqual([]);
    await pool.query(`UPDATE "${schema}"."connection_profile_revisions" SET "createdAt" = now() - interval '500 days' WHERE "profileId" = 'payment-stripe'`);
    const inventory = await retention.inventory(admin);
    const holds = Object.fromEntries(inventory.profiles.find(row => row.profileId === 'payment-stripe')!.revisions.map(row => [row.revision, row.holds]));
    // Revision 1 is the unfinished order's recorded revision; revision 2 is what it resolves to (newest of account A); 3 is current.
    expect(holds).toEqual({ 1: ['unfinished-order'], 2: ['unfinished-order'], 3: ['current'] });
    await expect(retention.purge(admin, { profileId: 'payment-stripe', dryRun: false, revisions: [1] }, context)).rejects.toBeInstanceOf(ConflictException);
    expect((await settings.revisions('payment-stripe')).map(row => row.revision)).toEqual([3, 2, 1]);
    // The order is finished long ago (outside the refund horizon): 1 and 2 become purgeable; dry run deletes nothing.
    await pool.query(`UPDATE "${schema}"."billing_orders" SET "fulfilledAt" = now() - interval '450 days', "createdAt" = now() - interval '450 days', state = 'paid' WHERE id = $1`, [created.id]);
    const dry = await retention.purge(admin, { profileId: 'payment-stripe', dryRun: true }, context);
    expect(dry).toMatchObject({ dryRun: true, selected: [1, 2], deleted: [] });
    expect((await settings.revisions('payment-stripe')).map(row => row.revision)).toEqual([3, 2, 1]);
    const done = await retention.purge(admin, { profileId: 'payment-stripe', dryRun: false, revisions: [1] }, context);
    expect(done).toMatchObject({ dryRun: false, deleted: [1], retainedRevisions: 2 });
    expect(await settings.environmentAt('payment-stripe', 1)).toBeUndefined();
    await expect(retention.purge(admin, { profileId: 'payment-stripe', dryRun: false, revisions: [3] }, context)).rejects.toBeInstanceOf(ConflictException);
    const audit = (await pool.query(`SELECT action, status, "userId", metadata FROM "${schema}"."operation_logs" WHERE module = 'payment-credentials' ORDER BY "createdAt"`)).rows;
    expect(audit.map(row => [row.action, row.status])).toEqual([['purge-dry-run', 'SUCCESS'], ['purge-refused', 'FAILED'], ['purge-dry-run', 'SUCCESS'], ['purge', 'SUCCESS'], ['purge-refused', 'FAILED']]);
    expect(audit.every(row => row.userId === admin)).toBe(true);
    for (const text of [JSON.stringify(audit), JSON.stringify(inventory), JSON.stringify(dry), JSON.stringify(done)]) {
      for (const secret of ['sk_test_', 'whsec_']) expect(text).not.toContain(secret);
    }
  });
});
