// @vitest-environment node
import { Pool, type PoolClient } from 'pg';
import { FAKE_PNG_BASE64, FakeCallbackVerifier, FakeMediaProvider } from '@zucker-framework/ai/testing';
import {
  TaskLeaseReconciler,
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


const SENTINEL_KEY = 'SENTINEL-API-KEY-7f3a';
const SENTINEL_RAW = 'SENTINEL-RAW-PROVIDER-ERROR-91bc';

describeWithPostgres('AITaskService launch gates (PostgreSQL)', () => {
  let pool: Pool;
  let schema: string;
  const stored = new Map<string, Buffer>();

  beforeEach(async () => {
    schema = `zucker_ai_gates_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 30, options: `-c search_path="${schema}"` });
    await pool.query(postgresTaskTestSchemaSql);
    await pool.query(AI_TASKS_POSTGRESQL_SCHEMA);
    await pool.query(WALLET_SQL);
    stored.clear();
  });
  afterEach(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  const wallet = (owner: string, balance: number) => pool.query('INSERT INTO test_wallets VALUES ($1, $2, 0)', [owner, balance]);
  const balances = async (owner: string) => (await pool.query('SELECT "balance", "frozen" FROM test_wallets WHERE "owner" = $1', [owner])).rows[0];
  const events = async (holdId?: string) => (await pool.query(
    holdId ? 'SELECT "action" FROM test_hold_events WHERE "holdId" = $1 ORDER BY "action"' : 'SELECT "action" FROM test_hold_events ORDER BY "action"',
    holdId ? [holdId] : [])).rows.map((row) => row.action as string);

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
      providers: { resolve: () => ({ provider, config: { apiKey: SENTINEL_KEY } }) },
      polling: { initialDelayMs: 20, maxDelayMs: 50 },
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      ...overrides,
    });
  }

  function runtime(aiTasks: AITaskService<PostgresTaskClient>, workerId = 'gates-worker') {
    return new DurableWorkerRuntime<AITaskPayload, AITaskExecution>({
      repository: new PostgresTaskRepository(adapt(pool)),
      resolveHandler: (task) => (task.kind === 'ai.media' ? aiTasks.handler : undefined),
      retryPolicy: new ExponentialTaskRetryPolicy(),
      classifyError: () => ({ code: 'INTERNAL', category: 'INTERNAL', summary: 'internal', retryable: false }),
      workerId,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
    });
  }
  const benign = (error: unknown) => {
    if (!(error instanceof DurableTaskRetryScheduledError || error instanceof DurableTaskNotClaimableError)) throw error;
  };

  const command = (key: string, owner = 'user-1') => ({
    ownerId: owner, kind: 'image' as const, providerId: 'fake-media', model: 'fake-image',
    input: { prompt: 'a red square' }, idempotencyKey: key,
  });
  const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
  async function status(id: string) {
    return (await pool.query('SELECT "status"::text AS status FROM async_jobs WHERE "id" = $1', [id])).rows[0].status as string;
  }
  async function drive(aiTasks: AITaskService<PostgresTaskClient>, ids: string[], timeoutMs = 10_000) {
    const worker = runtime(aiTasks);
    const repository = new PostgresTaskRepository(adapt(pool));
    const stopAt = Date.now() + timeoutMs;
    while (Date.now() < stopAt) {
      const states = await Promise.all(ids.map(status));
      if (states.every((state) => terminalStates.includes(state))) return;
      const ready = await repository.findReadyQueued({ now: new Date(), limit: 1, includeRetrying: true });
      if (!ready.length) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
      await worker.run(ready[0].id).catch(benign);
    }
    throw new Error('drive timed out');
  }
  async function runDueOnce(aiTasks: AITaskService<PostgresTaskClient>) {
    const ready = await new PostgresTaskRepository(adapt(pool)).findReadyQueued({ now: new Date(), limit: 10, includeRetrying: true });
    for (const task of ready) await runtime(aiTasks).run(task.id).catch(benign);
    return ready.length;
  }

  it('gate 1: another user can neither read, cancel, download nor list a task (null/empty)', async () => {
    await wallet('user-1', 50);
    const aiTasks = service(new FakeMediaProvider());
    const { task } = await aiTasks.submitAndWake(command('cross-user-01'));
    await drive(aiTasks, [task.id]);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'COMPLETED' });
    expect(await aiTasks.findOutput('user-1', task.id, 0)).not.toBeNull();
    expect(await aiTasks.get('user-2', task.id)).toBeNull();
    expect(await aiTasks.cancelOwned('user-2', task.id)).toBeNull();
    expect(await aiTasks.findOutput('user-2', task.id, 0)).toBeNull();
    expect(await aiTasks.findOutput('user-1', task.id, 1)).toBeNull();
    expect((await aiTasks.list('user-2', { limit: 10 })).items).toEqual([]);
    expect(await aiTasks.get('user-1', 'does-not-exist')).toBeNull();
    // A foreign cancel must not have touched the settled task or the wallet.
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED' });
    expect(await balances('user-1')).toEqual({ balance: 45, frozen: 0 });
    // Same idempotency key from another owner is a separate task and never returns the first owner's.
    await wallet('user-2', 50);
    const theirs = await aiTasks.submitAndWake(command('cross-user-01', 'user-2'));
    expect(theirs.task.id).not.toBe(task.id);
    expect(theirs.created).toBe(true);
  });

  it('gate 6: concurrent different keys with a balance for only some succeed exactly as often as affordable', async () => {
    await wallet('user-1', 12);
    const aiTasks = service(new FakeMediaProvider());
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => aiTasks.submitAndWake(command(`diff-key-${i}-xyz`))));
    const ok = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(8);
    expect(failed.every((result) => result.reason instanceof AITaskInsufficientCreditsError)).toBe(true);
    expect(await balances('user-1')).toEqual({ balance: 2, frozen: 10 });
    for (const table of ['async_jobs', 'ai_tasks', 'test_holds']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(2);
    }
    expect(await events()).toEqual(['place', 'place']);
  });

  it('gate 6: 10 concurrent submits with one key leave one task and one hold, also across a price change', async () => {
    await wallet('user-1', 100);
    let price = 5;
    const aiTasks = service(new FakeMediaProvider(), { costs: { resolve: () => price } });
    const first = await aiTasks.submitAndWake(command('idem-key-aaa'));
    price = 7;
    const rest = await Promise.all(Array.from({ length: 9 }, () => aiTasks.submitAndWake(command('idem-key-aaa'))));
    const all = [first, ...rest];
    expect(new Set(all.map((entry) => entry.task.id)).size).toBe(1);
    expect(all.filter((entry) => entry.created)).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM test_holds')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM async_jobs')).rows[0].n).toBe(1);
    expect(await balances('user-1')).toEqual({ balance: 95, frozen: 5 });
  });

  it('cancel racing completion settles the hold exactly once (CONFIRMED xor RELEASED)', async () => {
    await wallet('user-1', 1000);
    const aiTasks = service(new FakeMediaProvider({ defaultStep: { pollsUntilDone: 0 } }));
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round += 1) {
      const { task } = await aiTasks.submitAndWake(command(`race-key-${round}-ab`));
      const worker = runtime(aiTasks);
      await Promise.all([
        worker.run(task.id).catch(benign),
        new Promise((resolve) => setTimeout(resolve, round * 3)).then(() => aiTasks.cancelOwned('user-1', task.id)),
      ]);
      // A cancel that lost the race may leave a completed task; a cancel that won leaves no output.
      await drive(aiTasks, [task.id]);
      const view = (await aiTasks.get('user-1', task.id))!;
      const holdId = (await pool.query('SELECT "holdId" FROM ai_tasks WHERE "id" = $1', [task.id])).rows[0]?.holdId as string | undefined;
      const log = holdId ? await events(holdId) : [];
      outcomes.add(view.status);
      if (view.status === 'COMPLETED') {
        expect(view.charge).toBe('CONFIRMED');
        expect(log).toEqual(['confirm', 'place']);
      } else {
        expect(view.status).toBe('CANCELLED');
        expect(view.charge).toBe('RELEASED');
        expect(log).toEqual(['place', 'release']);
        expect(view.outputs).toEqual([]);
      }
    }
    const state = await balances('user-1');
    expect(state.frozen).toBe(0);
    expect(state.balance).toBeGreaterThanOrEqual(0);
    const confirmed = (await events()).filter((action) => action === 'confirm').length;
    expect(state.balance).toBe(1000 - confirmed * 5);
    expect([...outcomes].length).toBeGreaterThan(0);
  });

  it('lease loss while waiting: expired lease is requeued and the next run resumes the same provider task', async () => {
    await wallet('user-1', 10);
    const provider = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 1 } });
    const aiTasks = service(provider);
    const { task } = await aiTasks.submitAndWake(command('lease-loss-01'));
    expect(await runDueOnce(aiTasks)).toBe(1);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'WAITING_PROVIDER', charge: 'HELD' });
    const providerTaskId = (await pool.query('SELECT "providerTaskId" FROM ai_tasks')).rows[0].providerTaskId;
    expect(providerTaskId).toBeTruthy();
    // A worker claims the due poll and dies: lease expires with nothing written.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const repository = new PostgresTaskRepository<AITaskPayload, AITaskExecution>(adapt(pool));
    const now = new Date();
    const claimed = await repository.claim({ id: task.id, workerId: 'dead', leaseToken: 'dead-token', leaseExpiresAt: new Date(now.getTime() + 50), now });
    expect(claimed).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const reconciled = await new TaskLeaseReconciler(repository).runOnce();
    expect(reconciled).toMatchObject({ found: 1, requeued: 1, failed: 0 });
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ charge: 'HELD' });
    await drive(aiTasks, [task.id]);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED' });
    expect(provider.calls.filter((call) => call.method === 'generate')).toHaveLength(1);
    expect((await pool.query('SELECT "providerTaskId" FROM ai_tasks')).rows[0].providerTaskId).toBe(providerTaskId);
    expect(await events()).toEqual(['confirm', 'place']);
    expect(await balances('user-1')).toEqual({ balance: 5, frozen: 0 });
  });

  it('deadline timeout fails the task and releases the hold', async () => {
    await wallet('user-1', 10);
    const provider = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 100_000 } });
    const aiTasks = service(provider, { polling: { initialDelayMs: 10, maxDelayMs: 20, maxWaitMs: { image: 150 } } });
    const { task } = await aiTasks.submitAndWake(command('deadline-001'));
    await drive(aiTasks, [task.id]);
    const view = await aiTasks.get('user-1', task.id);
    expect(view).toMatchObject({ status: 'FAILED', charge: 'RELEASED', outputs: [] });
    expect(view!.error?.code).toBeTruthy();
    expect(await balances('user-1')).toEqual({ balance: 10, frozen: 0 });
    expect(await events()).toEqual(['place', 'release']);
    expect(stored.size).toBe(0);
  });

  it('gate 2: forged, unsigned and replayed callbacks change nothing', async () => {
    await wallet('user-1', 10);
    const provider = new FakeMediaProvider({ defaultStep: { pollsUntilDone: 1 } });
    const fake = new FakeCallbackVerifier();
    const aiTasks = service(provider, {
      callbacks: { resolve: (id) => (id === 'fake-media' ? fake : undefined) },
      polling: { initialDelayMs: 60_000, maxDelayMs: 60_000, earlyPollMinIntervalMs: 60_000 },
    });
    const { task } = await aiTasks.submitAndWake(command('callback-gate1'));
    expect(await runDueOnce(aiTasks)).toBe(1);
    const providerTaskId = (await pool.query('SELECT "providerTaskId" FROM ai_tasks')).rows[0].providerTaskId as string;
    const snapshot = async () => (await pool.query('SELECT "callbackOutcome", "holdState", "pollCount", "providerTaskId" FROM ai_tasks')).rows[0];
    const before = await snapshot();
    const body = JSON.stringify({ taskId: providerTaskId, status: 'COMPLETED', outputs: [{ url: 'https://evil.example.test/x.png' }] });

    // Unknown provider, missing header, wrong token, garbage body, other task id.
    expect(await aiTasks.handleCallback('nobody', body, {})).toMatchObject({ providerKnown: false, verified: false });
    expect(await aiTasks.handleCallback('fake-media', body, {})).toMatchObject({ verified: false });
    expect(await aiTasks.handleCallback('fake-media', body, { 'x-fake-signature': 'nope' })).toMatchObject({ verified: false });
    expect(await aiTasks.handleCallback('fake-media', 'not json', { 'x-fake-signature': 'valid' })).toMatchObject({ verified: false, action: 'none' });
    expect(await aiTasks.handleCallback('fake-media', '{"taskId":"someone-elses-task"}', { 'x-fake-signature': 'valid' })).toMatchObject({ action: 'none' });
    await runDueOnce(aiTasks);
    const after = await snapshot();
    expect(after.callbackOutcome).toEqual(before.callbackOutcome);
    expect(after.holdState).toBe('HELD');
    expect(after.providerTaskId).toBe(providerTaskId);
    expect(stored.size).toBe(0);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'WAITING_PROVIDER', charge: 'HELD', outputs: [] });

    // A signed callback (fake verifier carries no outcome) is still just a wake-up; finish by poll, then replay it.
    await aiTasks.handleCallback('fake-media', body, { 'x-fake-signature': 'valid' });
    await drive(aiTasks, [task.id]);
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED' });
    const outputsKeys = [...stored.keys()];
    const settled = await events();
    for (let i = 0; i < 3; i += 1) {
      expect(await aiTasks.handleCallback('fake-media', body, { 'x-fake-signature': 'valid' })).toMatchObject({ action: 'none' });
      expect(await aiTasks.handleCallback('fake-media', body, { 'x-fake-signature': 'forged' })).toMatchObject({ verified: false, action: 'none' });
    }
    expect(await runDueOnce(aiTasks)).toBe(0);
    expect(await events()).toEqual(settled);
    expect([...stored.keys()]).toEqual(outputsKeys);
    expect(await balances('user-1')).toEqual({ balance: 5, frozen: 0 });
    // The forged URL was never fetched or stored.
    expect(stored.get(`mem/${task.id}/0`)?.equals(PNG)).toBe(true);
  });

  it('projections truncate prompts and never expose provider payloads, ids or secrets', async () => {
    await wallet('user-1', 50);
    const provider = new FakeMediaProvider({
      script: [{}, { outcome: 'failure', error: SENTINEL_RAW }],
      defaultStep: { outputKind: 'url' },
    });
    const aiTasks = service(provider, {
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const longPrompt = `${'p'.repeat(100)}${'TAIL-OF-PROMPT'.repeat(200)}`;
    const ok = await aiTasks.submitAndWake({ ...command('proj-key-001'), input: { prompt: longPrompt } });
    const bad = await aiTasks.submitAndWake(command('proj-key-002'));
    await drive(aiTasks, [ok.task.id, bad.task.id]);
    const holdIds = (await pool.query('SELECT "holdId" FROM ai_tasks')).rows.map((row) => row.holdId as string).filter(Boolean);
    const providerIds = (await pool.query('SELECT "providerTaskId" FROM ai_tasks')).rows.map((row) => row.providerTaskId as string).filter(Boolean);
    const keys = [...stored.keys()];

    const management = await aiTasks.listForManagement({ promptLimit: 60 });
    expect(management.items).toHaveLength(2);
    const long = management.items.find((item) => item.id === ok.task.id)!;
    expect(long.prompt.length).toBeLessThanOrEqual(61);
    expect(long.prompt).not.toContain('TAIL-OF-PROMPT');
    expect((await aiTasks.getForManagement(ok.task.id, 60))!.prompt.length).toBeLessThanOrEqual(61);
    expect((await aiTasks.getForManagement(ok.task.id))!.prompt.length).toBeLessThanOrEqual(201);

    const surfaces = [
      JSON.stringify(management),
      JSON.stringify(await aiTasks.getForManagement(bad.task.id)),
      JSON.stringify(await aiTasks.get('user-1', ok.task.id)),
      JSON.stringify(await aiTasks.get('user-1', bad.task.id)),
      JSON.stringify(await aiTasks.list('user-1', { limit: 10 })),
      JSON.stringify(ok.task),
    ];
    for (const text of surfaces) {
      expect(text).not.toContain(SENTINEL_KEY);
      expect(text).not.toContain(SENTINEL_RAW);
      expect(text).not.toContain('fake-media.invalid');
      expect(text).not.toMatch(/storageKey|providerTaskId|holdId|sha256/);
      for (const secret of [...holdIds, ...providerIds, ...keys]) expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(await aiTasks.get('user-1', bad.task.id))).toContain('FAILED');
    // Nothing the provider saw as config was recorded with the key, and the key is not in the DB payloads.
    expect(JSON.stringify(provider.calls)).not.toContain(SENTINEL_KEY);
    const stash = JSON.stringify((await pool.query('SELECT * FROM async_jobs')).rows) + JSON.stringify((await pool.query('SELECT * FROM ai_tasks')).rows);
    expect(stash).not.toContain(SENTINEL_KEY);
  });
});
