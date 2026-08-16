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
});
