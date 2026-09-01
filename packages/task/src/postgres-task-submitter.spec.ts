import { PGlite } from '@electric-sql/pglite';
import {
  PostgresTaskSubmitter,
  type PostgresTaskTransactionRunner,
} from './postgres-task-submitter';
import { TaskOutboxConflictError } from './task-outbox';

type TaskPayload = { patentId: string };
type OutboxPayload = { kind: string };

const now = new Date('2026-08-15T00:00:00.000Z');

const schema = `
  CREATE TYPE async_job_status AS ENUM (
    'QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING',
    'COMPLETED', 'FAILED', 'CANCELLED'
  );
  CREATE TYPE async_job_outbox_status AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED');

  CREATE TABLE async_jobs (
    "id" text PRIMARY KEY,
    "kind" text NOT NULL,
    "resourceType" text NOT NULL,
    "resourceId" text NOT NULL,
    "userId" text,
    "orderId" text,
    "status" async_job_status NOT NULL DEFAULT 'QUEUED',
    "stage" text,
    "progress" integer NOT NULL DEFAULT 0,
    "attempt" integer NOT NULL DEFAULT 0,
    "maxAttempts" integer NOT NULL,
    "idempotencyKey" text NOT NULL UNIQUE,
    "idempotencyFingerprint" text NOT NULL,
    "handlerVersion" text NOT NULL,
    "payload" jsonb NOT NULL,
    "result" jsonb,
    "errorCode" text,
    "errorCategory" text,
    "errorSummary" text,
    "errorRetryable" boolean,
    "errorMetadata" jsonb,
    "providerRequestId" text,
    "workerId" text,
    "leaseToken" text,
    "leaseExpiresAt" timestamptz,
    "heartbeatAt" timestamptz,
    "availableAt" timestamptz NOT NULL,
    "startedAt" timestamptz,
    "completedAt" timestamptz,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL,
    "version" integer NOT NULL DEFAULT 0
  );

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

  CREATE TABLE patent_generation_tasks (
    "id" text PRIMARY KEY,
    "patentId" text NOT NULL
  );
`;

const submission = (
  overrides: {
    taskId?: string;
    idempotencyKey?: string;
    fingerprint?: string;
    eventId?: string;
    eventKind?: string;
    patentId?: string;
  } = {},
) => ({
  task: {
    id: overrides.taskId ?? 'task-1',
    kind: 'PATENT_GENERATION',
    resource: { type: 'patent', id: overrides.patentId ?? 'patent-1' },
    idempotencyKey: overrides.idempotencyKey ?? 'patent-1-generate-v1',
    idempotencyFingerprint: overrides.fingerprint ?? 'sha256:request-a',
    handlerVersion: 'v1',
    payload: { patentId: overrides.patentId ?? 'patent-1' },
    maxAttempts: 3,
    now,
  },
  outbox: {
    id: overrides.eventId ?? 'event-1',
    topic: 'task.created',
    payload: { kind: overrides.eventKind ?? 'PATENT_GENERATION' },
  },
});

describe('PostgresTaskSubmitter', () => {
  let database: PGlite;
  let submitter: PostgresTaskSubmitter<TaskPayload, unknown, OutboxPayload>;

  beforeEach(async () => {
    database = await PGlite.create();
    await database.exec(schema);
    const transactions: PostgresTaskTransactionRunner = {
      runInTransaction: (work) =>
        database.transaction(async (transaction) =>
          work({
            async query<TRow>(sql: string, parameters?: readonly unknown[]) {
              const result = await transaction.query(sql, parameters ? [...parameters] : []);
              return { rows: result.rows as TRow[] };
            },
          }),
        ),
    };
    submitter = new PostgresTaskSubmitter(transactions);
  });

  afterEach(async () => {
    await database.close();
  });

  it('creates the task and queue intent idempotently in one transaction', async () => {
    await expect(submitter.submit(submission())).resolves.toMatchObject({
      task: { created: true, task: { id: 'task-1' } },
      outbox: { created: true, record: { id: 'event-1', taskId: 'task-1' } },
    });
    await expect(submitter.submit(submission({ taskId: 'task-retry' }))).resolves.toMatchObject({
      task: { created: false, task: { id: 'task-1' } },
      outbox: { created: false, record: { id: 'event-1', taskId: 'task-1' } },
    });
  });

  it('rolls back a newly-created task when the outbox id conflicts', async () => {
    await submitter.submit(submission());

    await expect(
      submitter.submit(
        submission({
          taskId: 'task-2',
          idempotencyKey: 'patent-2-generate-v1',
          fingerprint: 'sha256:request-b',
          eventId: 'event-1',
          eventKind: 'DIFFERENT_EVENT',
        }),
      ),
    ).rejects.toBeInstanceOf(TaskOutboxConflictError);
    const task = await database.query('SELECT "id" FROM async_jobs WHERE "id" = $1', ['task-2']);
    expect(task.rows).toHaveLength(0);
  });

  it('persists an application projection in the task and outbox transaction', async () => {
    await submitter.submit(submission(), {
      transactionalWork: async (client, result) => {
        await client.query(
          'INSERT INTO patent_generation_tasks ("id", "patentId") VALUES ($1, $2)',
          [result.task.task.id, result.task.task.resource.id],
        );
      },
    });

    const projection = await database.query(
      'SELECT * FROM patent_generation_tasks WHERE "id" = $1',
      ['task-1'],
    );
    expect(projection.rows).toEqual([{ id: 'task-1', patentId: 'patent-1' }]);
  });

  it('rolls back the task and outbox when application projection persistence fails', async () => {
    await expect(
      submitter.submit(submission(), {
        transactionalWork: async () => {
          throw new Error('projection unavailable');
        },
      }),
    ).rejects.toThrow('projection unavailable');

    const task = await database.query('SELECT "id" FROM async_jobs WHERE "id" = $1', ['task-1']);
    const outbox = await database.query('SELECT "id" FROM async_job_outbox WHERE "id" = $1', [
      'event-1',
    ]);
    expect(task.rows).toHaveLength(0);
    expect(outbox.rows).toHaveLength(0);
  });

  it('creates a task batch and its projections atomically in input order', async () => {
    const batch = [
      submission(),
      submission({
        taskId: 'task-2',
        patentId: 'patent-2',
        idempotencyKey: 'patent-2-generate-v1',
        fingerprint: 'sha256:request-b',
        eventId: 'event-2',
      }),
    ];

    await expect(
      submitter.submitBatch(batch, {
        transactionalWork: async (client, results) => {
          for (const result of results) {
            await client.query(
              'INSERT INTO patent_generation_tasks ("id", "patentId") VALUES ($1, $2)',
              [result.task.task.id, result.task.task.resource.id],
            );
          }
        },
      }),
    ).resolves.toMatchObject([
      { task: { created: true, task: { id: 'task-1' } } },
      { task: { created: true, task: { id: 'task-2' } } },
    ]);

    const tasks = await database.query('SELECT "id" FROM async_jobs ORDER BY "id"');
    const events = await database.query('SELECT "id" FROM async_job_outbox ORDER BY "id"');
    const projections = await database.query(
      'SELECT "id", "patentId" FROM patent_generation_tasks ORDER BY "id"',
    );
    expect(tasks.rows).toEqual([{ id: 'task-1' }, { id: 'task-2' }]);
    expect(events.rows).toEqual([{ id: 'event-1' }, { id: 'event-2' }]);
    expect(projections.rows).toEqual([
      { id: 'task-1', patentId: 'patent-1' },
      { id: 'task-2', patentId: 'patent-2' },
    ]);
  });

  it('rolls back the entire batch when a later outbox intent conflicts', async () => {
    await submitter.submit(submission());

    await expect(
      submitter.submitBatch([
        submission({
          taskId: 'task-2',
          patentId: 'patent-2',
          idempotencyKey: 'patent-2-generate-v1',
          fingerprint: 'sha256:request-b',
          eventId: 'event-2',
        }),
        submission({
          taskId: 'task-3',
          patentId: 'patent-3',
          idempotencyKey: 'patent-3-generate-v1',
          fingerprint: 'sha256:request-c',
          eventId: 'event-1',
          eventKind: 'DIFFERENT_EVENT',
        }),
      ]),
    ).rejects.toBeInstanceOf(TaskOutboxConflictError);

    const tasks = await database.query('SELECT "id" FROM async_jobs ORDER BY "id"');
    const events = await database.query('SELECT "id" FROM async_job_outbox ORDER BY "id"');
    expect(tasks.rows).toEqual([{ id: 'task-1' }]);
    expect(events.rows).toEqual([{ id: 'event-1' }]);
  });
});
