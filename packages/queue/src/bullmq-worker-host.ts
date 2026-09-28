import { Worker, type ConnectionOptions, type Job as BullMqJob, type WorkerOptions } from 'bullmq';
import type { JobProgress } from './queue.interface';

export interface QueueWorkerJob<TData> {
  id: string;
  name: string;
  data: TData;
  attempt: number;
  /** Configured retry budget, including this attempt. */
  maxAttempts: number;
  updateProgress(progress: JobProgress): Promise<void>;
  log(message: string): Promise<number>;
}

export type QueueJobHandler<TData, TResult> = (job: QueueWorkerJob<TData>) => Promise<TResult>;

export interface QueueWorkerDefinition<TData = unknown, TResult = unknown> {
  queueName: string;
  handler: QueueJobHandler<TData, TResult>;
  concurrency?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  autorun?: boolean;
}

type WorkerFactory = (
  queueName: string,
  processor: (job: BullMqJob) => Promise<unknown>,
  options: WorkerOptions,
) => Worker;

export interface BullMqWorkerHostOptions {
  connection: ConnectionOptions;
  prefix?: string;
  onError?: (queueName: string, error: Error) => void;
  workerFactory?: WorkerFactory;
}

export interface QueueWorkerHealth {
  ready: boolean;
  registeredQueues: readonly string[];
  runningQueues: readonly string[];
}

export class BullMqWorkerHost {
  private readonly workers = new Map<string, Worker>();
  private readonly readyQueues = new Set<string>();
  private closing?: Promise<void>;
  private readonly workerFactory: WorkerFactory;

  constructor(private readonly options: BullMqWorkerHostOptions) {
    this.workerFactory =
      options.workerFactory ??
      ((queueName, processor, workerOptions) => new Worker(queueName, processor, workerOptions));
  }

  register<TData, TResult>(definition: QueueWorkerDefinition<TData, TResult>): void {
    if (this.closing) throw new Error('Worker host is closing');
    if (this.workers.has(definition.queueName)) {
      throw new Error(`Worker already registered for queue: ${definition.queueName}`);
    }
    for (const [name, value] of Object.entries({
      concurrency: definition.concurrency ?? 1,
      lockDurationMs: definition.lockDurationMs ?? 30_000,
      stalledIntervalMs: definition.stalledIntervalMs ?? 30_000,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    }

    const worker = this.workerFactory(
      definition.queueName,
      async (job) =>
        definition.handler({
          id: String(job.id),
          name: job.name,
          data: job.data as TData,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts?.attempts ?? 1,
          updateProgress: (progress) => job.updateProgress(progress),
          log: (message) => job.log(message),
        }),
      {
        connection: this.options.connection,
        prefix: this.options.prefix,
        concurrency: definition.concurrency ?? 1,
        lockDuration: definition.lockDurationMs ?? 30_000,
        autorun: definition.autorun ?? true,
        ...(definition.stalledIntervalMs === undefined ? {} : { stalledInterval: definition.stalledIntervalMs }),
      },
    );
    worker.on('ready', () => { if (!this.closing) this.readyQueues.add(definition.queueName); });
    worker.on('error', (error) => {
      this.readyQueues.delete(definition.queueName);
      this.options.onError?.(definition.queueName, error);
    });
    this.workers.set(definition.queueName, worker);
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.waitUntilReady()));
    for (const queueName of this.workers.keys()) this.readyQueues.add(queueName);
  }

  health(): QueueWorkerHealth {
    const registeredQueues = [...this.workers.keys()];
    const runningQueues = registeredQueues.filter((queueName) =>
      this.workers.get(queueName)?.isRunning(),
    );
    return {
      ready:
        registeredQueues.length > 0 &&
        this.readyQueues.size === registeredQueues.length &&
        runningQueues.length === registeredQueues.length,
      registeredQueues,
      runningQueues,
    };
  }

  /**
   * Actively verifies the Redis connections behind every worker.
   *
   * BullMQ's ready/error events cannot detect a half-open connection where the
   * TCP socket still exists but Redis no longer answers. Readiness endpoints
   * should use this bounded probe instead of relying on lifecycle events alone.
   */
  async probeHealth(timeoutMs = 1_000): Promise<QueueWorkerHealth> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new RangeError('timeoutMs must be at least 1');
    }

    const current = this.health();
    if (!current.ready) return current;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(
          [...this.workers.values()].map(async (worker) => {
            const client = await worker.getBackend().client;
            await client.get(worker.toKey('health-probe'));
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis worker health probe timed out')),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      return this.health();
    } catch {
      return { ...this.health(), ready: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  run(queueName: string): void {
    const worker = this.requireWorker(queueName);
    if (worker.isRunning()) return;
    void worker.run().catch((error: Error) => this.options.onError?.(queueName, error));
  }

  async pause(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.pause()));
  }

  async resume(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.resume()));
  }

  close(force = false): Promise<void> {
    if (this.closing) return this.closing;
    const workers = [...this.workers.values()];
    this.workers.clear();
    this.readyQueues.clear();
    this.closing = Promise.allSettled(workers.map(async (worker) => worker.close(force))).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Worker shutdown failed');
    });
    return this.closing;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private requireWorker(queueName: string): Worker {
    const worker = this.workers.get(queueName);
    if (!worker) throw new Error(`No worker registered for queue: ${queueName}`);
    return worker;
  }
}
