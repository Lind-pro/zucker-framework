/**
 * 任务队列接口 — 不绑定 BullMQ，通过接口抽象允许替换实现。
 */
export interface QueueProvider {
  /** 添加任务到队列 */
  add<T>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>>;
  /** 添加延迟任务 */
  addDelayed<T>(queueName: string, data: T, delayMs: number, options?: JobOptions): Promise<Job<T>>;
  /** 添加定时任务 */
  addRepeatable<T>(queueName: string, data: T, pattern: string, options?: JobOptions): Promise<Job<T>>;
  /** 获取任务状态 */
  getJob<T>(queueName: string, jobId: string): Promise<Job<T> | null>;
  /** 移除任务 */
  removeJob(queueName: string, jobId: string): Promise<void>;
  /** 暂停队列 */
  pause(queueName: string): Promise<void>;
  /** 恢复队列 */
  resume(queueName: string): Promise<void>;
  /** 获取队列统计 */
  getStats(queueName: string): Promise<QueueStats>;
}

export interface JobOptions {
  jobId?: string;
  priority?: number;
  attempts?: number;
  backoff?: { type: 'fixed' | 'exponential'; delay: number };
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

export interface Job<T = unknown> {
  id: string;
  data: T;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';
  progress: number;
  attempts: number;
  failedReason?: string;
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export const QUEUE_PROVIDER = 'QUEUE_PROVIDER';
