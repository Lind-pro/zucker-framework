import {
  Injectable,
  Inject,
  Optional,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { normalizeCorrelationId } from './correlation-id';
import { ApplicationLogger } from './application-logger';
import { LogSanitizer } from './log-sanitizer';
import { BusinessException } from '@zucker-framework/core';

export interface HttpFailureContext {
  requestId: string;
  method: string;
  endpoint: string;
  userId?: string;
  ip: string;
  userAgent: string;
  duration: number;
  extras: Record<string, unknown>;
}
export interface HttpErrorLoggerOptions {
  slowRequestMs?: number;
  /** Disable when the exception filter owns server-error stack logging. */
  logServerErrors?: boolean;
  onServerError?: (error: Error, context: HttpFailureContext) => void | Promise<void>;
}
export const HTTP_ERROR_LOGGER_OPTIONS = Symbol('HTTP_ERROR_LOGGER_OPTIONS');

@Injectable()
export class HttpErrorLoggerInterceptor implements NestInterceptor {
  constructor(
    @Inject(ApplicationLogger) private readonly logger: ApplicationLogger,
    @Optional()
    @Inject(HTTP_ERROR_LOGGER_OPTIONS)
    private readonly options: HttpErrorLoggerOptions = {},
    @Optional() @Inject(LogSanitizer) private readonly sanitizer: LogSanitizer = new LogSanitizer(),
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, url } = request;
    const now = Date.now();
    // 正常路径由相关 ID 中间件注入；fallback 仍必须经过同一安全规则，
    // 不能把不可信请求头直接写入日志。
    const requestId = normalizeCorrelationId(request.requestId ?? request.headers['x-request-id']);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - now;
          if (this.options.slowRequestMs !== undefined && duration > this.options.slowRequestMs)
            this.logger.warn('Slow Request', { method, url, requestId, duration }, 'HTTP');
        },
        error: (error) => {
          const status =
            error instanceof HttpException
              ? error.getStatus()
              : error instanceof BusinessException
                ? error.status
                : 500;
          const meta = {
            requestId,
            method,
            url,
            status,
            duration: `${Date.now() - now}ms`,
            error: {
              name: error instanceof Error ? error.name : String(error),
              message: error instanceof Error ? error.message : String(error),
              code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
            },
          };
          // 业务 4xx（验证码错误 / 令牌过期 / 邮箱已注册等）是预期客户端错误：
          // 记 warn 且不带堆栈，避免淹没真正的 5xx 服务端故障。
          if (status >= 500) {
            if (this.options.onServerError) {
              const failure: HttpFailureContext = {
                requestId,
                method,
                endpoint: this.sanitizer.sanitizeText(url),
                userId: request.user?.id,
                ip: this.sanitizer.sanitizeText(
                  request.ip || request.connection?.remoteAddress || '',
                ),
                userAgent: this.sanitizer.sanitizeText(request.headers?.['user-agent'] || ''),
                duration: Date.now() - now,
                extras: this.sanitizer.sanitizeValue({
                  body: request.body,
                  query: request.query,
                  params: request.params,
                }),
              };
              try {
                const observed = this.options.onServerError(
                  error instanceof Error ? error : new Error(String(error)),
                  failure,
                );
                if (observed)
                  void observed.catch(() => this.logger.warn('Error observation failed', 'HTTP'));
              } catch {
                this.logger.warn('Error observation failed', 'HTTP');
              }
            }
            if (this.options.logServerErrors !== false)
              this.logger.error(
                'Request Failed',
                error instanceof Error ? error.stack : undefined,
                meta,
                'HTTP',
              );
          } else {
            this.logger.warn('Request Rejected', meta, 'HTTP');
          }
        },
      }),
    );
  }
}
