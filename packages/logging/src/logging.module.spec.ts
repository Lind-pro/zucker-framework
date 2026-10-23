import type { MiddlewareConsumer } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CorrelationIdMiddleware } from './correlation-id';
import { ZuckerLoggingModule } from './logging.module';
import { HttpRequestObservationMiddleware, HTTP_REQUEST_OBSERVATION_OPTIONS } from './http-request-observation.middleware';
import { RejectedRequestLoggerMiddleware } from './rejected-request-logger.middleware';

describe('ZuckerLoggingModule', () => {
  it('uses the Nest 11 named wildcard for all correlation-id routes', () => {
    const forRoutes = vi.fn();
    const apply = vi.fn(() => ({ forRoutes }));
    const consumer = { apply } as unknown as MiddlewareConsumer;

    new ZuckerLoggingModule().configure(consumer);

    expect(apply).toHaveBeenCalledWith(CorrelationIdMiddleware);
    expect(forRoutes).toHaveBeenCalledWith('{*path}');
  });

  it('registers observation before rejection capture and passes the shared privacy option', () => {
    const onComplete = vi.fn(() => true);
    const options = { persistence: {}, retainClientIp: true, httpObservation: { onComplete, slowRequestMs: 3000 }, rejectedRequests: {} };
    const forRoutes = vi.fn();
    const apply = vi.fn(() => ({ forRoutes }));
    new ZuckerLoggingModule(options).configure({ apply } as unknown as MiddlewareConsumer);
    expect(apply.mock.calls.map(([middleware]) => middleware)).toEqual([
      CorrelationIdMiddleware, HttpRequestObservationMiddleware, RejectedRequestLoggerMiddleware,
    ]);
    expect(ZuckerLoggingModule.forRoot(options).providers).toContainEqual({
      provide: HTTP_REQUEST_OBSERVATION_OPTIONS,
      useValue: { onComplete, slowRequestMs: 3000, retainClientIp: true },
    });
    expect(() => ZuckerLoggingModule.forRoot({ httpObservation: { onComplete, slowRequestMs: 3000 } })).toThrow('requires persistence');
  });
});
