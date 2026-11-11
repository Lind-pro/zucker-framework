/**
 * Inbox (WP 3.2) test-engineer matrix on PostgreSQL: scanner races over many batches with timestamp ties,
 * the settle window, every built-in source against billing/AI fixtures, a source that fails mid-scan,
 * retention batch limits, the emit validation tables and the deletion contributor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ApplicationDatabase } from '../src/database';
import type { JobsService } from '../src/jobs/jobs.service';
import { InboxEventScanner, InboxService, INBOX_SOURCES, InboxEmitError, defineInboxSource, inboxDeletionContributor, inboxFeedbackNotifier,
  inboxOptionsFromEnvironment, inboxReferralNotifier, isInboxHref, validateInboxEmit, type InboxSource } from '../src/inbox';
import { createIsolatedSchema, type IsolatedSchema } from './helpers/phase3-schema';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const HOUR = 3_600_000;

run('inbox scanner and emit matrix (PostgreSQL)', () => {
  let iso: IsolatedSchema, scoped: Pool, db: ApplicationDatabase, inbox: InboxService;
  let seq = 0;
  const q = (sql: string, values: unknown[] = []) => scoped.query(sql, values);
  const count = async (where = 'TRUE', values: unknown[] = []) => (await q(`SELECT count(*)::int AS n FROM inbox_notifications WHERE ${where}`, values)).rows[0].n as number;
  const scanner = (overrides: Record<string, unknown> = {}, sources?: readonly InboxSource[]) =>
    new InboxEventScanner(db, inbox, { ...inboxOptionsFromEnvironment({}), settleMs: 0, ...overrides }, { registerWakeSource() {} } as unknown as JobsService, sources ?? INBOX_SOURCES);
  // A fresh cursor starts three days back, so earlier fixtures are cleared to keep every test self-contained.
  const resetCursors = async () => { await q(`DELETE FROM inbox_cursors`); await q(`DELETE FROM billing_outbox`); };
  const next = (prefix: string) => `${prefix}${++seq}`;
  async function user(id: string, username = id) { await q(`INSERT INTO users (id, username, password, name, "typeId") VALUES ($1, $2, 'x', 'n', 'member')`, [id, username]); }
  async function order(id: string, ownerId: string, extra: { offer?: object; subscriptionId?: string; paymentId?: string } = {}) {
    await q(`INSERT INTO billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
      "creationState", "captureState", state, "paymentId", "paymentKind", "subscriptionId", "fulfilledAt")
      VALUES ($1, $2, 'pack', 'fake', 'default', $3::jsonb, '/s', '/c', $1 || ':c', $1 || ':k', 'created', 'captured', 'paid', $4, 'pi', $5, now())`,
    [id, ownerId, JSON.stringify(extra.offer ?? {}), extra.paymentId ?? `${id}:pay`, extra.subscriptionId ?? null]);
  }
  const outbox = (kind: string, aggregateId: string, payload: object, at: Date) =>
    q(`INSERT INTO billing_outbox (id, kind, "aggregateId", payload, "createdAt") VALUES ($1, $2, $3, $4::jsonb, $5)`, [next('ob-'), kind, aggregateId, JSON.stringify(payload), at]);
  async function subscription(orderId: string, ownerId: string, subscriptionId: string) {
    const offer = { mode: 'subscription', catalogReference: 'plan1', version: 'v1', fulfillmentData: {} };
    await order(orderId, ownerId, { offer, subscriptionId, paymentId: `${orderId}:pay` });
    await q(`INSERT INTO billing_subscriptions (id, "ownerId", "initialOrderId", "providerId", "accountScope", "providerSubscriptionId", "catalogReference", offer, "grantBasis",
      "initialPaymentId", "initialPaymentKind") VALUES ($1, $2, $3, 'fake', 'default', $4, 'plan1', $5::jsonb, 'payment', $3 || ':pay', 'pi')`,
    [`bind-${orderId}`, ownerId, orderId, subscriptionId, JSON.stringify(offer)]);
    return `bind-${orderId}`;
  }
  const cycle = (id: string, bindingId: string, ownerId: string, subscriptionId: string, paymentId: string, initial: boolean) =>
    q(`INSERT INTO billing_subscription_cycles (id, "cycleKey", "bindingId", "ownerId", "providerId", "accountScope", "subscriptionId", "catalogReference", basis, "paymentId", "paymentKind",
      "recordId", "paidMoney", "paidAt", "policyVersion", policy, initial, "fulfilledAt") VALUES ($1, $1, $2, $3, 'fake', 'default', $4, 'plan1', 'payment', $5, 'pi', $1,
      '{"amount":"1.00","currency":"USD"}'::jsonb, now(), 'v1', '{}'::jsonb, $6, now())`, [id, bindingId, ownerId, subscriptionId, paymentId, initial]);
  async function refund(id: string, ownerId: string, orderId: string, state: string) {
    await q(`INSERT INTO billing_refund_payments (id, "ownerId", "orderId", "providerId", "accountScope", "paymentKind", "paymentId", "sourceKind", "sourceId", title, "paidMoney", "paidMinor",
      "minorScale", "totalCredits", "observedAt") VALUES ($1, $2, $3, 'fake', 'default', 'pi', $1 || ':pay', 'pi', $1 || ':pay', 'Pack', '{"amount":"10.00","currency":"USD"}'::jsonb, '1000', 2, 100, now())`, [`rp-${id}`, ownerId, orderId]);
    await q(`INSERT INTO billing_refund_requests (id, "targetId", "ownerId", "actorId", "clientKey", "commandKey", "requestedMinor", "beforeRefundedMinor", "expectedRefundedMinor", money, state,
      "creditAmount") VALUES ($1, $2, $3, 'staff', $1, $1, '100', '0', '100', '{"amount":"1.00","currency":"USD"}'::jsonb, $4, 0)`, [id, `rp-${id}`, ownerId, state]);
  }
  async function aiTask(id: string, ownerId: string, status: string, completedAt: Date | null, kind = 'image') {
    await q(`INSERT INTO async_jobs (id, kind, "resourceType", "resourceId", "userId", status, "maxAttempts", "idempotencyKey", "idempotencyFingerprint", "handlerVersion", payload, "completedAt")
      VALUES ($1, $2, 'ai-task', $1, $3, $4, 3, $1, 'f', '1', '{}'::jsonb, $5)`, [id, `ai.${kind}`, ownerId, status, completedAt]);
    await q(`INSERT INTO ai_tasks (id, "ownerId", kind, "providerId", model, cost, "holdState", "deadlineAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'fake', 'm', 1, 'NONE', now(), now(), now())`, [id, ownerId, kind]);
  }
  const typesFor = async (userId: string) => (await q(`SELECT "eventKey", type, params, href FROM inbox_notifications WHERE "userId"=$1 ORDER BY "eventKey"`, [userId])).rows;

  beforeAll(async () => {
    iso = await createIsolatedSchema('zucker_inboxm', databaseUrl!);
    scoped = new Pool({ connectionString: databaseUrl!, connectionTimeoutMillis: 5000, options: `-c search_path=${iso.schema} -c timezone=UTC` });
    db = new ApplicationDatabase(iso.url.href); inbox = new InboxService(db);
    for (const id of ['u1', 'u2', 'u3']) await user(id);
    await user('gone', 'deleted-gone');
  }, 60_000);
  afterAll(async () => { try { await db?.disconnect(); await scoped?.end(); } finally { await iso?.drop(); } });

  describe('scanner races', () => {
    it('23 outbox rows with one identical timestamp: racing scanners over small batches consume every row exactly once', async () => {
      await resetCursors();
      const tie = new Date(Date.now() - HOUR);
      for (let index = 0; index < 23; index += 1) {
        const id = `tie-${String(index).padStart(2, '0')}`;
        await order(id, 'u1');
        await outbox('billing.credit-fulfilled', id, { credits: index + 1 }, tie);
      }
      let scanned = 0, created = 0;
      for (let round = 0; round < 12; round += 1) {
        const results = await Promise.all([1, 2, 3].map(() => scanner({ batchSize: 4, maxBatchesPerRun: 2 }).scanAll()));
        for (const run_ of results) for (const result of run_.filter(entry => entry.source === 'billing.order-paid')) { scanned += result.scanned; created += result.created; }
      }
      expect(scanned).toBe(23);
      expect(created).toBe(23);
      const rows = (await q(`SELECT "eventKey", params FROM inbox_notifications WHERE "eventKey" LIKE 'order:tie-%' ORDER BY "eventKey"`)).rows;
      expect(rows).toHaveLength(23);
      expect(new Set(rows.map(row => row.eventKey)).size).toBe(23);
      expect(rows.map(row => row.params.credits)).toEqual(Array.from({ length: 23 }, (_, index) => index + 1));
      const cursor = (await q(`SELECT "cursorId" FROM inbox_cursors WHERE source='billing.order-paid'`)).rows[0];
      expect(cursor.cursorId).toBe((await q(`SELECT id FROM billing_outbox WHERE kind='billing.credit-fulfilled' ORDER BY "createdAt", id DESC LIMIT 1`)).rows[0].id);
    });

    it('rows inside the settle window are not consumed; after it they are, once', async () => {
      await resetCursors();
      await order('settle-1', 'u2');
      await outbox('billing.credit-fulfilled', 'settle-1', { credits: 9 }, new Date(Date.now() - 10_000));
      const result = (await scanner({ settleMs: 60_000 }).scanAll()).find(entry => entry.source === 'billing.order-paid')!;
      expect(result.scanned).toBe(0);
      expect(await count(`"eventKey"='order:settle-1'`)).toBe(0);
      expect((await scanner({ settleMs: 5_000 }).scanAll()).find(entry => entry.source === 'billing.order-paid')).toMatchObject({ scanned: 1, created: 1 });
      expect((await scanner({ settleMs: 5_000 }).scanAll()).find(entry => entry.source === 'billing.order-paid')).toMatchObject({ scanned: 0, created: 0 });
    });

    it('a late-committing older row never lands before the cursor (cursor trails the transaction limit)', async () => {
      await resetCursors();
      await order('late-a', 'u2'); await order('late-b', 'u2');
      // b is visible and old enough; a (older timestamp) commits only after b was scanned but still within the settle window of the first scan.
      await outbox('billing.credit-fulfilled', 'late-b', { credits: 1 }, new Date(Date.now() - 2 * HOUR));
      await scanner().scanAll();
      expect(await count(`"eventKey"='order:late-b'`)).toBe(1);
      await outbox('billing.credit-fulfilled', 'late-a', { credits: 1 }, new Date(Date.now() - 3 * HOUR));
      // Documented limit: a row stamped before the cursor is not seen. The settle window exists so this cannot happen for real
      // transactions (<= 30 s); the test pins the behaviour so a change of contract is noticed.
      await scanner().scanAll();
      expect(await count(`"eventKey"='order:late-a'`)).toBe(0);
    });
  });

  describe('built-in sources', () => {
    it('order-paid takes the owner from the order, ignores the payload owner, and coerces bad credit values to 0', async () => {
      await resetCursors();
      const at = new Date(Date.now() - HOUR);
      await order('own-1', 'u1'); await outbox('billing.credit-fulfilled', 'own-1', { credits: 12, ownerId: 'u2' }, at);
      await order('own-2', 'u3'); await outbox('billing.credit-fulfilled', 'own-2', { credits: 'lots' }, new Date(at.getTime() + 1));
      await order('own-3', 'u3'); await outbox('billing.credit-fulfilled', 'own-3', { credits: -5 }, new Date(at.getTime() + 2));
      await order('own-4', 'u3'); await outbox('billing.credit-fulfilled', 'own-4', { credits: 1.5 }, new Date(at.getTime() + 3));
      await outbox('billing.credit-fulfilled', 'no-such-order', { credits: 1 }, new Date(at.getTime() + 4));
      await scanner().scanAll();
      expect((await typesFor('u1')).find(row => row.eventKey === 'order:own-1')).toMatchObject({ params: { credits: 12 }, href: '/billing/orders' });
      expect((await typesFor('u2')).some(row => row.eventKey === 'order:own-1')).toBe(false);
      expect((await typesFor('u3')).filter(row => /order:own-[234]/.test(row.eventKey)).map(row => row.params.credits)).toEqual([0, 0, 0]);
    });

    it('subscription: the first cycle is announced as the purchase (same key as the checkout source), later cycles as renewals; never twice', async () => {
      await resetCursors();
      const binding = await subscription('sub-order-1', 'u1', 'psub-1');
      await cycle('cyc-init', binding, 'u1', 'psub-1', 'sub-order-1:pay', true);
      await cycle('cyc-renew', binding, 'u1', 'psub-1', 'pay-renew-1', false);
      const at = new Date(Date.now() - HOUR);
      await outbox('billing.credit-fulfilled', 'sub-order-1', { credits: 50 }, at);
      await outbox('billing.subscription-credit-fulfilled', 'cyc-init', { credits: 50 }, new Date(at.getTime() + 1));
      await outbox('billing.subscription-credit-fulfilled', 'cyc-renew', { credits: 40 }, new Date(at.getTime() + 2));
      for (let round = 0; round < 3; round += 1) await scanner().scanAll();
      const rows = (await typesFor('u1')).filter(row => /sub-order-1|cyc-/.test(row.eventKey));
      expect(rows).toEqual([
        { eventKey: 'cycle:cyc-renew', type: 'subscription.renewed', params: { credits: 40 }, href: '/billing/subscriptions' },
        { eventKey: 'order:sub-order-1', type: 'order.paid', params: { credits: 50 }, href: '/billing/orders' },
      ]);
    });

    it('refund: only a succeeded refund notifies; failed and canceled attempts are consumed silently; the owner is the request owner', async () => {
      await resetCursors();
      const at = new Date(Date.now() - HOUR);
      await order('rf-1', 'u2'); await refund('refund-ok', 'u2', 'rf-1', 'succeeded');
      await order('rf-2', 'u3'); await refund('refund-failed', 'u3', 'rf-2', 'failed');
      await order('rf-3', 'u3'); await refund('refund-canceled', 'u3', 'rf-3', 'canceled');
      for (const [index, id] of ['refund-ok', 'refund-failed', 'refund-canceled'].entries()) await outbox('billing.refund-settled', id, { ownerId: 'u1' }, new Date(at.getTime() + index));
      const result = (await scanner().scanAll()).find(entry => entry.source === 'billing.refund-settled')!;
      expect(result).toMatchObject({ scanned: 3, created: 1 });
      expect((await typesFor('u2')).filter(row => row.type === 'refund.settled')).toEqual([{ eventKey: 'refund:refund-ok', type: 'refund.settled', params: { outcome: 'succeeded' }, href: '/billing/orders' }]);
      expect((await typesFor('u3')).filter(row => row.type === 'refund.settled')).toEqual([]);
      expect((await typesFor('u1')).filter(row => row.type === 'refund.settled')).toEqual([]);
    });

    it('ai.tasks: COMPLETED and FAILED are announced to the task owner; PROCESSING, no completion time, unsettled and erased owners are not', async () => {
      await resetCursors();
      const old = new Date(Date.now() - HOUR);
      await aiTask('ai-done', 'u1', 'COMPLETED', old, 'video');
      await aiTask('ai-fail', 'u1', 'FAILED', new Date(old.getTime() + 1), 'audio');
      await aiTask('ai-run', 'u1', 'PROCESSING', null);
      await aiTask('ai-nots', 'u1', 'COMPLETED', null);
      await aiTask('ai-gone', 'gone', 'COMPLETED', new Date(old.getTime() + 2));
      await aiTask('ai-recent', 'u2', 'COMPLETED', new Date(Date.now() - 5_000));
      const results = await scanner({ settleMs: 60_000 }).scanAll();
      expect(results.find(entry => entry.source === 'ai.tasks')).toMatchObject({ scanned: 3, created: 2 });
      expect((await typesFor('u1')).filter(row => row.eventKey.startsWith('ai-task:'))).toEqual([
        { eventKey: 'ai-task:ai-done', type: 'ai.task.completed', params: { kind: 'video' }, href: '/account/tasks' },
        { eventKey: 'ai-task:ai-fail', type: 'ai.task.failed', params: { kind: 'audio' }, href: '/account/tasks' },
      ]);
      expect(await count(`"userId"='gone'`)).toBe(0);
      expect(await count(`"eventKey"='ai-task:ai-recent'`)).toBe(0);
      // The recent task is announced once it has settled, and the PROCESSING one when it finishes afterwards.
      await q(`UPDATE async_jobs SET status='COMPLETED', "completedAt"=now() - interval '1 minute' WHERE id='ai-run'`);
      await scanner({ settleMs: 1_000 }).scanAll();
      expect(await count(`"eventKey" IN ('ai-task:ai-recent', 'ai-task:ai-run')`)).toBe(2);
    });
  });

  describe('failing sources', () => {
    const good = (log: string[]) => defineInboxSource({ name: 'good', tables: ['users'], scan: async () => { log.push('good'); return []; } });
    const stamp = (id: string) => ({ at: new Date(Date.now() - HOUR), id });
    const note = (eventKey: string, extra: object = {}) => ({ userId: 'u1', eventKey, type: 'order.paid' as const, params: { credits: 1 }, ...extra });

    it('an event the inbox refuses is parked (logged and passed); the rest of the batch commits and the cursor moves past it', async () => {
      await resetCursors();
      const mid = defineInboxSource({ name: 'mid-fail', tables: ['users'], scan: async () => [
        { cursor: stamp('a'), notification: note('mid:1') }, { cursor: stamp('b'), notification: note('mid:2', { params: { note: 'free text' } }) },
        { cursor: stamp('c'), notification: note('mid:3') }] });
      const [result] = await scanner({}, [mid]).scanAll();
      expect(result).toMatchObject({ source: 'mid-fail', scanned: 3, parked: 1 });
      expect(await count(`"eventKey" LIKE 'mid:%'`)).toBe(2);
      expect(await count(`"eventKey" = 'mid:2'`)).toBe(0);
      expect((await q(`SELECT "cursorId" FROM inbox_cursors WHERE source='mid-fail'`)).rows[0]?.cursorId).toBe(stamp('c').id);
    });

    it('a source that throws does not escape tick(); the scanner recovers on the next wake', async () => {
      await resetCursors();
      let broken = true; const log: string[] = [];
      const flaky = defineInboxSource({ name: 'flaky', tables: ['users'], scan: async () => {
        if (broken) throw new Error('database hiccup'); log.push('ok'); return [{ cursor: stamp('z'), notification: note('flaky:1') }]; } });
      const s = scanner({ scanIntervalMs: 1000, retentionDays: 0 }, [flaky]);
      await expect(s.tick(10_000)).resolves.toBeUndefined();
      expect(await count(`"eventKey"='flaky:1'`)).toBe(0);
      broken = false;
      await s.tick(10_100); // still inside the throttle interval
      expect(log).toEqual([]);
      await s.tick(12_000);
      expect(log).toEqual(['ok']);
      expect(await count(`"eventKey"='flaky:1'`)).toBe(1);
    });

    it('tick() is single-flight and throttled per process', async () => {
      await resetCursors();
      let scans = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const slow = defineInboxSource({ name: 'slow', tables: ['users'], scan: async () => { scans += 1; await gate; return []; } });
      const s = scanner({ scanIntervalMs: 15_000, retentionDays: 0 }, [slow]);
      const first = s.tick(100_000), overlap = s.tick(100_001);
      release(); await Promise.all([first, overlap]);
      expect(scans).toBe(1);
      await s.tick(105_000); expect(scans).toBe(1);
      await s.tick(115_001); expect(scans).toBe(2);
    });

    it('one bad source must not starve the sources after it (isolation)', async () => {
      await resetCursors();
      const log: string[] = [];
      const bad = defineInboxSource({ name: 'poison', tables: ['users'], scan: async () => [{ cursor: stamp('p'), notification: note('poison:1', { href: 'https://evil.example' }) }] });
      const results = await scanner({}, [bad, good(log)]).scanAll().catch(() => null);
      expect(results, 'scanAll rejected: the source after the poisoned one was never scanned').not.toBeNull();
      expect(log).toEqual(['good']);
    });

    it('an outbox row with an out-of-range credit amount is consumed without blocking the source behind it', async () => {
      await resetCursors();
      const at = new Date(Date.now() - HOUR);
      await order('huge-1', 'u1'); await outbox('billing.credit-fulfilled', 'huge-1', { credits: 5_000_000_000 }, at);
      await order('after-huge', 'u1'); await outbox('billing.credit-fulfilled', 'after-huge', { credits: 3 }, new Date(at.getTime() + 1));
      await scanner().scanAll().catch(() => undefined);
      expect(await count(`"eventKey"='order:after-huge'`), 'a single row with credits > 1e9 stops the order-paid source forever').toBe(1);
    });
  });

  describe('retention', () => {
    it('deletes read or archived rows older than the window in bounded batches; unread and recent rows stay', async () => {
      await q(`DELETE FROM inbox_notifications`);
      const insert = (n: number, flags: string, age: string, prefix: string) => q(`INSERT INTO inbox_notifications (id, "userId", "eventKey", type, params, "isRead", "isArchived", "readAt", "createdAt")
        SELECT $1 || g, 'u1', $1 || g, 'order.paid', '{}'::jsonb, ${flags}, now() - interval '${age}' FROM generate_series(1, $2) g`, [prefix, n]);
      await insert(25, `true, false, now()`, '200 days', 'oldread-');
      await insert(5, `false, true, NULL`, '200 days', 'oldarch-');
      await insert(4, `false, false, NULL`, '200 days', 'oldunread-');
      await insert(6, `true, false, now()`, '10 days', 'recentread-');
      const s = scanner({ retentionDays: 90, retentionBatchSize: 10, maxRetentionBatches: 2 });
      expect(await s.purge()).toBe(20);
      expect(await count(`"eventKey" LIKE 'old%' AND "eventKey" NOT LIKE 'oldunread-%'`)).toBe(10);
      expect(await s.purge()).toBe(10);
      expect(await s.purge()).toBe(0);
      expect(await count(`"eventKey" LIKE 'oldunread-%'`)).toBe(4);
      expect(await count(`"eventKey" LIKE 'recentread-%'`)).toBe(6);
      expect(await scanner({ retentionDays: 0 }).purge()).toBe(0);
    });

    it('INBOX_RETENTION_DAYS parsing: default 90, 0 keeps forever, junk fails the boot', () => {
      expect(inboxOptionsFromEnvironment({}).retentionDays).toBe(90);
      expect(inboxOptionsFromEnvironment({ INBOX_RETENTION_DAYS: '' }).retentionDays).toBe(90);
      expect(inboxOptionsFromEnvironment({ INBOX_RETENTION_DAYS: '0' }).retentionDays).toBe(0);
      expect(inboxOptionsFromEnvironment({ INBOX_RETENTION_DAYS: ' 30 ' }).retentionDays).toBe(30);
      for (const bad of ['-1', '1.5', 'abc', '36501']) expect(() => inboxOptionsFromEnvironment({ INBOX_RETENTION_DAYS: bad }), bad).toThrow(/INBOX_RETENTION_DAYS/);
    });
  });

  describe('emit validation', () => {
    const ok = { userId: 'u1', eventKey: 'val:ok', type: 'order.paid' as const };
    it.each([
      ['/billing/orders', true], ['/', true], ['/billing/orders?x=1#y', true], ['/english', true], ['/account/tasks/', true],
      ['//evil.example', false], ['https://evil.example', false], ['javascript:alert(1)', false], ['/a b', false], ['/\\evil', false], ['/a/../b', false], ['/..', false],
      ['/en', false], ['/zh', false], ['/en/billing', false], ['/zh?x=1', false], ['billing', false], ['', false], [`/${'a'.repeat(512)}`, false], ['/a\nb', false], ['/a<script>', false],
    ])('href %j accepted=%s', (href, accepted) => { expect(isInboxHref(href)).toBe(accepted); });

    it('refuses bad params, keys, types and recipients and writes nothing', async () => {
      const bad: Array<[string, object]> = [
        ['extra param', { params: { credits: 1, note: 'x' } }], ['string count', { params: { credits: '5' } }], ['negative', { params: { credits: -1 } }],
        ['float', { params: { credits: 1.5 } }], ['over max', { params: { credits: 1_000_000_001 } }], ['NaN', { params: { credits: Number.NaN } }],
        ['array params', { params: [1] }], ['__proto__ key', { params: JSON.parse('{"__proto__": {"credits": 1}}') }],
        ['enum on count type', { type: 'ai.task.completed', params: { kind: 'text' } }], ['param on empty type', { type: 'feedback.replied', params: { credits: 1 } }],
        ['unknown type', { type: 'order.refunded' }], ['prototype type', { type: 'constructor' }], ['toString type', { type: 'toString' }],
        ['empty key', { eventKey: '' }], ['long key', { eventKey: 'k'.repeat(201) }], ['key with space', { eventKey: 'a b' }], ['key leading dash', { eventKey: '-a' }],
        ['empty recipient', { userId: '' }], ['long recipient', { userId: 'u'.repeat(201) }], ['number recipient', { userId: 5 }],
        ['bad href', { href: '//evil.example' }], ['locale href', { href: '/en/billing' }],
      ];
      for (const [label, patch] of bad) {
        const input = { ...ok, eventKey: `val:${label.replaceAll(' ', '-')}`, ...patch } as never;
        expect(() => validateInboxEmit(input), label).toThrow(InboxEmitError);
        await expect(inbox.emit(undefined, input), label).rejects.toBeInstanceOf(InboxEmitError);
      }
      await expect(inbox.emit(undefined, null as never)).rejects.toBeInstanceOf(InboxEmitError);
      expect(await count(`"eventKey" LIKE 'val:%'`)).toBe(0);
    });

    it('accepts the documented shapes for every type', async () => {
      await q(`DELETE FROM inbox_notifications`);
      const shapes: Array<[string, object]> = [['order.paid', { credits: 0 }], ['subscription.renewed', { credits: 1_000_000_000 }], ['refund.settled', { outcome: 'succeeded' }],
        ['ai.task.completed', { kind: 'image' }], ['ai.task.failed', { kind: 'audio' }], ['feedback.replied', {}], ['referral.rewarded', { credits: 7 }]];
      for (const [type, params] of shapes) expect((await inbox.emit(undefined, { userId: 'u1', eventKey: `shape:${type}`, type: type as never, params })).created, type).toBe(true);
      expect(await count()).toBe(7);
    });

    it('a rolled-back caller transaction leaves no notification; a committed one keeps it; the same key is a no-op the second time', async () => {
      await q(`DELETE FROM inbox_notifications`);
      await expect(db.transaction(async tx => { await inbox.emit(tx, { ...ok, eventKey: 'tx:rolled-back' }); throw new Error('business failure'); })).rejects.toThrow('business failure');
      expect(await count(`"eventKey"='tx:rolled-back'`)).toBe(0);
      await db.transaction(async tx => { await inbox.emit(tx, { ...ok, eventKey: 'tx:kept' }); });
      expect(await db.transaction(tx => inbox.emit(tx, { ...ok, eventKey: 'tx:kept' }))).toEqual({ created: false });
      // The same key for another user is a different notification.
      expect(await inbox.emit(undefined, { ...ok, userId: 'u2', eventKey: 'tx:kept' })).toEqual({ created: true });
    });

    it('notifier adapters: feedback reply is one notification per feedback id; referral reward needs a stable id and dedups', async () => {
      await q(`DELETE FROM inbox_notifications`);
      const feedback = inboxFeedbackNotifier(inbox), referral = inboxReferralNotifier(inbox);
      await feedback.notifyReply(undefined, { userId: 'u1', feedbackId: 'f9' }); await feedback.notifyReply(undefined, { userId: 'u1', feedbackId: 'f9' });
      await feedback.notifyReply(undefined, { userId: 'u1', feedbackId: 'f10' });
      expect(await count(`type='feedback.replied'`)).toBe(2);
      await referral.notifyReward(undefined, { userId: 'u1', credits: 5, rewardId: 'referral:o1:referrer' });
      await referral.notifyReward(undefined, { userId: 'u1', credits: 5, rewardId: 'referral:o1:referrer' });
      await referral.notifyReward(undefined, { userId: 'u1', credits: 5, orderId: 'o2' });
      await referral.notifyReward(undefined, { userId: 'u1', credits: 5 }); // no stable id: skipped, never throws
      expect(await count(`type='referral.rewarded'`)).toBe(2);
      expect((await typesFor('u1')).find(row => row.eventKey === 'referral-reward:o2')).toMatchObject({ params: { credits: 5 }, href: '/account/referrals' });
      // An erased recipient is skipped silently.
      await expect(feedback.notifyReply(undefined, { userId: 'gone', feedbackId: 'f1' })).resolves.toBeUndefined();
      expect(await count(`"userId"='gone'`)).toBe(0);
    });
  });

  describe('deletion', () => {
    it('removes every state of the user\'s rows (unread, read, archived), is idempotent and leaves other users alone', async () => {
      await q(`DELETE FROM inbox_notifications`);
      await inbox.emit(undefined, { userId: 'u1', eventKey: 'del:1', type: 'feedback.replied' });
      await inbox.emit(undefined, { userId: 'u1', eventKey: 'del:2', type: 'feedback.replied' });
      await inbox.emit(undefined, { userId: 'u1', eventKey: 'del:3', type: 'feedback.replied' });
      await inbox.emit(undefined, { userId: 'u2', eventKey: 'del:1', type: 'feedback.replied' });
      await q(`UPDATE inbox_notifications SET "isRead"=true, "readAt"=now() WHERE "userId"='u1' AND "eventKey"='del:2'`);
      await q(`UPDATE inbox_notifications SET "isArchived"=true WHERE "userId"='u1' AND "eventKey"='del:3'`);
      await db.transaction(tx => inboxDeletionContributor.erase(tx, 'u1'));
      await db.transaction(tx => inboxDeletionContributor.erase(tx, 'u1'));
      expect(await count(`"userId"='u1'`)).toBe(0);
      expect(await count(`"userId"='u2'`)).toBe(1);
      expect(inboxDeletionContributor).toMatchObject({ name: 'inbox', order: 60 });
    });
  });
});
