import type { MiddlewareConsumer } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CorrelationIdMiddleware } from './correlation-id';
import { ZuckerLoggingModule } from './logging.module';

describe('ZuckerLoggingModule', () => {
  it('uses the Nest 11 named wildcard for all correlation-id routes', () => {
    const forRoutes = vi.fn();
    const apply = vi.fn(() => ({ forRoutes }));
    const consumer = { apply } as unknown as MiddlewareConsumer;

    new ZuckerLoggingModule().configure(consumer);

    expect(apply).toHaveBeenCalledWith(CorrelationIdMiddleware);
    expect(forRoutes).toHaveBeenCalledWith('{*path}');
  });
});
