import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from 'eventemitter2';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { randomUUID } from 'crypto';
import { ACCESS_LOGGER_KEY, AccessLoggerOptions } from './access-logger.decorator';
import {
  ACCESS_LOG_EVENT,
  ACCESS_LOG_BEFORE_EVENT,
  OPERATION_LOG_EVENT,
  AccessLogPayload,
  OperationLogPayload,
} from './events';
import { getCorrelationId } from './correlation-id';

export const ACCESS_LOG_BUS = Symbol('ACCESS_LOG_BUS');

export interface AccessLogBus {
  publish(topic: string, payload: unknown): Promise<void>;
}

/** HTTP 请求的最小类型约束（避免 any） */
interface HttpRequest {
  user?: { id?: string; username?: string; email?: string };
  method: string;
  url: string;
  ip?: string;
  headers?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  socket?: { remoteAddress?: string };
}

/** 默认排除的敏感字段 */
const DEFAULT_SENSITIVE_FIELDS = ['password', 'secret', 'token', 'authorization', 'creditCard'];

@Injectable()
export class AccessLoggerInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(ACCESS_LOG_BUS)
    private readonly bus?: AccessLogBus,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Support class + method level composition:
    // Method-level metadata takes precedence, class-level provides defaults
    const classOptions = this.reflector.get<AccessLoggerOptions>(
      ACCESS_LOGGER_KEY,
      context.getClass(),
    );
    const methodOptions = this.reflector.get<AccessLoggerOptions>(
      ACCESS_LOGGER_KEY,
      context.getHandler(),
    );

    const loggerOptions: AccessLoggerOptions | undefined = methodOptions
      ? { ...classOptions, ...methodOptions }
      : classOptions;

    // 未标注装饰器 → 跳过
    if (!loggerOptions) {
      return next.handle();
    }

    // 对齐 hsweb AccessLogger.ignore — 显式忽略日志记录
    if (loggerOptions.ignore) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const startTime = Date.now();

    const userId = request.user?.id;
    const username = request.user?.username || request.user?.email;
    const method = request.method;
    const requestUrl = request.url;
    const ip = this.getClientIp(request);
    const userAgent = request.headers?.['user-agent'];

    // 对齐 hsweb AccessLoggerInfo.httpHeaders — 完整请求头
    const httpHeaders: Record<string, string | undefined> = request.headers
      ? { ...request.headers }
      : {};

    // 对齐 hsweb DefaultAccessLoggerParser.parse — 类+方法 action 用 "-" 拼接
    const classAction = classOptions?.action;
    const methodAction = methodOptions?.action || context.getHandler().name;
    const action =
      classAction && methodAction
        ? `${classAction}-${methodAction}`
        : classAction || methodAction;

    // 对齐 hsweb DefaultAccessLoggerParser.parse — 类+方法 describe 用 "\n" 拼接
    const classDescribe = classOptions?.describe;
    const methodDescribe = methodOptions?.describe;
    const describe =
      classDescribe && methodDescribe
        ? `${classDescribe}\n${methodDescribe}`
        : methodDescribe || classDescribe || '';

    const module =
      loggerOptions.module ||
      context.getClass().name.replace('Controller', '').toLowerCase();

    // 对齐 hsweb AccessLoggerInfo.id — 每条日志唯一标识
    const logId = randomUUID();
    // 对齐 hsweb AccessLoggerInfo.target — 控制器类名
    const target = context.getClass().name;

    const correlationId = getCorrelationId();
    const sensitiveFields = loggerOptions.excludeFields ?? DEFAULT_SENSITIVE_FIELDS;

    // 对齐 hsweb AccessLogger.ignoreParameter — 忽略指定参数
    const ignoreParams = loggerOptions.ignoreParameter ?? [];
    const ignoreAll = ignoreParams.includes('*');

    const parameters =
      loggerOptions.logParameters !== false && !ignoreAll
        ? this.sanitizeParameters(
            this.filterIgnoredParameters(
              this.extractParameters(request),
              ignoreParams,
            ),
            sensitiveFields,
          )
        : undefined;

    // 对齐 hsweb AccessLoggerInfo.context — 上下文键值对
    const logContext: Record<string, string> = {};
    if (userId) logContext.userId = userId;
    if (username) logContext.username = username;
    if (correlationId) logContext.correlationId = correlationId;

    // 对齐 hsweb AccessLoggerBeforeEvent — 在请求处理之前发射事件
    const beforePayload: AccessLogPayload = {
      id: logId,
      action,
      describe,
      module,
      target,
      userId,
      username,
      requestUrl,
      method,
      ip,
      userAgent,
      httpHeaders,
      context: logContext,
      requestTime: new Date(startTime),
      responseTime: 0,
      parameters,
      correlationId,
    };
    this.eventEmitter?.emit(ACCESS_LOG_BEFORE_EVENT, beforePayload);

    return next.handle().pipe(
      tap((result) => {
        const duration = Date.now() - startTime;
        const logResult =
          loggerOptions.logResult === true
            ? this.simplifyResult(result)
            : undefined;
        const targetId = this.extractTargetId(request, result);

        const response = context.switchToHttp().getResponse();
        const statusCode = response?.statusCode ?? 200;

        const accessPayload: AccessLogPayload = {
          id: logId,
          action,
          describe,
          module,
          target,
          userId,
          username,
          requestUrl,
          method,
          ip,
          userAgent,
          httpHeaders,
          context: logContext,
          requestTime: new Date(startTime),
          responseTime: duration,
          parameters,
          result: logResult,
          correlationId,
          statusCode,
        };

        const operationPayload: OperationLogPayload = {
          module,
          action,
          status: 'SUCCESS',
          userId,
          targetId,
          targetType: loggerOptions.targetType,
          method,
          path: requestUrl,
          ipAddress: ip,
          userAgent,
          duration,
          requestData: parameters,
          responseData: logResult,
          correlationId,
        };

        this.eventEmitter?.emit(ACCESS_LOG_EVENT, accessPayload);
        this.eventEmitter?.emit(OPERATION_LOG_EVENT, operationPayload);
        this.bus?.publish('system/access-log', accessPayload);
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const targetId = this.extractTargetId(request, null);

        // 对齐 hsweb AccessLoggerInfo.toSimpleMap — exception 包含完整堆栈
        const exceptionStr =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);

        const accessPayload: AccessLogPayload = {
          id: logId,
          action,
          describe,
          module,
          target,
          userId,
          username,
          requestUrl,
          method,
          ip,
          userAgent,
          httpHeaders,
          context: logContext,
          requestTime: new Date(startTime),
          responseTime: duration,
          parameters,
          exception: exceptionStr,
          correlationId,
          statusCode: error?.status ?? 500,
        };

        const operationPayload: OperationLogPayload = {
          module,
          action,
          status: 'FAILED',
          userId,
          targetId,
          targetType: loggerOptions.targetType,
          method,
          path: requestUrl,
          ipAddress: ip,
          userAgent,
          duration,
          requestData: parameters,
          errorMessage: error instanceof Error ? error.message : String(error),
          correlationId,
          metadata: {
            errorStack: error instanceof Error ? error.stack : undefined,
          },
        };

        this.eventEmitter?.emit(ACCESS_LOG_EVENT, accessPayload);
        this.eventEmitter?.emit(OPERATION_LOG_EVENT, operationPayload);
        this.bus?.publish('system/access-log', accessPayload);

        return throwError(() => error);
      }),
    );
  }

  private extractTargetId(request: HttpRequest, result: unknown): string | undefined {
    if (request.params?.id) return request.params.id;
    if (request.body?.id) return String(request.body.id);
    const res = result as Record<string, unknown> | null;
    if (res?.id) return String(res.id);
    const resData = res?.data as Record<string, unknown> | undefined;
    if (resData?.id) return String(resData.id);
    return undefined;
  }

  private getClientIp(request: HttpRequest): string {
    return (
      request.ip ||
      request.headers?.['x-forwarded-for'] ||
      request.headers?.['x-real-ip'] ||
      request.socket?.remoteAddress ||
      ''
    );
  }

  private extractParameters(request: HttpRequest): Record<string, unknown> | undefined {
    const params: Record<string, unknown> = {};
    if (request.query && Object.keys(request.query).length > 0) {
      params.query = request.query;
    }
    if (request.body && Object.keys(request.body).length > 0) {
      params.body = request.body;
    }
    if (request.params && Object.keys(request.params).length > 0) {
      params.params = request.params;
    }
    return Object.keys(params).length > 0 ? params : undefined;
  }

  /**
   * 过滤被忽略的参数 — 对齐 hsweb AccessLogger.ignoreParameter / DefaultAccessLoggerParser.ignoreParameter
   */
  private filterIgnoredParameters(
    params: Record<string, unknown> | undefined,
    ignoreParams: string[],
  ): Record<string, unknown> | undefined {
    if (!params || ignoreParams.length === 0) return params;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === 'body' && typeof value === 'object' && value !== null) {
        const bodyFiltered: Record<string, unknown> = {};
        for (const [bk, bv] of Object.entries(value as Record<string, unknown>)) {
          if (!ignoreParams.includes(bk)) {
            bodyFiltered[bk] = bv;
          }
        }
        if (Object.keys(bodyFiltered).length > 0) {
          filtered[key] = bodyFiltered;
        }
      } else if (key === 'query' && typeof value === 'object' && value !== null) {
        const queryFiltered: Record<string, unknown> = {};
        for (const [qk, qv] of Object.entries(value as Record<string, unknown>)) {
          if (!ignoreParams.includes(qk)) {
            queryFiltered[qk] = qv;
          }
        }
        if (Object.keys(queryFiltered).length > 0) {
          filtered[key] = queryFiltered;
        }
      } else {
        filtered[key] = value;
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  }

  private sanitizeParameters(
    params: Record<string, unknown> | undefined,
    sensitiveFields: string[],
  ): Record<string, unknown> | undefined {
    if (!params) return undefined;
    return JSON.parse(JSON.stringify(params, (key, value) => {
      if (sensitiveFields.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        return '***';
      }
      return value;
    }));
  }

  private simplifyResult(result: unknown): unknown {
    if (result === null || result === undefined) return null;

    if (Array.isArray(result)) {
      const sample = result.slice(0, 10);
      try {
        const sampleStr = JSON.stringify(sample);
        if (sampleStr.length > 5120) {
          return { type: 'array', length: result.length, sample: '[数据过大]' };
        }
        return { type: 'array', length: result.length, sample };
      } catch {
        return { type: 'array', length: result.length, sample: '[无法序列化]' };
      }
    }

    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      try {
        const str = JSON.stringify(obj);
        if (str.length > 10240) {
          return { type: 'large_object', size: str.length, keys: Object.keys(obj) };
        }
        return obj;
      } catch {
        return { type: 'circular_object', keys: Object.keys(obj) };
      }
    }

    return result;
  }
}
