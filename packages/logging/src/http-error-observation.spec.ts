// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { LogSanitizer } from './log-sanitizer';
import { HttpErrorLoggerInterceptor } from './http-error-logger.interceptor';

describe('HttpErrorLoggerInterceptor — 原始异常保真', () => {
  const trackError = vi.fn().mockResolvedValue(undefined);
  const interceptor = new HttpErrorLoggerInterceptor(
    { warn: vi.fn(), error: vi.fn() } as never,
    { onServerError: trackError, logServerErrors: false },
    new LogSanitizer({ sensitiveFields: ['privateText'] }),
  );

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        requestId: 'request-1',
        method: 'POST',
        url: '/records/generate',
        ip: '127.0.0.1',
        connection: {},
        headers: { 'user-agent': 'test' },
        user: { id: 'user-1' },
        body: { privateText: 'sensitive text' },
        query: {},
        params: {},
      }),
    }),
  } as unknown as ExecutionContext;

  const run = (error: unknown) => {
    const next = {
      handle: () => throwError(() => error),
    } as CallHandler;
    return firstValueFrom(interceptor.intercept(context, next));
  };

  beforeEach(() => {
    trackError.mockClear();
  });

  it('原样重抛未知 Error，让过滤器拿到原始堆栈', async () => {
    const error = new Error('provider failed');

    await expect(run(error)).rejects.toBe(error);
    expect(trackError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ requestId: 'request-1' }),
    );
  });

  it('原样重抛 5xx HttpException 并计入聚合', async () => {
    const error = new InternalServerErrorException('database failed');

    await expect(run(error)).rejects.toBe(error);
    expect(trackError).toHaveBeenCalledWith(error, expect.any(Object));
  });

  it('4xx 业务异常不进入错误聚合，但仍原样交给过滤器', async () => {
    const error = new BadRequestException('invalid input');

    await expect(run(error)).rejects.toBe(error);
    expect(trackError).not.toHaveBeenCalled();
  });
});
