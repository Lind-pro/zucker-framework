import { Worker, type ConnectionOptions, type Job as BullMqJob, type WorkerOptions } from 'bullmq';
import type { JobProgress } from './queue.interface';

export interface QueueWorkerJob<TData> {
  id: string;
  name: string;
  data: TData;
  attempt: number;
  updateProgress(progress: JobProgress): Promise<void>;
  log(message: string): Promise<number>;
}

export type QueueJobHandler<TData, TResult> = (job: QueueWorkerJob<TData>) => Promise<TResult>;

export interface QueueWorkerDefinition<TData = unknown, TResult = unknown> {
  queueName: string;
  handler: QueueJobHandler<TData, TResult>;
  concurrency?: number;
  lockDurationMs?: number;
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
  private readonly workerFactory: WorkerFactory;

  constructor(private readonly options: BullMqWorkerHostOptions) {
    this.workerFactory =
      options.workerFactory ??
      ((queueName, processor, workerOptions) => new Worker(queueName, processor, workerOptions));
  }

  register<TData, TResult>(definition: QueueWorkerDefinition<TData, TResult>): void {
    if (this.workers.has(definition.queueName)) {
      throw new Error(`Worker already registered for queue: ${definition.queueName}`);
    }
    if ((definition.concurrency ?? 1) < 1) throw new RangeError('concurrency must be at least 1');
    if ((definition.lockDurationMs ?? 30_000) < 1) {
      throw new RangeError('lockDurationMs must be at least 1');
    }

    const worker = this.workerFactory(
      definition.queueName,
      async (job) =>
        definition.handler({
          id: String(job.id),
          name: job.name,
          data: job.data as TData,
          attempt: job.attemptsMade + 1,
          updateProgress: (progress) => job.updateProgress(progress),
          log: (message) => job.log(message),
        }),
      {
        connection: this.options.connection,
        prefix: this.options.prefix,
        concurrency: definition.concurrency ?? 1,
        lockDuration: definition.lockDurationMs ?? 30_000,
        autorun: definition.autorun ?? true,
      },
    );
    worker.on('ready', () => this.readyQueues.add(definition.queueName));
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

  async close(force = false): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    this.readyQueues.clear();
    await Promise.all(workers.map((worker) => worker.close(force)));
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
