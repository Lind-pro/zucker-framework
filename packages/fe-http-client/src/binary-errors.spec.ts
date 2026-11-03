// @vitest-environment node
import { AxiosError, type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';

describe('binary error normalization', () => {
  const json = JSON.stringify({ message: ['配额不足', '请稍后重试'], code: 'QUOTA', details: { remaining: 0 } });
  it.each([new Blob([json]), new TextEncoder().encode(json).buffer])('decodes Chinese JSON and keeps original response bytes', async body => {
    const adapter: AxiosAdapter = async config => { throw new AxiosError('bad response', 'ERR_BAD_RESPONSE', config, {}, { config, data: body, status: 400, statusText: '', headers: {} }); };
    const errorHandler = vi.fn();
    await expect(new HttpClient({ errorHandler }).get('/download', {}, { adapter })).rejects.toMatchObject({ message: '配额不足；请稍后重试', code: 'QUOTA', details: { remaining: 0 }, status: 400, response: { data: body } });
    expect(errorHandler).toHaveBeenCalledOnce();
  });
  it.each([new Blob(['not-json']), new Blob(['x'.repeat(1024 * 1024 + 1)]), new TextEncoder().encode('null').buffer])('falls back safely for non-object, malformed or oversized bodies', async body => {
    const adapter: AxiosAdapter = async config => { throw new AxiosError('bad response', undefined, config, {}, { config, data: body, status: 403, statusText: '', headers: {} }); };
    await expect(new HttpClient().get('/download', {}, { adapter })).rejects.toMatchObject({ message: '请求失败 (403)', response: { data: body } });
  });

  it.each([
    { status: 401, retry: true },
    { status: 401, retry: false },
    { status: 403, retry: false },
    { status: 400, retry: false },
  ])('does not apply a stale $status response after cancellation while decoding', async ({ status, retry }) => {
    const controller = new AbortController();
    const body = new Blob([json]);
    let release!: (value: string) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    vi.spyOn(body, 'text').mockImplementation(() => {
      notifyStarted();
      return new Promise<string>(resolve => { release = resolve; });
    });
    const adapter: AxiosAdapter = async config => {
      if (retry) Object.assign(config, { _isRetry: true });
      throw new AxiosError('bad response', 'ERR_BAD_RESPONSE', config, {}, { config, data: body, status, statusText: '', headers: {} });
    };
    const clearAuth = vi.fn(); const onUnauthorized = vi.fn(); const onForbidden = vi.fn();
    const onResponseError = vi.fn(); const errorHandler = vi.fn(); const refreshWithCookie = vi.fn();
    const client = new HttpClient({ clearAuth, onUnauthorized, onForbidden, onResponseError, errorHandler, refreshWithCookie });
    const pending = client.get('/download', {}, { adapter, signal: controller.signal });
    const result = pending.catch(error => error);
    await started;
    controller.abort();
    release(json);
    expect(await result).toMatchObject({ code: 'ERR_CANCELED' });
    expect(clearAuth).not.toHaveBeenCalled(); expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onForbidden).not.toHaveBeenCalled(); expect(onResponseError).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled(); expect(refreshWithCookie).not.toHaveBeenCalled();
  });
});
