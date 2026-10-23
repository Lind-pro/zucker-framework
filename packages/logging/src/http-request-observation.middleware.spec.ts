// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestObservationMiddleware, HTTP_COMPLETION_OBSERVATION, type HttpRequestObservationOptions, type ObservedHttpRequest } from './http-request-observation.middleware';
import { RejectedRequestLoggerMiddleware } from './rejected-request-logger.middleware';
import { runWithCorrelationId } from './correlation-id';
import type { AccessLogService } from './persistent-logs';

class Response extends EventEmitter { statusCode = 200; }
function setup(options: Partial<HttpRequestObservationOptions> = {}) {
  const onComplete = vi.fn().mockResolvedValue(true);
  const log = vi.fn().mockResolvedValue(undefined);
  const logs = { log } as unknown as AccessLogService;
  const middleware = new HttpRequestObservationMiddleware({ onComplete, ...options }, logs);
  const request: ObservedHttpRequest & { path: string; url: string; method: string; ip: string; headers: Record<string, string>; route?: { path: unknown }; user?: { id: string } } = {
    path: '/records/private-id', url: '/records/private-id?token=secret', method: 'GET', ip: '192.0.2.5', headers: {},
  };
  const response = new Response();
  const next = vi.fn();
  runWithCorrelationId('synthetic-request', () => middleware.use(request, response, next));
  return { request, response, next, log, logs, onComplete };
}
afterEach(() => vi.useRealTimers());

describe('complete HTTP observations', () => {
  it('observes every successful response once at finish using only the matched route template', async () => {
    const { request, response, onComplete, next } = setup({ retainClientIp: true });
    request.route = { path: '/records/:id' };
    request.user = { id: 'synthetic-user' };
    expect(next).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    response.emit('finish');
    response.emit('close');
    await expect(request[HTTP_COMPLETION_OBSERVATION]).resolves.toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(response.listenerCount('finish')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', route: '/records/:id', statusCode: 200, outcome: 'finished',
      userId: 'synthetic-user', requestId: 'synthetic-request', ip: '192.0.2.5', requestTime: expect.any(Date),
    }));
    expect(JSON.stringify(onComplete.mock.calls)).not.toContain('private-id');
    expect(JSON.stringify(onComplete.mock.calls)).not.toContain('token');
  });

  it('groups unmatched requests as unknown, omits IPs by default and keeps one error detail across both middlewares', async () => {
    const { request, response, onComplete, logs, log } = setup();
    new RejectedRequestLoggerMiddleware(logs, {}).use(request, response, () => {});
    response.statusCode = 404;
    response.emit('finish');
    response.emit('close');
    await request[HTTP_COMPLETION_OBSERVATION];
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ route: 'unknown', ip: undefined, statusCode: 404 }));
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ exception: 'HTTP 404', statusCode: 404 }), expect.objectContaining({ completionObservation: expect.any(Promise) }));
  });

  it('records an interrupted stream once as aborted rather than a completed success', async () => {
    const { request, response, onComplete, log } = setup();
    response.emit('data', 'event 1');
    response.emit('data', 'event 2');
    expect(onComplete).not.toHaveBeenCalled();
    response.emit('close');
    response.emit('finish');
    await request[HTTP_COMPLETION_OBSERVATION];
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted', statusCode: 499 }));
    expect(log).toHaveBeenCalledOnce();
  });

  it('keeps unannotated slow request details', async () => {
    vi.useFakeTimers();
    const { request, response, log } = setup({ slowRequestMs: 3000 });
    vi.advanceTimersByTime(3000);
    response.emit('finish');
    await request[HTTP_COMPLETION_OBSERVATION];
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ responseTime: 3000, statusCode: 200, exception: undefined }), expect.any(Object));
  });

  it.each([
    () => { throw new Error('statistics unavailable'); },
    () => Promise.reject(new Error('statistics unavailable')),
    () => false,
  ])('rejects the sampling acknowledgement when the observer fails', async (onComplete) => {
    const { request, response } = setup({ onComplete });
    expect(() => response.emit('finish')).not.toThrow();
    await expect(request[HTTP_COMPLETION_OBSERVATION]).resolves.toBe(false);
  });

  it('bounds acknowledgement without cancelling the in-flight aggregate write', async () => {
    vi.useFakeTimers();
    let accept: (success: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => { accept = resolve; });
    const onComplete = vi.fn(() => pending);
    const { request, response } = setup({ onComplete, acknowledgementTimeoutMs: 2000 });
    response.emit('finish');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(request[HTTP_COMPLETION_OBSERVATION]).resolves.toBe(false);
    accept(true);
    await pending;
    await expect(request[HTTP_COMPLETION_OBSERVATION]).resolves.toBe(false);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
