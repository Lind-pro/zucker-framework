import { describe, expect, it, vi, afterEach } from 'vitest';
import { HttpClient } from './http-client';
import { readSseStream } from './sse';

afterEach(() => vi.unstubAllGlobals());
describe('stream refresh lifecycle', () => {
  it('rejects a cancelled waiter immediately without cancelling shared refresh', async () => {
    let finish!: (value: { access_token: string }) => void;
    const refresh = vi.fn(() => new Promise<{ access_token: string }>(resolve => { finish = resolve; }));
    const clearAuth = vi.fn(); const errorHandler = vi.fn();
    const fetcher = vi.fn().mockImplementation(async (_url, init) => new Response(null, { status: init.headers.Authorization === 'Bearer fresh' ? 200 : 401 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpClient({ refreshWithCookie: refresh, clearAuth, errorHandler });
    const controller = new AbortController();
    const first = client.fetchStream('/one', { signal: controller.signal });
    const second = client.fetchStream('/two');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    finish({ access_token: 'fresh' });
    expect((await second).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(clearAuth).not.toHaveBeenCalled(); expect(errorHandler).not.toHaveBeenCalled();
  });
  it.each([403, 500])('checks refreshed HTTP %s instead of returning an error response', async status => {
    const clearAuth = vi.fn(); const onForbidden = vi.fn(); const errorHandler = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: '合成失败' }), { status })));
    const client = new HttpClient({ refreshWithCookie: async () => ({ access_token: 'fresh' }), clearAuth, onForbidden, errorHandler });
    await expect(client.fetchStream('/stream')).rejects.toThrow(status === 403 ? '没有访问权限' : '合成失败');
    expect(clearAuth).not.toHaveBeenCalled();
    expect(onForbidden).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
    expect(errorHandler).toHaveBeenCalledTimes(status === 500 ? 1 : 0);
  });
  it('does not revoke successful refresh on a retry transport failure', async () => {
    const clearAuth = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockRejectedValueOnce(new TypeError('offline')));
    await expect(new HttpClient({ refreshWithCookie: async () => ({ access_token: 'fresh' }), clearAuth, errorHandler: vi.fn() }).fetchStream('/stream')).rejects.toThrow('offline');
    expect(clearAuth).not.toHaveBeenCalled();
  });
  it('cancels upstream and preserves parser failure even if cancellation fails', async () => {
    const cancel = vi.fn(() => { throw new Error('cancel failed'); });
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: broken\n\n')); }, cancel }));
    const failure = new Error('parser failed');
    await expect(readSseStream(response, { onEvent() { throw failure; } })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledWith(failure);
    expect(response.body!.locked).toBe(false);
  });
});
