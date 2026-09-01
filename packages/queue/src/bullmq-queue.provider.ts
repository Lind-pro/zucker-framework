import { Queue, type ConnectionOptions, type Job as BullMqJob, type QueueOptions } from 'bullmq';
import type { Job, JobOptions, QueueProvider, QueueStats } from './queue.interface';

type QueueFactory = (name: string, options: QueueOptions) => Queue;

export interface BullMqQueueProviderOptions {
  connection: ConnectionOptions;
  prefix?: string;
  defaultJobName?: string;
  queueFactory?: QueueFactory;
}

export class BullMqQueueProvider implements QueueProvider {
  private readonly queues = new Map<string, Queue>();
  private readonly defaultJobName: string;
  private readonly queueFactory: QueueFactory;

  constructor(private readonly options: BullMqQueueProviderOptions) {
    this.defaultJobName = options.defaultJobName ?? 'task';
    this.queueFactory =
      options.queueFactory ?? ((name, queueOptions) => new Queue(name, queueOptions));
  }

  async add<T>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>> {
    this.assertValidJobId(options?.jobId);
    const job = await this.getQueue(queueName).add(
      options?.name ?? this.defaultJobName,
      data,
      this.toBullMqOptions(options),
    );
    return this.toJob(job);
  }

  async ensure<T>(
    queueName: string,
    data: T,
    options: JobOptions & { jobId: string },
  ): Promise<Job<T>> {
    this.assertValidJobId(options.jobId);
    const queue = this.getQueue(queueName);
    const existing = await queue.getJob(options.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') {
        return this.toJob(existing as BullMqJob<T>);
      }
      await existing.remove();
    }
    return this.add(queueName, data, options);
  }

  async addDelayed<T>(
    queueName: string,
    data: T,
    delayMs: number,
    options?: JobOptions,
  ): Promise<Job<T>> {
    if (delayMs < 0) throw new RangeError('delayMs cannot be negative');
    this.assertValidJobId(options?.jobId);
    const job = await this.getQueue(queueName).add(options?.name ?? this.defaultJobName, data, {
      ...this.toBullMqOptions(options),
      delay: delayMs,
    });
    return this.toJob(job);
  }

  async addRepeatable<T>(
    queueName: string,
    data: T,
    pattern: string,
    options?: JobOptions,
  ): Promise<Job<T>> {
    this.assertValidJobId(options?.jobId);
    const job = await this.getQueue(queueName).add(options?.name ?? this.defaultJobName, data, {
      ...this.toBullMqOptions(options),
      repeat: { pattern },
    });
    return this.toJob(job);
  }

  async getJob<T>(queueName: string, jobId: string): Promise<Job<T> | null> {
    const job = await this.getQueue(queueName).getJob(jobId);
    return job ? this.toJob(job as BullMqJob<T>) : null;
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getQueue(queueName).getJob(jobId);
    if (job) await job.remove();
  }

  async pause(queueName: string): Promise<void> {
    await this.getQueue(queueName).pause();
  }

  async resume(queueName: string): Promise<void> {
    await this.getQueue(queueName).resume();
  }

  async getStats(queueName: string): Promise<QueueStats> {
    const counts = await this.getQueue(queueName).getJobCounts(
      'wait',
      'active',
      'completed',
      'failed',
      'delayed',
      'prioritized',
      'paused',
    );
    return {
      waiting: (counts.wait ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0),
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.waitUntilReady()));
  }

  async close(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(queues.map((queue) => queue.close()));
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private getQueue(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const queue = this.queueFactory(name, {
      connection: this.options.connection,
      prefix: this.options.prefix,
    });
    this.queues.set(name, queue);
    return queue;
  }

  private toBullMqOptions(options?: JobOptions) {
    if (!options) return undefined;
    return {
      jobId: options.jobId,
      deduplication: options.deduplicationId ? { id: options.deduplicationId } : undefined,
      priority: options.priority,
      attempts: options.attempts,
      backoff: options.backoff,
      removeOnComplete: options.removeOnComplete,
      removeOnFail: options.removeOnFail,
    };
  }

  private assertValidJobId(jobId?: string): void {
    if (jobId?.includes(':')) {
      throw new TypeError('BullMQ jobId cannot contain a colon');
    }
  }

  private async toJob<T>(job: BullMqJob<T>): Promise<Job<T>> {
    const state = await job.getState();
    return {
      id: String(job.id),
      data: job.data,
      status: this.mapState(state),
      progress: job.progress,
      attempts: job.attemptsMade,
      failedReason: job.failedReason || undefined,
      createdAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : undefined,
      completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
    };
  }

  private mapState(state: string): Job['status'] {
    if (state === 'active' || state === 'completed' || state === 'failed' || state === 'delayed') {
      return state;
    }
    if (
      state === 'waiting' ||
      state === 'waiting-children' ||
      state === 'prioritized' ||
      state === 'paused'
    ) {
      return 'waiting';
    }
    return 'unknown';
  }
}
