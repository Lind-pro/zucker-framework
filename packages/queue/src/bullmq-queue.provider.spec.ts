import type { Queue } from 'bullmq';
import { BullMqQueueProvider } from './bullmq-queue.provider';

const createBullJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1',
  data: { taskId: 'task-1' },
  progress: 25,
  attemptsMade: 1,
  failedReason: undefined,
  timestamp: Date.parse('2026-08-15T00:00:00.000Z'),
  processedOn: Date.parse('2026-08-15T00:00:01.000Z'),
  finishedOn: undefined,
  getState: vi.fn().mockResolvedValue('waiting'),
  remove: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const createQueue = () => ({
  on: vi.fn(),
  backend: { client: Promise.resolve({ llen: vi.fn().mockResolvedValue(1) }) },
  toKey: vi.fn((key: string) => `queue:${key}`),
  add: vi.fn(),
  addBulk: vi.fn(),
  upsertJobScheduler: vi.fn(),
  getJob: vi.fn(),
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined),
  getJobCounts: vi.fn().mockResolvedValue({
    wait: 2,
    prioritized: 1,
    paused: 1,
    active: 3,
    completed: 4,
    failed: 5,
    delayed: 6,
  }),
  waitUntilReady: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

describe('BullMqQueueProvider', () => {
  it('preserves native count keys for backend-specific monitoring consumers', async () => {
    const queue = createQueue();
    const counts = { waiting: 1, prioritized: 2, 'waiting-children': 3 };
    queue.getJobCounts.mockResolvedValue(counts);
    const provider = new BullMqQueueProvider({ connection: {}, queueFactory: () => queue as unknown as Queue });
    expect(await provider.getJobCounts('synthetic')).toEqual(counts);
    expect(queue.getJobCounts).toHaveBeenCalledWith();
    await provider.close();
  });

  it('waits for all producers to close even when one close throws synchronously', async () => {
    const queues = [createQueue(), createQueue()];
    const failure = new Error('synthetic close failure');
    queues[0].close.mockImplementation(() => { throw failure; });
    let finish!: () => void;
    queues[1].close.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    let index = 0;
    const provider = new BullMqQueueProvider({ connection: {}, queueFactory: () => queues[index++] as unknown as Queue });
    await provider.waitUntilReady(['first', 'second']);
    let settled = false;
    const closing = provider.close().catch(error => { settled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    expect(await closing).toMatchObject({ errors: [failure] });
    expect(queues[1].close).toHaveBeenCalledOnce();
  });
  it('maps queue options and uses a stable job id for transport deduplication', async () => {
    const bullJob = createBullJob();
    const queue = createQueue();
    queue.add.mockResolvedValue(bullJob);
    const queueFactory = vi.fn(() => queue as unknown as Queue);
    const provider = new BullMqQueueProvider({
      connection: { host: 'redis', port: 6379 },
      prefix: 'zucker',
      queueFactory,
    });

    const job = await provider.add(
      'ai-image',
      { taskId: 'task-1' },
      {
        name: 'DRAWING_GENERATION',
        jobId: 'task-1',
        deduplicationId: 'drawing-1-v1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
      },
    );

    expect(queueFactory).toHaveBeenCalledWith('ai-image', {
      connection: { host: 'redis', port: 6379 },
      prefix: 'zucker',
    });
    expect(queue.add).toHaveBeenCalledWith(
      'DRAWING_GENERATION',
      { taskId: 'task-1' },
      {
        jobId: 'task-1',
        deduplication: { id: 'drawing-1-v1' },
        priority: undefined,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: undefined,
      },
    );
    expect(job).toMatchObject({ id: 'job-1', status: 'waiting', attempts: 1, progress: 25 });
  });

  it('validates all bulk IDs before enqueueing and uses native bulk submission', async () => {
    const queue = createQueue();
    const queueFactory = vi.fn(() => queue as unknown as Queue);
    const provider = new BullMqQueueProvider({ connection: { host: 'redis' }, queueFactory });
    await expect(provider.addBulk('batch', [{ data: {}, options: { jobId: 'ok' } }, { data: {}, options: { jobId: 'bad:id' } }])).rejects.toThrow('colon');
    expect(queueFactory).not.toHaveBeenCalled();
    expect(await provider.addBulk('batch', [])).toEqual([]);
    expect(queueFactory).not.toHaveBeenCalled();
    queue.addBulk.mockResolvedValue([createBullJob()]);
    expect(await provider.addBulk('batch', [{ data: { taskId: 'task-1' }, options: { name: 'crawl', attempts: 3 } }])).toHaveLength(1);
    expect(queue.addBulk).toHaveBeenCalledWith([{ name: 'crawl', data: { taskId: 'task-1' }, opts: expect.objectContaining({ attempts: 3 }) }]);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('maps delayed jobs and rejects negative delay', async () => {
    const bullJob = createBullJob({ getState: vi.fn().mockResolvedValue('delayed') });
    const queue = createQueue();
    queue.add.mockResolvedValue(bullJob);
    const provider = new BullMqQueueProvider({
      connection: { host: 'redis', port: 6379 },
      queueFactory: () => queue as unknown as Queue,
    });

    await expect(provider.addDelayed('export', {}, -1)).rejects.toThrow(
      'delayMs cannot be negative',
    );
    await expect(
      provider.addDelayed('export', {}, 5_000, { jobId: 'export-1' }),
    ).resolves.toMatchObject({
      status: 'delayed',
    });
    expect(queue.add).toHaveBeenLastCalledWith(
      'task',
      {},
      expect.objectContaining({
        jobId: 'export-1',
        delay: 5_000,
      }),
    );
  });

  it('keeps a live stable job and replaces a stale terminal record', async () => {
    const waiting = createBullJob({ id: 'stable', getState: vi.fn().mockResolvedValue('waiting') });
    const completed = createBullJob({
      id: 'stable',
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    const replacement = createBullJob({ id: 'stable' });
    const queue = createQueue();
    queue.getJob.mockResolvedValueOnce(waiting).mockResolvedValueOnce(completed);
    queue.add.mockResolvedValue(replacement);
    const provider = new BullMqQueueProvider({
      connection: { host: 'redis', port: 6379 },
      queueFactory: () => queue as unknown as Queue,
    });
    const options = { jobId: 'stable', attempts: 3 };

    await expect(provider.ensure('ai-text', { taskId: 'task-1' }, options)).resolves.toMatchObject({
      id: 'stable',
      status: 'waiting',
    });
    expect(queue.add).not.toHaveBeenCalled();

    await expect(provider.ensure('ai-text', { taskId: 'task-1' }, options)).resolves.toMatchObject({
      id: 'stable',
    });
    expect(completed.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid BullMQ job ids before creating a queue connection', async () => {
    const queueFactory = vi.fn(() => createQueue() as unknown as Queue);
    const provider = new BullMqQueueProvider({
      connection: { host: 'redis', port: 6379 },
      queueFactory,
    });

    await expect(provider.add('ai-text', {}, { jobId: 'patent:task-1' })).rejects.toThrow(
      'BullMQ jobId cannot contain a colon',
    );
    await expect(
      provider.addDelayed('ai-text', {}, 1_000, { jobId: 'patent:task-1' }),
    ).rejects.toThrow('BullMQ jobId cannot contain a colon');
    await expect(
      provider.addRepeatable('ai-text', {}, '*/5 * * * *', {
        jobId: 'patent:task-1',
      }),
    ).rejects.toThrow('BullMQ jobId cannot contain a colon');
    expect(queueFactory).not.toHaveBeenCalled();
  });

  it('combines waiting-like BullMQ states in queue statistics', async () => {
    const queue = createQueue();
    const provider = new BullMqQueueProvider({
      connection: { host: 'redis', port: 6379 },
      queueFactory: () => queue as unknown as Queue,
    });

    await expect(provider.getStats('ai-text')).resolves.toEqual({
      waiting: 4,
      active: 3,
      completed: 4,
      failed: 5,
      delayed: 6,
    });
  });

  it('prewarms named producers and reports connection failures without publishing a job', async () => {
    const queue = createQueue();
    const onError = vi.fn();
    const provider = new BullMqQueueProvider({ connection: { host: 'redis' }, onError,
      queueFactory: () => queue as unknown as Queue });
    await provider.waitUntilReady(['outbox']);
    expect(queue.waitUntilReady).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
    const error = new Error('synthetic unavailable');
    queue.on.mock.calls.find(([name]) => name === 'error')![1](error);
    expect(onError).toHaveBeenCalledWith('outbox', error);
    await provider.getStats('outbox');
    expect(queue.getJobCounts.mock.calls[0]).not.toContain('paused');
    expect((await queue.backend.client).llen).toHaveBeenCalledWith('queue:paused');
  });

  it('shares a pending close promise and cannot reopen a producer during drain', async () => {
    const queue = createQueue();
    let finish!: () => void;
    queue.close.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const provider = new BullMqQueueProvider({ connection: { host: 'redis' }, queueFactory: () => queue as unknown as Queue });
    await provider.waitUntilReady(['queue']);
    const first = provider.close();
    expect(provider.close()).toBe(first);
    await expect(provider.add('queue', {})).rejects.toThrow('closing');
    finish(); await first;
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it('closes every lazily-created queue exactly once', async () => {
    const queues = [createQueue(), createQueue()];
    const provider = new BullMqQueueProvider({
      connection: { host: 'redis', port: 6379 },
      queueFactory: vi
        .fn()
        .mockReturnValueOnce(queues[0] as unknown as Queue)
        .mockReturnValueOnce(queues[1] as unknown as Queue),
    });
    await provider.getStats('ai-text');
    await provider.getStats('ai-image');

    await provider.close();
    await provider.close();

    expect(queues[0].close).toHaveBeenCalledTimes(1);
    expect(queues[1].close).toHaveBeenCalledTimes(1);
  });
});
