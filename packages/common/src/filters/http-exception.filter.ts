import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Response } from 'express';
import { BusinessException, ValidationException } from '@zucker-framework/core';

interface ValidationErrorLike {
  property: string;
  constraints?: Record<string, string>;
  children?: ValidationErrorLike[];
}

export interface NormalizedHttpError {
  status: number;
  code: string;
  message: string;
  result: unknown;
  timestamp: number;
}
export interface HttpErrorRequest {
  requestId?: string;
  method?: string;
  url?: string;
  originalUrl?: string;
  user?: { id?: string };
}
export interface HttpErrorContext {
  exception: unknown;
  request: HttpErrorRequest;
  kind: 'validation' | 'business' | 'http' | 'unknown';
}
export interface HttpExceptionFilterOptions {
  formatResponse?: (body: NormalizedHttpError, context: HttpErrorContext) => unknown;
  onServerError?: (context: HttpErrorContext) => void;
}
export const HTTP_EXCEPTION_FILTER_OPTIONS = Symbol('HTTP_EXCEPTION_FILTER_OPTIONS');

/**
 * 统一异常过滤器
 *
 * 将所有异常转换为统一响应格式:
 * { status, code, message, result, timestamp }
 *
 * - BusinessException -> 使用异常自身的 status/code
 * - ValidationException -> 400 + 验证详情
 * - HttpException (NestJS) -> 对应 HTTP status
 * - 未知异常 -> 500 + INTERNAL_ERROR
 */
const BUSINESS_EXCEPTION_BRAND = Symbol.for('zucker.business-exception');

/**
 * True when `e` is a BusinessException: the realm-wide symbol brand set by
 * `@zucker-framework/core` first (robust against minified / renamed classes and duplicate module
 * copies), then a class named BusinessException for older core versions.
 */
function hasBusinessExceptionBrand(e: object): boolean {
  if ((e as Record<symbol, unknown>)[BUSINESS_EXCEPTION_BRAND] === true) return true;
  for (let proto = Object.getPrototypeOf(e); proto && proto !== Error.prototype; proto = Object.getPrototypeOf(proto)) {
    if ((proto as { constructor?: { name?: unknown } }).constructor?.name === 'BusinessException') return true;
  }
  return false;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);
  constructor(
    @Optional()
    @Inject(HTTP_EXCEPTION_FILTER_OPTIONS)
    private readonly options: HttpExceptionFilterOptions = {},
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let kind: HttpErrorContext['kind'] = 'unknown';
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = '服务器内部错误';
    let result: unknown = null;
    let retryAfterSeconds: number | undefined;

    if (exception instanceof ValidationException || this.isValidationLike(exception)) {
      kind = 'validation';
      // ValidationException is a BusinessException subclass — handle first for detail extraction
      const e = exception as ValidationException;
      status = e.status;
      code = e.code;
      message = e.message;
      result = e.details;
    } else if (exception instanceof BusinessException || this.isBusinessLike(exception)) {
      kind = 'business';
      // BusinessException hierarchy (NotFoundException, UnauthorizedException, ForbiddenException, etc.)
      // Also handles cross-module-boundary instanceof failures (e.g. ESM/CJS dual loading in test env)
      const e = exception as BusinessException;
      status = e.status;
      code = e.code;
      message = e.message;
      if (e.details !== undefined) {
        result = e.details;
      }
    } else if (exception instanceof HttpException) {
      kind = 'http';
      // NestJS built-in HttpException (BadRequestException, etc.)
      status = exception.getStatus();
      code = this.statusToCode(status);
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;

        // Preserve an explicit product code before falling back to Nest's
        // conventional `error` field. Product services use `{ code }` for
        // recoverable conflicts such as optimistic version mismatches.
        if (typeof resp.code === 'string') {
          code = resp.code;
        } else if (typeof resp.error === 'string') {
          code = resp.error;
        }

        if ('message' in resp) {
          if (Array.isArray(resp.message)) {
            message = this.extractValidationMessage(resp.message);
            // NestJS validation pipe produces array of messages — expose as result
            result = resp.message;
          } else if (typeof resp.message === 'string') {
            message = resp.message;
          } else {
            message = exception.message;
          }
        } else {
          message = exception.message;
        }

        // Domain port errors (`@zucker-framework/admin` mapPortError) carry a machine-readable
        // reason, validation issues and client-safe details; keep them for the client.
        if (typeof resp.reason === 'string' && ('issues' in resp || 'details' in resp || 'code' in resp)) {
          result = {
            reason: resp.reason,
            ...(Array.isArray(resp.issues) ? { issues: resp.issues.filter((item) => typeof item === 'string') } : {}),
            ...(resp.details && typeof resp.details === 'object' && !Array.isArray(resp.details) ? { details: resp.details } : {}),
          };
        }

        // Forward extra fields (e.g. retryAfter from TooManyRequestsException)
        if ('retryAfter' in resp) {
          result = { retryAfter: resp.retryAfter };
          if (
            status === HttpStatus.TOO_MANY_REQUESTS &&
            typeof resp.retryAfter === 'number' &&
            Number.isFinite(resp.retryAfter) &&
            resp.retryAfter >= 0
          ) {
            retryAfterSeconds = Math.ceil(resp.retryAfter);
          }
        }
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      // ORM/provider diagnostics can embed submitted fields, hashes, tokens and SQL values.
      // Raw details remain available to an explicitly configured onServerError reporter.
      this.logger.error('Unhandled server error');
    } else {
      this.logger.error('Unhandled non-Error exception');
    }

    // A thrown status outside the error range would make `response.status()` throw here.
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
    }

    if (response.headersSent) {
      // A streamed response has already started; writing JSON now would throw.
      this.logger.error(`Exception after response headers were sent (status ${status})`);
      if (typeof (response as { end?: () => void }).end === 'function' && !response.writableEnded) {
        response.end();
      }
      return;
    }

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }

    const body: NormalizedHttpError = { status, code, message, result, timestamp: Date.now() };
    const context: HttpErrorContext = {
      exception,
      kind,
      request: ctx.getRequest?.<HttpErrorRequest>() ?? {},
    };
    if (status >= 500) {
      try {
        this.options.onServerError?.(context);
      } catch {
        /* Reporting must not change the HTTP response. */
      }
    }
    response.status(status).json(this.options.formatResponse?.(body, context) ?? body);
  }

  /**
   * Duck-type check for BusinessException — handles cross-module instanceof failures
   * (e.g. ESM/CJS dual loading in test environments).
   */
  private isBusinessLike(e: unknown): e is BusinessException {
    const cast = e as { status?: unknown; code?: unknown; isAxiosError?: unknown };
    return (
      e instanceof Error &&
      !(e instanceof HttpException) &&
      // Only a second copy of the framework's BusinessException class qualifies. Third-party
      // client errors (Axios, provider SDKs) also carry numeric `status` + string `code`, and
      // forwarding them would leak upstream messages and turn an upstream 401 into a session expiry.
      hasBusinessExceptionBrand(e) &&
      cast.isAxiosError !== true &&
      typeof cast['status'] === 'number' &&
      typeof cast['code'] === 'string'
    );
  }

  private isValidationLike(e: unknown): e is ValidationException {
    const cast = e as { code?: unknown };
    return this.isBusinessLike(e) && cast['code'] === 'VALIDATION_ERROR';
  }

  /**
   * Map HTTP status code to a standard error code string.
   */
  private statusToCode(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 405:
        return 'METHOD_NOT_ALLOWED';
      case 406:
        return 'NOT_ACCEPTABLE';
      case 409:
        return 'CONFLICT';
      case 415:
        return 'UNSUPPORTED_MEDIA_TYPE';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'TOO_MANY_REQUESTS';
      case 500:
        return 'INTERNAL_ERROR';
      case 502:
        return 'BAD_GATEWAY';
      case 503:
        return 'SERVICE_UNAVAILABLE';
      case 504:
        return 'GATEWAY_TIMEOUT';
      default:
        return 'INTERNAL_ERROR';
    }
  }

  private extractValidationMessage(errors: unknown[]): string {
    if (errors.length === 0) {
      return '请求参数验证失败';
    }

    const firstError = errors[0];

    if (typeof firstError === 'string') {
      return firstError;
    }

    if (this.isValidationError(firstError)) {
      const constraints = firstError.constraints;
      if (constraints) {
        const messages = Object.values(constraints);
        if (messages.length > 0) {
          return messages[0];
        }
      }
      if (firstError.children && firstError.children.length > 0) {
        return this.extractValidationMessage(firstError.children);
      }
    }

    return '请求参数验证失败';
  }

  private isValidationError(obj: unknown): obj is ValidationErrorLike {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'property' in obj &&
      ('constraints' in obj || 'children' in obj)
    );
  }
}
