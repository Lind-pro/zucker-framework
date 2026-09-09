export const ACCESS_LOG_EVENT = 'zucker.access-log';
export const ACCESS_LOG_BEFORE_EVENT = 'zucker.access-log.before';
export const OPERATION_LOG_EVENT = 'zucker.operation-log';
export const SYSTEM_LOG_EVENT = 'zucker.system-log';

/**
 * 访问日志数据
 *
 * 新增字段（相对初始版本）:
 * - httpHeaders: 完整请求头映射
 * - context: 上下文键值对
 */
export interface AccessLogPayload {
  /** 日志唯一 ID */
  id: string;
  action: string;
  describe: string;
  module: string;
  /** 目标类/控制器名 */
  target?: string;
  userId?: string;
  username?: string;
  requestUrl: string;
  method: string;
  ip: string;
  userAgent?: string;
  /** HTTP 请求头集合 */
  httpHeaders?: Record<string, string | undefined>;
  /** 上下文键值对 */
  context?: Record<string, string>;
  requestTime: Date;
  responseTime: number;
  parameters?: Record<string, unknown>;
  result?: unknown;
  exception?: string;
  correlationId?: string;
  statusCode?: number;
}

export interface OperationLogPayload {
  module: string;
  action: string;
  status: 'SUCCESS' | 'FAILED';
  userId?: string;
  targetId?: string;
  targetType?: string;
  method: string;
  path: string;
  ipAddress: string;
  userAgent?: string;
  duration: number;
  requestData?: unknown;
  responseData?: unknown;
  errorMessage?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 系统日志事件数据 — 对齐 jetlinks SystemLoggingEvent / SerializableSystemLog
 */
export interface SystemLogPayload {
  id: string;
  name: string;
  level: string;
  message: string;
  className?: string;
  methodName?: string;
  threadName?: string;
  exceptionStack?: string;
  createTime: Date;
  context?: Record<string, string>;
}

/**
 * 将 AccessLogPayload 转为可序列化的简单 Map
 *
 * @param payload 访问日志数据
 * @param objectFilter 可选的值过滤函数
 *   用于对 parameters / response 等值做序列化转换（如截断大对象）
 */
export function accessLogToSimpleMap(
  payload: AccessLogPayload,
  objectFilter?: (value: unknown) => unknown,
): Record<string, unknown> {
  const filter = objectFilter ?? ((v: unknown) => v);
  const map: Record<string, unknown> = {
    id: payload.id,
    action: payload.action,
    describe: payload.describe,
    module: payload.module,
    target: payload.target ?? '',
    method: payload.method,
    ip: payload.ip,
    url: payload.requestUrl,
    httpHeaders: payload.httpHeaders,
    httpMethod: payload.method,
    parameters: payload.parameters,
    response: filter(payload.result),
    requestTime: payload.requestTime.getTime(),
    responseTime: payload.requestTime.getTime() + payload.responseTime,
    useTime: payload.responseTime,
    userId: payload.userId,
    username: payload.username,
    correlationId: payload.correlationId,
    statusCode: payload.statusCode,
    context: payload.context,
  };
  if (payload.exception) {
    map.exception = payload.exception;
  }
  return map;
}
