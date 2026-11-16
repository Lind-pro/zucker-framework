// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { MediaType } from '@zucker-framework/ai';
import { FAKE_PNG_BASE64, FakeMediaProvider } from '@zucker-framework/ai/testing';
import { DurableTaskRetryScheduledError, DurableWorkerRuntime, ExponentialTaskRetryPolicy, PostgresTaskRepository, type PostgresTaskClient } from '@zucker-framework/task';
import { postgresTaskTestSchemaSql } from '../../task/src/postgres-test-schema';
import { AITaskService, type AITaskServiceOptions } from './ai-task.service';
import { AI_TASKS_POSTGRESQL_SCHEMA } from './schema';
import type { AITaskProviderRequest } from './ports';

// Embedded PostgreSQL exercises actual rollback/checkpoint SQL. Multi-connection races remain in
// the TEST_DATABASE_URL suites; no sockets, provider accounts or external services are used here.
const OUTBOX = `CREATE TYPE async_job_outbox_status AS ENUM ('PENDING','PUBLISHING','PUBLISHED');
CREATE TABLE async_job_outbox (id text PRIMARY KEY,"taskId" text NOT NULL,topic text NOT NULL,payload jsonb NOT NULL,
 status async_job_outbox_status NOT NULL DEFAULT 'PENDING',attempt integer NOT NULL DEFAULT 0,"availableAt" timestamptz NOT NULL,
 "workerId" text,"leaseToken" text,"leaseExpiresAt" timestamptz,"publishedAt" timestamptz,"lastError" text,
 "createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL);
CREATE TABLE wallet (balance integer NOT NULL, frozen integer NOT NULL);
INSERT INTO wallet VALUES (100,0);
CREATE TABLE settlements (action text NOT NULL);`;

describe('AI paid submission checkpoints and bounded output delivery', () => {
  let db: PGlite;
  let failSql: ((sql: string, values?: readonly unknown[]) => void) | undefined;
  let failConfirm: number;
  let stored: number;
  let now: Date;
  const adapt = (connection: Pick<PGlite, 'query'>): PostgresTaskClient => ({
    async query<Row>(sql: string, values?: readonly unknown[]) {
      failSql?.(sql, values);
      return { rows: (await connection.query<Row>(sql, values ? [...values] : [])).rows };
    },
  });
  beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(postgresTaskTestSchemaSql + AI_TASKS_POSTGRESQL_SCHEMA + OUTBOX);
    failSql = undefined; failConfirm = 0; stored = 0; now = new Date();
  });
  afterEach(async () => { await db.close(); });
  const balances = async () => (await db.query('SELECT * FROM wallet')).rows[0];
  const events = async () => (await db.query<{ action: string }>('SELECT action FROM settlements ORDER BY action')).rows.map(row => row.action);
  function service(provider: FakeMediaProvider, override: Partial<AITaskServiceOptions<PostgresTaskClient>> = {}) {
    return new AITaskService({
      transactions: { runInTransaction: work => db.transaction(tx => work(adapt(tx))) },
      costs: { resolve: query => 5 * Number(query.input.options?.count ?? 1) },
      holds: {
        async place(tx, input) { await tx.query('UPDATE wallet SET balance=balance-$1,frozen=frozen+$1', [input.amount]); await tx.query("INSERT INTO settlements VALUES ('hold')"); },
        async confirm(tx) {
          if (failConfirm-- > 0) throw new Error('synthetic transient ledger failure');
          await tx.query('UPDATE wallet SET frozen=0'); await tx.query("INSERT INTO settlements VALUES ('confirm')");
        },
        async release(tx) { await tx.query('UPDATE wallet SET balance=balance+frozen,frozen=0'); await tx.query("INSERT INTO settlements VALUES ('release')"); },
      },
      outputs: { async put(output) { stored++; return { storageKey: `files/${output.index}` }; } },
      providers: { resolve: () => ({ provider, config: { apiKey: 'synthetic' } }) },
      polling: { initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {}, now: () => now,
      ...override,
    });
  }
  async function submit(tasks: AITaskService, count = 1) {
    return (await tasks.submitAndWake({ ownerId: 'owner', kind: 'image', providerId: 'fake-media', model: 'fake-image',
      input: { prompt: 'synthetic', options: { count } }, idempotencyKey: 'checkpoint-00001' })).task;
  }
  async function run(tasks: AITaskService, id: string, signal?: AbortSignal) {
    now = new Date(now.getTime() + 10);
    return new DurableWorkerRuntime({ repository: new PostgresTaskRepository(adapt(db)), resolveHandler: () => tasks.handler,
      retryPolicy: new ExponentialTaskRetryPolicy({ baseDelayMs: 0, maxDelayMs: 0 }), now: () => now,
      classifyError: () => ({ code: 'INTERNAL', category: 'INTERNAL', summary: 'synthetic transient failure', retryable: true }),
      workerId: 'synthetic-worker' }).run(id, { signal });
  }

  it('retries a failed completion transaction from stored outputs without regenerating or re-uploading', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'sync' } });
    const tasks = service(provider), task = await submit(tasks);
    failConfirm = 1;
    await expect(run(tasks, task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    expect((await db.query('SELECT "executionState", "generatedOutputs" FROM ai_tasks')).rows[0]).toEqual({ executionState: 'STORED', generatedOutputs: null });
    expect(await balances()).toEqual({ balance: 95, frozen: 5 });
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(provider.calls.filter(call => call.method === 'generate')).toHaveLength(1);
    expect(stored).toBe(1);
    expect(await balances()).toEqual({ balance: 95, frozen: 0 });
    expect(await events()).toEqual(['confirm', 'hold']);
  });

  it('retries synchronous output storage from the persisted generated result', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'sync' } });
    let writes = 0;
    const tasks = service(provider, { outputs: { put: async () => { if (++writes === 1) throw new Error('storage offline'); return { storageKey: 'ready' }; } } });
    const task = await submit(tasks);
    await expect(run(tasks, task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    expect((await db.query('SELECT "executionState" FROM ai_tasks')).rows[0]).toEqual({ executionState: 'GENERATED' });
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(provider.calls).toHaveLength(1); expect(writes).toBe(2);
    expect(await events()).toEqual(['confirm', 'hold']);
  });

  it('persists accepted async task id before a failed poll-deferral transaction', async () => {
    const provider = new FakeMediaProvider();
    const tasks = service(provider), task = await submit(tasks);
    let remaining = 1;
    failSql = sql => { if (sql.includes('"deferrals" = a."deferrals" + 1') && remaining-- > 0) throw new Error('deferral write failed'); };
    await expect(run(tasks, task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(provider.calls.map(call => call.method)).toEqual(['generate', 'getTaskStatus']);
  });

  it('recovers a lost submit-result checkpoint using a read-only provider lookup', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'sync' } });
    const recoverSubmission = vi.fn(async function (this: { output: { base64: string } }, _request: AITaskProviderRequest, _signal: AbortSignal) { return this.output; });
    const resolver = { output: { base64: FAKE_PNG_BASE64 }, resolve: () => ({ provider, config: { apiKey: 'synthetic' } }), recoverSubmission };
    const tasks = service(provider, { providers: resolver });
    const task = await submit(tasks);
    let remaining = 3;
    failSql = (_sql, values) => { if (values?.[2] === 'GENERATED' && remaining-- > 0) throw new Error('result checkpoint unavailable'); };
    await expect(run(tasks, task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(provider.calls).toHaveLength(1); expect(recoverSubmission).toHaveBeenCalledTimes(1);
    expect(recoverSubmission.mock.calls[0]?.[0]).toMatchObject({ taskId: task.id });
  });

  it('marks an unrecoverable unknown submission explicitly and refunds without reissuing it', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'sync' } });
    const tasks = service(provider), task = await submit(tasks);
    let remaining = 3;
    failSql = (_sql, values) => { if (values?.[2] === 'GENERATED' && remaining-- > 0) throw new Error('checkpoint unavailable'); };
    await expect(run(tasks, task.id)).rejects.toBeInstanceOf(DurableTaskRetryScheduledError);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'FAILED' });
    expect(await tasks.get('owner', task.id)).toMatchObject({ charge: 'RELEASED', error: { code: 'AI_PROVIDER_SUBMISSION_UNKNOWN' } });
    expect(provider.calls).toHaveLength(1); expect(await balances()).toEqual({ balance: 100, frozen: 0 });
  });

  it('preserves all requested synchronous outputs and charges once', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'sync', outputs: 4 } });
    const tasks = service(provider), task = await submit(tasks, 4);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect((await tasks.get('owner', task.id))?.outputs).toHaveLength(4);
    expect(stored).toBe(4); expect(await balances()).toEqual({ balance: 80, frozen: 0 });
  });

  it('does not charge the full batch when the provider delivers fewer outputs', async () => {
    const tasks = service(new FakeMediaProvider({ defaultStep: { mode: 'sync', outputs: 1 } })), task = await submit(tasks, 4);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'FAILED' });
    expect(await tasks.get('owner', task.id)).toMatchObject({ charge: 'RELEASED', error: { code: 'AI_OUTPUT_COUNT_MISMATCH' } });
    expect(stored).toBe(0); expect(await balances()).toEqual({ balance: 100, frozen: 0 });
  });

  it('bounds result checkpoints before persisting inline provider data', async () => {
    const provider = new FakeMediaProvider();
    vi.spyOn(provider, 'generate').mockResolvedValue({ base64: 'a'.repeat(10_000), mediaType: MediaType.IMAGE,
      cost: 0, provider: provider.id, model: 'fake-image', durationMs: 0 });
    const tasks = service(provider, { outputLimits: { maxBytes: { image: 100 } } }), task = await submit(tasks);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'FAILED' });
    expect((await db.query('SELECT "generatedOutputs" FROM ai_tasks')).rows[0]).toEqual({ generatedOutputs: null });
    expect(await tasks.get('owner', task.id)).toMatchObject({ charge: 'RELEASED', error: { code: 'AI_OUTPUT_REJECTED' } });
  });

  it('honours a synchronous host abort from the transport without waiting for the download deadline', async () => {
    const controller = new AbortController();
    const tasks = service(new FakeMediaProvider({ defaultStep: { mode: 'sync', outputKind: 'url' } }), {
      outputLimits: { downloadTimeoutMs: 60_000 },
      fetch: () => { controller.abort(new Error('synthetic host interruption')); return new Promise(() => {}); },
    });
    const task = await submit(tasks);
    await expect(run(tasks, task.id, controller.signal)).rejects.toMatchObject({ name: 'DurableTaskAbortedError' });
    // Host interruption preserves recovery state/hold; an owner cancellation refunds once.
    await tasks.cancelOwned('owner', task.id);
    expect(await balances()).toEqual({ balance: 100, frozen: 0 });
    expect(await events()).toEqual(['hold', 'release']);
  });

  it('fences a checkpoint against owner cancellation during output storage', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'sync' } });
    const tasks = service(provider, { outputs: { put: async output => {
      await tasks.cancelOwned(output.ownerId, output.taskId);
      return { storageKey: 'written-before-cancel' };
    } } });
    const task = await submit(tasks);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'CANCELLED' });
    expect((await db.query('SELECT * FROM ai_task_outputs')).rows).toHaveLength(0);
    expect(await events()).toEqual(['hold', 'release']);
    expect(await balances()).toEqual({ balance: 100, frozen: 0 });
  });

  it('upgrades legacy attempted tasks conservatively without marking unknown submissions NEW', async () => {
    const tasks = service(new FakeMediaProvider());
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await tasks.submitAndWake({ ownerId: 'owner', kind: 'image', providerId: 'fake-media', model: 'fake-image',
      input: { prompt: 'legacy' }, idempotencyKey: `legacy-key-${i}` })).task.id);
    await db.query('UPDATE async_jobs SET attempt=1 WHERE id=$1', [ids[1]]);
    await db.query('UPDATE ai_tasks SET "providerTaskId"=\'provider-known\' WHERE id=$1', [ids[2]]);
    await db.query('UPDATE async_jobs SET status=\'COMPLETED\' WHERE id=$1', [ids[3]]);
    await db.exec('ALTER TABLE ai_tasks DROP COLUMN "executionState", DROP COLUMN "generatedOutputs"');
    const migration = readFileSync(new URL('../assets/ai-tasks.execution-checkpoints.postgresql.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    const states = new Map((await db.query<{ id: string; executionState: string }>('SELECT id,"executionState" FROM ai_tasks')).rows.map(row => [row.id, row.executionState]));
    expect(ids.map(id => states.get(id))).toEqual(['NEW', 'SUBMITTING', 'ACCEPTED', 'STORED']);
  });

  it.each(['headers', 'body'] as const)('bounds a stalled output %s and releases the hold', async phase => {
    let aborted = false, cancelled = false;
    const tasks = service(new FakeMediaProvider({ defaultStep: { mode: 'sync', outputKind: 'url' } }), {
      outputLimits: { downloadTimeoutMs: 30 },
      fetch: async (_url, init) => {
        init!.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
        if (phase === 'headers') return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(FAKE_PNG_BASE64, 'base64')); }, cancel() { cancelled = true; } }));
      },
    });
    const task = await submit(tasks);
    await expect(run(tasks, task.id)).resolves.toMatchObject({ status: 'FAILED' });
    expect(await tasks.get('owner', task.id)).toMatchObject({ charge: 'RELEASED', error: { code: 'AI_OUTPUT_TIMEOUT' } });
    expect(aborted).toBe(true); if (phase === 'body') expect(cancelled).toBe(true);
    expect(await balances()).toEqual({ balance: 100, frozen: 0 });
  });
});
