import { InMemoryTaskRepository } from './in-memory-task-repository';
import { TaskQueueReconciler } from './task-queue-reconciler';

const at = (seconds: number) => new Date(Date.UTC(2026, 7, 15, 0, 0, seconds));

describe('TaskQueueReconciler', () => {
  it('ensures only ready queued tasks and retries failed publishing on the next pass', async () => {
    const repository = new InMemoryTaskRepository<{ value: number }>();
    await repository.create({
      id: 'ready',
      kind: 'AI_TASK',
      resource: { type: 'document', id: 'doc-1' },
      idempotencyKey: 'ready-key',
      idempotencyFingerprint: 'ready-fingerprint',
      handlerVersion: 'v1',
      payload: { value: 1 },
      maxAttempts: 3,
      now: at(0),
    });
    await repository.create({
      id: 'future',
      kind: 'AI_TASK',
      resource: { type: 'document', id: 'doc-2' },
      idempotencyKey: 'future-key',
      idempotencyFingerprint: 'future-fingerprint',
      handlerVersion: 'v1',
      payload: { value: 2 },
      maxAttempts: 3,
      availableAt: at(30),
      now: at(0),
    });

    const ensure = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(undefined);
    const reconciler = new TaskQueueReconciler(repository, { ensure }, { now: () => at(10) });

    await expect(reconciler.runOnce()).resolves.toEqual({ found: 1, ensured: 0, failed: 1 });
    await expect(reconciler.runOnce()).resolves.toEqual({ found: 1, ensured: 1, failed: 0 });
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'ready' }));
  });

  it('rejects an invalid batch size', () => {
    const repository = new InMemoryTaskRepository();
    expect(
      () => new TaskQueueReconciler(repository, { ensure: vi.fn() }, { batchSize: 0 }),
    ).toThrow('batchSize must be at least 1');
  });

  it('rotates through more ready tasks than fit in one batch', async () => {
    const repository = new InMemoryTaskRepository<{ value: number }>();
    for (let index = 1; index <= 3; index += 1) {
      await repository.create({
        id: `task-${index}`,
        kind: 'AI_TASK',
        resource: { type: 'document', id: `doc-${index}` },
        idempotencyKey: `key-${index}`,
        idempotencyFingerprint: `fingerprint-${index}`,
        handlerVersion: 'v1',
        payload: { value: index },
        maxAttempts: 3,
        now: at(index),
      });
    }
    const ensure = vi.fn().mockResolvedValue(undefined);
    const reconciler = new TaskQueueReconciler(
      repository,
      { ensure },
      { batchSize: 2, now: () => at(10) },
    );

    await expect(reconciler.runOnce()).resolves.toMatchObject({ found: 2 });
    await expect(reconciler.runOnce()).resolves.toMatchObject({ found: 1 });
    expect(ensure.mock.calls.map(([task]) => task.id)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('requeues a RETRYING task stranded without a lease and keeps its last error', async () => {
    const repository = new InMemoryTaskRepository<{ value: number }>();
    await repository.create({
      id: 'stranded',
      kind: 'AI_TASK',
      resource: { type: 'document', id: 'doc-1' },
      idempotencyKey: 'stranded-key',
      idempotencyFingerprint: 'stranded-fingerprint',
      handlerVersion: 'v1',
      payload: { value: 1 },
      maxAttempts: 3,
      now: at(0),
    });
    await repository.claim({
      id: 'stranded',
      workerId: 'worker-1',
      leaseToken: 'lease-1',
      leaseExpiresAt: at(30),
      now: at(1),
    });
    const error = {
      code: 'PROVIDER_TIMEOUT',
      category: 'PROVIDER_TIMEOUT' as const,
      summary: 'timed out',
      retryable: true,
    };
    // The worker dies after this step, before RETRYING -> QUEUED.
    await repository.transition({
      id: 'stranded',
      from: 'PROCESSING',
      to: 'RETRYING',
      leaseToken: 'lease-1',
      error,
      availableAt: at(5),
      now: at(2),
    });
    const ensure = vi.fn().mockResolvedValue(undefined);

    const early = new TaskQueueReconciler(repository, { ensure }, { now: () => at(4) });
    await expect(early.runOnce()).resolves.toMatchObject({ found: 0 });

    const reconciler = new TaskQueueReconciler(repository, { ensure }, { now: () => at(6) });
    await expect(reconciler.runOnce()).resolves.toEqual({ found: 1, ensured: 1, failed: 0 });
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stranded', status: 'QUEUED', error }),
    );
    await expect(repository.findById('stranded')).resolves.toMatchObject({
      status: 'QUEUED',
      error,
    });
  });

  it('does not skip rows when earlier rows are claimed between passes', async () => {
    const repository = new InMemoryTaskRepository<{ value: number }>();
    for (let index = 1; index <= 4; index += 1) {
      await repository.create({
        id: `task-${index}`,
        kind: 'AI_TASK',
        resource: { type: 'document', id: `doc-${index}` },
        idempotencyKey: `key-${index}`,
        idempotencyFingerprint: `fingerprint-${index}`,
        handlerVersion: 'v1',
        payload: { value: index },
        maxAttempts: 3,
        now: at(index),
      });
    }
    const ensure = vi.fn().mockResolvedValue(undefined);
    const reconciler = new TaskQueueReconciler(
      repository,
      { ensure },
      { batchSize: 2, now: () => at(10) },
    );

    await reconciler.runOnce();
    // Both rows of the first page are claimed before the next pass (OFFSET 2 would skip 3 and 4).
    for (const id of ['task-1', 'task-2']) {
      await repository.claim({
        id,
        workerId: 'worker',
        leaseToken: `lease-${id}`,
        leaseExpiresAt: at(50),
        now: at(10),
      });
    }
    await reconciler.runOnce();
    expect(ensure.mock.calls.map(([task]) => task.id)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
    ]);
  });
});
