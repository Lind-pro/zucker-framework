import type { ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { BullMqQueueEvents, type QueueCompletedEvent } from './bullmq-queue-events';
import { BullMqQueueProvider } from './bullmq-queue.provider';
import { BullMqWorkerHost } from './bullmq-worker-host';

const redisUrl = process.env.TEST_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

function connectionFromUrl(value: string): ConnectionOptions {
  const url = new URL(value);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number.isFinite(database) ? database : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
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
    const provider = new BullMqQueueProvider({ connection, prefix: 'zucker-test' });
    const workerHost = new BullMqWorkerHost({ connection, prefix: 'zucker-test' });
    const queueEvents = new BullMqQueueEvents({ connection, prefix: 'zucker-test' });
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
    }
  }, 20_000);

  it('continues delivery after Redis temporarily pauses commands', async () => {
    const connection = connectionFromUrl(redisUrl as string);
    const queueName = `zucker-redis-pause-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const provider = new BullMqQueueProvider({ connection, prefix: 'zucker-test' });
    const workerHost = new BullMqWorkerHost({ connection, prefix: 'zucker-test' });
    const queueEvents = new BullMqQueueEvents({ connection, prefix: 'zucker-test' });
    const control = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });
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
      await control.call('CLIENT', 'PAUSE', '300', 'ALL');
      const job = await provider.add(
        queueName,
        { taskId: 'task-after-pause' },
        {
          jobId: 'task-after-pause',
        },
      );
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
    }
  }, 20_000);
});
