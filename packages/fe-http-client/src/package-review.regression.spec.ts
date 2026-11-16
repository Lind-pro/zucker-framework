import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter } from 'axios';
import { HttpClient } from './http-client';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Package review regressions', () => {
  it.each(['before-refresh', 'during-refresh'] as const)('R01: old-account POST is cancelled after account switches (%s)', async timing => {
    let token = 'account-A';
    const credentials: unknown[] = [];
    const bodies: unknown[] = [];
    const refresh = vi.fn(async () => {
      token = 'account-B';
      return { access_token: 'account-A-refreshed' };
    });
    const adapter: AxiosAdapter = async config => {
      credentials.push(config.headers.get('Authorization'));
      bodies.push(config.data);
      if (credentials.length === 1) {
        if (timing === 'before-refresh') token = 'account-B';
        throw new AxiosError('expired', 'ERR_BAD_REQUEST', config, undefined, {
          config, status: 401, statusText: '', headers: {}, data: { message: 'expired' },
        });
      }
      return { config, status: 200, statusText: '', headers: {}, data: { status: 200, result: 'written' } };
    };
    const client = new HttpClient({ baseURL: '/api', getToken: () => token, refreshWithCookie: refresh });
    await expect(client.post('/profile', { displayName: 'intended for account A' }, undefined, { adapter })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(credentials).toEqual(['Bearer account-A']);
    expect(bodies).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(timing === 'before-refresh' ? 0 : 1);
  });


  it.each(['before-response', 'refresh-success', 'refresh-failure'] as const)(
    'cancels stale stream writes without clearing the new session (%s)', async timing => {
      let token = 'A';
      const clearAuth = vi.fn();
      const refresh = vi.fn(async () => {
        token = 'B';
        if (timing === 'refresh-failure') throw Object.assign(new Error('expired'), { status: 401 });
        return { access_token: 'A-new' };
      });
      const fetch = vi.fn(async () => {
        if (timing === 'before-response') token = 'B';
        return new Response('expired', { status: 401 });
      });
      vi.stubGlobal('fetch', fetch);
      const client = new HttpClient({ getToken: () => token, clearAuth, refreshWithCookie: refresh });
      await expect(client.fetchStream('/write', { method: 'POST', body: { value: 'A' } }))
        .rejects.toMatchObject({ code: 'ERR_CANCELED' });
      expect(fetch).toHaveBeenCalledOnce();
      expect(clearAuth).not.toHaveBeenCalled();
      expect(token).toBe('B');
    },
  );

  it('checks the session again after waiting for the browser refresh lock', async () => {
    let token = 'A';
    const refresh = vi.fn();
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, task: () => Promise<unknown>) => {
      token = 'B';
      return task();
    } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('expired', { status: 401 })));
    const client = new HttpClient({ getToken: () => token, refreshWithCookie: refresh });
    await expect(client.fetchStream('/write')).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects a refreshed token identified as another session before storing it', async () => {
    const setToken = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('expired', { status: 401 })));
    const client = new HttpClient({ getToken: () => 'A:old', sessionKey: token => token.split(':')[0], setToken,
      refreshWithCookie: async () => ({ access_token: 'B:new' }) });
    await expect(client.fetchStream('/write')).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(setToken).not.toHaveBeenCalled();
  });

});
