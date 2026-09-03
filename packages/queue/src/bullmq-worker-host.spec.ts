import type { Job, Worker } from 'bullmq';
import { BullMqWorkerHost } from './bullmq-worker-host';

const createWorker = (running = true) => {
  const backend = {
    client: Promise.resolve({ get: vi.fn().mockResolvedValue(null) }),
  };
  return {
    on: vi.fn(),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn(() => running),
    getBackend: vi.fn(() => backend),
    toKey: vi.fn((suffix: string) => `queue:${suffix}`),
    run: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
};

describe('BullMqWorkerHost', () => {
  it('registers a handler with explicit concurrency and maps the job context', async () => {
    const worker = createWorker();
    let processor: ((job: Job) => Promise<unknown>) | undefined;
    const workerFactory = vi.fn((_queueName, value) => {
      processor = value;
      return worker as unknown as Worker;
    });
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const host = new BullMqWorkerHost({
      connection: { host: 'redis', port: 6379 },
      prefix: 'zucker',
      workerFactory,
    });

    host.register({
      queueName: 'ai-image',
      concurrency: 2,
      lockDurationMs: 60_000,
      handler,
    });
    expect(workerFactory).toHaveBeenCalledWith(
      'ai-image',
      expect.any(Function),
      expect.objectContaining({ concurrency: 2, lockDuration: 60_000, prefix: 'zucker' }),
    );

    const job = {
      id: 'job-1',
      name: 'DRAWING_GENERATION',
      data: { taskId: 'task-1' },
      attemptsMade: 1,
      updateProgress: vi.fn().mockResolvedValue(undefined),
      log: vi.fn().mockResolvedValue(1),
    } as unknown as Job;
    await expect(processor?.(job)).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job-1',
        attempt: 2,
        data: { taskId: 'task-1' },
      }),
    );
  });

  it('rejects duplicate queue registration', () => {
    const worker = createWorker();
    const host = new BullMqWorkerHost({
      connection: { host: 'redis', port: 6379 },
      workerFactory: () => worker as unknown as Worker,
    });
    host.register({ queueName: 'export', handler: async () => undefined });

    expect(() => host.register({ queueName: 'export', handler: async () => undefined })).toThrow(
      'Worker already registered',
    );
  });

  it('starts an autorun=false worker without waiting for its lifecycle promise', async () => {
    let rejectRun: (error: Error) => void = () => undefined;
    const worker = createWorker(false);
    worker.run.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectRun = reject;
      }),
    );
    const onError = vi.fn();
    const host = new BullMqWorkerHost({
      connection: { host: 'redis', port: 6379 },
      onError,
      workerFactory: () => worker as unknown as Worker,
    });
    host.register({ queueName: 'analytics', autorun: false, handler: async () => undefined });

    expect(host.run('analytics')).toBeUndefined();
    expect(worker.run).toHaveBeenCalledTimes(1);
    rejectRun(new Error('redis disconnected'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledWith(
      'analytics',
      expect.objectContaining({ message: 'redis disconnected' }),
    );
  });

  it('waits for pause, resume, and graceful close on every worker', async () => {
    const workers = [createWorker(), createWorker()];
    const host = new BullMqWorkerHost({
      connection: { host: 'redis', port: 6379 },
      workerFactory: vi
        .fn()
        .mockReturnValueOnce(workers[0] as unknown as Worker)
        .mockReturnValueOnce(workers[1] as unknown as Worker),
    });
    host.register({ queueName: 'ai-text', handler: async () => undefined });
    host.register({ queueName: 'ai-image', handler: async () => undefined });

    await host.pause();
    await host.resume();
    await host.close();

    for (const worker of workers) {
      expect(worker.pause).toHaveBeenCalledTimes(1);
      expect(worker.resume).toHaveBeenCalledTimes(1);
      expect(worker.close).toHaveBeenCalledWith(false);
    }
  });

  it('reports readiness only while every registered worker is connected and running', async () => {
    const workers = [createWorker(), createWorker()];
    const host = new BullMqWorkerHost({
      connection: { host: 'redis', port: 6379 },
      workerFactory: vi
        .fn()
        .mockReturnValueOnce(workers[0] as unknown as Worker)
        .mockReturnValueOnce(workers[1] as unknown as Worker),
    });
    host.register({ queueName: 'ai-text', handler: async () => undefined });
    host.register({ queueName: 'ai-image', handler: async () => undefined });

    expect(host.health()).toEqual({
      ready: false,
      registeredQueues: ['ai-text', 'ai-image'],
      runningQueues: ['ai-text', 'ai-image'],
    });

    await host.waitUntilReady();
    expect(host.health().ready).toBe(true);

    const errorListener = workers[0].on.mock.calls.find(([event]) => event === 'error')?.[1];
    errorListener?.(new Error('redis disconnected'));
    expect(host.health().ready).toBe(false);

    const readyListener = workers[0].on.mock.calls.find(([event]) => event === 'ready')?.[1];
    readyListener?.();
    expect(host.health().ready).toBe(true);

    await host.close();
    expect(host.health()).toEqual({ ready: false, registeredQueues: [], runningQueues: [] });
  });

  it('actively detects a half-open Redis connection without losing recovery state', async () => {
    const worker = createWorker();
    const client = await worker.getBackend().client;
    const host = new BullMqWorkerHost({
      connection: { host: 'redis', port: 6379 },
      workerFactory: () => worker as unknown as Worker,
    });
    host.register({ queueName: 'ai-image', handler: async () => undefined });
    await host.waitUntilReady();

    client.get.mockImplementationOnce(() => new Promise<null>(() => undefined));
    await expect(host.probeHealth(5)).resolves.toMatchObject({ ready: false });

    await expect(host.probeHealth(5)).resolves.toMatchObject({ ready: true });
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid active probe timeout', async () => {
    const host = new BullMqWorkerHost({ connection: { host: 'redis', port: 6379 } });

    await expect(host.probeHealth(0)).rejects.toThrow('timeoutMs must be at least 1');
  });
});
