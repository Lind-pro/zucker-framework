import { Injectable, NestMiddleware, Inject, Optional } from '@nestjs/common';
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
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run(correlationId, fn);
}

/**
 * 在自动生成的 correlationId 上下文中运行异步函数
 */
export function runWithNewCorrelationId<T>(fn: () => T): T {
  return correlationStorage.run(randomUUID(), fn);
}

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeCorrelationId(value: unknown): string {
  return typeof value === 'string' && SAFE_CORRELATION_ID.test(value) ? value : randomUUID();
}

export interface CorrelationIdOptions {
  headerName?: string;
  requestProperty?: string;
}
export const CORRELATION_ID_OPTIONS = Symbol('CORRELATION_ID_OPTIONS');

/**
 * NestJS 中间件：从请求头提取或生成 Correlation ID，存入 AsyncLocalStorage
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(
    @Optional() @Inject(CORRELATION_ID_OPTIONS) private readonly options: CorrelationIdOptions = {},
  ) {}
  use(
    req: { headers: Record<string, string | string[] | undefined>; [key: string]: unknown },
    res: { setHeader(name: string, value: string): void },
    next: () => void,
  ): void {
    const header = this.options.headerName ?? CORRELATION_ID_HEADER;
    const correlationId = normalizeCorrelationId(req.headers[header.toLowerCase()]);
    if (this.options.requestProperty) req[this.options.requestProperty] = correlationId;

    res.setHeader(header, correlationId);

    correlationStorage.run(correlationId, () => {
      next();
    });
  }
}
