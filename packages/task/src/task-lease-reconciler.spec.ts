import { InMemoryTaskRepository } from './in-memory-task-repository';
import { TaskLeaseReconciler } from './task-lease-reconciler';

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

const createTask = async (repository: InMemoryTaskRepository, maxAttempts = 2) => {
  await repository.create({
    id: 'task-1',
    kind: 'DRAWING_GENERATION',
    resource: { type: 'drawing', id: 'drawing-1' },
    idempotencyKey: 'drawing-1:v1',
    idempotencyFingerprint: 'sha256:drawing-1',
    handlerVersion: 'v1',
    payload: {},
    maxAttempts,
    now: at(0),
  });
  await repository.claim({
    id: 'task-1',
    workerId: 'worker-a',
    leaseToken: 'lease-a',
    leaseExpiresAt: at(10),
    now: at(1),
  });
};

describe('TaskLeaseReconciler', () => {
  it('requeues an expired attempt and fences the old worker', async () => {
    const repository = new InMemoryTaskRepository();
    await createTask(repository);
    const reconciler = new TaskLeaseReconciler(repository, {
      now: () => at(10),
      retryDelayMs: 5_000,
    });

    await expect(reconciler.runOnce()).resolves.toEqual({
      found: 1,
      requeued: 1,
      failed: 0,
      conflicts: 0,
    });
    await expect(repository.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      availableAt: at(15),
      error: { code: 'WORKER_LEASE_EXPIRED' },
    });
    await expect(
      repository.transition({
        id: 'task-1',
        from: 'PROCESSING',
        to: 'COMPLETED',
        leaseToken: 'lease-a',
        now: at(12),
      }),
    ).resolves.toBeNull();
  });

  it('marks an expired task failed when its attempt budget is exhausted', async () => {
    const repository = new InMemoryTaskRepository();
    await createTask(repository, 1);
    const reconciler = new TaskLeaseReconciler(repository, { now: () => at(10) });

    await expect(reconciler.runOnce()).resolves.toEqual({
      found: 1,
      requeued: 0,
      failed: 1,
      conflicts: 0,
    });
    await expect(repository.findById('task-1')).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('does not recover a lease that is still alive', async () => {
    const repository = new InMemoryTaskRepository();
    await createTask(repository);
    const reconciler = new TaskLeaseReconciler(repository, { now: () => at(9) });

    await expect(reconciler.runOnce()).resolves.toEqual({
      found: 0,
      requeued: 0,
      failed: 0,
      conflicts: 0,
    });
  });
});
