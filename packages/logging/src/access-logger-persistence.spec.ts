import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from 'eventemitter2';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AccessLoggerInterceptor } from './access-logger.interceptor';
import { ACCESS_LOGGER_KEY } from './access-logger.decorator';
import { ACCESS_LOG_EVENT, OPERATION_LOG_EVENT } from './events';
import { PiiFilter } from './pii-filter';
import { HTTP_COMPLETION_OBSERVATION, HTTP_ACCESS_CAPTURED } from './http-request-observation.middleware';
import type { AccessLogService, OperationLogService } from './persistent-logs';

function setup() {
  function handler() {}
  class RecordsController {}
  Reflect.defineMetadata(
    ACCESS_LOGGER_KEY,
    { action: 'save', module: 'records', logResult: true },
    handler,
  );
  const request = {
    method: 'POST',
    url: '/records?token=secret',
    ip: '192.0.2.10',
    user: { id: 'u1' },
    headers: {},
    params: { id: 'r1' },
    body: { privateDocument: 'private', password: 'secret' },
  };
  const context = {
    getClass: () => RecordsController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 201 }) }),
  } as unknown as ExecutionContext;
  const access = { log: vi.fn().mockResolvedValue(undefined) };
  const operation = { log: vi.fn().mockResolvedValue(undefined) };
  const bus = new EventEmitter2();
  const events = { access: vi.fn(), operation: vi.fn() };
  bus.on(ACCESS_LOG_EVENT, events.access);
  bus.on(OPERATION_LOG_EVENT, events.operation);
  const interceptor = new AccessLoggerInterceptor(
    new Reflector(),
    bus,
    undefined,
    new PiiFilter({ sensitiveFields: ['privateDocument'] }),
    access as unknown as AccessLogService,
    operation as unknown as OperationLogService,
    { retainClientIp: true },
  );
  return { context, access, operation, interceptor, events };
}

describe('persistent HTTP audit capture', () => {
  it('persists each log kind once with the configured redaction and audit IP policy', async () => {
    const { interceptor, context, access, operation, events } = setup();
    const result = { id: 'r1', privateDocument: 'secret-document' };
    expect(await lastValueFrom(interceptor.intercept(context, { handle: () => of(result) }))).toBe(
      result,
    );
    expect(access.log).toHaveBeenCalledOnce();
    expect(operation.log).toHaveBeenCalledOnce();
    expect(events.access).toHaveBeenCalledOnce();
    expect(events.operation).toHaveBeenCalledOnce();
    expect(access.log).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: '192.0.2.10',
        requestUrl: '/records?token=[REDACTED]',
        parameters: {
          body: { privateDocument: '[REDACTED]', password: '[REDACTED]' },
          params: { id: 'r1' },
        },
        result: { id: 'r1', privateDocument: '[REDACTED]' },
      }),
      { completionObservation: undefined, completionResponse: undefined },
    );
    expect(operation.log).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'r1', status: 'SUCCESS' }),
    );
  });

  it('preserves structured HTTP error details and rethrows the original failure', async () => {
    const { interceptor, context, access, operation } = setup();
    const failure = new BadRequestException({
      message: ['Invalid input', 'more details'],
      code: 'INVALID_RECORD',
    });
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => failure) })),
    ).rejects.toBe(failure);
    expect(access.log).toHaveBeenCalledWith(
      expect.objectContaining({ exception: '[INVALID_RECORD] Invalid input', statusCode: 400 }),
      { completionObservation: undefined, completionResponse: undefined },
    );
    expect(operation.log).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED', errorMessage: '[INVALID_RECORD] Invalid input' }),
    );
  });

  it('attempts both log writers and does not fail an accepted request if either writer rejects', async () => {
    const { interceptor, context, access, operation } = setup();
    access.log.mockRejectedValue(new Error('storage unavailable'));
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) })),
    ).resolves.toEqual({ ok: true });
    await Promise.resolve();
    expect(operation.log).toHaveBeenCalledOnce();
  });

  it('retains a validation 400 when the response contains ValidationError objects', async () => {
    const { interceptor, context, access, operation } = setup();
    const failure = new BadRequestException([
      { property: 'email', value: 'private@example.test', constraints: { isEmail: 'Invalid email' } },
    ]);
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => failure) })),
    ).rejects.toBe(failure);
    expect(access.log).toHaveBeenCalledWith(
      expect.objectContaining({ exception: 'Bad Request Exception', statusCode: 400 }),
      { completionObservation: undefined, completionResponse: undefined },
    );
    expect(operation.log).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED', errorMessage: 'Bad Request Exception' }),
    );
  });

  it('captures a streaming action once and forwards the final HTTP observation acknowledgement', async () => {
    const { interceptor, context, access, operation, events } = setup();
    const request = context.switchToHttp().getRequest();
    request[HTTP_COMPLETION_OBSERVATION] = Promise.resolve(true);
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ chunk: 1 }, { chunk: 2 }) }));
    expect(access.log).toHaveBeenCalledOnce();
    expect(operation.log).toHaveBeenCalledOnce();
    expect(events.access).toHaveBeenCalledOnce();
    expect(request[HTTP_ACCESS_CAPTURED]).toBe(true);
    expect(access.log).toHaveBeenCalledWith(expect.objectContaining({ result: { chunk: 2 } }), {
      completionObservation: request[HTTP_COMPLETION_OBSERVATION],
      completionResponse: undefined,
    });
  });
});
