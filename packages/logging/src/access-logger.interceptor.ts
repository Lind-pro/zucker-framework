import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  Optional,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
// The CommonJS default is the original EventEmitter2 constructor in both formats.
import EventEmitter2Constructor, { type EventEmitter2 } from 'eventemitter2';
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
import { PiiFilter } from './pii-filter';
import { AccessLogService, OperationLogService } from './persistent-logs';
import {
  HTTP_ACCESS_CAPTURED,
  HTTP_COMPLETION_OBSERVATION,
  HTTP_COMPLETION_RESPONSE,
  type ObservedHttpRequest,
} from './http-request-observation.middleware';

export const ACCESS_LOG_BUS = Symbol('ACCESS_LOG_BUS');
export const ACCESS_LOG_CAPTURE_OPTIONS = Symbol('ACCESS_LOG_CAPTURE_OPTIONS');
export interface AccessLogCaptureOptions {
  /** Retain client IPs for authorized audit/timeline queries. Disabled by default. */
  retainClientIp?: boolean;
  /** Application privacy ceilings; false also overrides controller-level opt-ins. */
  captureParameters?: boolean;
  captureResults?: boolean;
}

export interface AccessLogBus {
  publish(topic: string, payload: unknown): Promise<void>;
}

/** HTTP 请求的最小类型约束（避免 any） */
interface HttpRequest extends ObservedHttpRequest {
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
  private readonly piiFilter: PiiFilter;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(EventEmitter2Constructor) private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(ACCESS_LOG_BUS)
    private readonly bus?: AccessLogBus,
    @Optional() piiFilter?: PiiFilter,
    @Optional() private readonly accessLogs?: AccessLogService,
    @Optional() private readonly operationLogs?: OperationLogService,
    @Optional()
    @Inject(ACCESS_LOG_CAPTURE_OPTIONS)
    private readonly captureOptions?: AccessLogCaptureOptions,
  ) {
    this.piiFilter = piiFilter ?? new PiiFilter();
  }

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

    // 显式忽略日志记录
    if (loggerOptions.ignore) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const startTime = Date.now();

    const userId = request.user?.id;
    const username = this.sanitizeOptional(request.user?.username || request.user?.email);
    const method = request.method;
    const requestUrl = this.piiFilter.sanitize(request.url);
    const clientIp = this.getClientIp(request);
    const ip = this.captureOptions?.retainClientIp ? clientIp : this.piiFilter.sanitize(clientIp);
    const userAgent = this.sanitizeOptional(request.headers?.['user-agent']);

    // 完整请求头
    const httpHeaders = request.headers
      ? (this.piiFilter.sanitizeObject({
          ...request.headers,
        }) as Record<string, string | undefined>)
      : {};

    // 类+方法 action 用 "-" 拼接
    const classAction = classOptions?.action;
    const methodAction = methodOptions?.action || context.getHandler().name;
    const action =
      classAction && methodAction ? `${classAction}-${methodAction}` : classAction || methodAction;

    // 类+方法 describe 用 "\n" 拼接
    const classDescribe = classOptions?.describe;
    const methodDescribe = methodOptions?.describe;
    const describe =
      classDescribe && methodDescribe
        ? `${classDescribe}\n${methodDescribe}`
        : methodDescribe || classDescribe || '';

    const module =
      loggerOptions.module || context.getClass().name.replace('Controller', '').toLowerCase();

    // 每条日志唯一标识
    const logId = randomUUID();
    // 控制器类名
    const target = context.getClass().name;

    const correlationId = getCorrelationId();
    const sensitiveFields = loggerOptions.excludeFields ?? DEFAULT_SENSITIVE_FIELDS;

    // 忽略指定参数
    const ignoreParams = loggerOptions.ignoreParameter ?? [];
    const ignoreAll = ignoreParams.includes('*');

    const parameters =
      this.captureOptions?.captureParameters !== false && loggerOptions.logParameters !== false && !ignoreAll
        ? this.sanitizeParameters(
            this.filterIgnoredParameters(this.extractParameters(request), ignoreParams),
            sensitiveFields,
          )
        : undefined;

    // 上下文键值对
    const logContext: Record<string, string> = {};
    if (userId) logContext.userId = userId;
    if (username) logContext.username = username;
    if (correlationId) logContext.correlationId = correlationId;

    // 在请求处理之前发射事件
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

    let lastResult: unknown;
    return next.handle().pipe(
      tap({
        next: (result) => {
          lastResult = result;
        },
        complete: () => {
          const result = lastResult;
          const duration = Date.now() - startTime;
          const logResult =
            this.captureOptions?.captureResults !== false && loggerOptions.logResult === true ? this.simplifyResult(result) : undefined;
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
            exception: statusCode >= 400 ? `HTTP ${statusCode}` : undefined,
          };

          const operationPayload: OperationLogPayload = {
            module,
            action,
            status: statusCode >= 400 ? 'FAILED' : 'SUCCESS',
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

          const accessLogs = request[HTTP_ACCESS_CAPTURED] ? undefined : this.accessLogs;
          if (accessLogs) request[HTTP_ACCESS_CAPTURED] = true;
          this.eventEmitter?.emit(ACCESS_LOG_EVENT, accessPayload);
          this.eventEmitter?.emit(OPERATION_LOG_EVENT, operationPayload);
          this.bus?.publish('system/access-log', accessPayload);
          void Promise.allSettled([
            accessLogs?.log({ ...accessPayload, requestId: correlationId }, {
              completionObservation: request[HTTP_COMPLETION_OBSERVATION],
              completionResponse: request[HTTP_COMPLETION_RESPONSE],
            }),
            this.operationLogs?.log(operationPayload),
          ]);
        },
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const targetId = this.extractTargetId(request, null);

        const exceptionStr = this.piiFilter.sanitize(this.extractErrorMessage(error));

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
          errorMessage: exceptionStr,
          correlationId,
          metadata: {
            errorStack:
              error instanceof Error && error.stack
                ? this.piiFilter.sanitize(error.stack)
                : undefined,
          },
        };

        const accessLogs = request[HTTP_ACCESS_CAPTURED] ? undefined : this.accessLogs;
        if (accessLogs) request[HTTP_ACCESS_CAPTURED] = true;
        this.eventEmitter?.emit(ACCESS_LOG_EVENT, accessPayload);
        this.eventEmitter?.emit(OPERATION_LOG_EVENT, operationPayload);
        this.bus?.publish('system/access-log', accessPayload);
        void Promise.allSettled([
          accessLogs?.log({ ...accessPayload, requestId: correlationId }, {
            completionObservation: request[HTTP_COMPLETION_OBSERVATION],
            completionResponse: request[HTTP_COMPLETION_RESPONSE],
          }),
          this.operationLogs?.log(operationPayload),
        ]);

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
    return request.ip || request.socket?.remoteAddress || '';
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
   * 过滤被忽略的参数
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
    return this.piiFilter.sanitizeObject(
      new PiiFilter({
        sensitiveFields,
      }).sanitizeObject(params),
    );
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      const data = response as { message?: unknown; code?: unknown };
      const detail = Array.isArray(data.message) ? data.message[0] : data.message;
      // ValidationPipe may supply ValidationError objects containing submitted values.
      // Keep the original HTTP failure and avoid serializing those objects into logs.
      const message = typeof detail === 'string' && detail ? detail : error.message;
      return typeof data.code === 'string' && data.code ? `[${data.code}] ${message}` : message;
    }
    return error instanceof Error ? error.message : String(error);
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
        return this.piiFilter.sanitizeValue({
          type: 'array',
          length: result.length,
          sample,
        });
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
        return this.piiFilter.sanitizeValue(obj);
      } catch {
        return { type: 'circular_object', keys: Object.keys(obj) };
      }
    }

    return typeof result === 'string' ? this.piiFilter.sanitize(result) : result;
  }

  private sanitizeOptional(value: string | undefined): string | undefined {
    return value === undefined ? undefined : this.piiFilter.sanitize(value);
  }
}
