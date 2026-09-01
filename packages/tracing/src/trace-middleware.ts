import { Injectable, NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface TraceContext {
  traceId: string;
  parentSpanId?: string;
  /** W3C trace flags (01 = sampled) */
  traceFlags: string;
  /** tracestate header value for vendor-specific data */
  traceState?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * 获取当前 traceId
 */
export function getTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

/**
 * 获取当前 span 的 parentSpanId
 */
export function getSpanId(): string | undefined {
  return traceStorage.getStore()?.parentSpanId;
}

/**
 * 获取当前完整 trace context
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * 在指定 trace 上下文中运行函数（用于后台任务、消息消费等）
 */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}

/**
 * 生成 W3C traceparent header 值，用于传播到下游服务
 *
 * @param traceId 32 字符 hex trace ID
 * @param spanId 16 字符 hex span ID
 * @param sampled 是否被采样
 * @returns 格式: 00-{traceId}-{spanId}-{flags}
 */
export function generateTraceparent(
  traceId: string,
  spanId: string,
  sampled = true,
): string {
  const flags = sampled ? '01' : '00';
  return `00-${traceId}-${spanId}-${flags}`;
}

/**
 * 解析 W3C Trace Context traceparent header
 * 格式: version-traceId-parentId-traceFlags
 * 例: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
function parseTraceparent(header: string): TraceContext | null {
  const parts = header.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version !== '00') return null;
  if (traceId.length !== 32 || parentId.length !== 16) return null;
  if (!/^[0-9a-fA-F]{32}$/.test(traceId) || !/^[0-9a-fA-F]{16}$/.test(parentId)) return null;
  return { traceId, parentSpanId: parentId, traceFlags: flags };
}

/**
 * NestJS 中间件：从 traceparent header 提取/生成 traceId，存入 AsyncLocalStorage
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: { headers: Record<string, string | undefined> }, res: { setHeader(name: string, value: string): void }, next: () => void): void {
    const traceparent = req.headers['traceparent'] as string | undefined;
    const tracestate = req.headers['tracestate'] as string | undefined;
    let ctx: TraceContext;

    if (traceparent) {
      const parsed = parseTraceparent(traceparent);
      ctx = parsed ?? { traceId: randomUUID().replace(/-/g, ''), traceFlags: '01' };
    } else {
      ctx = { traceId: randomUUID().replace(/-/g, ''), traceFlags: '01' };
    }

    if (tracestate) {
      ctx.traceState = tracestate;
    }

    // 生成本次请求的 spanId 并返回 traceparent
    const spanId = randomUUID().replace(/-/g, '').substring(0, 16);
    res.setHeader('traceparent', generateTraceparent(ctx.traceId, spanId, ctx.traceFlags === '01'));
    if (ctx.traceState) {
      res.setHeader('tracestate', ctx.traceState);
    }

    traceStorage.run(ctx, () => {
      next();
    });
  }
}
