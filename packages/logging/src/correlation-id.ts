import { Injectable, NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'crypto';

const correlationStorage = new AsyncLocalStorage<string>();

/**
 * 获取当前请求的 Correlation ID
 */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

/**
 * 在指定 correlationId 上下文中运行异步函数
 * 用于在后台任务、消息消费等非 HTTP 场景中传播 correlationId
 *
 * @example
 * ```typescript
 * await runWithCorrelationId('my-task-id', async () => {
 *   // 这里 getCorrelationId() 会返回 'my-task-id'
 *   await someAsyncWork();
 * });
 * ```
 */
export function runWithCorrelationId<T>(
  correlationId: string,
  fn: () => T,
): T {
  return correlationStorage.run(correlationId, fn);
}

/**
 * 在自动生成的 correlationId 上下文中运行异步函数
 */
export function runWithNewCorrelationId<T>(fn: () => T): T {
  return correlationStorage.run(randomUUID(), fn);
}

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * NestJS 中间件：从请求头提取或生成 Correlation ID，存入 AsyncLocalStorage
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: { headers: Record<string, string | undefined> }, res: { setHeader(name: string, value: string): void }, next: () => void): void {
    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string) || randomUUID();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    correlationStorage.run(correlationId, () => {
      next();
    });
  }
}
