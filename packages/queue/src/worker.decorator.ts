import { SetMetadata } from '@nestjs/common';

export const QUEUE_WORKER_KEY = 'ZUCKER_QUEUE_WORKER';

export interface QueueWorkerOptions {
  queue: string;
  concurrency?: number;
}

/**
 * @QueueWorker — 标记一个方法为队列消费者。
 * 对标 BullMQ 的 @Process() 装饰器。
 */
export function QueueWorker(options: QueueWorkerOptions | string): MethodDecorator {
  const opts = typeof options === 'string' ? { queue: options } : options;
  return SetMetadata(QUEUE_WORKER_KEY, opts);
}
