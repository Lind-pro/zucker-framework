import { InMemoryTaskOutboxRepository } from './in-memory-task-outbox';
import { TaskOutboxConflictError } from './task-outbox';

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

describe('InMemoryTaskOutboxRepository', () => {
  it('deduplicates append by event id', async () => {
    const outbox = new InMemoryTaskOutboxRepository<{ taskId: string }>();
    const input = {
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: { taskId: 'task-1' },
      now: at(0),
    };

    expect((await outbox.append(input)).created).toBe(true);
    expect((await outbox.append(input)).created).toBe(false);
  });

  it('rejects reuse of an event id with different content', async () => {
    const outbox = new InMemoryTaskOutboxRepository<{ taskId: string }>();
    await outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: { taskId: 'task-1' },
      now: at(0),
    });

    await expect(
      outbox.append({
        id: 'event-1',
        taskId: 'task-1',
        topic: 'task.created',
        payload: { taskId: 'task-2' },
        now: at(1),
      }),
    ).rejects.toBeInstanceOf(TaskOutboxConflictError);
  });

  it('allows only one active publisher to claim an event', async () => {
    const outbox = new InMemoryTaskOutboxRepository();
    await outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });

    const first = await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      limit: 10,
      now: at(1),
    });
    const duplicate = await outbox.claimBatch({
      workerId: 'dispatcher-b',
      leaseToken: 'lease-b',
      leaseExpiresAt: at(20),
      limit: 10,
      now: at(1),
    });

    expect(first).toHaveLength(1);
    expect(duplicate).toHaveLength(0);
  });

  it('uses the publisher lease token to fence stale acknowledgements', async () => {
    const outbox = new InMemoryTaskOutboxRepository();
    await outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });
    await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      limit: 1,
      now: at(1),
    });

    await expect(outbox.markPublished('event-1', 'lease-b', at(2))).resolves.toBe(false);
    await expect(outbox.markPublished('event-1', 'lease-a', at(2))).resolves.toBe(true);
  });

  it('rejects publish acknowledgements after the publisher lease expires', async () => {
    const outbox = new InMemoryTaskOutboxRepository();
    await outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });
    await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(10),
      limit: 1,
      now: at(1),
    });

    await expect(outbox.markPublished('event-1', 'lease-a', at(10))).resolves.toBe(false);
    await expect(
      outbox.reschedule('event-1', 'lease-a', at(20), 'late failure', at(10)),
    ).resolves.toBe(false);
  });

  it('reschedules a failed publish and hides it until availableAt', async () => {
    const outbox = new InMemoryTaskOutboxRepository();
    await outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });
    await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(20),
      limit: 1,
      now: at(1),
    });
    await outbox.reschedule('event-1', 'lease-a', at(15), 'redis unavailable', at(2));

    await expect(
      outbox.claimBatch({
        workerId: 'dispatcher-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(20),
        limit: 1,
        now: at(14),
      }),
    ).resolves.toHaveLength(0);
    await expect(
      outbox.claimBatch({
        workerId: 'dispatcher-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(30),
        limit: 1,
        now: at(15),
      }),
    ).resolves.toHaveLength(1);
  });

  it('reclaims a publishing event after its dispatcher lease expires', async () => {
    const outbox = new InMemoryTaskOutboxRepository();
    await outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: {},
      now: at(0),
    });
    await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(10),
      limit: 1,
      now: at(1),
    });

    const reclaimed = await outbox.claimBatch({
      workerId: 'dispatcher-b',
      leaseToken: 'lease-b',
      leaseExpiresAt: at(30),
      limit: 1,
      now: at(10),
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ leaseToken: 'lease-b', attempt: 2 });
  });
});
