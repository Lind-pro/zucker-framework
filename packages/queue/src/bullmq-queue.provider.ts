import { createHash } from 'node:crypto';
import { Queue, type ConnectionOptions, type Job as BullMqJob, type QueueOptions } from 'bullmq';
import type { Job, JobOptions, QueueProvider, QueueStats } from './queue.interface';

type QueueFactory = (name: string, options: QueueOptions) => Queue;

export interface BullMqQueueProviderOptions {
  connection: ConnectionOptions;
  prefix?: string;
  defaultJobName?: string;
  queueFactory?: QueueFactory;
  onError?: (queueName: string, error: Error) => void;
}

export class BullMqQueueProvider implements QueueProvider {
  private readonly queues = new Map<string, Queue>();
  private closing?: Promise<void>;
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

  /** Preserve BullMQ native bulk submission semantics rather than looping add(). */
  async addBulk<T>(queueName: string, entries: readonly { data: T; options?: JobOptions }[]): Promise<Job<T>[]> {
    for (const entry of entries) this.assertValidJobId(entry.options?.jobId);
    if (entries.length === 0) return [];
    const jobs = await this.getQueue(queueName).addBulk(entries.map(({ data, options }) => ({
      name: options?.name ?? this.defaultJobName,
      data,
      opts: this.toBullMqOptions(options),
    })));
    return Promise.all(jobs.map(job => this.toJob(job as BullMqJob<T>)));
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
      try {
        await existing.remove();
      } catch (error) {
        // A concurrent ensure() may have already replaced (or a worker locked) the job.
        // Re-read and accept a live replacement instead of failing the caller.
        const current = await queue.getJob(options.jobId);
        if (current) {
          const currentState = await current.getState();
          if (currentState !== 'completed' && currentState !== 'failed') {
            return this.toJob(current as BullMqJob<T>);
          }
          throw error;
        }
      }
    }
    // BullMQ add() with an existing jobId returns the existing job rather than duplicating it.
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
    const name = options?.name ?? this.defaultJobName;
    const schedulerId =
      options?.jobId ??
      `scheduler-${createHash('sha256').update(name).update('\0').update(pattern).digest('hex')}`;
    const job = await this.getQueue(queueName).upsertJobScheduler(
      schedulerId,
      { pattern },
      {
        name,
        data,
        opts: this.toBullMqSchedulerOptions(options),
      },
    );
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

  /** Native count keys for existing BullMQ monitoring contracts. Unlike
   * getStats(), this does not merge prioritized/legacy-paused into waiting. */
  async getJobCounts(queueName: string): Promise<Record<string, number>> {
    return this.getQueue(queueName).getJobCounts();
  }

  async getStats(queueName: string): Promise<QueueStats> {
    const queue = this.getQueue(queueName);
    const counts = await queue.getJobCounts(
      'wait',
      'active',
      'completed',
      'failed',
      'delayed',
      'prioritized',
    );
    // BullMQ 6 no longer accepts paused in getJobCounts. Read legacy v5 data
    // without moving/resuming it; upgrading a transport must not mutate jobs.
    const client = await queue.backend.client;
    const paused = await client.llen(queue.toKey('paused'));
    return {
      waiting: (counts.wait ?? 0) + (counts.prioritized ?? 0) + paused,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  }

  async waitUntilReady(queueNames: readonly string[] = []): Promise<void> {
    for (const name of queueNames) this.getQueue(name);
    await Promise.all([...this.queues.values()].map((queue) => queue.waitUntilReady()));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const queues = [...this.queues.values()];
    this.queues.clear();
    this.closing = Promise.allSettled(queues.map(async (queue) => queue.close())).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Queue shutdown failed');
    });
    return this.closing;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private getQueue(name: string): Queue {
    if (this.closing) throw new Error('Queue provider is closing');
    const existing = this.queues.get(name);
    if (existing) return existing;
    const queue = this.queueFactory(name, {
      connection: this.options.connection,
      prefix: this.options.prefix,
    });
    if (this.options.onError) queue.on('error', (error) => this.options.onError!(name, error));
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

  private toBullMqSchedulerOptions(options?: JobOptions) {
    if (!options) return undefined;
    return {
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
