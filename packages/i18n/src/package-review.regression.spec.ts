import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable, type Subscriber } from 'rxjs';
import { LocaleInterceptor, LocaleContext } from './locale-context';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const httpContext = () => ({
  switchToHttp: () => ({
    getRequest: () => ({ headers: {}, method: 'GET', url: '/events' }),
    getResponse: () => ({ statusCode: 200 }),
  }),
}) as never;

describe('Package review regressions', () => {
  it('R02: LocaleInterceptor unsubscribe tears down the source', () => {
    const cleanup = vi.fn();
    let upstream!: Subscriber<unknown>;
    const source = new Observable(subscriber => { upstream = subscriber; return cleanup; });
    const subscription = new LocaleInterceptor().intercept(httpContext(), { handle: () => source }).subscribe();
    subscription.unsubscribe();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(upstream.closed).toBe(true);
    upstream.unsubscribe();
  });


  it.each(['complete', 'error'] as const)('preserves async locale context and cleans up on %s', async mode => {
    const cleanup = vi.fn();
    const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { 'accept-language': 'zh' } }) }) } as never;
    let observed = '';
    const source = new Observable(subscriber => {
      const timer = setTimeout(() => {
        observed = LocaleContext.getCurrent();
        if (mode === 'error') subscriber.error(new Error('synthetic'));
        else subscriber.complete();
      }, 0);
      return () => { clearTimeout(timer); cleanup(); };
    });
    await new Promise<void>(resolve => {
      new LocaleInterceptor().intercept(context, { handle: () => source }).subscribe({ complete: resolve, error: resolve });
    });
    expect(observed).toBe('zh');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(LocaleContext.getCurrent()).toBe('en');
  });

});
