import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ApplicationDatabase } from '../src/database';
import type { JobsService } from '../src/jobs/jobs.service';
import { InboxEventScanner, InboxService, inboxOptionsFromEnvironment, INBOX_SOURCES, defineInboxSource, inboxDeletionContributor,
  inboxFeedbackNotifier, InboxEmitError } from '../src/inbox';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_inbox_${randomUUID().replaceAll('-', '')}`;

run('in-app notifications (WP 3.2)', () => {
  let pool: Pool, scoped: Pool, db: ApplicationDatabase, inbox: InboxService;
  const q = (sql: string, values: unknown[] = []) => scoped.query(sql, values);
  const scanner = (overrides: Record<string, unknown> = {}) => new InboxEventScanner(db, inbox,
    { ...inboxOptionsFromEnvironment({}), ...overrides }, { registerWakeSource() {} } as unknown as JobsService);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    scoped = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000, options: `-c search_path=${schema} -c timezone=UTC` });
    url.searchParams.set('schema', schema); db = new ApplicationDatabase(url.href);
    inbox = new InboxService(db);
    for (const id of ['u1', 'u2', 'gone'])
      await q(`INSERT INTO users (id, username, password, name, "typeId") VALUES ($1, $2, 'x', 'n', 'member')`, [id, id === 'gone' ? 'deleted-gone' : id]);
  });
  afterAll(async () => {
    try { await db?.disconnect(); await scoped?.end(); }
    finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('emits once under concurrent replays and validates input', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      inbox.emit(undefined, { userId: 'u1', eventKey: 'test:1', type: 'order.paid', params: { credits: 5 }, href: '/billing/orders' })));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect((await q(`SELECT count(*)::int AS n FROM inbox_notifications WHERE "eventKey" = 'test:1'`)).rows[0].n).toBe(1);
    await expect(inbox.emit(undefined, { userId: 'u1', eventKey: 'x', type: 'order.paid', params: { note: 'hi' } })).rejects.toBeInstanceOf(InboxEmitError);
    await expect(inbox.emit(undefined, { userId: 'u1', eventKey: 'x', type: 'order.paid', href: '//evil.example' })).rejects.toBeInstanceOf(InboxEmitError);
    await expect(inbox.emit(undefined, { userId: 'u1', eventKey: 'x', type: 'order.paid', href: '/zh/billing' })).rejects.toBeInstanceOf(InboxEmitError);
    await expect(inbox.emit(undefined, { userId: 'u1', eventKey: 'x', type: 'nope' as 'order.paid' })).rejects.toBeInstanceOf(InboxEmitError);
    expect(await inbox.emit(undefined, { userId: 'gone', eventKey: 'x', type: 'order.paid' })).toEqual({ created: false });
    expect(await inbox.emit(undefined, { userId: 'missing', eventKey: 'x', type: 'order.paid' })).toEqual({ created: false });
  });

  it('scopes list, read, read-all and archive to the recipient', async () => {
    await inbox.emit(undefined, { userId: 'u2', eventKey: 'test:2', type: 'ai.task.completed', params: { kind: 'image' }, href: '/account/tasks' });
    await inboxFeedbackNotifier(inbox).notifyReply(undefined, { userId: 'u1', feedbackId: 'f1' });
    const page = await inbox.list('u1', {});
    expect(page.total).toBe(2);
    expect(page.unreadCount).toBe(2);
    expect(Object.keys(page.data[0]).sort()).toEqual(['createdAt', 'href', 'id', 'isRead', 'params', 'readAt', 'type']);
    const other = (await inbox.list('u2', {})).data[0];
    await expect(inbox.markRead('u1', other.id)).rejects.toMatchObject({ status: 404 });
    await expect(inbox.archive('u1', other.id)).rejects.toMatchObject({ status: 404 });
    await expect(inbox.markRead('u1', 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
    const first = await inbox.markRead('u1', page.data[0].id);
    expect(first.isRead).toBe(true);
    expect((await inbox.markRead('u1', page.data[0].id)).readAt).toEqual(first.readAt);
    expect(await inbox.unreadCount('u1')).toEqual({ unreadCount: 1 });
    expect(await inbox.markAllRead('u1')).toEqual({ updated: 1 });
    expect(await inbox.unreadCount('u2')).toEqual({ unreadCount: 1 });
    await inbox.archive('u2', other.id);
    expect((await inbox.list('u2', {})).total).toBe(0);
    await expect(inbox.list('u1', { pageSize: '500' })).rejects.toMatchObject({ status: 400 });
    await expect(inbox.list('u1', { userId: 'u2' })).rejects.toMatchObject({ status: 400 });
  });

  it('turns a fulfilled order into exactly one notification across scans and replicas', async () => {
    const old = new Date(Date.now() - 3_600_000), fresh = new Date();
    for (const [order, at] of [['o1', old], ['o2', fresh]] as const) {
      await q(`INSERT INTO billing_orders (id, "ownerId", "offerId", "providerId", "accountScope", offer, "successUrl", "cancelUrl", "createKey", "captureKey",
        "creationState", "captureState", state) VALUES ($1, 'u1', 'pack', 'fake', 'default', '{}'::jsonb, '/s', '/c', $1 || ':c', $1 || ':k', 'created', 'captured', 'paid')`, [order]);
      await q(`INSERT INTO billing_outbox (id, kind, "aggregateId", payload, "createdAt") VALUES ($1, 'billing.credit-fulfilled', $2, $3::jsonb, $4)`,
        [`ob-${order}`, order, JSON.stringify({ credits: 100, ownerId: 'u1' }), at]);
    }
    // Two replicas race: one locks the cursor, the other skips; afterwards a rescan changes nothing.
    const [a, b] = await Promise.all([scanner().scanAll(), scanner().scanAll()]);
    const paid = [...a, ...b].filter(result => result.source === 'billing.order-paid');
    expect(paid.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    await scanner().scanAll();
    const rows = (await q(`SELECT "eventKey", type, params, href FROM inbox_notifications WHERE "eventKey" LIKE 'order:%'`)).rows;
    expect(rows).toEqual([{ eventKey: 'order:o1', type: 'order.paid', params: { credits: 100 }, href: '/billing/orders' }]);
    // The fresh row becomes visible once it is older than the settle window.
    const later = await scanner({ settleMs: 0 }).scanAll();
    expect(later.find(result => result.source === 'billing.order-paid')?.created).toBe(1);
    // A cursor rolled back (crash before commit) re-emits under the same keys: no duplicates.
    await q(`UPDATE inbox_cursors SET "cursorAt" = now() - interval '2 days', "cursorId" = '' WHERE source = 'billing.order-paid'`);
    const replay = await scanner({ settleMs: 0 }).scanAll();
    expect(replay.find(result => result.source === 'billing.order-paid')).toMatchObject({ scanned: 2, created: 0 });
  });

  it('announces finished AI tasks and skips a source whose table is missing', async () => {
    await q(`INSERT INTO async_jobs (id, kind, "resourceType", "resourceId", "userId", status, "maxAttempts", "idempotencyKey", "idempotencyFingerprint",
      "handlerVersion", payload, "completedAt") VALUES ('t1', 'ai.image', 'ai-task', 't1', 'u2', 'FAILED', 3, 't1', 'f', '1', '{}'::jsonb, now() - interval '1 hour')`);
    await q(`INSERT INTO ai_tasks (id, "ownerId", kind, "providerId", model, cost, "holdState", "deadlineAt", "createdAt", "updatedAt")
      VALUES ('t1', 'u2', 'image', 'fake', 'm', 1, 'NONE', now(), now(), now())`);
    await scanner().scanAll();
    expect((await q(`SELECT type, params FROM inbox_notifications WHERE "eventKey" = 'ai-task:t1'`)).rows)
      .toEqual([{ type: 'ai.task.failed', params: { kind: 'image' } }]);
    const missing = defineInboxSource({ name: 'missing', tables: ['no_such_table'], scan: async () => { throw new Error('not reached'); } });
    const custom = new InboxEventScanner(db, inbox, inboxOptionsFromEnvironment({}), undefined, [missing, ...INBOX_SOURCES]);
    expect((await custom.scanAll())[0]).toMatchObject({ source: 'missing', skipped: 'missing-table' });
  });

  it('purges old read rows and erases a deleted account', async () => {
    await q(`UPDATE inbox_notifications SET "createdAt" = now() - interval '200 days' WHERE "userId" = 'u1'`);
    await q(`UPDATE inbox_notifications SET "isRead" = false, "readAt" = NULL WHERE "eventKey" = 'order:o1'`);
    const deleted = await scanner().purge();
    expect(deleted).toBeGreaterThan(0);
    expect((await q(`SELECT "eventKey" FROM inbox_notifications WHERE "userId" = 'u1' AND "createdAt" < now() - interval '100 days' ORDER BY "eventKey"`)).rows)
      .toEqual([{ eventKey: 'order:o1' }, { eventKey: 'order:o2' }]);
    await db.transaction(tx => inboxDeletionContributor.erase(tx, 'u1'));
    expect((await q(`SELECT count(*)::int AS n FROM inbox_notifications WHERE "userId" = 'u1'`)).rows[0].n).toBe(0);
  });
});
