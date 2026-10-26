// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { lastValueFrom, of, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessLoggerInterceptor } from './access-logger.interceptor';
import { ACCESS_LOGGER_KEY } from './access-logger.decorator';
import { HttpRequestObservationMiddleware, type ObservedHttpRequest } from './http-request-observation.middleware';
import { AccessLogService } from './persistent-logs';
import { RejectedRequestLoggerMiddleware } from './rejected-request-logger.middleware';

class Response extends EventEmitter { statusCode = 200; }
function setup() {
  function handler() {}
  class RecordsController {}
  Reflect.defineMetadata(ACCESS_LOGGER_KEY, { describe: 'Read record', module: 'records' }, handler);
  const create = vi.fn().mockResolvedValue({ id: 'saved' });
  const db = { model: () => ({ create }) as unknown as ModelOperations } as DatabaseAdapter;
  const shouldPersist = vi.fn((input, context) => !context.completionObserved || input.statusCode >= 400 || input.responseTime >= 3000);
  const access = new AccessLogService(db, undefined, { accessShouldPersist: shouldPersist });
  const writes = vi.spyOn(access, 'log');
  const request: ObservedHttpRequest & { method: string; url: string; path: string; headers: Record<string, string>; route: { path: string } } = {
    method: 'GET', url: '/records/r1', path: '/records/r1', headers: {}, route: { path: '/records/:id' },
  };
  const response = new Response();
  const observation = vi.fn().mockResolvedValue(true);
  new HttpRequestObservationMiddleware({ onComplete: observation, slowRequestMs: 3000 }, access).use(request, response, () => {});
  new RejectedRequestLoggerMiddleware(access, {}).use(request, response, () => {});
  const context = {
    getClass: () => RecordsController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  const interceptor = new AccessLoggerInterceptor(new Reflector(), undefined, undefined, undefined, access);
  return { response, create, writes, shouldPersist, observation, context, interceptor };
}
afterEach(() => vi.useRealTimers());

describe('final HTTP response governs access sampling and retention', () => {
  it('retains a serialization failure even when the decorated handler returned successfully', async () => {
    const { response, create, writes, shouldPersist, observation, context, interceptor } = setup();
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));
    expect(create).not.toHaveBeenCalled();
    expect(shouldPersist).not.toHaveBeenCalled();
    response.statusCode = 503;
    response.emit('finish');
    response.emit('close');
    await writes.mock.results[0].value;
    expect(observation).toHaveBeenCalledOnce();
    expect(writes).toHaveBeenCalledOnce();
    expect(shouldPersist).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503, exception: 'HTTP 503' }), { completionObserved: true });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ exception: 'HTTP 503' }) });
  });

  it('retains a slow streamed response although its handler emitted all chunks quickly', async () => {
    vi.useFakeTimers();
    const { response, create, writes, shouldPersist, observation, context, interceptor } = setup();
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ chunk: 1 }, { chunk: 2 }) }));
    vi.advanceTimersByTime(3500);
    response.emit('finish');
    await writes.mock.results[0].value;
    expect(writes).toHaveBeenCalledOnce();
    expect(observation).toHaveBeenCalledOnce();
    expect(shouldPersist).toHaveBeenCalledWith(expect.objectContaining({ responseTime: 3500, statusCode: 200 }), { completionObserved: true });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ responseTime: 3500 }) });
  });

  it('does not duplicate the aborted detail when a stream completes after HTTP close', async () => {
    const { response, create, writes, context, interceptor } = setup();
    const stream = new Subject<number>();
    const completion = lastValueFrom(interceptor.intercept(context, { handle: () => stream }));
    stream.next(1);
    response.emit('close');
    stream.complete();
    await completion;
    await writes.mock.results[0].value;
    expect(writes).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ exception: 'HTTP 499' }) });
  });
});
