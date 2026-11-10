import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { LocalFileStorage } from '@zucker-framework/storage';
import { QuotaReservationService } from '@zucker-framework/credit';
import { DurableTaskRetryScheduledError } from '@zucker-framework/task';
import type { DurableTaskAttemptContext } from '@zucker-framework/task';
import { ApplicationDatabase } from '../src/database';
import { createCreditLedger } from '../src/billing/ledger';
import { FilesService } from '../src/files/files.service';
import { DeliveryService } from '../src/delivery/delivery.service';
import { JobsService } from '../src/jobs/jobs.service';
import { JobsHost } from '../src/jobs/jobs.host';
import { DefaultJobHandlers } from '../src/jobs/jobs.handlers';
import { CreditsService } from '../src/credits/credits.service';
import { CREDIT_EXPIRY_JOB, CreditsRuntime } from '../src/credits/credits.runtime';
import { QuotaService } from '../src/credits/quota.service';
import { QUOTA_RECONCILE_JOB, QuotaRuntime } from '../src/credits/quota.runtime';
import { createQuotaStore } from '../src/credits/quota.store';
import type { QuotaOptions } from '../src/credits/quota.config';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_credits_${randomUUID().replaceAll('-', '')}`;
run('canonical credits and persistent record quota', () => {
  let pool: Pool, first: ApplicationDatabase, second: ApplicationDatabase, directory: string, ownerId: string, otherId: string;
  const hosts: JobsHost[] = [];
  function harness(database = first, options: QuotaOptions = { recordLimit: 1, period: 'daily', reservationTtlMs: 900000 }, enabled = false) {
    const jobs = new JobsService(database), delivery = new DeliveryService(database, { accountScope: '', leaseMs: 2000, heartbeatMs: 500 });
    const files = new FilesService(database, new LocalFileStorage({ basePath: directory }), { maxObjectBytes: 2048 });
    new DefaultJobHandlers(jobs, files, delivery).onModuleInit();
    const credits = new CreditsService(database), creditRuntime = new CreditsRuntime(database, jobs), quota = new QuotaService(database, options), quotaRuntime = new QuotaRuntime(database, jobs, quota);
    creditRuntime.onModuleInit(); quotaRuntime.onModuleInit();
    const host = new JobsHost(jobs, delivery, { enabled, workerId: randomUUID(), concurrency: 2, scanIntervalMs: 100, leaseMs: 2000, heartbeatMs: 500, shutdownWaitMs: 2000 }); hosts.push(host);
    return { jobs, host, credits, creditRuntime, quota, quotaRuntime };
  }
  const record = (jobs: JobsService, key = randomUUID(), owner = ownerId) => jobs.submitForUser(owner, key, { kind: 'record', input: { value: 'Synthetic durable record' } });
  const rows = async (table: string) => (await pool.query(`SELECT * FROM "${schema}"."${table}"`)).rows;
  async function grant(amount = 10, expiresAt?: Date, owner = ownerId) {
    const ledger = createCreditLedger(first), operation = { idempotencyKey: randomUUID(), accountId: owner, operationType: 'SYNTHETIC_GRANT', amount, resourceType: 'test-receipt', resourceId: randomUUID() };
    const input = { accountId: owner, amount, source: 'checkout', sourceId: operation.resourceId, expiresAt, operation,
      transactionData: { type: 'GRANT', description: 'Synthetic paid credits', metadata: { source: 'checkout', sourceId: operation.resourceId, privateValue: 'must-not-be-public' } } };
    expect(await first.transaction(tx => ledger.grant(tx, input))).toBe(true);
    return { input, replay: () => first.transaction(tx => ledger.grant(tx, input)) };
  }
  async function failWrite(table: 'credit_transaction' | 'quota_usage', event: 'INSERT' | 'UPDATE', condition: string, work: () => Promise<void>) {
    await pool.query(`CREATE FUNCTION "${schema}".synthetic_credit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic credit write failed'; END; $$`);
    try { await pool.query(`CREATE TRIGGER synthetic_credit_failure BEFORE ${event} ON "${schema}"."${table}" FOR EACH ROW ${condition} EXECUTE FUNCTION "${schema}".synthetic_credit_failure()`);
      try { await work(); } finally { await pool.query(`DROP TRIGGER synthetic_credit_failure ON "${schema}"."${table}"`); }
    } finally { await pool.query(`DROP FUNCTION "${schema}".synthetic_credit_failure()`); }
  }
  async function staleContext(jobs: JobsService, id: string): Promise<DurableTaskAttemptContext> {
    const task = await jobs.repository.claim({ id, workerId: 'stale-worker', leaseToken: 'stale-token', now: new Date(), leaseExpiresAt: new Date(Date.now() + 2000) });
    if (!task) throw new Error('Synthetic claim failed');
    await pool.query(`UPDATE "${schema}"."async_jobs" SET "leaseExpiresAt"=$2 WHERE id=$1`, [id, new Date(Date.now() - 1000)]);
    return { task, leaseToken: 'stale-token', signal: new AbortController().signal, now: () => new Date(), assertActive: async () => {}, reportProgress: async () => task };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!); // Safety, as in every persistent suite: only a database named *_dev/*_test/*_tests (it creates and drops its own schema).
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use a designated development/test database');
    directory = mkdtempSync(join(tmpdir(), 'zucker-credit-objects-')); pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const entry of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(value => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', entry.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); first = new ApplicationDatabase(url.href); second = new ApplicationDatabase(url.href);
    ownerId = randomUUID(); otherId = randomUUID();
    for (const id of [ownerId, otherId]) await first.model('users').create({ data: { id, username: `credits_${id.replaceAll('-', '')}`, name: 'Synthetic credit owner', typeId: 'member', email: `${id}@example.invalid`, emailVerified: true, status: true } });
  });
  beforeEach(async () => { await pool.query(`TRUNCATE "${schema}".quota_reservations,"${schema}".quota_usage,"${schema}".credit_account,"${schema}".credit_transaction,"${schema}".credit_lots,"${schema}".credit_operation_receipts,"${schema}".async_jobs CASCADE`); });
  afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())); vi.restoreAllMocks(); });
  afterAll(async () => { try { await Promise.all([first?.disconnect(), second?.disconnect()]); }
    finally { try { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); } } });

  it('expires normally granted credits through the Jobs host once, without a duplicate receipt reviving them', async () => {
    const a = harness(first, { period: 'daily', reservationTtlMs: 900000 }, true), receipt = await grant(10, new Date(Date.now() + 300));
    expect(await a.credits.balance(ownerId)).toMatchObject({ available: 10, expired: 0, bookBalance: 10 });
    await new Promise(done => setTimeout(done, 350));
    expect(await a.credits.balance(ownerId)).toMatchObject({ available: 0, expired: 10, pendingExpiry: 10, bookBalance: 10 });
    expect((await rows('credit_transaction')).filter(row => row.type === 'EXPIRE')).toHaveLength(0);
    await a.host.onApplicationBootstrap(); await a.host.waitForIdle(); await a.creditRuntime.scheduleDue(); await a.host.waitForIdle();
    expect(await receipt.replay()).toBe(false);
    expect(await a.credits.balance(ownerId)).toMatchObject({ available: 0, frozen: 0, expired: 10, pendingExpiry: 0, bookBalance: 0 });
    expect((await rows('credit_transaction')).filter(row => row.type === 'EXPIRE')).toHaveLength(1);
    const tasks = await a.jobs.list(ownerId); expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ kind: CREDIT_EXPIRY_JOB, status: 'COMPLETED', canCancel: false });
    expect((await a.credits.lots(ownerId, { page: 1, pageSize: 20 })).data[0]).toMatchObject({ status: 'expired', availableAmount: 0 });
  });

  it('never expires an account through a stale maintenance lease', async () => {
    const a = harness(); await grant(10, new Date(Date.now() - 1000)); await a.creditRuntime.scheduleDue();
    const task = (await a.jobs.list(ownerId))[0], context = await staleContext(a.jobs, task.id);
    expect(await a.jobs.handler(CREDIT_EXPIRY_JOB, '1')!.complete!(context, {})).toBe(false);
    expect(await a.credits.balance(ownerId)).toMatchObject({ bookBalance: 10, pendingExpiry: 10 });
    expect((await rows('credit_transaction')).filter(row => row.type === 'EXPIRE')).toHaveLength(0);
    await expect(a.jobs.cancel(ownerId, task.id)).rejects.toMatchObject({ status: 400 });
  });

  it('rolls task completion and lot/account expiry back with a failed journal insert', async () => {
    const a = harness(); await grant(10, new Date(Date.now() - 1000)); await a.creditRuntime.scheduleDue(); const task = (await a.jobs.list(ownerId))[0];
    await failWrite('credit_transaction', 'INSERT', `WHEN (NEW.type='EXPIRE')`, async () => { await expect(a.host.runTask(task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError); });
    expect((await rows('credit_lots'))[0].isExpired).toBe(false); expect(await a.credits.balance(ownerId)).toMatchObject({ bookBalance: 10 });
    await pool.query(`UPDATE "${schema}".async_jobs SET "availableAt"=$2 WHERE id=$1`, [task.id, new Date(Date.now() - 1000)]);
    await a.host.runTask(task.id); expect(await a.credits.balance(ownerId)).toMatchObject({ bookBalance: 0, expired: 10 });
  });

  it('pages only owned journal and lots, keeps raw metadata private, and distinguishes frozen from available', async () => {
    const a = harness(); await grant(10); await grant(5); await grant(99, undefined, otherId);
    const lots = await first.model('creditLots').findMany({ where: { userId: ownerId }, select: { id: true } }) as Array<{ id: string }>;
    const holdId = randomUUID(); await first.transaction(tx => createCreditLedger(first).hold(tx, { id: holdId, accountId: ownerId,
      amount: 3, lotIds: lots.map(lot => lot.id), resourceType: 'synthetic-read-check', resourceId: holdId,
      operationKey: `read-hold:${holdId}`, transactionData: { type: 'FREEZE' } }));
    expect(await a.credits.balance(ownerId)).toMatchObject({ available: 12, frozen: 3, expired: 0 });
    const page = await a.credits.transactions(ownerId, { page: 1, pageSize: 1, type: 'GRANT' });
    expect(page.total).toBe(2); expect(page.data).toHaveLength(1); expect(page.data[0].metadata).toBeUndefined(); expect(page.data[0].references).not.toHaveProperty('privateValue');
    expect((await a.credits.lots(ownerId, { page: 3, pageSize: 1 })).data).toEqual([]);
    expect((await a.credits.lots(otherId, { page: 1, pageSize: 20 })).total).toBe(1);
  });

  it('admits only one concurrent reservation and atomically confirms one durable result', async () => {
    const a = harness(), b = harness(second), key = randomUUID();
    const results = await Promise.allSettled([record(a.jobs, key), record(b.jobs)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await rows('async_jobs')).toHaveLength(1); expect(await rows('async_job_outbox')).toHaveLength(1); expect(await rows('quota_reservations')).toHaveLength(1);
    const task = (await rows('async_jobs'))[0];
    expect(await a.quota.recordSnapshot(ownerId)).toMatchObject({ used: 0, reserved: 1, remaining: 0 });
    await a.host.runTask(task.id); await b.host.runTask(task.id);
    expect(await a.quota.recordSnapshot(ownerId)).toMatchObject({ used: 1, reserved: 0, remaining: 0 });
    expect(await rows('job_records')).toHaveLength(1); expect((await rows('quota_reservations'))[0]).toMatchObject({ status: 'CONFIRMED', amount: 1, resourceId: task.id });
    expect(await rows('credit_account')).toHaveLength(0);
  });

  it('keeps repeated submissions idempotent and releases cancellation in the task transaction', async () => {
    const a = harness(), key = randomUUID(), firstTask = await record(a.jobs, key), repeated = await record(a.jobs, key);
    expect(repeated.id).toBe(firstTask.id); expect(await rows('quota_reservations')).toHaveLength(1);
    await expect(a.jobs.cancel(otherId, firstTask.id)).rejects.toMatchObject({ status: 404 });
    expect(await a.jobs.cancel(ownerId, firstTask.id)).toMatchObject({ status: 'CANCELLED', canCancel: false });
    expect((await rows('quota_reservations'))[0].status).toBe('RELEASED'); expect(await a.quota.recordSnapshot(ownerId)).toMatchObject({ used: 0, reserved: 0, remaining: 1 });
    await record(a.jobs); expect(await rows('quota_reservations')).toHaveLength(2);
  });

  it('rolls quota confirmation, usage, business result and task completion back together', async () => {
    const a = harness(), task = await record(a.jobs);
    await failWrite('quota_usage', 'UPDATE', 'WHEN (NEW.used > OLD.used)', async () => { await expect(a.host.runTask(task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError); });
    expect((await rows('quota_reservations'))[0].status).toBe('RESERVED'); expect((await rows('quota_usage'))[0].used).toBe(0); expect(await rows('job_records')).toHaveLength(0);
    await pool.query(`UPDATE "${schema}".async_jobs SET "availableAt"=$2 WHERE id=$1`, [task.id, new Date(Date.now() - 1000)]);
    await a.host.runTask(task.id); expect((await rows('quota_usage'))[0].used).toBe(1); expect(await rows('job_records')).toHaveLength(1);
  });

  it('releases a final failed record and reconciles crash-terminal reservations through the same host', async () => {
    const a = harness(), invalid = await a.jobs.submit({ kind: 'record', ownerId, idempotencyKey: randomUUID(), resource: { type: 'job-record', id: randomUUID() }, payload: { value: '' } });
    expect(await a.host.runTask(invalid.task.id)).toMatchObject({ status: 'FAILED' }); expect((await rows('quota_reservations'))[0].status).toBe('RELEASED');
    const crashed = await record(a.jobs); await first.transaction(tx => tx.query(`UPDATE async_jobs SET status='FAILED' WHERE id=$1`, [crashed.id]));
    await a.quotaRuntime.scheduleDue(); const maintenance = (await a.jobs.list(ownerId)).find(task => task.kind === QUOTA_RECONCILE_JOB)!;
    await a.host.runTask(maintenance.id); expect(await a.quota.get(ownerId, crashed.id)).toMatchObject({ status: 'RELEASED', reason: 'task-terminal' });
    expect(await a.quota.recordSnapshot(ownerId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it('expires abandoned reservations with fencing and never charges them', async () => {
    const a = harness(first, { recordLimit: 1, period: 'daily', reservationTtlMs: 30 }), task = await record(a.jobs);
    await new Promise(done => setTimeout(done, 50)); await a.quotaRuntime.scheduleDue();
    const maintenance = (await a.jobs.list(ownerId)).find(item => item.kind === QUOTA_RECONCILE_JOB)!;
    const context = await staleContext(a.jobs, maintenance.id);
    expect(await a.jobs.handler(QUOTA_RECONCILE_JOB, '1')!.complete!(context, {})).toBe(false);
    expect(await a.quota.get(ownerId, task.id)).toMatchObject({ status: 'RESERVED' });
    await a.jobs.repository.recoverExpiredLease({ id: maintenance.id, leaseToken: 'stale-token', now: new Date(), error: { code: 'SYNTHETIC_LEASE', category: 'INTERNAL', retryable: true, summary: 'Synthetic expired lease' } });
    await a.host.runTask(maintenance.id);
    expect(await a.quota.get(ownerId, task.id)).toMatchObject({ status: 'EXPIRED' }); expect((await rows('quota_usage'))[0].used).toBe(0);
    expect(await a.host.runTask(task.id)).toMatchObject({ status: 'FAILED' });
    expect(await rows('job_records')).toHaveLength(0);
  });

  it('preserves an accepted reservation when a later higher policy admits another operation', async () => {
    const original = harness(), firstTask = await record(original.jobs);
    const raised = harness(second, { recordLimit: 2, period: 'daily', reservationTtlMs: 900000 }), secondTask = await record(raised.jobs);
    await original.host.runTask(firstTask.id); await raised.host.runTask(secondTask.id);
    expect(await original.quota.get(ownerId, firstTask.id)).toMatchObject({ status: 'CONFIRMED', limit: 1 });
    expect(await raised.quota.get(ownerId, secondTask.id)).toMatchObject({ status: 'CONFIRMED', limit: 2 });
    expect((await rows('quota_usage'))[0].used).toBe(2); expect(await rows('job_records')).toHaveLength(2);
  });

  it('honors two captured reservations after a limit reduction while rejecting new work', async () => {
    const original = harness(first, { recordLimit: 2, period: 'daily', reservationTtlMs: 900000 });
    const firstTask = await record(original.jobs), secondTask = await record(original.jobs);
    const reduced = harness(second, { recordLimit: 1, period: 'daily', reservationTtlMs: 900000 });
    await expect(record(reduced.jobs)).rejects.toMatchObject({ status: 409 });
    // A persisted cap can fall below accepted commitments without invalidating historical usage.
    await first.model('quotaUsage').updateMany({ where: { subjectId: ownerId, counter: 'record' }, data: { limit: 1 } });
    await reduced.host.runTask(firstTask.id); await reduced.host.runTask(secondTask.id); await reduced.host.runTask(firstTask.id);
    expect(await reduced.quota.recordSnapshot(ownerId)).toMatchObject({ limit: 1, used: 2, reserved: 0, remaining: 0 });
    await expect(record(reduced.jobs)).rejects.toMatchObject({ status: 409 });
    expect((await rows('quota_usage'))[0]).toMatchObject({ used: 2, limit: 1 });
    expect(await rows('quota_reservations')).toHaveLength(2); expect(await rows('job_records')).toHaveLength(2);
  });

  it('uses captured quota policy after restart/configuration changes and prevents identity rewrites', async () => {
    const a = harness(), task = await record(a.jobs), restarted = harness(second, { period: 'monthly', reservationTtlMs: 900000 });
    await restarted.host.runTask(task.id); expect(await restarted.quota.get(ownerId, task.id)).toMatchObject({ status: 'CONFIRMED', limit: 1, policyVersion: 'record:daily:1' });
    expect((await rows('quota_usage'))[0].used).toBe(1);
    await expect(pool.query(`UPDATE "${schema}".quota_reservations SET "subjectId"=$2 WHERE id=$1`, [task.id, otherId])).rejects.toThrow(/immutable/);
    await expect(pool.query(`UPDATE "${schema}".quota_reservations SET status='RESERVED',"finishedAt"=NULL WHERE id=$1`, [task.id])).rejects.toThrow(/immutable/);
    await expect(a.quota.get(otherId, task.id)).rejects.toMatchObject({ status: 404 });
  });

  it('confirms the reservation’s captured period through the public quota mechanism', async () => {
    const service = new QuotaReservationService(createQuotaStore(first));
    const row = await service.reserve({ id: randomUUID(), subjectId: ownerId, counter: 'neutral-contract', amount: 1,
      period: 'captured-period', limit: 2, policyVersion: 'captured-v1', resourceType: 'synthetic-proof', resourceId: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
    expect(await service.confirm(row.id)).toBe(true); expect(await new QuotaReservationService(createQuotaStore(second)).confirm(row.id)).toBe(false);
    expect(await service.release(row.id)).toBe(false); expect((await rows('quota_usage'))[0]).toMatchObject({ period: 'captured-period', used: 1, limit: 2 });
  });
});
