import { AxiosError, type AxiosAdapter } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('transport evidence and caller cancellation', () => {
  it.each([new Blob(['{"message":"quota exceeded"}']), new TextEncoder().encode('failure').buffer])('retains binary failure response and transport metadata', async (body) => {
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError('original', 'ERR_BAD_REQUEST', config, { port: 'fake' }, { config, data: body, status: 403, statusText: 'Forbidden', headers: {} });
    };
    await expect(new HttpClient().get('/binary', {}, { adapter })).rejects.toMatchObject({
      status: 403, response: { data: body }, code: 'ERR_BAD_REQUEST', cause: expect.any(AxiosError),
    });
  });
  it('clears stale identity on a login page without redirecting', async () => {
    vi.stubGlobal('window', { location: { pathname: '/login' } });
    const clearAuth = vi.fn(); const onUnauthorized = vi.fn();
    const adapter: AxiosAdapter = async (config) => { throw new AxiosError('unauthorized', undefined, config, {}, { config, data: {}, status: 401, statusText: '', headers: {} }); };
    await new HttpClient({ clearAuth, onUnauthorized }).get('/login', {}, { adapter }).catch(() => {});
    expect(clearAuth).toHaveBeenCalledOnce(); expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it('does not toast or clear identity when a caller cancels pending response headers', async () => {
    const controller = new AbortController(); const errorHandler = vi.fn();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))));
    const pending = new HttpClient({ errorHandler }).fetchStream('/stream', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(errorHandler).not.toHaveBeenCalled();
  });
  it('does not retry or clear authentication if cancelled during shared refresh', async () => {
    const controller = new AbortController(); const errorHandler = vi.fn(); const clearAuth = vi.fn();
    let finish!: (value: { access_token: string }) => void;
    const refresh = vi.fn(() => new Promise<{ access_token: string }>((resolve) => { finish = resolve; }));
    const fetcher = vi.fn(async () => new Response(null, { status: 401 })); vi.stubGlobal('fetch', fetcher);
    const pending = new HttpClient({ refreshWithCookie: refresh, errorHandler, clearAuth }).fetchStream('/stream', { signal: controller.signal });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    controller.abort(); finish({ access_token: 'fresh' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(errorHandler).not.toHaveBeenCalled(); expect(clearAuth).not.toHaveBeenCalled();
  });
  it('carries the original signal into a refreshed stream request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    await new HttpClient({ refreshWithCookie: async () => ({ access_token: 'fresh' }) }).fetchStream('/stream', { signal: controller.signal });
    expect(fetcher.mock.calls[1][1].signal).toBe(controller.signal);
  });
});
