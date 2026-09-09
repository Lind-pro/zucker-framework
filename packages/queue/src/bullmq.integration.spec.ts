import { Queue, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { BullMqQueueEvents, type QueueCompletedEvent } from './bullmq-queue-events';
import { BullMqQueueProvider } from './bullmq-queue.provider';
import { BullMqWorkerHost } from './bullmq-worker-host';
import { bullMqConnectionFromUrl } from './bullmq-connection';

const redisUrl = process.env.TEST_REDIS_URL;
const queuePrefix = process.env.TEST_REDIS_PREFIX ?? 'zucker-test';
const describeWithRedis = redisUrl ? describe : describe.skip;

function connectionFromUrl(value: string): ConnectionOptions {
  return bullMqConnectionFromUrl(value, { role: 'worker' });
}

async function removeTestQueue(queueName: string): Promise<void> {
  const queue = new Queue(queueName, {
    connection: bullMqConnectionFromUrl(redisUrl as string),
    prefix: queuePrefix,
  });
  try {
    // The random queue name belongs only to this test. Never flush a shared Redis DB.
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('BullMQ integration test timed out')),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

describeWithRedis('BullMQ runtime integration', () => {
  it('deduplicates a fixed job id and delivers completion through QueueEvents', async () => {
    const connection = connectionFromUrl(redisUrl as string);
    const queueName = `zucker-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const provider = new BullMqQueueProvider({ connection, prefix: queuePrefix });
    const workerHost = new BullMqWorkerHost({ connection, prefix: queuePrefix });
    const queueEvents = new BullMqQueueEvents({ connection, prefix: queuePrefix });
    let handled = 0;
    let complete: (event: QueueCompletedEvent) => void = () => undefined;
    const completed = new Promise<QueueCompletedEvent>((resolve) => {
      complete = resolve;
    });
    const unsubscribe = queueEvents.listen(queueName, { completed: complete });

    workerHost.register<{ taskId: string }, { accepted: boolean }>({
      queueName,
      handler: async (job) => {
        handled += 1;
        await job.updateProgress(50);
        return { accepted: job.data.taskId === 'task-1' };
      },
    });

    try {
      await Promise.all([workerHost.waitUntilReady(), queueEvents.waitUntilReady()]);
      const first = await provider.add(queueName, { taskId: 'task-1' }, { jobId: 'task-1' });
      const duplicate = await provider.add(queueName, { taskId: 'task-1' }, { jobId: 'task-1' });
      const event = await waitFor(completed, 15_000);

      expect(first.id).toBe('task-1');
      expect(duplicate.id).toBe('task-1');
      expect(event).toMatchObject({ queueName, jobId: 'task-1' });
      expect(handled).toBe(1);
    } finally {
      unsubscribe();
      await workerHost.close();
      await queueEvents.close();
      await provider.close();
      await removeTestQueue(queueName);
    }
  }, 20_000);

  it('continues delivery after its producer client reconnects', async () => {
    const connection = connectionFromUrl(redisUrl as string);
    const queueName = `zucker-client-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const control = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const provider = new BullMqQueueProvider({ connection: control, prefix: queuePrefix });
    const workerHost = new BullMqWorkerHost({ connection, prefix: queuePrefix });
    const queueEvents = new BullMqQueueEvents({ connection, prefix: queuePrefix });
    let handled = 0;
    let complete: (event: QueueCompletedEvent) => void = () => undefined;
    const completed = new Promise<QueueCompletedEvent>((resolve) => {
      complete = resolve;
    });
    const unsubscribe = queueEvents.listen(queueName, { completed: complete });

    workerHost.register<{ taskId: string }, { accepted: boolean }>({
      queueName,
      handler: async () => {
        handled += 1;
        return { accepted: true };
      },
    });

    try {
      await Promise.all([
        workerHost.waitUntilReady(),
        queueEvents.waitUntilReady(),
        control.ping(),
      ]);
      await provider.getJob(queueName, 'not-present');
      // Reconnect only this test's client; CLIENT PAUSE would affect every NAS user.
      const disconnected = new Promise<void>((resolveEnd) => control.once('end', resolveEnd));
      control.disconnect();
      await waitFor(disconnected, 5000);
      const reconnected = control.connect();
      const job = await provider.add(
        queueName,
        { taskId: 'task-after-pause' },
        {
          jobId: 'task-after-pause',
        },
      );
      await reconnected;
      const event = await waitFor(completed, 15_000);

      expect(job.id).toBe('task-after-pause');
      expect(event).toMatchObject({ queueName, jobId: 'task-after-pause' });
      expect(handled).toBe(1);
    } finally {
      unsubscribe();
      await workerHost.close();
      await queueEvents.close();
      await provider.close();
      await control.quit();
      await removeTestQueue(queueName);
    }
  }, 20_000);
});
