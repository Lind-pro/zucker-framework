import { AxiosError, type AxiosAdapter } from 'axios';
import { expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';

it.each(['resolve', 'reject'])('does not clear identity or retry an aborted Axios request when refresh later %s', async outcome => {
  const controller = new AbortController();
  let complete!: () => void;
  const refresh = vi.fn(() => new Promise<{ access_token: string }>((resolve, reject) => {
    complete = () => outcome === 'resolve' ? resolve({ access_token: 'fresh' }) : reject(new Error('refresh failed'));
  }));
  const clearAuth = vi.fn(); const errorHandler = vi.fn();
  const adapter = vi.fn<AxiosAdapter>(async config => { throw new AxiosError('unauthorized', undefined, config, {}, { config, data: {}, status: 401, statusText: '', headers: {} }); });
  const pending = new HttpClient({ refreshWithCookie: refresh, clearAuth, errorHandler }).get('/one', undefined, { adapter, signal: controller.signal });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  controller.abort(); complete();
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  expect(adapter).toHaveBeenCalledOnce(); expect(clearAuth).not.toHaveBeenCalled(); expect(errorHandler).not.toHaveBeenCalled();
});
