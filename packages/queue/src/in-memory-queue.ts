import { Logger, type OnModuleDestroy } from '@nestjs/common';
import type { QueueProvider, Job, JobOptions, QueueStats } from './queue.interface';

/**
 * 内存队列实现 — 开发/测试用途，不保证持久化。
 * 生产环境请替换为 BullMQ 等实现。
 */
export class InMemoryQueue implements QueueProvider, OnModuleDestroy {
  private readonly logger = new Logger(InMemoryQueue.name);
  private queues = new Map<string, Map<string, Job>>();
  private paused = new Set<string>();
  private counter = 0;
  /** timer 引用：queueName:jobId → timer */
  private readonly delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private getQueue(name: string): Map<string, Job> {
    let q = this.queues.get(name);
    if (!q) {
      q = new Map();
      this.queues.set(name, q);
    }
    return q;
  }

  private nextId(): string {
    return String(++this.counter);
  }

  async add<T>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>> {
    const q = this.getQueue(queueName);
    const id = options?.jobId ?? this.nextId();
    const job: Job<T> = {
      id,
      data,
      status: 'waiting',
      progress: 0,
      attempts: 0,
      createdAt: new Date(),
    };
    q.set(id, job as Job);
    return job;
  }

  async ensure<T>(
    queueName: string,
    data: T,
    options: JobOptions & { jobId: string },
  ): Promise<Job<T>> {
    const existing = await this.getJob<T>(queueName, options.jobId);
    if (existing && existing.status !== 'completed' && existing.status !== 'failed') {
      return existing;
    }
    if (existing) await this.removeJob(queueName, options.jobId);
    return this.add(queueName, data, options);
  }

  async addDelayed<T>(
    queueName: string,
    data: T,
    delayMs: number,
    options?: JobOptions,
  ): Promise<Job<T>> {
    const q = this.getQueue(queueName);
    const id = options?.jobId ?? this.nextId();
    const job: Job<T> = {
      id,
      data,
      status: 'delayed',
      progress: 0,
      attempts: 0,
      createdAt: new Date(),
    };
    q.set(id, job as Job);

    // 延迟后将状态转为 waiting
    const timerKey = `${queueName}:${id}`;
    const timer = setTimeout(() => {
      this.delayTimers.delete(timerKey);
      const existing = q.get(id);
      if (existing && existing.status === 'delayed') {
        existing.status = 'waiting';
      }
    }, delayMs);
    this.delayTimers.set(timerKey, timer);

    return job;
  }

  async addRepeatable<T>(
    queueName: string,
    data: T,
    pattern: string,
    options?: JobOptions,
  ): Promise<Job<T>> {
    this.logger.warn(
      `InMemoryQueue 不支持定时任务。pattern "${pattern}" 被忽略，仅创建一次性任务。生产环境请使用 BullMQ。`,
    );
    return this.add(queueName, data, options);
  }

  async getJob<T>(queueName: string, jobId: string): Promise<Job<T> | null> {
    const q = this.getQueue(queueName);
    return (q.get(jobId) as Job<T>) ?? null;
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const q = this.getQueue(queueName);
    q.delete(jobId);

    const timerKey = `${queueName}:${jobId}`;
    const timer = this.delayTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.delayTimers.delete(timerKey);
    }
  }

  async pause(queueName: string): Promise<void> {
    this.paused.add(queueName);
  }

  async resume(queueName: string): Promise<void> {
    this.paused.delete(queueName);
  }

  async getStats(queueName: string): Promise<QueueStats> {
    const q = this.getQueue(queueName);
    const stats: QueueStats = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    for (const job of q.values()) {
      if (job.status !== 'unknown') stats[job.status]++;
    }
    return stats;
  }

  onModuleDestroy(): void {
    for (const timer of this.delayTimers.values()) {
      clearTimeout(timer);
    }
    this.delayTimers.clear();
  }
}
