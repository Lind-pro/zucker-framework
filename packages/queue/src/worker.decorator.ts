import { SetMetadata } from '@nestjs/common';

export const QUEUE_WORKER_KEY = 'ZUCKER_QUEUE_WORKER';

export interface QueueWorkerOptions {
  queue: string;
  concurrency?: number;
}

/**
 * @QueueWorker — 标记一个 provider 方法为队列消费者。
 * 对标 BullMQ 的 @Process() 装饰器。
 *
 * 仅当 `ZuckerQueueModule.forRoot({ workerHost })`（或 forRootAsync 返回 workerHost）
 * 配置了 BullMqWorkerHost 时才会在应用启动时注册并运行；方法接收 `QueueWorkerJob`。
 * 未配置 workerHost 时会在启动日志中警告，方法不会被调用。
 */
export function QueueWorker(options: QueueWorkerOptions | string): MethodDecorator {
  const opts = typeof options === 'string' ? { queue: options } : options;
  return SetMetadata(QUEUE_WORKER_KEY, opts);
}
