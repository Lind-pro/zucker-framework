import { PGlite } from '@electric-sql/pglite';
import { PostgresTaskRepository, type PostgresTaskClient } from './postgres-task-repository';
import { TaskIdempotencyConflictError, type CreateTaskInput } from './task-repository';

type Payload = { patentId: string };
type Result = { documentId: string };

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

const createInput = (
  overrides: Partial<CreateTaskInput<Payload>> = {},
): CreateTaskInput<Payload> => ({
  id: 'task-1',
  kind: 'PATENT_GENERATION',
  resource: { type: 'patent', id: 'patent-1' },
  userId: 'user-1',
  orderId: 'order-1',
  idempotencyKey: 'patent-1-generate-v1',
  idempotencyFingerprint: 'sha256:request-a',
  handlerVersion: 'v1',
  payload: { patentId: 'patent-1' },
  maxAttempts: 3,
  now: at(0),
  ...overrides,
});

const schema = `
  CREATE TYPE async_job_status AS ENUM (
    'QUEUED',
    'PROCESSING',
    'WAITING_PROVIDER',
    'RETRYING',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
  );

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
    "version" integer NOT NULL DEFAULT 0,
    CONSTRAINT async_jobs_progress_range CHECK ("progress" BETWEEN 0 AND 100),
    CONSTRAINT async_jobs_attempt_range CHECK ("attempt" >= 0 AND "maxAttempts" >= 1)
  );
`;

describe('PostgresTaskRepository', () => {
  let database: PGlite;
  let repository: PostgresTaskRepository<Payload, Result>;

  beforeEach(async () => {
    database = await PGlite.create();
    await database.exec(schema);
    const client: PostgresTaskClient = {
      async query<TRow>(sql: string, parameters?: readonly unknown[]) {
        const result = await database.query(sql, parameters ? [...parameters] : []);
        return { rows: result.rows as TRow[] };
      },
    };
    repository = new PostgresTaskRepository(client);
  });

  afterEach(async () => {
    await database.close();
  });

  it('creates idempotently and rejects a changed fingerprint', async () => {
    await expect(repository.create(createInput())).resolves.toMatchObject({ created: true });
    await expect(repository.create(createInput({ id: 'task-2' }))).resolves.toMatchObject({
      created: false,
      task: { id: 'task-1', payload: { patentId: 'patent-1' } },
    });
    await expect(
      repository.create(
        createInput({
          id: 'task-3',
          idempotencyFingerprint: 'sha256:changed',
        }),
      ),
    ).rejects.toBeInstanceOf(TaskIdempotencyConflictError);
  });

  it('lists only queued work whose availability time has arrived', async () => {
    await repository.create(createInput());
    await repository.create(
      createInput({
        id: 'task-2',
        idempotencyKey: 'patent-2-generate-v1',
        idempotencyFingerprint: 'sha256:request-b',
        availableAt: at(30),
      }),
    );

    await expect(repository.findReadyQueued({ now: at(10), limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: 'task-1', status: 'QUEUED' }),
    ]);
    await expect(repository.findReadyQueued({ now: at(40), limit: 1 })).resolves.toHaveLength(1);
  });

  it('reloads an idempotent row when a concurrent conflict is outside the insert snapshot', async () => {
    let hideInsertResult = true;
    const snapshotClient: PostgresTaskClient = {
      async query<TRow>(sql: string, parameters?: readonly unknown[]) {
        const result = await database.query(sql, parameters ? [...parameters] : []);
        if (hideInsertResult && sql.includes('WITH inserted AS')) {
          hideInsertResult = false;
          return { rows: [] };
        }
        return { rows: result.rows as TRow[] };
      },
    };
    const snapshotRepository = new PostgresTaskRepository<Payload, Result>(snapshotClient);

    await expect(snapshotRepository.create(createInput())).resolves.toMatchObject({
      created: false,
      task: { id: 'task-1', idempotencyFingerprint: 'sha256:request-a' },
    });
  });

  it('allows only one concurrent claimant to acquire the attempt lease', async () => {
    await repository.create(createInput());
    const [first, second] = await Promise.all([
      repository.claim({
        id: 'task-1',
        workerId: 'worker-a',
        leaseToken: 'lease-a',
        leaseExpiresAt: at(20),
        now: at(1),
      }),
      repository.claim({
        id: 'task-1',
        workerId: 'worker-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(20),
        now: at(1),
      }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'PROCESSING',
      attempt: 1,
      version: 1,
    });
  });

  it('rejects heartbeat and completion at the exact lease expiry boundary', async () => {
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(10),
      now: at(1),
    });

    await expect(
      repository.heartbeat({
        id: 'task-1',
        leaseToken: 'lease-a',
        leaseExpiresAt: at(30),
        now: at(10),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.transition({
        id: 'task-1',
        from: 'PROCESSING',
        to: 'COMPLETED',
        leaseToken: 'lease-a',
        result: { documentId: 'late-document' },
        now: at(10),
      }),
    ).resolves.toBeNull();
  });

  it('reports monotonic progress only for the current live lease', async () => {
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      now: at(1),
    });

    await expect(
      repository.reportProgress({
        id: 'task-1',
        leaseToken: 'lease-a',
        stage: 'rendering',
        progress: 60,
        now: at(2),
      }),
    ).resolves.toMatchObject({ stage: 'rendering', progress: 60 });
    await expect(
      repository.reportProgress({
        id: 'task-1',
        leaseToken: 'lease-a',
        progress: 10,
        now: at(3),
      }),
    ).resolves.toMatchObject({ progress: 60 });
    await expect(
      repository.reportProgress({
        id: 'task-1',
        leaseToken: 'wrong-lease',
        progress: 90,
        now: at(4),
      }),
    ).resolves.toBeNull();
  });

  it('recovers an expired lease once and fences the old worker', async () => {
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(10),
      now: at(1),
    });
    const error = {
      code: 'WORKER_LEASE_EXPIRED',
      category: 'INTERNAL' as const,
      summary: 'Worker heartbeat expired',
      retryable: true,
    };

    const [recovered, staleRecovery] = await Promise.all([
      repository.recoverExpiredLease({
        id: 'task-1',
        leaseToken: 'lease-a',
        error,
        availableAt: at(15),
        now: at(10),
      }),
      repository.recoverExpiredLease({
        id: 'task-1',
        leaseToken: 'lease-b',
        error,
        availableAt: at(15),
        now: at(10),
      }),
    ]);

    expect([recovered, staleRecovery].filter(Boolean)).toHaveLength(1);
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      leaseToken: undefined,
      availableAt: at(15),
      error: { code: 'WORKER_LEASE_EXPIRED' },
    });
    await expect(
      repository.transition({
        id: 'task-1',
        from: 'PROCESSING',
        to: 'COMPLETED',
        leaseToken: 'lease-a',
        now: at(11),
      }),
    ).resolves.toBeNull();
  });

  it('stores a successful result and clears the worker lease atomically', async () => {
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      now: at(1),
    });

    await expect(
      repository.transition({
        id: 'task-1',
        from: 'PROCESSING',
        to: 'COMPLETED',
        leaseToken: 'lease-a',
        stage: 'persisted',
        progress: 80,
        result: { documentId: 'document-1' },
        now: at(2),
      }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
      progress: 100,
      result: { documentId: 'document-1' },
      leaseToken: undefined,
      completedAt: at(2),
    });
  });
});
