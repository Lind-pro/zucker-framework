import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { LocalFileStorage } from '@zucker-framework/storage';
import { DurableTaskAbortedError, DurableTaskRetryScheduledError, PostgresTaskRepository, TaskLeaseReconciler } from '@zucker-framework/task';
import type { DurableTaskAttemptContext } from '@zucker-framework/task';
import { NotificationIdempotencyConflictError, NotificationLeaseLostError, NotifyChannel, PostgresNotificationDeliveryRepository, notificationDeliverySchemaSql } from '@zucker-framework/notification';
import type { MailProvider } from '@zucker-framework/notification';
import { ApplicationDatabase } from '../src/database';
import { FilesService } from '../src/files/files.service';
import { DeliveryService } from '../src/delivery/delivery.service';
import { deliveryOptionsFromEnvironment } from '../src/delivery/delivery.config';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { DefaultJobHandlers } from '../src/jobs/jobs.handlers';
import type { JobsOptions } from '../src/jobs/jobs.config';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const schema = `zucker_jobs_${randomUUID().replaceAll('-', '')}`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fakeMail(idempotent = true) {
  const provider: MailProvider = { name: 'synthetic-mail', supportsIdempotency: idempotent,
    isConfigured: () => true, deliver: vi.fn(async () => ({ success: true, messageId: randomUUID() })), close: vi.fn(async () => {}) };
  return provider;
}

run('durable runtime with actual PostgreSQL and synthetic providers', () => {
  let pool: Pool, first: ApplicationDatabase, second: ApplicationDatabase, scopedUrl: string, directory: string;
  let ownerId: string, otherId: string;
  const hosts: JobsHost[] = [];
  const options: JobsOptions = { enabled: false, workerId: 'synthetic-a', concurrency: 2, scanIntervalMs: 50,
    leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 };
  function harness(database = first, provider: MailProvider | undefined = fakeMail(), changes: Partial<JobsOptions> = {}) {
    const jobs = new JobsService(database);
    const delivery = new DeliveryService(database, { provider, accountScope: provider ? 'synthetic-account' : '', leaseMs: 2000, heartbeatMs: 500 });
    const files = new FilesService(database, new LocalFileStorage({ basePath: directory }), { maxObjectBytes: 2048 });
    new DefaultJobHandlers(jobs, files, delivery).onModuleInit();
    const host = new JobsHost(jobs, delivery, { ...options, ...changes }); hosts.push(host);
    return { jobs, delivery, host, files, provider };
  }
  const command = (kind = 'record', extra: object = {}) => ({ kind, idempotencyKey: randomUUID(), ownerId,
    resource: { type: 'synthetic-record', id: randomUUID() }, payload: { value: 'synthetic', notify: false }, ...extra });
  const mail = () => ({ ownerId, idempotencyKey: randomUUID(), subject: 'Synthetic subject', text: 'Synthetic content' });
  async function rows(table: string) { return (await pool.query(`SELECT * FROM "${schema}"."${table}"`)).rows; }
  async function failInsert(table: 'async_job_outbox' | 'notification_deliveries', work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_job_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic job commit failure'; END; $$`);
    try {
      await pool.query(`CREATE TRIGGER synthetic_job_failure BEFORE INSERT ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_job_failure()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER synthetic_job_failure ON "${schema}"."${table}"`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_job_failure()`); }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.pathname !== '/cnipa_dev') throw new Error('This fixture requires the approved isolated development database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-job-objects-'));
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN'); await connection.query(`CREATE SCHEMA "${schema}"`); await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await connection.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    url.searchParams.set('schema', schema); scopedUrl = url.href;
    first = new ApplicationDatabase(scopedUrl); second = new ApplicationDatabase(scopedUrl);
    ownerId = randomUUID(); otherId = randomUUID();
    for (const id of [ownerId, otherId]) await first.model('users').create({ data: { id, username: `job_${id.replaceAll('-', '')}`,
      name: 'Synthetic job owner', typeId: 'member', email: `${id}@example.invalid`, emailVerified: true, status: true } });
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE "${schema}"."delivery_messages", "${schema}"."notification_deliveries", "${schema}"."job_records", "${schema}"."async_jobs" CASCADE`);
  });
  afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())); vi.restoreAllMocks(); });
  afterAll(async () => {
    try { await Promise.all([first?.onModuleDestroy(), second?.onModuleDestroy()]); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } }
  });

  it('deduplicates concurrent owned submissions, preserves the outbox, and rejects changed payloads', async () => {
    const a = harness(), b = harness(second), input = command();
    const [one, two] = await Promise.all([a.jobs.submit(input), b.jobs.submit(input)]);
    expect(one.task.id).toBe(two.task.id); expect([one.created, two.created].sort()).toEqual([false, true]);
    expect(await rows('async_jobs')).toHaveLength(1); expect(await rows('async_job_outbox')).toHaveLength(1);
    await expect(a.jobs.submit({ ...input, payload: { value: 'changed' } })).rejects.toThrow(/idempotency/i);
    await expect(a.jobs.get(otherId, one.task.id)).rejects.toMatchObject({ status: 404 });
    await expect(a.jobs.cancel(otherId, one.task.id)).rejects.toMatchObject({ status: 404 });
    expect(await a.jobs.list(otherId)).toEqual([]);
    expect(await a.jobs.cancel(ownerId, one.task.id)).toMatchObject({ status: 'CANCELLED' });
  });

  it('rolls task and task-event creation back when the same-transaction outbox insert fails', async () => {
    const a = harness();
    await failInsert('async_job_outbox', async () => { await expect(a.jobs.submit(command())).rejects.toThrow(); });
    expect(await rows('async_jobs')).toHaveLength(0); expect(await rows('async_job_events')).toHaveLength(0);
    expect(await rows('async_job_outbox')).toHaveLength(0);
  });

  it('rolls completion, business record and private message back if notification metadata fails', async () => {
    const a = harness(), created = await a.jobs.submit(command('record', { payload: { value: 'atomic', notify: true } }));
    await failInsert('notification_deliveries', async () => { await expect(a.host.runTask(created.task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError); });
    expect((await a.jobs.repository.findById(created.task.id))?.status).toBe('QUEUED');
    expect(await rows('job_records')).toHaveLength(0); expect(await rows('delivery_messages')).toHaveLength(0); expect(await rows('notification_deliveries')).toHaveLength(0);
    await pool.query(`UPDATE "${schema}"."async_jobs" SET "availableAt"=$2 WHERE id=$1`, [created.task.id, new Date(Date.now() - 1000)]);
    await expect(a.host.runTask(created.task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await a.jobs.record(ownerId, created.task.id)).toMatchObject({ value: 'atomic' });
    expect(await rows('notification_deliveries')).toHaveLength(1);
    await expect(a.delivery.forTask(otherId, created.task.id)).rejects.toMatchObject({ status: 404 });
    expect(await a.delivery.forTask(ownerId, created.task.id)).toMatchObject({ status: 'PENDING', attempt: 0 });
  });

  it('refuses a stale completion and prevents its business writes after lease recovery', async () => {
    const a = harness(), created = await a.jobs.submit(command());
    expect(await a.jobs.repository.claim({ id: created.task.id, workerId: 'expired', leaseToken: 'old-token', now: new Date(), leaseExpiresAt: new Date(Date.now() + 1000) })).not.toBeNull();
    await pool.query(`UPDATE "${schema}"."async_jobs" SET "leaseExpiresAt"=$2 WHERE id=$1`, [created.task.id, new Date(Date.now() - 1000)]);
    const stale = (await a.jobs.repository.findById(created.task.id))!;
    await new TaskLeaseReconciler(a.jobs.repository).runOnce();
    const fresh = await a.jobs.repository.claim({ id: created.task.id, workerId: 'new', leaseToken: 'new-token', now: new Date(), leaseExpiresAt: new Date(Date.now() + 2000) });
    expect(fresh).not.toBeNull();
    const context: DurableTaskAttemptContext = { task: stale, leaseToken: 'old-token', signal: new AbortController().signal,
      now: () => new Date(), assertActive: async () => {}, reportProgress: async () => stale };
    expect(await a.jobs.handler('record', '1')!.complete!(context, { value: 'stale', notify: true })).toBe(false);
    expect(await rows('job_records')).toHaveLength(0); expect(await rows('notification_deliveries')).toHaveLength(0);
    expect(await new PostgresTaskRepository(a.jobs.client).transition({ id: created.task.id, from: 'PROCESSING', to: 'COMPLETED', leaseToken: 'new-token', result: {}, now: new Date() })).not.toBeNull();
  });

  it('runs a consumer extension registered before bootstrap through a durable wake source', async () => {
    const a = harness(first, undefined, { enabled: true });
    a.jobs.registerHandler({ kind: 'consumer.extension', version: '3', handler: { execute: async context => ({ echo: context.task.payload }) } });
    const input = command('consumer.extension', { payload: { extension: true } });
    const source = { calls: 0, async runOnce() { this.calls++; await first.transaction(tx => a.jobs.submitInTransaction(tx, input)); } };
    a.jobs.registerWakeSource({ name: 'consumer-outbox', runOnce: source.runOnce.bind(source) });
    await a.host.onApplicationBootstrap(); await a.host.onApplicationBootstrap(); await a.host.waitForIdle();
    expect(source.calls).toBeGreaterThan(0);
    expect((await rows('async_jobs'))[0]).toMatchObject({ kind: 'consumer.extension', status: 'COMPLETED', attempt: 1, result: { echo: { extension: true } } });
    expect((await rows('async_job_outbox'))[0].status).toBe('PUBLISHED');
    expect(() => a.jobs.registerHandler({ kind: 'late', version: '1', handler: { execute: async () => null } })).toThrow();
    await a.host.stop(); const calls = source.calls; await new Promise(done => setTimeout(done, 120)); expect(source.calls).toBe(calls);
  });

  it('interrupts and drains an active attempt, leaving its durable lease for restart recovery', async () => {
    const provider = fakeMail(), a = harness(first, provider), started = deferred(); let cleaned = false;
    a.jobs.registerHandler({ kind: 'interruptible', version: '1', handler: { execute: async context => {
      started.resolve(); await new Promise<void>(done => context.signal.addEventListener('abort', () => done(), { once: true })); return {};
    }, cleanup: async () => { cleaned = true; } } });
    const created = await a.jobs.submit(command('interruptible'));
    const attempt = a.host.runTask(created.task.id).catch(error => error); await started.promise;
    await Promise.all([a.host.stop(), a.host.stop()]);
    expect(await attempt).toBeInstanceOf(DurableTaskAbortedError); expect(cleaned).toBe(true); expect(provider.close).toHaveBeenCalledTimes(1);
    expect((await a.jobs.repository.findById(created.task.id))?.status).toBe('PROCESSING');
    await expect(a.host.runTask(created.task.id)).rejects.toBeInstanceOf(DurableTaskAbortedError);
  });

  it('reports a bounded shutdown failure if a handler ignores interruption, then drains before fixture cleanup', async () => {
    const a = harness(first, fakeMail(), { shutdownWaitMs: 20 }), started = deferred(), release = deferred();
    a.jobs.registerHandler({ kind: 'uncooperative', version: '1', handler: { execute: async () => { started.resolve(); await release.promise; return {}; } } });
    const created = await a.jobs.submit(command('uncooperative')), attempt = a.host.runTask(created.task.id).catch(error => error);
    await started.promise;
    try { await expect(a.host.stop()).rejects.toThrow(/shutdown did not drain/); }
    finally { release.resolve(); await attempt; hosts.splice(hosts.indexOf(a.host), 1); }
    expect((await a.jobs.repository.findById(created.task.id))?.status).toBe('PROCESSING');
  });

  it('reports provider-close failure and does not attempt a second close', async () => {
    const provider = fakeMail(); vi.mocked(provider.close!).mockRejectedValue(new Error('synthetic close failure'));
    const a = harness(first, provider);
    try {
      await expect(a.host.stop()).rejects.toThrow(/provider did not close cleanly/);
      await expect(a.host.stop()).rejects.toThrow(/provider did not close cleanly/);
      expect(provider.close).toHaveBeenCalledTimes(1);
    } finally { hosts.splice(hosts.indexOf(a.host), 1); }
  });

  it('executes actual file recovery as a registered task with owner-scoped submission', async () => {
    const a = harness(), file = await a.files.upload(ownerId, randomUUID(), { originalname: 'synthetic.pdf', buffer: Buffer.from('%PDF-1.7\nsynthetic') });
    await pool.query(`UPDATE "${schema}"."file_assets" SET state='pending', revision=revision+1 WHERE id=$1`, [file.id]);
    await expect(a.jobs.submitForUser(otherId, randomUUID(), { kind: 'files.recover', input: { assetId: file.id } })).rejects.toThrow();
    const created = await a.jobs.submitForUser(ownerId, randomUUID(), { kind: 'files.recover', input: { assetId: file.id } });
    await expect(a.host.runTask(created.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await a.files.inspect(ownerId, file.id)).toMatchObject({ state: 'ready' });
  });

  it('fails unconfigured notification requests before persisting either a task or envelope', async () => {
    const a = harness(); const disabled = new DeliveryService(first, deliveryOptionsFromEnvironment({}));
    const jobs = new JobsService(first); new DefaultJobHandlers(jobs, a.files, disabled).onModuleInit();
    await expect(jobs.submitForUser(ownerId, randomUUID(), { kind: 'record', input: { value: 'x', notify: true } })).rejects.toMatchObject({ status: 503 });
    await expect(disabled.enqueue(mail())).rejects.toMatchObject({ status: 503 });
    expect(await rows('async_jobs')).toHaveLength(0); expect(await rows('delivery_messages')).toHaveLength(0); await disabled.close();
  });

  it('deduplicates PostgreSQL deliveries and fences old tokens after expired lease recovery', async () => {
    const a = harness(), b = harness(second), input = mail();
    const [one, two] = await Promise.all([a.delivery.enqueue(input), b.delivery.enqueue(input)]);
    expect(one.delivery.id).toBe(two.delivery.id); expect([one.created, two.created].sort()).toEqual([false, true]);
    await expect(a.delivery.enqueue({ ...input, text: 'changed' })).rejects.toBeInstanceOf(NotificationIdempotencyConflictError);
    const now = new Date(), claims = await Promise.all([a.delivery.repository.claimNext({ workerId: 'a', now, leaseMs: 1000 }), b.delivery.repository.claimNext({ workerId: 'b', now, leaseMs: 1000 })]);
    expect(claims.filter(Boolean)).toHaveLength(1); const old = claims.find(Boolean)!;
    const later = new Date(now.getTime() + 1001);
    expect(await a.delivery.repository.recoverExpiredLeases(later)).toEqual({ retried: 1, dead: 0 });
    const fresh = (await b.delivery.repository.claimNext({ workerId: 'fresh', now: later, leaseMs: 1000 }))!;
    expect(fresh.attempt).toBe(2); expect(fresh.leaseToken).not.toBe(old.leaseToken);
    await expect(a.delivery.repository.markDelivered({ id: old.id, leaseToken: old.leaseToken, now: later })).rejects.toBeInstanceOf(NotificationLeaseLostError);
    expect(await b.delivery.repository.markDelivered({ id: fresh.id, leaseToken: fresh.leaseToken, now: later })).toMatchObject({ status: 'DELIVERED', attempt: 2 });
  });

  it('retries an idempotent transient provider with the same key and private immutable content', async () => {
    const provider = fakeMail(), send = vi.mocked(provider.deliver); send.mockRejectedValueOnce(new Error('sensitive-provider-error'));
    const a = harness(first, provider), input = mail(), delivery = await a.delivery.enqueue(input);
    expect(await a.delivery.runOnce('mail')).toMatchObject({ kind: 'retry-scheduled' });
    expect(await a.delivery.getOwned(ownerId, delivery.delivery.id)).toMatchObject({ errorCode: 'MAIL_PROVIDER_UNAVAILABLE', status: 'RETRYING' });
    await pool.query(`UPDATE "${schema}"."notification_deliveries" SET "availableAt"=$2 WHERE id=$1`, [delivery.delivery.id, new Date(Date.now() - 1000)]);
    expect(await a.delivery.runOnce('mail')).toMatchObject({ kind: 'delivered' });
    expect(send.mock.calls.map(call => call[1]?.idempotencyKey)).toEqual([delivery.delivery.idempotencyKey, delivery.delivery.idempotencyKey]);
    expect(send.mock.calls[0][0]).toMatchObject({ to: `${ownerId}@example.invalid`, subject: input.subject, text: input.text });
    const view = await a.delivery.getOwned(ownerId, delivery.delivery.id); expect(view).not.toHaveProperty('recipient'); expect(view).not.toHaveProperty('text');
    await expect(pool.query(`UPDATE "${schema}"."delivery_messages" SET text='changed' WHERE id=$1`, [delivery.delivery.id])).rejects.toThrow(/immutable/);
    await expect(pool.query(`UPDATE "${schema}"."delivery_messages" SET "dispatchStartedAt"=NULL WHERE id=$1`, [delivery.delivery.id])).rejects.toThrow(/evidence/);
  });

  it('does not retry SMTP after an ambiguous response', async () => {
    const provider = fakeMail(false); vi.mocked(provider.deliver).mockRejectedValueOnce(new Error('synthetic response lost'));
    const a = harness(first, provider), delivery = await a.delivery.enqueue(mail());
    expect(await a.delivery.runOnce('smtp')).toMatchObject({ kind: 'dead', errorCode: 'MAIL_OUTCOME_UNKNOWN' });
    expect(await a.delivery.runOnce('smtp')).toMatchObject({ kind: 'idle' }); expect(provider.deliver).toHaveBeenCalledTimes(1);
    expect(await a.delivery.getOwned(ownerId, delivery.delivery.id)).toMatchObject({ status: 'DEAD', requiresReview: true });
  });

  it('does not resend SMTP after a crash with a durable dispatch marker', async () => {
    const provider = fakeMail(false), a = harness(first, provider), created = await a.delivery.enqueue(mail());
    const now = new Date(Date.now() - 5000);
    await pool.query(`UPDATE "${schema}"."notification_deliveries" SET "availableAt"=$2 WHERE id=$1`, [created.delivery.id, now]);
    expect(await a.delivery.repository.claimNext({ workerId: 'killed', now, leaseMs: 1000 })).not.toBeNull();
    await pool.query(`UPDATE "${schema}"."delivery_messages" SET "dispatchStartedAt"=$2 WHERE id=$1`, [created.delivery.id, now]);
    expect(await a.delivery.runOnce('restarted')).toMatchObject({ kind: 'dead', errorCode: 'MAIL_OUTCOME_UNKNOWN' });
    expect(provider.deliver).not.toHaveBeenCalled(); expect(await a.delivery.getOwned(ownerId, created.delivery.id)).toMatchObject({ requiresReview: true });
  });

  it('refuses recipient changes after enqueue without dispatching to either address', async () => {
    const provider = fakeMail(), a = harness(first, provider), created = await a.delivery.enqueue(mail());
    await first.model('users').update({ where: { id: ownerId }, data: { email: 'changed@example.invalid' } });
    try { expect(await a.delivery.runOnce('mail')).toMatchObject({ kind: 'dead', errorCode: 'MAIL_RECIPIENT_UNAVAILABLE' }); expect(provider.deliver).not.toHaveBeenCalled(); }
    finally { await first.model('users').update({ where: { id: ownerId }, data: { email: `${ownerId}@example.invalid` } }); }
    expect(await a.delivery.getOwned(ownerId, created.delivery.id)).toMatchObject({ status: 'DEAD', requiresReview: false });
  });

  it('runs the exported notification schema and repository against an ordinary PostgreSQL client', async () => {
    const client = await pool.connect(), isolated = `notification_contract_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${isolated}"`); await client.query(`SET LOCAL search_path TO "${isolated}"`);
      await client.query("SET LOCAL timezone TO 'Asia/Shanghai'"); await client.query(notificationDeliverySchemaSql);
      const repository = new PostgresNotificationDeliveryRepository({ query: async <TRow>(sql: string, values?: readonly unknown[]) => {
        const result = await client.query(sql, values ? [...values] : undefined); return { rows: result.rows as TRow[] };
      } });
      const now = new Date();
      for (const [id, priority] of [['ordinary', 1], ['urgent', 10]] as const)
        await repository.enqueue({ id, priority, idempotencyKey: id, idempotencyFingerprint: id, deliveryRef: id,
          channel: NotifyChannel.EMAIL, maxAttempts: 3, createdAt: now });
      const urgent = (await repository.claimNext({ workerId: 'w', now, leaseMs: 10000 }))!;
      expect(urgent.id).toBe('urgent'); expect(urgent.availableAt).toEqual(now);
      const renewed = await repository.extendLease({ id: urgent.id, leaseToken: urgent.leaseToken, now, leaseMs: 20000 });
      expect(renewed.leaseExpiresAt).toEqual(new Date(now.getTime() + 20000));
      await repository.scheduleRetry({ id: urgent.id, leaseToken: urgent.leaseToken, now, availableAt: now, errorCode: 'SYNTHETIC_TRANSIENT' });
      const retry = (await repository.claimNext({ workerId: 'retry', now, leaseMs: 10000 }))!;
      expect(retry).toMatchObject({ id: 'urgent', attempt: 2 });
      await expect(repository.markDead({ id: urgent.id, leaseToken: urgent.leaseToken, now, errorCode: 'STALE', retryable: false })).rejects.toBeInstanceOf(NotificationLeaseLostError);
      expect(await repository.markDelivered({ id: retry.id, leaseToken: retry.leaseToken, now, providerMessageId: 'receipt' })).toMatchObject({ status: 'DELIVERED', providerMessageId: 'receipt' });
      const ordinary = (await repository.claimNext({ workerId: 'w', now, leaseMs: 10000 }))!;
      expect(await repository.markDead({ id: ordinary.id, leaseToken: ordinary.leaseToken, now, errorCode: 'SYNTHETIC_PERMANENT', retryable: false })).toMatchObject({ status: 'DEAD', errorRetryable: false });
    } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
  });

  it('preserves UTC instants between ordinary pg, raw transactions and direct Prisma models', async () => {
    const a = harness(), created = await a.delivery.enqueue(mail()), instant = new Date('2026-10-23T22:37:15.632Z');
    await pool.query(`UPDATE "${schema}"."notification_deliveries" SET "availableAt"=$2 WHERE id=$1`, [created.delivery.id, instant]);
    const raw = await first.transaction(tx => tx.query<{ stored: Date; parameter: Date; timezone: string; same: boolean }>(
      `SELECT "availableAt" AS stored, $1::timestamptz AS parameter, current_setting('TimeZone') AS timezone, "availableAt" = $1 AS same FROM notification_deliveries`, [instant]));
    expect(raw.rows[0]).toEqual({ stored: instant, parameter: instant, timezone: 'UTC', same: true });
    const typed = await first.model('notificationDelivery').findUnique({ where: { id: created.delivery.id } }) as { availableAt: Date };
    expect(typed.availableAt).toEqual(instant);
  });

  it('stops idempotent provider replay after the persisted first-dispatch window', async () => {
    const provider = fakeMail(), a = harness(first, provider), created = await a.delivery.enqueue(mail());
    const firstDispatch = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await pool.query(`UPDATE "${schema}"."delivery_messages" SET "dispatchStartedAt"=$2 WHERE id=$1`, [created.delivery.id, firstDispatch]);
    expect(await a.delivery.runOnce('restarted')).toMatchObject({ kind: 'dead', errorCode: 'MAIL_IDEMPOTENCY_WINDOW_EXPIRED' });
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(await a.delivery.getOwned(ownerId, created.delivery.id)).toMatchObject({ status: 'DEAD', requiresReview: true });
    expect(deliveryOptionsFromEnvironment({ DELIVERY_REPLAY_WINDOW_MS: '3600000' })).toMatchObject({ replayWindowMs: 3600000 });
    expect(() => deliveryOptionsFromEnvironment({ DELIVERY_REPLAY_WINDOW_MS: String(24 * 60 * 60 * 1000) })).toThrow(/23 hours/);
  });

  it('marks exhausted expired delivery leases dead and enforces the PostgreSQL lease invariant', async () => {
    const a = harness(), now = new Date();
    await a.delivery.repository.enqueue({ id: 'exhausted', idempotencyKey: 'exhausted', idempotencyFingerprint: 'x', channel: NotifyChannel.EMAIL, deliveryRef: 'private-ref', maxAttempts: 1, createdAt: now });
    await a.delivery.repository.claimNext({ workerId: 'one', now, leaseMs: 1 });
    expect(await a.delivery.repository.recoverExpiredLeases(new Date(now.getTime() + 2))).toEqual({ retried: 0, dead: 1 });
    expect(await a.delivery.repository.getById('exhausted')).toMatchObject({ status: 'DEAD', errorCode: 'NOTIFICATION_LEASE_EXPIRED' });
    await expect(pool.query(`UPDATE "${schema}"."notification_deliveries" SET status='PROCESSING' WHERE id='exhausted'`)).rejects.toThrow(/lease_check/);
  });

  it('recovers a killed Node worker from PostgreSQL in a fresh process without an in-memory queue', async () => {
    const a = harness(), created = await a.jobs.submit(command()), scratch = mkdtempSync(join(tmpdir(), 'zucker-job-restart-'));
    const script = join(scratch, 'worker.cjs');
    writeFileSync(script, String.raw`
const {createRequire}=require('node:module');const {resolve}=require('node:path');const load=createRequire(resolve('package.json'));
load('tsx/cjs');load('reflect-metadata');const {ApplicationDatabase}=load('./src/database.ts');
const {JobsService}=load('./src/jobs/jobs.service.ts');const {JobsHost}=load('./src/jobs/jobs.host.ts');
const {DeliveryService}=load('./src/delivery/delivery.service.ts');const {DefaultJobHandlers}=load('./src/jobs/jobs.handlers.ts');
const {FilesService}=load('./src/files/files.service.ts');const {LocalFileStorage}=load('@zucker-framework/storage');
(async()=>{let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);const db=new ApplicationDatabase(process.env.TEST_DATABASE_URL);
const jobs=new JobsService(db);const delivery=new DeliveryService(db,{accountScope:'',leaseMs:1000,heartbeatMs:200});
const files=new FilesService(db,new LocalFileStorage({basePath:input.directory}),{maxObjectBytes:2048});new DefaultJobHandlers(jobs,files,delivery).onModuleInit();
if(input.mode==='claim'){await jobs.repository.claim({id:input.id,workerId:'killed-node',leaseToken:'killed-lease',now:new Date(),leaseExpiresAt:new Date(Date.now()+250)});process.stdout.write('CLAIMED\n');setInterval(()=>{},1000);return;}
const host=new JobsHost(jobs,delivery,{enabled:true,workerId:'fresh-node',concurrency:1,scanIntervalMs:50,leaseMs:1000,heartbeatMs:200,shutdownWaitMs:1000});
try{await host.onApplicationBootstrap();await host.waitForIdle();const task=await jobs.repository.findById(input.id);process.stdout.write('EVIDENCE:'+JSON.stringify({pid:process.pid,status:task.status,attempt:task.attempt}));}
finally{await host.stop();await db.onModuleDestroy();}})().catch(()=>{process.stderr.write('Synthetic job worker failed');process.exitCode=1;});
`);
    try {
      const killed = spawn(process.execPath, [script], { cwd: resolve('.'), env: { ...process.env, TEST_DATABASE_URL: scopedUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<void>((done, reject) => { killed.once('error', reject); killed.once('exit', () => done()); });
      killed.stdin.end(JSON.stringify({ mode: 'claim', id: created.task.id, directory }));
      try { await new Promise<void>((done, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic child did not claim')), 10000); killed.stdout.on('data', chunk => { if (chunk.toString().includes('CLAIMED')) { clearTimeout(timer); done(); } }); killed.once('error', reject); }); }
      finally { killed.kill('SIGKILL'); await exited; }
      await new Promise(done => setTimeout(done, 300));
      const fresh = spawn(process.execPath, [script], { cwd: resolve('.'), env: { ...process.env, TEST_DATABASE_URL: scopedUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = await new Promise<string>((done, reject) => { let text = ''; const timer = setTimeout(() => { fresh.kill('SIGKILL'); reject(new Error('Synthetic restart timed out')); }, 10000);
        fresh.stdout.on('data', chunk => { text += chunk; }); fresh.once('error', reject); fresh.once('exit', code => { clearTimeout(timer); code === 0 ? done(text) : reject(new Error('Synthetic restart failed')); }); fresh.stdin.end(JSON.stringify({ mode: 'recover', id: created.task.id, directory })); });
      const evidence = JSON.parse(output.slice(output.indexOf('EVIDENCE:') + 9)); expect(evidence).toMatchObject({ status: 'COMPLETED', attempt: 2 }); expect(evidence.pid).not.toBe(process.pid);
      expect(await a.jobs.record(ownerId, created.task.id)).toMatchObject({ value: 'synthetic' });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
