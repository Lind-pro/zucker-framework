// @vitest-environment node
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { FakeMediaProvider } from '@zucker-framework/ai/testing';
import {
  DurableTaskNotClaimableError,
  DurableTaskRetryScheduledError,
  DurableWorkerRuntime,
  ExponentialTaskRetryPolicy,
  PostgresTaskRepository,
  type PostgresTaskClient,
} from '@zucker-framework/task';
import { postgresTaskTestSchemaSql } from '../../task/src/postgres-test-schema';
import { AITaskService, type AITaskExecution } from './ai-task.service';
import { AITaskInsufficientCreditsError } from './errors';
import type { CreditHoldPort, OutputStorePort } from './ports';
import { AI_TASKS_POSTGRESQL_SCHEMA } from './schema';
import type { AITaskPayload } from './types';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const MiB = 1024 * 1024;

const WALLET_SQL = `
  CREATE TYPE async_job_outbox_status AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED');
  CREATE TABLE async_job_outbox (
    "id" text PRIMARY KEY, "taskId" text NOT NULL REFERENCES async_jobs("id") ON DELETE CASCADE, "topic" text NOT NULL,
    "payload" jsonb NOT NULL, "status" async_job_outbox_status NOT NULL DEFAULT 'PENDING', "attempt" integer NOT NULL DEFAULT 0,
    "availableAt" timestamptz NOT NULL, "workerId" text, "leaseToken" text, "leaseExpiresAt" timestamptz, "publishedAt" timestamptz,
    "lastError" text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
  );
  CREATE TABLE test_wallets ("owner" text PRIMARY KEY, "balance" integer NOT NULL, "frozen" integer NOT NULL);
  CREATE TABLE test_holds ("id" text PRIMARY KEY, "owner" text NOT NULL, "amount" integer NOT NULL, "status" text NOT NULL);
`;

const adapt = (client: PoolClient | Pool): PostgresTaskClient =>
  ({ query: async (sql, values) => ({ rows: (await client.query(sql, values ? [...values] : [])).rows }) });

const holds: CreditHoldPort<PostgresTaskClient> = {
  async place(tx, input) {
    await tx.query('INSERT INTO test_holds VALUES ($1, $2, $3, \'HELD\')', [input.holdId, input.ownerId, input.amount]);
    const debited = await tx.query('UPDATE test_wallets SET "balance" = "balance" - $2, "frozen" = "frozen" + $2 WHERE "owner" = $1 AND "balance" >= $2 RETURNING "owner"',
      [input.ownerId, input.amount]);
    if (!debited.rows.length) throw new AITaskInsufficientCreditsError(input.amount);
  },
  async confirm(tx, input) {
    const held = await tx.query<{ amount: number }>('UPDATE test_holds SET "status" = \'CONFIRMED\' WHERE "id" = $1 AND "status" = \'HELD\' RETURNING "amount"', [input.holdId]);
    if (held.rows[0]) await tx.query('UPDATE test_wallets SET "frozen" = "frozen" - $2 WHERE "owner" = $1', [input.ownerId, held.rows[0].amount]);
  },
  async release(tx, input) {
    const held = await tx.query<{ amount: number }>('UPDATE test_holds SET "status" = \'RELEASED\' WHERE "id" = $1 AND "status" = \'HELD\' RETURNING "amount"', [input.holdId]);
    if (held.rows[0]) await tx.query('UPDATE test_wallets SET "frozen" = "frozen" - $2, "balance" = "balance" + $2 WHERE "owner" = $1', [input.ownerId, held.rows[0].amount]);
  },
};

/** Synthetic MP4: an `ftyp` header followed by filler, produced chunk by chunk (never held whole). */
function syntheticVideo(totalBytes: number, declareLength: boolean): { response: Response; sha256: string } {
  const header = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
  const chunk = Buffer.alloc(MiB, 7);
  const hash = createHash('sha256');
  let sent = 0;
  const pieces = (): Buffer | null => {
    if (sent >= totalBytes) return null;
    const source = sent === 0 ? Buffer.concat([header, chunk]) : chunk;
    const piece = source.subarray(0, Math.min(source.length, totalBytes - sent));
    sent += piece.length;
    return piece;
  };
  // Pre-compute the digest the same way without keeping the bytes.
  for (let total = 0, first = true; total < totalBytes; first = false) {
    const source = first ? Buffer.concat([header, chunk]) : chunk;
    const piece = source.subarray(0, Math.min(source.length, totalBytes - total));
    hash.update(piece);
    total += piece.length;
  }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces();
      if (piece) controller.enqueue(new Uint8Array(piece));
      else controller.close();
    },
  });
  const headers: Record<string, string> = { 'content-type': 'video/mp4' };
  if (declareLength) headers['content-length'] = String(totalBytes);
  return { response: new Response(body, { status: 200, headers }), sha256: hash.digest('hex') };
}

describeWithPostgres('AITaskService output size cap and streaming store (PostgreSQL)', () => {
  let pool: Pool;
  let schema: string;

  beforeEach(async () => {
    schema = `zucker_ai_cap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, max: 10, options: `-c search_path="${schema}"` });
    await pool.query(postgresTaskTestSchemaSql);
    await pool.query(AI_TASKS_POSTGRESQL_SCHEMA);
    await pool.query(WALLET_SQL);
    await pool.query('INSERT INTO test_wallets VALUES ($1, $2, 0)', ['user-1', 100]);
  });
  afterEach(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  /** Streaming store that never buffers: it hashes/counts what it reads and records aborted (partial) writes. */
  function streamingStore() {
    const objects = new Map<string, { bytes: number; sha256: string }>();
    const aborted: string[] = [];
    let putCalls = 0;
    const port: OutputStorePort = {
      async put() { throw new Error('buffered put must not be used when putStream exists'); },
      async putStream(output) {
        putCalls += 1;
        const key = `mem/${output.taskId}/${output.index}`;
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          for await (const chunk of output.stream) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
        } catch (error) {
          aborted.push(key); // a real store deletes the partial object here
          throw error;
        }
        const object = { bytes, sha256: hash.digest('hex') };
        objects.set(key, object);
        return { storageKey: key, ...object };
      },
    };
    return { port, objects, aborted, calls: () => putCalls };
  }

  async function runToEnd(aiTasks: AITaskService<PostgresTaskClient>, id: string) {
    const runtime = new DurableWorkerRuntime<AITaskPayload, AITaskExecution>({
      repository: new PostgresTaskRepository(adapt(pool)),
      resolveHandler: () => aiTasks.handler,
      retryPolicy: new ExponentialTaskRetryPolicy(),
      classifyError: () => ({ code: 'INTERNAL', category: 'INTERNAL', summary: 'internal', retryable: false }),
      workerId: 'cap-worker', leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000,
    });
    const stopAt = Date.now() + 60_000;
    while (Date.now() < stopAt) {
      const status = (await pool.query('SELECT "status"::text AS s FROM async_jobs WHERE "id" = $1', [id])).rows[0].s as string;
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) return status;
      await runtime.run(id).catch((error) => {
        if (!(error instanceof DurableTaskRetryScheduledError || error instanceof DurableTaskNotClaimableError)) throw error;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('task did not finish');
  }

  function service(store: OutputStorePort, video: () => Response, maxBytes = 200 * MiB) {
    const provider = new FakeMediaProvider({ defaultStep: { mode: 'async', pollsUntilDone: 0, outputKind: 'url' } });
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
      holds,
      costs: { resolve: () => 5 },
      outputs: store,
      providers: { resolve: () => ({ provider, config: { apiKey: 'synthetic-key' } }) },
      polling: { initialDelayMs: 5, maxDelayMs: 20 },
      outputLimits: { maxBytes: { video: maxBytes } },
      fetch: async () => video(),
      sleep: async () => undefined,
    });
  }
  const command = (key: string) => ({
    ownerId: 'user-1', kind: 'video' as const, providerId: 'fake-media', model: 'fake-video', input: { prompt: 'a synthetic wave' }, idempotencyKey: key,
  });

  it('a 50 MiB video output streams into the store and completes (CONFIRMED) under the default 200 MiB cap', async () => {
    const store = streamingStore();
    let expected = '';
    const aiTasks = service(store.port, () => { const video = syntheticVideo(50 * MiB, false); expected = video.sha256; return video.response; });
    const { task } = await aiTasks.submitAndWake(command('cap-video-50mib'));
    expect(await runToEnd(aiTasks, task.id)).toBe('COMPLETED');
    const view = (await aiTasks.get('user-1', task.id))!;
    expect(view).toMatchObject({ status: 'COMPLETED', charge: 'CONFIRMED', outputs: [{ index: 0, contentType: 'video/mp4', bytes: 50 * MiB }] });
    expect(store.objects.get(`mem/${task.id}/0`)).toEqual({ bytes: 50 * MiB, sha256: expected });
    expect((await aiTasks.findOutput('user-1', task.id, 0))?.sha256).toBe(expected);
    expect((await pool.query('SELECT "balance", "frozen" FROM test_wallets')).rows[0]).toEqual({ balance: 95, frozen: 0 });
  }, 90_000);

  it('an output above the cap fails while streaming (no declared length) and releases the hold', async () => {
    const store = streamingStore();
    const aiTasks = service(store.port, () => syntheticVideo(9 * MiB, false).response, 8 * MiB);
    const { task } = await aiTasks.submitAndWake(command('cap-video-over'));
    expect(await runToEnd(aiTasks, task.id)).toBe('FAILED');
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ status: 'FAILED', charge: 'RELEASED', outputs: [], error: { code: 'AI_OUTPUT_REJECTED' } });
    expect(store.aborted).toEqual([`mem/${task.id}/0`]);
    expect(store.objects.size).toBe(0);
    expect((await pool.query('SELECT "balance", "frozen" FROM test_wallets')).rows[0]).toEqual({ balance: 100, frozen: 0 });
  }, 60_000);

  it('a declared length above the cap is refused before the store is called', async () => {
    const store = streamingStore();
    const aiTasks = service(store.port, () => syntheticVideo(9 * MiB, true).response, 8 * MiB);
    const { task } = await aiTasks.submitAndWake(command('cap-video-declared'));
    expect(await runToEnd(aiTasks, task.id)).toBe('FAILED');
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ charge: 'RELEASED', error: { code: 'AI_OUTPUT_REJECTED' } });
    expect(store.calls()).toBe(0);
  }, 60_000);

  it('a permanent store refusal (quota) fails with AI_OUTPUT_QUOTA_EXCEEDED and releases the hold without retrying', async () => {
    let calls = 0;
    const { AITaskOutputRejectedError } = await import('./errors');
    const store: OutputStorePort = {
      async put() { throw new Error('unused'); },
      async putStream(output) { calls += 1; output.stream.destroy(); throw new AITaskOutputRejectedError('quota'); },
    };
    const aiTasks = service(store, () => syntheticVideo(MiB, false).response);
    const { task } = await aiTasks.submitAndWake(command('cap-video-quota'));
    expect(await runToEnd(aiTasks, task.id)).toBe('FAILED');
    expect(await aiTasks.get('user-1', task.id)).toMatchObject({ charge: 'RELEASED', error: { code: 'AI_OUTPUT_QUOTA_EXCEEDED' } });
    expect(calls).toBe(1);
  }, 60_000);
});
