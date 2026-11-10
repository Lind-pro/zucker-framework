// @vitest-environment node
import { Pool, type PoolClient } from 'pg';
import { FAKE_PNG_BASE64, FakeCallbackVerifier, FakeMediaProvider } from '@zucker-framework/ai/testing';
import {
  DurableTaskNotClaimableError,
  DurableTaskRetryScheduledError,
  DurableWorkerRuntime,
  ExponentialTaskRetryPolicy,
  PostgresTaskRepository,
  type DurableTaskAttemptContext,
  type PostgresTaskClient,
} from '@zucker-framework/task';
import { postgresTaskTestSchemaSql } from '../../task/src/postgres-test-schema';
import { AITaskService, type AITaskExecution, type AITaskServiceOptions } from './ai-task.service';
import { AITaskInsufficientCreditsError } from './errors';
import type { AITaskCallbackVerifier, CreditHoldPort } from './ports';
import { AI_TASKS_POSTGRESQL_SCHEMA } from './schema';
import type { AITaskPayload } from './types';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const PNG = Buffer.from(FAKE_PNG_BASE64, 'base64');

const WALLET_SQL = `
  CREATE TYPE async_job_outbox_status AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED');
  CREATE TABLE async_job_outbox (
    "id" text PRIMARY KEY,
    "taskId" text NOT NULL REFERENCES async_jobs("id") ON DELETE CASCADE,
    "topic" text NOT NULL,
    "payload" jsonb NOT NULL,
    "status" async_job_outbox_status NOT NULL DEFAULT 'PENDING',
    "attempt" integer NOT NULL DEFAULT 0,
    "availableAt" timestamptz NOT NULL,
    "workerId" text,
    "leaseToken" text,
    "leaseExpiresAt" timestamptz,
    "publishedAt" timestamptz,
    "lastError" text,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
  );
  CREATE TABLE test_wallets ("owner" text PRIMARY KEY, "balance" integer NOT NULL CHECK ("balance" >= 0), "frozen" integer NOT NULL CHECK ("frozen" >= 0));
  CREATE TABLE test_holds ("id" text PRIMARY KEY, "owner" text NOT NULL, "amount" integer NOT NULL, "status" text NOT NULL);
  CREATE TABLE test_hold_events ("holdId" text NOT NULL, "action" text NOT NULL);
`;

function adapt(client: PoolClient | Pool): PostgresTaskClient {
  return { query: async (sql, values) => ({ rows: (await client.query(sql, values ? [...values] : [])).rows }) };
}

/** Synthetic SQL wallet: exercises the port contract on real transactions (row locks, rollback). */
const sqlHolds: CreditHoldPort<PostgresTaskClient> = {
  async place(tx, input) {
    const inserted = await tx.query('INSERT INTO test_holds VALUES ($1, $2, $3, \'HELD\') ON CONFLICT DO NOTHING RETURNING "id"',
      [input.holdId, input.ownerId, input.amount]);
    if (!inserted.rows.length) return;
    const debited = await tx.query('UPDATE test_wallets SET "balance" = "balance" - $2, "frozen" = "frozen" + $2 WHERE "owner" = $1 AND "balance" >= $2 RETURNING "owner"',
      [input.ownerId, input.amount]);
    if (!debited.rows.length) throw new AITaskInsufficientCreditsError(input.amount);
    await tx.query('INSERT INTO test_hold_events VALUES ($1, \'place\')', [input.holdId]);
  },
  async confirm(tx, input) {
    const held = await tx.query<{ amount: number }>('UPDATE test_holds SET "status" = \'CONFIRMED\' WHERE "id" = $1 AND "status" = \'HELD\' RETURNING "amount"', [input.holdId]);
    if (!held.rows[0]) return;
    await tx.query('UPDATE test_wallets SET "frozen" = "frozen" - $2 WHERE "owner" = $1', [input.ownerId, held.rows[0].amount]);
    await tx.query('INSERT INTO test_hold_events VALUES ($1, \'confirm\')', [input.holdId]);
  },
  async release(tx, input) {
    const held = await tx.query<{ amount: number }>('UPDATE test_holds SET "status" = \'RELEASED\' WHERE "id" = $1 AND "status" = \'HELD\' RETURNING "amount"', [input.holdId]);
    if (!held.rows[0]) return;
    await tx.query('UPDATE test_wallets SET "frozen" = "frozen" - $2, "balance" = "balance" + $2 WHERE "owner" = $1', [input.ownerId, held.rows[0].amount]);
    await tx.query('INSERT INTO test_hold_events VALUES ($1, \'release\')', [input.holdId]);
  },
};

describeWithPostgres('AITaskService PostgreSQL contract', () => {
  let pool: Pool;
  let schema: string;
  const stored = new Map<string, Buffer>();

  beforeEach(async () => {
    schema = `zucker_ai_tasks_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 20, options: `-c search_path="${schema}"` });
    await pool.query(postgresTaskTestSchemaSql);
    await pool.query(AI_TASKS_POSTGRESQL_SCHEMA);
    await pool.query(WALLET_SQL);
    stored.clear();
  });

  afterEach(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  async function wallet(owner: string, balance: number) {
    await pool.query('INSERT INTO test_wallets VALUES ($1, $2, 0)', [owner, balance]);
  }
  async function balances(owner: string) {
    return (await pool.query('SELECT "balance", "frozen" FROM test_wallets WHERE "owner" = $1', [owner])).rows[0];
  }
  async function holdEvents() {
    return (await pool.query('SELECT "action" FROM test_hold_events ORDER BY "action"')).rows.map((row) => row.action);
  }

  function service(provider: FakeMediaProvider, overrides: Partial<AITaskServiceOptions<PostgresTaskClient>> = {}) {
    return new AITaskService<PostgresTaskClient>({
      transactions: {
        async runInTransaction(work) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await work(adapt(client));
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      },
      holds: sqlHolds,
      costs: { resolve: () => 5 },
      outputs: { async put(output) { const key = `mem/${output.taskId}/${output.index}`; stored.set(key, output.body); return { storageKey: key }; } },
      providers: { resolve: () => ({ provider, config: { apiKey: 'synthetic-key' } }) },
      polling: { initialDelayMs: 20, maxDelayMs: 50, wakeCheckIntervalMs: 20 },
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      ...overrides,
    });
  }

  function runtime(aiTasks: AITaskService<PostgresTaskClient>) {
    return new DurableWorkerRuntime<AITaskPayload, AITaskExecution>({
      repository: new PostgresTaskRepository(adapt(pool)),
      resolveHandler: (task) => (task.kind === 'ai.media' ? aiTasks.handler : undefined),
      retryPolicy: new ExponentialTaskRetryPolicy(),
      classifyError: () => ({ code: 'INTERNAL', category: 'INTERNAL', summary: 'internal', retryable: false }),
      workerId: 'wp22-worker',
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
    });
  }

  const command = (key = 'key-0000000001') => ({
    ownerId: 'user-1', kind: 'image' as const, providerId: 'fake-media', model: 'fake-image',
    input: { prompt: 'a red square', options: { width: 64 } }, idempotencyKey: key,
  });

  async function statuses(ids: readonly string[]) {
    const rows = (await pool.query('SELECT "id", "status"::text AS status FROM async_jobs WHERE "id" = ANY($1::text[])', [[...ids]])).rows;
    return new Map(rows.map((row) => [row.id as string, row.status as string]));
  }

  /** One worker (concurrency 1), like a host: run whatever is due, until `done` or the timeout. */
  async function drive(aiTasks: AITaskService<PostgresTaskClient>, done: () => Promise<boolean>, timeoutMs = 10_000) {
    const worker = runtime(aiTasks);
    const repository = new PostgresTaskRepository(adapt(pool));
    const stopAt = Date.now() + timeoutMs;
    while (Date.now() < stopAt) {
      if (await done()) return;
      const ready = await repository.findReadyQueued({ now: new Date(), limit: 1, includeRetrying: true });
      if (!ready.length) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
      try {
        await worker.run(ready[0].id);
      } catch (error) {
        if (!(error instanceof DurableTaskRetryScheduledError || error instanceof DurableTaskNotClaimableError)) throw error;
      }
    }
    throw new Error('drive timed out');
  }
  const terminal = (ids: string[]) => async () => [...(await statuses(ids)).values()].every((status) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status));
  /** Runs exactly the due work once (used to stop right after a deferral). */
  async function runDueOnce(aiTasks: AITaskService<PostgresTaskClient>) {
    const ready = await new PostgresTaskRepository(adapt(pool)).findReadyQueued({ now: new Date(), limit: 10, includeRetrying: true });
    for (const task of ready) {
      await runtime(aiTasks).run(task.id).catch((error) => {
        if (!(error instanceof DurableTaskRetryScheduledError || error instanceof DurableTaskNotClaimableError)) throw error;
      });
    }
    return ready.length;
  }

  it('completes, re-hosts the output and confirms the hold once', async () => {
    await wallet('user-1', 10);
    const provider = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 1 } });
    const aiTasks = service(provider);
    const { task, created } = await aiTasks.submitAndWake(command());
    expect(created).toBe(true);
    expect(task).toMatchObject({ status: 'QUEUED', cost: 5, charge: 'HELD' });
    expect(await balances('user-1')).toEqual({ balance: 5, frozen: 5 });

    await drive(aiTasks, terminal([task.id]));
    const view = await aiTasks.get('user-1', task.id);
    expect(view).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED', outputs: [{ index: 0, contentType: 'image/png' }] });
    expect(await balances('user-1')).toEqual({ balance: 5, frozen: 0 });
    expect(await holdEvents()).toEqual(['confirm', 'place']);
    expect(stored.get(`mem/${task.id}/0`)?.equals(PNG)).toBe(true);
    expect(await aiTasks.get('user-2', task.id)).toBeNull();
  });

  it('rolls the whole submission back when credits are insufficient', async () => {
    await wallet('user-1', 2);
    const aiTasks = service(new FakeMediaProvider());
    await expect(aiTasks.submitAndWake(command())).rejects.toBeInstanceOf(AITaskInsufficientCreditsError);
    for (const table of ['async_jobs', 'async_job_outbox', 'ai_tasks', 'test_holds']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect(await balances('user-1')).toEqual({ balance: 2, frozen: 0 });
  });

  it('releases the hold when the provider fails', async () => {
    await wallet('user-1', 10);
    const aiTasks = service(new FakeMediaProvider({ defaultStep: { outcome: 'failure' } }));
    const { task } = await aiTasks.submitAndWake(command());
    await drive(aiTasks, terminal([task.id]));
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'FAILED', charge: 'RELEASED', error: { code: 'AI_PROVIDER_FAILED' } });
    expect(await balances('user-1')).toEqual({ balance: 10, frozen: 0 });
  });

  it('settles duplicate verified callbacks exactly once', async () => {
    await wallet('user-1', 10);
    const provider = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 10_000 } });
    const verifier: AITaskCallbackVerifier = {
      verify: async (rawBody) => {
        const { taskId } = JSON.parse(String(rawBody)) as { taskId: string };
        return { providerTaskId: taskId, task: { taskId, status: 'COMPLETED', outputs: [{ url: 'https://cdn.example.test/a.png' }] } };
      },
    };
    const aiTasks = service(provider, {
      callbacks: { resolve: (id) => (id === 'fake-media' ? verifier : undefined) },
      polling: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    const { task } = await aiTasks.submitAndWake(command());
    expect(await runDueOnce(aiTasks)).toBe(1);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'WAITING_PROVIDER', charge: 'HELD' });
    const providerTaskId = (await pool.query('SELECT "providerTaskId" FROM ai_tasks')).rows[0].providerTaskId;
    const body = JSON.stringify({ taskId: providerTaskId });
    const results = await Promise.all(Array.from({ length: 5 }, () => aiTasks.handleCallback('fake-media', body, {})));
    expect(results.every((result) => result.verified)).toBe(true);
    await drive(aiTasks, terminal([task.id]));
    expect((await statuses([task.id])).get(task.id)).toBe('COMPLETED');
    expect(provider.calls.filter((call) => call.method === 'getTaskStatus')).toHaveLength(0);
    expect(await aiTasks.handleCallback('fake-media', body, {})).toMatchObject({ verified: true, action: 'none' });
    expect(await holdEvents()).toEqual(['confirm', 'place']);
    expect(await balances('user-1')).toEqual({ balance: 5, frozen: 0 });
  });

  it('ignores a forged success callback except for one rate-limited early poll', async () => {
    await wallet('user-1', 10);
    const provider = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 10_000 } });
    const fake = new FakeCallbackVerifier();
    const aiTasks = service(provider, {
      callbacks: { resolve: () => fake },
      polling: { initialDelayMs: 60_000, maxDelayMs: 60_000, earlyPollMinIntervalMs: 10_000 },
    });
    const { task } = await aiTasks.submitAndWake(command());
    expect(await runDueOnce(aiTasks)).toBe(1);
    const providerTaskId = (await pool.query('SELECT "providerTaskId" FROM ai_tasks')).rows[0].providerTaskId;
    const forged = JSON.stringify({ taskId: providerTaskId, status: 'COMPLETED', outputs: [{ url: 'https://evil.example.test/x.png' }] });
    const before = (await pool.query('SELECT "callbackOutcome", "holdState", "pollCount" FROM ai_tasks')).rows[0];

    expect(await aiTasks.handleCallback('fake-media', forged, { 'x-fake-signature': 'forged' }))
      .toEqual({ providerKnown: true, verified: false, action: 'poll-scheduled' });
    for (let i = 0; i < 5; i += 1) {
      expect((await aiTasks.handleCallback('fake-media', forged, { 'x-fake-signature': 'forged' })).action).toBe('none');
    }
    expect(await runDueOnce(aiTasks)).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      expect((await aiTasks.handleCallback('fake-media', forged, { 'x-fake-signature': 'forged' })).action).toBe('none');
      expect(await runDueOnce(aiTasks)).toBe(0);
    }
    expect(provider.calls.filter((call) => call.method === 'getTaskStatus')).toHaveLength(1);
    const after = (await pool.query('SELECT "callbackOutcome", "holdState", "pollCount" FROM ai_tasks')).rows[0];
    expect(after).toEqual({ ...before, pollCount: before.pollCount + 1 });
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'WAITING_PROVIDER', charge: 'HELD', outputs: [] });

    expect(await aiTasks.cancelOwned('user-2', task.id)).toBeNull();
    expect(await aiTasks.cancelOwned('user-1', task.id)).toMatchObject({ status: 'CANCELLED', charge: 'RELEASED' });
    expect(await balances('user-1')).toEqual({ balance: 10, frozen: 0 });
    expect(stored.size).toBe(0);
  });

  it('does not let long provider waits starve a short task on one worker', async () => {
    await wallet('user-1', 100);
    const provider = new FakeMediaProvider({
      script: [{ pollsUntilDone: 10_000 }, { pollsUntilDone: 10_000 }, { pollsUntilDone: 10_000 }],
      defaultStep: { pollsUntilDone: 0 },
    });
    const aiTasks = service(provider, { polling: { initialDelayMs: 50, maxDelayMs: 100 } });
    const long = [];
    for (let i = 0; i < 3; i += 1) {
      long.push((await aiTasks.submitAndWake({ ...command(`long-key-000${i}`), kind: 'video', model: 'fake-video' })).task.id);
    }
    // Let the long tasks start waiting before the short one arrives.
    await drive(aiTasks, async () => (await Promise.all(long.map((id) => aiTasks.get('user-1', id))))
      .every((view) => view?.status === 'WAITING_PROVIDER'));
    const short = (await aiTasks.submitAndWake(command('short-key-0001'))).task.id;
    const started = Date.now();
    await drive(aiTasks, terminal([short]), 5_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await aiTasks.get('user-1', short)).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED' });
    for (const id of long) expect(await aiTasks.get('user-1', id)).toMatchObject({ status: 'WAITING_PROVIDER', charge: 'HELD' });
    // No lease is held while waiting.
    expect((await pool.query('SELECT count(*)::int AS n FROM async_jobs WHERE "leaseToken" IS NOT NULL')).rows[0].n).toBe(0);
    const budget = (await pool.query('SELECT "maxAttempts" FROM async_jobs WHERE "id" = $1', [long[0]])).rows[0].maxAttempts;
    expect(budget).toBeGreaterThan(10);
  });

  it('rejects terminal writes from an expired lease', async () => {
    await wallet('user-1', 10);
    const aiTasks = service(new FakeMediaProvider());
    const { task } = await aiTasks.submitAndWake(command());
    const repository = new PostgresTaskRepository<AITaskPayload, AITaskExecution>(adapt(pool));
    const now = new Date();
    const claimed = await repository.claim({ id: task.id, workerId: 'stale', leaseToken: 'stale-token', leaseExpiresAt: new Date(now.getTime() + 100), now });
    expect(claimed).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const context = { task: claimed!, leaseToken: 'stale-token', signal: new AbortController().signal } as DurableTaskAttemptContext<AITaskPayload, AITaskExecution>;
    const result: AITaskExecution = { outputs: [{ taskId: task.id, index: 0, storageKey: 'k', contentType: 'image/png', bytes: 1, sha256: 'x' }] };
    expect(await aiTasks.handler.complete!(context, result)).toBe(false);
    expect(await aiTasks.handler.fail!(context, { code: 'X', category: 'INTERNAL', summary: 'x', retryable: false })).toBe(false);
    expect(await aiTasks.store.updateFenced(adapt(pool), { id: task.id, leaseToken: 'stale-token', now: new Date(), providerTaskId: 'p-1' })).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM ai_task_outputs')).rows[0].n).toBe(0);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'PROCESSING', charge: 'HELD' });
  });

  it('creates one task and one hold for concurrent submissions with the same key', async () => {
    await wallet('user-1', 100);
    const aiTasks = service(new FakeMediaProvider());
    const results = await Promise.all(Array.from({ length: 10 }, () => aiTasks.submitAndWake(command('same-key-123'))));
    expect(new Set(results.map((result) => result.task.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM test_holds')).rows[0].n).toBe(1);
    expect(await balances('user-1')).toEqual({ balance: 95, frozen: 5 });
    // Another owner with the same key gets its own task.
    await wallet('user-2', 100);
    const other = await aiTasks.submitAndWake({ ...command('same-key-123'), ownerId: 'user-2' });
    expect(other.task.id).not.toBe(results[0].task.id);
    await expect(aiTasks.submitAndWake({ ...command('same-key-123'), input: { prompt: 'different' } })).rejects.toMatchObject({ code: 'AI_TASK_IDEMPOTENCY_CONFLICT' });
  });
});
