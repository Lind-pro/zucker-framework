import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from 'eventemitter2';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AccessLoggerInterceptor } from './access-logger.interceptor';
import { ACCESS_LOGGER_KEY } from './access-logger.decorator';
import { ACCESS_LOG_EVENT } from './events';
import type { AccessLogService } from './persistent-logs';

function setup(bus: { publish: (topic: string, payload: unknown) => Promise<void> }, emitter = new EventEmitter2()) {
  function handler() {}
  class AccountsController {}
  Reflect.defineMetadata(ACCESS_LOGGER_KEY, { action: 'change' }, handler);
  const request = {
    method: 'POST',
    url: '/accounts/password',
    ip: '192.0.2.10',
    headers: {
      authorization: 'Bearer abc',
      'x-api-key': 'raw-api-key',
      'x-auth-token': 'raw-auth-token',
      'content-type': 'application/json',
    },
    body: {
      oldPassword: 'old-secret',
      newPassword: 'new-secret',
      code: '123456',
      title: 'visible',
    },
  };
  const context = {
    getClass: () => AccountsController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
  } as unknown as ExecutionContext;
  const access = { log: vi.fn().mockResolvedValue(undefined) };
  const interceptor = new AccessLoggerInterceptor(
    new Reflector(),
    emitter,
    bus,
    undefined,
    access as unknown as AccessLogService,
  );
  return { context, access, interceptor };
}

describe('AccessLoggerInterceptor hardening', () => {
  it('does not leak an unhandled rejection when the bus publish fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { interceptor, context } = setup({ publish: () => Promise.reject(new Error('bus down')) });
      await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps a successful response when a log listener throws', async () => {
    const emitter = new EventEmitter2();
    emitter.on(ACCESS_LOG_EVENT, () => {
      throw new Error('listener bug');
    });
    const { interceptor, context } = setup({ publish: async () => undefined }, emitter);
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) })),
    ).resolves.toEqual({ ok: true });
  });

  it('redacts password-change parameters and credential headers', async () => {
    const { interceptor, context, access } = setup({ publish: async () => undefined });
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));
    const payload = access.log.mock.calls[0][0];
    expect(payload.parameters).toEqual({
      body: { oldPassword: '[REDACTED]', newPassword: '[REDACTED]', code: '[REDACTED]', title: 'visible' },
    });
    expect(payload.httpHeaders).toEqual({
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-auth-token': '[REDACTED]',
      'content-type': 'application/json',
    });
    expect(JSON.stringify(payload)).not.toMatch(/secret|raw-api-key|raw-auth-token|123456/);
  });
});

describe('AccessLoggerInterceptor URL redaction', () => {
  function urlSetup(url: string, query: Record<string, unknown>, options: Record<string, unknown> = {}) {
    function handler() {}
    class CallbackController {}
    Reflect.defineMetadata(ACCESS_LOGGER_KEY, { action: 'callback', ...options }, handler);
    const request = {
      method: 'GET',
      url,
      ip: '192.0.2.10',
      headers: { 'content-type': 'application/json' },
      query,
    };
    const context = {
      getClass: () => CallbackController,
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    } as unknown as ExecutionContext;
    const access = { log: vi.fn().mockResolvedValue(undefined) };
    const interceptor = new AccessLoggerInterceptor(
      new Reflector(),
      new EventEmitter2(),
      { publish: async () => undefined },
      undefined,
      access as unknown as AccessLogService,
    );
    return { context, access, interceptor };
  }

  it('redacts ?code= in the stored URL and in parameters.query together', async () => {
    const { interceptor, context, access } = urlSetup('/cb?code=x&page=2', { code: 'x', page: '2' });
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));
    const payload = access.log.mock.calls[0][0];
    expect(payload.requestUrl).toContain('code=[REDACTED]');
    expect(payload.requestUrl).toContain('page=2');
    expect(payload.requestUrl).not.toContain('code=x');
    expect(payload.parameters.query.code).toBe('[REDACTED]');
  });

  it('applies excludeFields to the URL as well', async () => {
    const { interceptor, context, access } = urlSetup(
      '/cb?ticketNo=T-99&page=2',
      { ticketNo: 'T-99', page: '2' },
      { excludeFields: ['ticketNo'] },
    );
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));
    const payload = access.log.mock.calls[0][0];
    expect(payload.requestUrl).toContain('ticketNo=[REDACTED]');
    expect(payload.requestUrl).not.toContain('T-99');
    expect(payload.parameters.query.ticketNo).toBe('[REDACTED]');
  });
});
