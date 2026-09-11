// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { HttpErrorLoggerInterceptor } from './http-error-logger.interceptor';

describe('HttpErrorLoggerInterceptor requestId safety', () => {
  const logger = {
    setContext: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  const interceptor = new HttpErrorLoggerInterceptor(logger as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function run(request: Record<string, unknown>, error: Error = new Error('failed')) {
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const next = {
      handle: () => throwError(() => error),
    } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);
  }

  it('中间件缺失时也不会把不可信请求头写入日志', async () => {
    await run({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'unsafe\nforged-log-line' },
    });

    expect(logger.error).toHaveBeenCalledWith(
      'Request Failed',
      expect.any(String),
      expect.objectContaining({
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      }),
      'HTTP',
    );
  });

  it('keeps client errors out of server stack logs without changing the host logger context', async () => {
    await run(
      { method: 'POST', url: '/items', headers: {} },
      new BadRequestException('Invalid input'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Request Rejected',
      expect.objectContaining({ status: 400 }),
      'HTTP',
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.setContext).not.toHaveBeenCalled();
  });

  it('保留中间件已验证的 Request ID', async () => {
    await run({
      requestId: 'request-1',
      method: 'GET',
      url: '/health',
      headers: {},
    });

    expect(logger.error).toHaveBeenCalledWith(
      'Request Failed',
      expect.any(String),
      expect.objectContaining({ requestId: 'request-1' }),
      'HTTP',
    );
  });
});
