import { afterEach, describe, expect, it, vi } from 'vitest';
import { Subject, EMPTY, throwError } from 'rxjs';
import { TraceInterceptor } from './trace-interceptor';
import { InMemoryTracer } from './tracer';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const httpContext = () => ({
  switchToHttp: () => ({
    getRequest: () => ({ headers: {}, method: 'GET', url: '/events' }),
    getResponse: () => ({ statusCode: 200 }),
  }),
}) as never;

describe('Package review regressions', () => {
  it('R10: trace stays open until completion or cancellation', () => {
    const tracer = new InMemoryTracer();
    const interceptor = new TraceInterceptor(tracer);
    const source = new Subject();
    const subscription = interceptor.intercept(httpContext(), { handle: () => source }).subscribe();
    source.next('first event');
    expect(subscription.closed).toBe(false);
    expect(tracer.getSpans()[0].isRecording()).toBe(true);
    subscription.unsubscribe();
    expect(tracer.getSpans()[0].isRecording()).toBe(false);
    const empty = interceptor.intercept(httpContext(), { handle: () => new Subject() }).subscribe();
    empty.unsubscribe();
    expect(tracer.getSpans()[1].isRecording()).toBe(false);
  });


  it.each(['complete', 'error', 'throw'] as const)('ends each subscription once on %s', mode => {
    const tracer = new InMemoryTracer();
    const interceptor = new TraceInterceptor(tracer);
    const error = Object.assign(new Error('failed'), { status: 409 });
    const stream = interceptor.intercept(httpContext(), { handle: () => {
      if (mode === 'throw') throw error;
      return mode === 'error' ? throwError(() => error) : EMPTY;
    } });
    const end = vi.fn();
    const startSpan = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      const span = startSpan(...args);
      const finish = span.end.bind(span);
      vi.spyOn(span, 'end').mockImplementation(() => { end(); finish(); });
      return span;
    });
    stream.subscribe({ error: () => {} });
    stream.subscribe({ error: () => {} });
    expect(tracer.getSpans()).toHaveLength(2);
    expect(end).toHaveBeenCalledTimes(2);
    expect(tracer.getSpans().every(span => !span.isRecording())).toBe(true);
    expect(tracer.getSpans().every(span => span.status === (mode === 'complete' ? 'OK' : 'ERROR'))).toBe(true);
    expect(tracer.getSpans()[0].attributes['http.status_code']).toBe(mode === 'complete' ? 200 : 409);
  });

});
