import { describe, it, expect, vi } from 'vitest';
import {
  TraceMiddleware,
  getTraceId,
  getSpanId,
  getTraceContext,
  runWithTraceContext,
  generateTraceparent,
} from './trace-middleware';

describe('TraceMiddleware', () => {
  const middleware = new TraceMiddleware();

  describe('W3C traceparent parsing', () => {
    it('should parse valid traceparent header', () => {
      const req = {
        headers: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      };
      const res = { setHeader: vi.fn() };
      let capturedTraceId: string | undefined;

      middleware.use(req, res, () => {
        capturedTraceId = getTraceId();
      });

      expect(capturedTraceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('should extract parentSpanId from traceparent', () => {
      const req = {
        headers: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      };
      const res = { setHeader: vi.fn() };
      let capturedSpanId: string | undefined;

      middleware.use(req, res, () => {
        capturedSpanId = getSpanId();
      });

      expect(capturedSpanId).toBe('00f067aa0ba902b7');
    });

    it('should generate new traceId when traceparent is missing', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };
      let capturedTraceId: string | undefined;

      middleware.use(req, res, () => {
        capturedTraceId = getTraceId();
      });

      expect(capturedTraceId).toBeDefined();
      expect(capturedTraceId!.length).toBe(32);
    });

    it('should generate new traceId for invalid traceparent format', () => {
      const req = { headers: { traceparent: 'invalid-header' } };
      const res = { setHeader: vi.fn() };
      let capturedTraceId: string | undefined;

      middleware.use(req, res, () => {
        capturedTraceId = getTraceId();
      });

      expect(capturedTraceId).toBeDefined();
      expect(capturedTraceId!.length).toBe(32);
    });

    it('should reject version other than 00', () => {
      const req = {
        headers: {
          traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      };
      const res = { setHeader: vi.fn() };
      let capturedTraceId: string | undefined;

      middleware.use(req, res, () => {
        capturedTraceId = getTraceId();
      });

      // Should generate new traceId since version is not 00
      expect(capturedTraceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('should reject traceparent with wrong length traceId', () => {
      const req = {
        headers: { traceparent: '00-short-00f067aa0ba902b7-01' },
      };
      const res = { setHeader: vi.fn() };
      let capturedTraceId: string | undefined;

      middleware.use(req, res, () => {
        capturedTraceId = getTraceId();
      });

      expect(capturedTraceId).not.toBe('short');
    });
  });

  describe('response headers', () => {
    it('should set traceparent response header', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };

      middleware.use(req, res, () => {});

      expect(res.setHeader).toHaveBeenCalledWith('traceparent', expect.stringMatching(/^00-/));
    });

    it('should propagate tracestate header', () => {
      const req = {
        headers: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          tracestate: 'vendor=value',
        },
      };
      const res = { setHeader: vi.fn() };

      middleware.use(req, res, () => {});

      expect(res.setHeader).toHaveBeenCalledWith('tracestate', 'vendor=value');
    });
  });

  describe('trace context propagation', () => {
    it('should store tracestate in context', () => {
      const req = {
        headers: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          tracestate: 'rojo=00f067aa0ba902b7',
        },
      };
      const res = { setHeader: vi.fn() };
      let capturedCtx: ReturnType<typeof getTraceContext>;

      middleware.use(req, res, () => {
        capturedCtx = getTraceContext();
      });

      expect(capturedCtx!.traceState).toBe('rojo=00f067aa0ba902b7');
    });
  });
});

describe('generateTraceparent', () => {
  it('should generate valid W3C traceparent with sampled flag', () => {
    const result = generateTraceparent('a'.repeat(32), 'b'.repeat(16), true);
    expect(result).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('should set flag to 00 when not sampled', () => {
    const result = generateTraceparent('a'.repeat(32), 'b'.repeat(16), false);
    expect(result).toMatch(/-00$/);
  });

  it('should default to sampled=true', () => {
    const result = generateTraceparent('a'.repeat(32), 'b'.repeat(16));
    expect(result).toMatch(/-01$/);
  });
});

describe('runWithTraceContext', () => {
  it('should run function within trace context', () => {
    const ctx = { traceId: 'x'.repeat(32), traceFlags: '01' };
    const result = runWithTraceContext(ctx, () => {
      return getTraceId();
    });
    expect(result).toBe('x'.repeat(32));
  });

  it('should support async context propagation', async () => {
    const ctx = { traceId: 'y'.repeat(32), traceFlags: '01', parentSpanId: 'z'.repeat(16) };
    const result = await runWithTraceContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getTraceContext();
    });
    expect(result?.traceId).toBe('y'.repeat(32));
    expect(result?.parentSpanId).toBe('z'.repeat(16));
  });
});

describe('TraceMiddleware propagation hardening', () => {
  it('links the response traceparent to the recorded server span and validates tracestate', async () => {
    const { TraceMiddleware: Middleware, getCurrentSpanId: currentSpanId } = await import('./trace-middleware');
    const { TraceInterceptor } = await import('./trace-interceptor');
    const { InMemoryTracer } = await import('./tracer');
    const { of, lastValueFrom } = await import('rxjs');
    const tracer = new InMemoryTracer();
    const interceptor = new TraceInterceptor(tracer);
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => void (headers[name] = value) };
    let inner: string | undefined;
    await new Promise<void>((resolve) => {
      new Middleware().use(
        {
          headers: {
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            tracestate: 'vendor=ok,bad\r\ninjected',
          },
        },
        res,
        () => {
          inner = currentSpanId();
          const request = { method: 'GET', url: '/items?token=secret', headers: {} };
          const context = {
            switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
          } as never;
          void lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') })).then(() => resolve());
        },
      );
    });
    const [span] = tracer.getSpans();
    expect(headers.traceparent).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${inner}-01`);
    expect(span.spanId).toBe(inner);
    expect(span.parentSpanId).toBe('00f067aa0ba902b7');
    expect(span.attributes['http.url']).toBe('/items');
    expect(headers.tracestate).toBeUndefined();
  });
});
