import { InMemoryTaskRepository } from './in-memory-task-repository';
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
  idempotencyKey: 'patent-1:generate:v1',
  idempotencyFingerprint: 'sha256:request-a',
  handlerVersion: 'v1',
  payload: { patentId: 'patent-1' },
  maxAttempts: 3,
  now: at(0),
  ...overrides,
});

describe('InMemoryTaskRepository', () => {
  it('deduplicates the same request and rejects key reuse with different input', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();

    expect((await repository.create(createInput())).created).toBe(true);
    expect((await repository.create(createInput({ id: 'task-2' }))).created).toBe(false);
    await expect(
      repository.create(
        createInput({
          id: 'task-3',
          idempotencyFingerprint: 'sha256:different-request',
        }),
      ),
    ).rejects.toBeInstanceOf(TaskIdempotencyConflictError);
  });

  it('claims once and rejects a second worker', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(createInput());

    const claimed = await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      now: at(1),
    });
    const duplicate = await repository.claim({
      id: 'task-1',
      workerId: 'worker-b',
      leaseToken: 'lease-b',
      leaseExpiresAt: at(20),
      now: at(1),
    });

    expect(claimed).toMatchObject({ status: 'PROCESSING', attempt: 1, leaseToken: 'lease-a' });
    expect(duplicate).toBeNull();
  });

  it('does not allow transition to bypass the claim lease', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(createInput());

    await expect(
      repository.transition({
        id: 'task-1',
        from: 'QUEUED',
        to: 'PROCESSING',
        now: at(1),
      }),
    ).resolves.toBeNull();
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      attempt: 0,
    });
  });

  it('uses fencing tokens so a stale worker cannot complete the task', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      now: at(1),
    });

    const stale = await repository.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'COMPLETED',
      leaseToken: 'lease-b',
      result: { documentId: 'doc-stale' },
      now: at(2),
    });
    const completed = await repository.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'COMPLETED',
      leaseToken: 'lease-a',
      result: { documentId: 'doc-1' },
      now: at(3),
    });

    expect(stale).toBeNull();
    expect(completed).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(completed?.result).toEqual({ documentId: 'doc-1' });
  });

  it('rejects heartbeat and completion after the lease expires', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
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
        result: { documentId: 'late-doc' },
        now: at(10),
      }),
    ).resolves.toBeNull();
  });

  it('reports monotonic progress only for the current live lease', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
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
        progress: 20,
        now: at(3),
      }),
    ).resolves.toMatchObject({ progress: 60 });
    await expect(
      repository.reportProgress({
        id: 'task-1',
        leaseToken: 'stale-lease',
        progress: 90,
        now: at(4),
      }),
    ).resolves.toBeNull();
  });

  it('requeues a retry without allowing the old lease to write afterward', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      now: at(1),
    });
    const retrying = await repository.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'RETRYING',
      leaseToken: 'lease-a',
      error: {
        code: 'PROVIDER_429',
        category: 'RATE_LIMIT',
        summary: 'rate limited',
        retryable: true,
      },
      availableAt: at(15),
      now: at(2),
    });
    expect(retrying).toMatchObject({ status: 'RETRYING', availableAt: at(15) });
    expect(retrying?.leaseToken).toBeUndefined();

    const queued = await repository.transition({
      id: 'task-1',
      from: 'RETRYING',
      to: 'QUEUED',
      now: at(3),
    });

    expect(queued).toMatchObject({ status: 'QUEUED', availableAt: at(15) });
    expect(queued?.leaseToken).toBeUndefined();
    await expect(
      repository.claim({
        id: 'task-1',
        workerId: 'worker-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(30),
        now: at(14),
      }),
    ).resolves.toBeNull();
  });

  it('cancels an active task and fences its worker', async () => {
    const repository = new InMemoryTaskRepository<Payload, Result>();
    await repository.create(createInput());
    await repository.claim({
      id: 'task-1',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      now: at(1),
    });

    const cancelled = await repository.cancel('task-1', at(2));
    expect(cancelled).toMatchObject({ status: 'CANCELLED' });
    await expect(
      repository.transition({
        id: 'task-1',
        from: 'PROCESSING',
        to: 'COMPLETED',
        leaseToken: 'lease-a',
        result: { documentId: 'late-doc' },
        now: at(3),
      }),
    ).resolves.toBeNull();
  });
});
