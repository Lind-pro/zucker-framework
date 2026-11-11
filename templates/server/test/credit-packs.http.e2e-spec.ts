import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { MenuController, PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerAdminModule } from '@zucker-framework/admin';
import { ZuckerMonitoringModule } from '@zucker-framework/monitoring';
import { ZuckerLoggingModule } from '@zucker-framework/logging';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { RefundProtocolError } from '@zucker-framework/payment';
import type { HostedCheckoutAdapter, HostedCheckoutObservation, HostedCheckoutOrder, RefundAdapter, RefundObservation, RefundPaymentObservation } from '@zucker-framework/payment';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { createAdministrator } from '../src/accounts/create-administrator';
import { BILLING_OPTIONS, BillingService, type BillingOptions } from '../src/billing/billing.service';
import { BILLING_POLICIES } from '../src/billing/billing.policy';
import { SubscriptionsModule } from '../src/subscriptions/subscriptions.module';
import { RuntimeSettingsModule } from '../src/runtime-settings/runtime-settings.module';
import { RUNTIME_SETTINGS_BASE_ENV } from '../src/runtime-settings/runtime-settings.tokens';
import { PolicyModule } from '../src/policy/policy.module';
import { PolicyService } from '../src/policy/policy.service';
import { applicationCorsOptions } from '../src/http-options';

/**
 * Credit packs and plan credits over real HTTP + PostgreSQL: security gates (viewer 403, no secret in
 * the public catalog), idempotency under 10 concurrent requests, webhook replay, provider-choice policy,
 * locale fallback, pack deletion with an open order and a credit-pack refund. Providers are synthetic.
 */
const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_packs_http_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202', password = 'SyntheticPacks9!';
const SECRET_SCOPE = 'SENTINEL-ACCOUNT-SCOPE-never-public', SECRET_REF = 'price_SENTINELREFNEVERPUBLIC';
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WEB_URL: origin, JWT_SECRET: 'synthetic-credit-packs-jwt-at-least-32-chars',
  CONFIG_ENCRYPTION_KEY: 'synthetic-config-encryption-key-for-packs-only' };
const money = (amount: string) => ({ amount, currency: 'USD' });

run('credit packs, plan credits and checkout over HTTP (PostgreSQL)', () => {
  let app: INestApplication, pool: Pool, database: ApplicationDatabase, billing: BillingService, policies: PolicyService;
  let admin: { id: string; token: string }, viewer: { id: string; token: string }, buyer: { id: string; token: string }, plain: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const checkouts = new Map<string, HostedCheckoutObservation>(), orders = new Map<string, HostedCheckoutOrder>();
  const creations: Record<string, number> = {}, payments = new Map<string, RefundPaymentObservation>(), refunds: RefundObservation[] = [];

  function hosted(id: string): HostedCheckoutAdapter {
    return { id, accountScope: SECRET_SCOPE, modes: ['payment'], validate() {},
      async create(order) {
        creations[order.id] = (creations[order.id] ?? 0) + 1; orders.set(order.id, structuredClone(order));
        const fact: HostedCheckoutObservation = { checkoutId: `checkout-${order.id}`, reference: order.id, catalogReference: order.offer.catalogReference,
          mode: order.offer.mode, quantity: 1, state: 'pending', url: `https://synthetic.invalid/pay/${order.id}` };
        checkouts.set(fact.checkoutId, fact); return structuredClone(fact);
      },
      async retrieve(checkoutId) { return structuredClone(checkouts.get(checkoutId)!); },
      async verifyWebhook(input) {
        if (input.headers['x-synthetic-signature'] !== 'valid') return null;
        return JSON.parse(Buffer.from(input.rawBody).toString('utf8')) as { eventId: string; checkoutId: string; reference: string };
      } };
  }
  const refundAdapter: RefundAdapter = { id: 'stripe', accountScope: SECRET_SCOPE,
    capabilities: { paymentKinds: ['payment-intent'], partial: true, requestIdempotency: 'provider', retrieveRefund: true, listRefunds: false },
    async retrievePayment(payment) { const value = payments.get(payment.paymentId); if (!value) throw new Error('Synthetic payment unavailable'); return structuredClone(value); },
    async retrieve(refundId) { return structuredClone(refunds.find(row => row.refundId === refundId)!); },
    async create(command) {
      const paid = payments.get(command.payment.paymentId)!;
      const refund: RefundObservation = { refundId: `refund-${command.commandKey}`, paymentId: command.payment.paymentId, paymentKind: command.payment.paymentKind,
        source: paid.source, state: 'succeeded', providerStatus: 'succeeded', money: command.money, commandKey: command.commandKey, occurredAt: new Date().toISOString() };
      refunds.push(refund); paid.refundedMoney = command.money; paid.settlement = 'refunded';
      return structuredClone(refund);
    },
    // Mirrors the real Stripe refund adapter: a bad signature throws, a valid non-refund event is ignored (null).
    async verifyWebhook(input) {
      if (input.headers['x-synthetic-signature'] !== 'valid') throw new RefundProtocolError('verification_failed', 'Synthetic signature rejected');
      return null;
    } };
  const options: BillingOptions = { providers: [hosted('stripe'), hosted('paypal')], refundProviders: [refundAdapter], webUrl: origin, catalogJson: '[]' };
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token = admin.token) =>
    request(app.getHttpServer())[method](`/api${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`);
  const order = (offerId: string, key: string, providerId = 'stripe', token = buyer.token) =>
    api('post', '/billing/orders', token).set('Idempotency-Key', key).send({ offerId, providerId });
  const orderIdFor = (userId: string, key: string) => createHash('sha256').update(JSON.stringify(['checkout', userId, key])).digest('hex');
  const webhook = (event: object, signature = 'valid', provider = 'stripe') => request(app.getHttpServer()).post(`/api/billing/webhooks/${provider}`)
    .set('Content-Type', 'application/json').set('X-Synthetic-Signature', signature).send(JSON.stringify(event));
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql.replaceAll('"S".', `"${schema}".`), values)).rows;
  const lots = (userId: string) => q('SELECT source, amount, "remainingAmount", "expiresAt" FROM "S".credit_lots WHERE "userId" = $1 ORDER BY "createdAt"', [userId]);
  const payOrder = (id: string, kind: 'payment-intent' = 'payment-intent') => {
    const placed = orders.get(id)!, checkoutId = `checkout-${id}`;
    checkouts.set(checkoutId, { ...checkouts.get(checkoutId)!, state: 'paid', paidMoney: placed.offer.money, paymentId: `payment-${id}`, paymentKind: kind });
    payments.set(`payment-${id}`, { paymentId: `payment-${id}`, paymentKind: kind, paidMoney: placed.offer.money, source: { kind: 'charge', id: `charge-${id}` }, settlement: 'paid',
      refundedMoney: money('0'), pendingRefundMoney: money('0') });
  };
  async function account(username: string, permissions: string[] = []) {
    const email = `${username}@example.invalid`;
    const action = (path: string, body: object) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', { username, email, password }).expect(201); await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200);
    for (const permission of permissions) {
      if (!await database.model('permissions').findUnique({ where: { id: permission } })) await database.model('permissions').create({ data: { id: permission, name: permission } });
      await database.model('userPermissions').create({ data: { userId: logged.body.userId, permissionId: permission, grantType: 'grant' } });
    }
    return { id: logged.body.userId as string, token: logged.body.token as string };
  }
  const packBody = (extra: object = {}) => ({ slug: `pack-${randomUUID().slice(0, 8)}`, title: 'Synthetic pack', credits: 100, expiresInDays: 30, status: true,
    prices: [{ currency: 'USD', amount: '9.90', providerRefs: { stripe: `price_${randomUUID().replaceAll('-', '').slice(0, 20)}` } }], ...extra });
  async function newPack(extra: object = {}) { return (await api('post', '/management/credit-packs').send(packBody(extra)).expect(201)).body as { id: string; slug: string }; }

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const limits = { points: 100_000, duration: 60 };
    const module = await Test.createTestingModule({ imports: [EventEmitterModule.forRoot(), ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: env.JWT_SECRET!, registerControllers: false }), ZuckerConfigModule.forRoot(), ZuckerMonitoringModule,
      ZuckerLoggingModule.forRoot({ persistence: {}, rejectedRequests: {} }), ZuckerAdminModule.forRoot({ features: ['users', 'roles', 'permissions'] }),
      ZuckerRateLimiterModule.forRoot({ limiters: { accounts: limits, 'session-refresh': limits, 'session-refresh-network': limits, 'session-read': limits,
        billing: limits, 'billing-webhook': limits, 'api-default': limits } }),
      RuntimeSettingsModule, PolicyModule.forRoot({ policies: [...BILLING_POLICIES] }), AccountModule, SubscriptionsModule],
      controllers: [MenuController],
      providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(RUNTIME_SETTINGS_BASE_ENV).useValue(env).overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(BILLING_OPTIONS).useValue(options).compile();
    app = module.createNestApplication({ rawBody: true }); app.enableCors(applicationCorsOptions({ ACCOUNT_ORIGINS: origin }));
    app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    billing = app.get(BillingService); policies = app.get(PolicyService);
    await createAdministrator(database, { username: 'packadmin', email: 'packadmin@example.invalid', password });
    admin = { id: '', token: (await request(app.getHttpServer()).post('/api/authorize/login').set('Origin', origin).send({ username: 'packadmin', password }).expect(200)).body.token };
    viewer = await account('packviewer', ['plans:query']); buyer = await account('packbuyer'); plain = await account('packplain');
  });
  afterAll(async () => { try { await app?.close(); await database?.disconnect(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } } });

  // ── Security gate 1: viewer role gets 403 on every write ────────────────
  it('refuses every credit pack and plan write to a read-only viewer and to a plain member, and changes nothing', async () => {
    const pack = await newPack();
    const plan = (await api('post', '/management/plans').send({ slug: 'gate-plan', name: 'Gate', status: true, prices: [{ interval: 'month', currency: 'USD', amount: '5', credits: 3, creditExpiry: 'period', providerRefs: {} }] }).expect(201)).body;
    const before = JSON.stringify([await q('SELECT * FROM "S".credit_packs ORDER BY id'), await q('SELECT * FROM "S".subscription_plans ORDER BY id')]);
    for (const user of [viewer, plain]) {
      for (const [method, path, body] of [
        ['post', '/management/credit-packs', packBody()], ['put', `/management/credit-packs/${pack.id}`, { credits: 1 }],
        ['patch', `/management/credit-packs/${pack.id}/status`, { status: false }], ['delete', `/management/credit-packs/${pack.id}`, undefined],
        ['post', '/management/plans', { slug: 'viewer-plan', name: 'V', prices: [] }], ['put', `/management/plans/${plan.id}`, { name: 'Hacked' }],
        ['patch', `/management/plans/${plan.id}/status`, { status: false }], ['delete', `/management/plans/${plan.id}`, undefined],
      ] as const) await api(method, path, user.token).send(body).expect(403);
    }
    // Reads need plans:query: a plain member is refused, a viewer may read; no token at all is 401.
    await api('get', '/management/credit-packs', plain.token).expect(403);
    await api('get', `/management/credit-packs/${pack.id}`, plain.token).expect(403);
    await api('get', '/management/credit-packs', viewer.token).expect(200);
    await request(app.getHttpServer()).post('/api/management/credit-packs').set('Origin', origin).send(packBody()).expect(401);
    await request(app.getHttpServer()).delete(`/api/management/credit-packs/${pack.id}`).set('Origin', origin).expect(401);
    expect(JSON.stringify([await q('SELECT * FROM "S".credit_packs ORDER BY id'), await q('SELECT * FROM "S".subscription_plans ORDER BY id')])).toBe(before);
    // An update-only operator may edit but not create or delete.
    const editor = await account('packeditor', ['plans:query', 'plans:update']);
    await api('put', `/management/credit-packs/${pack.id}`, editor.token).send({ credits: 150 }).expect(200);
    await api('post', '/management/credit-packs', editor.token).send(packBody()).expect(403);
    await api('delete', `/management/credit-packs/${pack.id}`, editor.token).expect(403);
  });

  // ── Security gate 5: no secret in the public catalog ────────────────────
  it('never exposes provider references, account scopes or private fields in /billing/plans, /billing/catalog or /billing/currencies', async () => {
    const pack = (await api('post', '/management/credit-packs').send(packBody({ slug: 'public-pack', prices: [{ currency: 'USD', amount: '4', providerRefs: { stripe: SECRET_REF } }] })).expect(201)).body;
    await api('post', '/management/plans').send({ slug: 'public-plan', name: 'Public', status: true,
      prices: [{ interval: 'one_time', currency: 'USD', amount: '8', termDays: 30, credits: 5, creditExpiry: 'period', providerRefs: { stripe: `${SECRET_REF}Plan` } }] }).expect(201);
    for (const path of ['/billing/plans', '/billing/plans?currency=USD&locale=zh', '/billing/catalog', '/billing/currencies']) {
      for (const response of [await request(app.getHttpServer()).get(`/api${path}`).expect(200), await api('get', path, buyer.token).expect(200)]) {
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(SECRET_REF); expect(text).not.toContain(SECRET_SCOPE);
        expect(text).not.toMatch(/providerRefs|accountScope|catalogReference|providerRef\b|fulfillmentData|"revision"|createdAt/);
      }
    }
    const body = (await request(app.getHttpServer()).get('/api/billing/plans').expect(200)).body;
    expect(body.packs.find((item: { slug: string }) => item.slug === 'public-pack').prices[0]).toEqual({ currency: 'USD', amount: '4.00', purchasable: true, providers: ['stripe'], offerId: `pack:${pack.id}:USD` });
    // Drafts are never listed publicly.
    await api('patch', `/management/credit-packs/${pack.id}/status`).send({ status: false }).expect(200);
    expect((await request(app.getHttpServer()).get('/api/billing/plans').expect(200)).body.packs.map((item: { slug: string }) => item.slug)).not.toContain('public-pack');
  });

  // ── Locale fallback ────────────────────────────────────────────────────
  it('localises plan and pack text: exact tag, then language, then base; hostile locales read as the base text', async () => {
    await api('post', '/management/credit-packs').send(packBody({ slug: 'i18n-pack', title: 'Base title', titleI18n: { zh: '中文标题', 'pt-BR': 'Titulo BR', pt: 'Titulo PT' },
      description: 'Base description', descriptionI18n: { zh: '中文描述' } })).expect(201);
    const titleFor = async (query: string) => {
      const found = (await request(app.getHttpServer()).get(`/api/billing/plans${query}`).expect(200)).body.packs.find((item: { slug: string }) => item.slug === 'i18n-pack');
      return [found.title, found.description];
    };
    expect(await titleFor('?locale=zh')).toEqual(['中文标题', '中文描述']);
    expect(await titleFor('?locale=zh-Hans')).toEqual(['中文标题', '中文描述']);
    expect(await titleFor('?locale=pt-BR')).toEqual(['Titulo BR', 'Base description']);
    expect(await titleFor('?locale=pt-PT')).toEqual(['Titulo PT', 'Base description']);
    for (const query of ['', '?locale=fr', '?locale=%3Cscript%3E', '?locale=constructor', '?locale=zh_CN', `?locale=${'a'.repeat(200)}`])
      expect(await titleFor(query)).toEqual(['Base title', 'Base description']);
    // An unknown or hostile currency never filters the page to nothing.
    expect((await request(app.getHttpServer()).get('/api/billing/plans?currency=%27%3B--').expect(200)).body.packs.length).toBeGreaterThan(0);
  });

  // ── Security gate 6: checkout idempotency under 10 concurrent requests ──
  it('creates exactly one order and one provider checkout for 10 concurrent requests with one Idempotency-Key', async () => {
    const pack = await newPack(), key = `idem-${randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 10 }, () => order(`pack:${pack.id}:USD`, key)));
    expect(responses.map(response => response.status)).toEqual(Array(10).fill(200));
    const ids = new Set(responses.map(response => response.body.id));
    expect([...ids]).toEqual([orderIdFor(buyer.id, key)]);
    expect(await q('SELECT count(*)::int AS n FROM "S".billing_orders WHERE "ownerId" = $1 AND "offerId" = $2', [buyer.id, `pack:${pack.id}:USD`])).toEqual([{ n: 1 }]);
    expect(creations[orderIdFor(buyer.id, key)]).toBe(1);
    // The same key with a different offer is refused rather than silently returning the first order.
    const other = await newPack();
    expect((await order(`pack:${other.id}:USD`, key)).status).toBeGreaterThanOrEqual(400);
    // 10 distinct keys are 10 independent orders.
    const fanOut = await Promise.all(Array.from({ length: 10 }, () => order(`pack:${pack.id}:USD`, `fan-${randomUUID()}`)));
    expect(new Set(fanOut.map(response => response.body.id)).size).toBe(10);
  });

  it('refuses offers that cannot be sold: draft pack, missing provider reference, unknown pack, foreign provider and injected amounts', async () => {
    const draft = await newPack({ status: false }), noRef = await newPack({ prices: [{ currency: 'USD', amount: '3', providerRefs: { paypal: `price_${randomUUID().replaceAll('-', '').slice(0, 20)}` } }] });
    const before = (await q('SELECT count(*)::int AS n FROM "S".billing_orders'))[0].n;
    for (const [offerId, providerId] of [[`pack:${draft.id}:USD`, 'stripe'], [`pack:${noRef.id}:USD`, 'stripe'], ['pack:missing:USD', 'stripe'],
      [`pack:${noRef.id}:EUR`, 'paypal'], [`pack:${noRef.id}:USD`, 'creem']] as const)
      expect((await order(offerId, `bad-${randomUUID()}`, providerId)).status).toBeGreaterThanOrEqual(400);
    await api('post', '/billing/orders').set('Idempotency-Key', `bad-${randomUUID()}`).send({ offerId: `pack:${noRef.id}:USD`, providerId: 'paypal', amount: '0.01' }).expect(400);
    expect((await q('SELECT count(*)::int AS n FROM "S".billing_orders'))[0].n - before).toBe(0);
  });

  // ── Security gates 2 + 6: webhooks and confirm, replay and concurrency ──
  it('grants a pack once for 10 concurrent webhook replays and 10 concurrent confirms; a bad signature changes nothing', async () => {
    const pack = await newPack({ credits: 250, expiresInDays: 10 });
    const key = `grant-${randomUUID()}`, created = (await order(`pack:${pack.id}:USD`, key).expect(200)).body, id = created.id as string;
    const event = { eventId: `evt-${id}`, checkoutId: `checkout-${id}`, reference: id };
    // Not yet paid at the provider: a signed webhook must not grant (it is answered, not applied).
    expect((await webhook(event)).status).toBeLessThan(600);
    expect(await lots(buyer.id)).toEqual([]);
    payOrder(id);
    // Forged or unsigned callbacks fail closed (no state change), even after the payment is real.
    for (const signature of ['forged', '']) await webhook(event, signature);
    await request(app.getHttpServer()).post('/api/billing/webhooks/stripe').set('Content-Type', 'application/json').send(JSON.stringify(event));
    await request(app.getHttpServer()).post('/api/billing/webhooks/unknown-provider').set('X-Synthetic-Signature', 'valid').send(JSON.stringify(event));
    expect(await lots(buyer.id)).toEqual([]);
    expect((await q('SELECT "fulfilledAt" FROM "S".billing_orders WHERE id = $1', [id]))[0].fulfilledAt).toBeNull();
    // 10 concurrent valid replays plus 10 concurrent browser confirms.
    const results = await Promise.all([...Array.from({ length: 10 }, () => webhook(event)),
      ...Array.from({ length: 10 }, () => api('post', `/billing/orders/${id}/confirm`, buyer.token).send({}))]);
    // Losers of the race are told to retry (409 conflict by design); nothing else is acceptable and at least one wins.
    expect(results.map(result => result.status).filter(status => status !== 200 && status !== 409), 'unexpected statuses').toEqual([]);
    expect(results.some(result => result.status === 200)).toBe(true);
    await api('post', `/billing/orders/${id}/confirm`, buyer.token).send({}).expect(200);
    const granted = await lots(buyer.id);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ source: 'purchase', amount: 250, remainingAmount: 250 });
    const expires = (granted[0].expiresAt as Date).getTime() - Date.now();
    expect(expires).toBeGreaterThan(9.9 * 86_400_000); expect(expires).toBeLessThan(10.1 * 86_400_000);
    expect((await api('get', '/billing/balance', buyer.token).expect(200)).body).toMatchObject({ balance: 250 });
    // Later replays (and a webhook for another buyer's order id) stay no-ops.
    await webhook(event).expect(200);
    await api('post', `/billing/orders/${id}/confirm`, plain.token).send({}).expect(res => expect([403, 404]).toContain(res.status));
    expect(await lots(buyer.id)).toHaveLength(1);
    expect(await q('SELECT count(*)::int AS n FROM "S".credit_transaction WHERE "userId" = $1', [buyer.id])).toEqual([{ n: 1 }]);
    // The grant used the snapshot frozen on the order, not later edits to the pack.
    await api('put', `/management/credit-packs/${pack.id}`).send({ credits: 1 }).expect(200);
    expect((await q('SELECT offer FROM "S".billing_orders WHERE id = $1', [id]))[0].offer.fulfillmentData).toMatchObject({ credits: 250, expiresInDays: 10, pack: { packId: pack.id, credits: 250 } });
  });

  it('answers a forged, unsigned or unknown-provider webhook with a 4xx (gate 2: fail closed, not 5xx)', async () => {
    const pack = await newPack(), created = (await order(`pack:${pack.id}:USD`, `forged-${randomUUID()}`).expect(200)).body, id = created.id as string;
    payOrder(id);
    const event = { eventId: `evt-${id}`, checkoutId: `checkout-${id}`, reference: id };
    const statuses: Record<string, number> = {
      forged: (await webhook(event, 'forged')).status, emptySignature: (await webhook(event, '')).status,
      missingHeader: (await request(app.getHttpServer()).post('/api/billing/webhooks/stripe').set('Content-Type', 'application/json').send(JSON.stringify(event))).status,
      unknownProvider: (await request(app.getHttpServer()).post('/api/billing/webhooks/unknown-provider').set('X-Synthetic-Signature', 'valid').send(JSON.stringify(event))).status,
    };
    for (const status of Object.values(statuses)) { expect(status, JSON.stringify(statuses)).toBeGreaterThanOrEqual(400); expect(status, JSON.stringify(statuses)).toBeLessThan(500); }
    expect((await q('SELECT "fulfilledAt" FROM "S".billing_orders WHERE id = $1', [id]))[0].fulfilledAt).toBeNull();
  });

  // ── Server-side write validation and optimistic concurrency ─────────────
  it('validates plan and pack writes on the server (credits, expiry, locales, highlights) and serialises concurrent edits by revision', async () => {
    const price = (extra: object) => ({ interval: 'month', currency: 'USD', amount: '5', providerRefs: {}, ...extra });
    const create = (body: object) => api('post', '/management/plans').send({ name: 'V', status: true, ...body });
    for (const [name, body] of [
      ['period expiry on a lifetime price', { slug: 'v1', prices: [price({ interval: 'lifetime', credits: 5, creditExpiry: 'period' })] }],
      ['fractional credits', { slug: 'v2', prices: [price({ credits: 1.5 })] }],
      ['negative credits', { slug: 'v3', prices: [price({ credits: -1 })] }],
      ['expiry of zero days', { slug: 'v4', prices: [price({ credits: 1, creditExpiry: 0 })] }],
      ['bad locale key', { slug: 'v5', prices: [], nameI18n: { 'en US': 'x' } }],
      ['too many highlights', { slug: 'v6', prices: [], highlights: Array.from({ length: 13 }, (_v, i) => `h${i}`) }],
      ['unknown field', { slug: 'v7', prices: [], isAdmin: true }],
      ['control character in badge', { slug: 'v8', prices: [], badge: 'a\u0007b' }],
    ] as const) expect((await create(body)).status, name).toBe(400);
    expect(await q(`SELECT 1 FROM "S".subscription_plans WHERE slug ~ '^v[0-9]$'`)).toEqual([]);
    const pack = await newPack({ credits: 10 });
    const races = await Promise.all(Array.from({ length: 10 }, (_v, index) => api('put', `/management/credit-packs/${pack.id}`).send({ credits: 100 + index, expectedRevision: 0 })));
    expect(races.filter(response => response.status === 200)).toHaveLength(1);
    expect(races.filter(response => response.status === 409)).toHaveLength(9);
    expect((await api('get', `/management/credit-packs/${pack.id}`).expect(200)).body.revision).toBe(1);
    // 10 concurrent creates of one slug: one winner, the rest conflict, and exactly one row exists.
    const slug = `race-${randomUUID().slice(0, 8)}`;
    const creates = await Promise.all(Array.from({ length: 10 }, (_v, index) => api('post', '/management/credit-packs').send(packBody({ slug,
      prices: [{ currency: 'USD', amount: '1', providerRefs: { stripe: `price_race${index}x${randomUUID().replaceAll('-', '').slice(0, 12)}` } }] }))));
    expect(creates.filter(response => response.status === 201)).toHaveLength(1);
    expect(creates.filter(response => response.status !== 201).every(response => response.status === 409)).toBe(true);
    expect(await q('SELECT 1 FROM "S".credit_packs WHERE slug = $1', [slug])).toHaveLength(1);
  });

  // ── Provider-choice enforcement ────────────────────────────────────────
  it('holds buyers to the default provider when choice is off, advertises it, and ignores a default that is not enabled', async () => {
    const pack = await newPack({ prices: [{ currency: 'USD', amount: '6', providerRefs: { stripe: `price_${randomUUID().replaceAll('-', '').slice(0, 20)}`, paypal: `P-${randomUUID().replaceAll('-', '').slice(0, 20)}` } }] });
    const setPolicy = async (values: Record<string, unknown>) => { const current = await policies.view('billing'); await policies.save('synthetic-operator', 'billing', { expectedRevision: current.revision, values }); };
    expect((await order(`pack:${pack.id}:USD`, `pc-${randomUUID()}`, 'paypal')).status).toBe(200); // default policy: free choice
    await setPolicy({ defaultProvider: 'stripe', allowProviderChoice: false });
    expect((await request(app.getHttpServer()).get('/api/billing/plans').expect(200)).body.checkout).toEqual({ defaultProvider: 'stripe', allowProviderChoice: false, promoCodes: 'none' });
    const before = (await q('SELECT count(*)::int AS n FROM "S".billing_orders'))[0].n;
    expect((await order(`pack:${pack.id}:USD`, `pc-${randomUUID()}`, 'paypal')).status).toBe(400);
    expect((await q('SELECT count(*)::int AS n FROM "S".billing_orders'))[0].n).toBe(before);
    expect((await order(`pack:${pack.id}:USD`, `pc-${randomUUID()}`, 'stripe')).status).toBe(200);
    // A default provider that is not enabled is reported as null and does not lock buyers out.
    await setPolicy({ defaultProvider: 'creem', allowProviderChoice: false });
    expect((await request(app.getHttpServer()).get('/api/billing/plans').expect(200)).body.checkout).toEqual({ defaultProvider: null, allowProviderChoice: false, promoCodes: 'none' });
    expect((await order(`pack:${pack.id}:USD`, `pc-${randomUUID()}`, 'paypal')).status).toBe(200);
    await setPolicy({ defaultProvider: null, allowProviderChoice: null });
    expect((await request(app.getHttpServer()).get('/api/billing/plans').expect(200)).body.checkout).toEqual({ defaultProvider: null, allowProviderChoice: true, promoCodes: 'none' });
  });

  // ── Pack deletion with an open order; refund ────────────────────────────
  it('refuses to delete a pack with an open order, deletes it once fulfilled, and the frozen order survives', async () => {
    const pack = await newPack({ credits: 40 }), created = (await order(`pack:${pack.id}:USD`, `del-${randomUUID()}`).expect(200)).body, id = created.id as string;
    expect((await api('delete', `/management/credit-packs/${pack.id}`).expect(409)).body).toBeTruthy();
    expect(await q('SELECT 1 FROM "S".credit_packs WHERE id = $1', [pack.id])).toHaveLength(1);
    payOrder(id); await api('post', `/billing/orders/${id}/confirm`, buyer.token).send({}).expect(200);
    await api('delete', `/management/credit-packs/${pack.id}`).expect(200);
    await api('delete', `/management/credit-packs/${pack.id}`).expect(404);
    expect(await q('SELECT 1 FROM "S".credit_pack_prices WHERE "packId" = $1', [pack.id])).toEqual([]);
    expect((await q('SELECT offer FROM "S".billing_orders WHERE id = $1', [id]))[0].offer.fulfillmentData.pack).toMatchObject({ packId: pack.id, credits: 40 });
    // The deleted pack can no longer be sold.
    expect((await order(`pack:${pack.id}:USD`, `del-${randomUUID()}`)).status).toBeGreaterThanOrEqual(400);
    // 10 concurrent deletes of a fresh pack: exactly one succeeds, the rest are 404.
    const fresh = await newPack();
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => api('delete', `/management/credit-packs/${fresh.id}`)))).map(response => response.status);
    expect(statuses.filter(status => status === 200)).toHaveLength(1); expect(statuses.filter(status => status === 404)).toHaveLength(9);
  });

  it('refunds a credit pack purchase: the granted credits are recovered exactly once', async () => {
    const pack = await newPack({ credits: 60, prices: [{ currency: 'USD', amount: '12.00', providerRefs: { stripe: `price_${randomUUID().replaceAll('-', '').slice(0, 20)}` } }] });
    const refundee = await account(`refundee${randomUUID().slice(0, 6)}`);
    const created = (await order(`pack:${pack.id}:USD`, `rf-${randomUUID()}`, 'stripe', refundee.token).expect(200)).body, id = created.id as string;
    payOrder(id); await api('post', `/billing/orders/${id}/confirm`, refundee.token).send({}).expect(200);
    expect((await lots(refundee.id))[0]).toMatchObject({ amount: 60, remainingAmount: 60 });
    const refundKey = randomUUID();
    const refund = () => api('post', '/billing/refunds').set('Idempotency-Key', refundKey).send({ targetType: 'order', targetId: id, amount: '12.00', reason: 'Synthetic refund' });
    const first = await refund();
    expect(first.status).toBeLessThan(300);
    const replay = await refund();
    expect(replay.status).toBeLessThan(300);
    expect(refunds.filter(row => row.paymentId === `payment-${id}`)).toHaveLength(1);
    expect(await lots(refundee.id)).toEqual([expect.objectContaining({ amount: 60, remainingAmount: 0 })]);
    expect((await api('get', '/billing/balance', refundee.token).expect(200)).body).toMatchObject({ balance: 0, frozenBalance: 0 });
  });
});
