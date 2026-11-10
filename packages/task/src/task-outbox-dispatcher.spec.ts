import { InMemoryTaskOutboxRepository } from './in-memory-task-outbox';
import { TaskOutboxDispatcher } from './task-outbox-dispatcher';
import type { TaskQueuePublisher } from './task-outbox';

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

describe('TaskOutboxDispatcher', () => {
  it('publishes and acknowledges a claimed event', async () => {
    const repository = new InMemoryTaskOutboxRepository();
    await repository.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });
    const publisher: TaskQueuePublisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const dispatcher = new TaskOutboxDispatcher(repository, publisher, {
      workerId: 'dispatcher-a',
      createLeaseToken: () => 'lease-a',
      now: () => at(1),
    });

    await expect(dispatcher.runOnce()).resolves.toEqual({
      claimed: 1,
      published: 1,
      rescheduled: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
      exhausted: 0,
    });
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1' }));
  });

  it('reschedules a failed publish with a bounded error summary', async () => {
    const repository = new InMemoryTaskOutboxRepository();
    await repository.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });
    const publisher: TaskQueuePublisher = {
      publish: vi.fn().mockRejectedValue(new Error('redis unavailable'.repeat(30))),
    };
    const dispatcher = new TaskOutboxDispatcher(repository, publisher, {
      workerId: 'dispatcher-a',
      createLeaseToken: () => 'lease-a',
      retryDelayMs: () => 5_000,
      now: () => at(1),
    });

    await expect(dispatcher.runOnce()).resolves.toEqual({
      claimed: 1,
      published: 0,
      rescheduled: 1,
      conflicts: 0,
      deferred: 0,
      errors: 0,
      exhausted: 0,
    });
    await expect(
      repository.claimBatch({
        workerId: 'dispatcher-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(10),
        limit: 1,
        now: at(5),
      }),
    ).resolves.toHaveLength(0);
    await expect(
      repository.claimBatch({
        workerId: 'dispatcher-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(20),
        limit: 1,
        now: at(6),
      }),
    ).resolves.toHaveLength(1);
  });

  const appendEvents = async (repository: InMemoryTaskOutboxRepository, count: number) => {
    for (let index = 1; index <= count; index += 1) {
      await repository.append({
        id: `event-${index}`,
        taskId: `task-${index}`,
        topic: 'task.created',
        payload: {},
        now: at(index - 1),
      });
    }
  };

  it('stops publishing a batch once its shared lease is nearly exhausted', async () => {
    const repository = new InMemoryTaskOutboxRepository();
    await appendEvents(repository, 3);
    let clock = 10;
    const publisher: TaskQueuePublisher = {
      publish: vi.fn(async () => {
        clock += 25; // each publish takes 25s against a 30s lease
      }),
    };
    const dispatcher = new TaskOutboxDispatcher(repository, publisher, {
      workerId: 'dispatcher-a',
      createLeaseToken: () => 'lease-a',
      leaseDurationMs: 30_000,
      leaseSafetyMarginMs: 5_000,
      now: () => at(clock),
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      claimed: 3,
      published: 1,
      deferred: 2,
    });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('continues the batch when a reschedule throws', async () => {
    const repository = new InMemoryTaskOutboxRepository();
    await appendEvents(repository, 2);
    vi.spyOn(repository, 'reschedule').mockRejectedValueOnce(new Error('db blip'));
    const publisher: TaskQueuePublisher = {
      publish: vi
        .fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValue(undefined),
    };
    const dispatcher = new TaskOutboxDispatcher(repository, publisher, {
      workerId: 'dispatcher-a',
      createLeaseToken: () => 'lease-a',
      now: () => at(5),
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      claimed: 2,
      published: 1,
      errors: 1,
    });
  });

  it('parks a message after maxAttempts and reports it', async () => {
    const repository = new InMemoryTaskOutboxRepository();
    await appendEvents(repository, 1);
    const onExhausted = vi.fn();
    const publisher: TaskQueuePublisher = {
      publish: vi.fn().mockRejectedValue(new Error('poison')),
    };
    let clock = 1;
    const dispatcher = new TaskOutboxDispatcher(repository, publisher, {
      workerId: 'dispatcher-a',
      createLeaseToken: () => `lease-${clock}`,
      retryDelayMs: () => 1_000,
      maxAttempts: 2,
      exhaustedRetryDelayMs: 600_000,
      onExhausted,
      now: () => new Date(at(0).getTime() + clock * 1_000),
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({ rescheduled: 1, exhausted: 0 });
    clock = 3;
    await expect(dispatcher.runOnce()).resolves.toMatchObject({ rescheduled: 1, exhausted: 1 });
    expect(onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'event-1', attempt: 2 }),
      expect.any(Error),
    );
    clock = 100;
    await expect(dispatcher.runOnce()).resolves.toMatchObject({ claimed: 0 });
    clock = 700;
    await expect(dispatcher.runOnce()).resolves.toMatchObject({ claimed: 1 });
  });

  it('a publisher that never settles ends the batch with errors: 1, the rest deferred and no markPublished (L5)', async () => {
    vi.useFakeTimers();
    try {
      const repository = new InMemoryTaskOutboxRepository();
      for (const n of [1, 2, 3]) {
        await repository.append({ id: `event-${n}`, taskId: `task-${n}`, topic: 'task.created', payload: {}, now: at(0) });
      }
      const markPublished = vi.spyOn(repository, 'markPublished');
      const publish = vi.fn(() => new Promise<void>(() => undefined)); // never settles
      const dispatcher = new TaskOutboxDispatcher(repository, { publish }, {
        workerId: 'dispatcher-a',
        createLeaseToken: () => 'lease-a',
        leaseDurationMs: 1_000,
        leaseSafetyMarginMs: 100,
        // Wall clock follows the fake timers so the remaining lease shrinks as time passes.
        now: () => new Date(Date.now()),
      });

      const run = dispatcher.runOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(run).resolves.toEqual({
        claimed: 3,
        published: 0,
        rescheduled: 0,
        conflicts: 0,
        deferred: 2,
        errors: 1,
        exhausted: 0,
      });
      expect(publish).toHaveBeenCalledTimes(1); // the batch stopped at the first hanging publish
      expect(markPublished).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
