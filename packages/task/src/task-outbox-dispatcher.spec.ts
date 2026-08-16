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
});
