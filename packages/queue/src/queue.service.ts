import { Inject, Injectable } from '@nestjs/common';
import { QUEUE_PROVIDER, type QueueProvider, type Job, type JobOptions, type QueueStats } from './queue.interface';

/**
 * QueueService — 队列管理服务，对 QueueProvider 做薄封装，
 * 方便在业务代码中注入使用。
 */
@Injectable()
export class QueueService {
  constructor(
    @Inject(QUEUE_PROVIDER)
    private readonly provider: QueueProvider,
  ) {}

  /** 添加任务到队列 */
  add<T>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>> {
    return this.provider.add(queueName, data, options);
  }

  /** 添加延迟任务 */
  addDelayed<T>(queueName: string, data: T, delayMs: number, options?: JobOptions): Promise<Job<T>> {
    return this.provider.addDelayed(queueName, data, delayMs, options);
  }

  /** 添加定时任务 */
  addRepeatable<T>(queueName: string, data: T, pattern: string, options?: JobOptions): Promise<Job<T>> {
    return this.provider.addRepeatable(queueName, data, pattern, options);
  }

  /** 获取任务状态 */
  getJob<T>(queueName: string, jobId: string): Promise<Job<T> | null> {
    return this.provider.getJob(queueName, jobId);
  }

  /** 移除任务 */
  removeJob(queueName: string, jobId: string): Promise<void> {
    return this.provider.removeJob(queueName, jobId);
  }

  /** 暂停队列 */
  pause(queueName: string): Promise<void> {
    return this.provider.pause(queueName);
  }

  /** 恢复队列 */
  resume(queueName: string): Promise<void> {
    return this.provider.resume(queueName);
  }

  /** 获取队列统计 */
  getStats(queueName: string): Promise<QueueStats> {
    return this.provider.getStats(queueName);
  }
}
