import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { BusinessException, ValidationException } from '@zucker/core';

interface ValidationErrorLike {
  property: string;
  constraints?: Record<string, string>;
  children?: ValidationErrorLike[];
}

/**
 * 统一异常过滤器
 *
 * 参考 hsweb CommonErrorControllerAdvice — 将所有异常转换为统一响应格式:
 * { status, code, message, result, timestamp }
 *
 * 对比 hsweb:
 * - BusinessException -> 使用异常自身的 status/code
 * - ValidationException -> 400 + 验证详情
 * - HttpException (NestJS) -> 对应 HTTP status
 * - 未知异常 -> 500 + INTERNAL_ERROR
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = '服务器内部错误';
    let result: unknown = null;
    let retryAfterSeconds: number | undefined;

    if (exception instanceof ValidationException || this.isValidationLike(exception)) {
      // ValidationException is a BusinessException subclass — handle first for detail extraction
      const e = exception as ValidationException;
      status = e.status;
      code = e.code;
      message = e.message;
      result = e.details;
    } else if (exception instanceof BusinessException || this.isBusinessLike(exception)) {
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
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
    } else {
      this.logger.error(`Unhandled non-Error exception: ${String(exception)}`);
    }

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }

    response.status(status).json({
      status,
      code,
      message,
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Duck-type check for BusinessException — handles cross-module instanceof failures
   * (e.g. ESM/CJS dual loading in test environments).
   */
  private isBusinessLike(e: unknown): e is BusinessException {
    const cast = e as { status?: unknown; code?: unknown };
    return (
      e instanceof Error &&
      typeof cast['status'] === 'number' &&
      typeof cast['code'] === 'string' &&
      !(e instanceof HttpException)
    );
  }

  private isValidationLike(e: unknown): e is ValidationException {
    const cast = e as { code?: unknown };
    return this.isBusinessLike(e) && cast['code'] === 'VALIDATION_ERROR';
  }

  /**
   * Map HTTP status code to a standard error code string.
   * 参考 hsweb CodeConstants.Error
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
