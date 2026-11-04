import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';

const response = (config: InternalAxiosRequestConfig, status: number, data: unknown) => ({
  config,
  status,
  statusText: '',
  headers: {},
  data,
});
const protectedAdapter: AxiosAdapter = async (config) => {
  if (config.headers.get('Authorization') !== 'Bearer fresh') {
    throw new AxiosError(
      'Unauthorized',
      'ERR_BAD_REQUEST',
      config,
      undefined,
      response(config, 401, { message: 'Unauthorized' }),
    );
  }
  return response(config, 200, { status: 200, result: { ok: true } });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HTTP refresh compatibility', () => {
  it.each([
    ['axios', 503], ['axios', 500], ['axios', 0],
    ['stream', 503], ['stream', 500], ['stream', 0],
  ] as const)('preserves credentials after a %s refresh fails with %s and recovers on the next request', async (transport, status) => {
    let token = 'expired';
    const clearAuth = vi.fn();
    const unauthorized = vi.fn();
    const errorHandler = vi.fn();
    const failure = status ? Object.assign(new Error('Refresh temporarily unavailable'), { response: { status } }) : new TypeError('Network unavailable');
    const refresh = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ access_token: 'fresh' });
    const client = new HttpClient({ getToken: () => token, setToken: value => { token = value; }, clearAuth,
      onUnauthorized: unauthorized, errorHandler, refreshWithCookie: refresh });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response('Synthetic response', {
      status: new Headers(options.headers).get('Authorization') === 'Bearer fresh' ? 200 : 401,
    })));
    const send = () => transport === 'axios' ? client.get('/protected', {}, { adapter: protectedAdapter }) : client.fetchStream('/protected');
    await expect(send()).rejects.toMatchObject(status ? { status } : { message: 'Network unavailable' });
    expect(clearAuth).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(token).toBe('expired');
    await expect(send()).resolves.toBeDefined();
    expect(token).toBe('fresh');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([['axios', 401], ['axios', 403], ['stream', 401], ['stream', 403]] as const)(
    'clears credentials when %s refresh definitively rejects them with %s', async (transport, status) => {
      const clearAuth = vi.fn();
      const unauthorized = vi.fn();
      const refresh = vi.fn().mockRejectedValue({ response: { status } });
      const client = new HttpClient({ getToken: () => 'expired', clearAuth, onUnauthorized: unauthorized, refreshWithCookie: refresh });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Expired', { status: 401 })));
      const result = transport === 'axios' ? client.get('/protected', {}, { adapter: protectedAdapter }) : client.fetchStream('/protected');
      await expect(result).rejects.toMatchObject({ _authHandled: true });
      expect(clearAuth).toHaveBeenCalledOnce();
      expect(unauthorized).toHaveBeenCalledOnce();
    },
  );

  it.each(['axios', 'stream'] as const)('preserves direct 503 evidence without refreshing or clearing %s credentials', async transport => {
    const clearAuth = vi.fn();
    const unauthorized = vi.fn();
    const refresh = vi.fn();
    const client = new HttpClient({ getToken: () => 'current', clearAuth, onUnauthorized: unauthorized, refreshWithCookie: refresh });
    const adapter: AxiosAdapter = async config => { throw new AxiosError('Unavailable', 'ERR_BAD_RESPONSE', config, undefined, response(config, 503, { message: 'Authentication service temporarily unavailable' })); };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Authentication service temporarily unavailable', { status: 503 })));
    await expect(transport === 'axios' ? client.get('/protected', {}, { adapter }) : client.fetchStream('/protected')).rejects.toMatchObject({ status: 503 });
    expect(refresh).not.toHaveBeenCalled();
    expect(clearAuth).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('coalesces concurrent cookie refresh without reading or persisting a refresh token', async () => {
    let token = 'expired';
    const cookieRefresh = vi.fn(async () => ({ access_token: 'fresh' }));
    const getRefreshToken = vi.fn();
    const setRefreshToken = vi.fn();
    const client = new HttpClient({
      getToken: () => token,
      setToken: (value) => {
        token = value;
      },
      refreshWithCookie: cookieRefresh,
      getRefreshToken,
      setRefreshToken,
    });
    await expect(
      Promise.all([
        client.get('/one', {}, { adapter: protectedAdapter }),
        client.get('/two', {}, { adapter: protectedAdapter }),
      ]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(cookieRefresh).toHaveBeenCalledTimes(1);
    expect(cookieRefresh.mock.calls[0]).toEqual([]);
    expect(getRefreshToken).not.toHaveBeenCalled();
    expect(setRefreshToken).not.toHaveBeenCalled();
  });

  it('coordinates different clients with the same browser refresh lock', async () => {
    let token = 'expired';
    let chain = Promise.resolve();
    const lock = vi.fn((_name: string, execute: () => Promise<unknown>) => {
      const result = chain.then(execute);
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request: lock } });
    const refresh = vi.fn(async () => ({ access_token: 'fresh' }));
    const config = {
      getToken: () => token,
      setToken: (value: string) => {
        token = value;
      },
      refreshWithCookie: refresh,
      refreshLockName: 'shared-refresh',
    };
    const clients = [new HttpClient(config), new HttpClient(config)];
    await Promise.all(
      clients.map((client) => client.get('/resource', {}, { adapter: protectedAdapter })),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(lock.mock.calls.every(([name]) => name === 'shared-refresh')).toBe(true);
  });

  it('retains explicit refresh-token compatibility', async () => {
    let token = 'expired';
    const refresh = vi.fn(async () => ({ access_token: 'fresh', refresh_token: 'new-refresh' }));
    const saveRefresh = vi.fn();
    const client = new HttpClient({
      getToken: () => token,
      setToken: (value) => {
        token = value;
      },
      getRefreshToken: () => 'old-refresh',
      setRefreshToken: saveRefresh,
      refreshTokenFn: refresh,
    });
    await client.get('/resource', {}, { adapter: protectedAdapter });
    expect(refresh).toHaveBeenCalledWith('old-refresh');
    expect(saveRefresh).toHaveBeenCalledWith('new-refresh');
  });

  it('exposes structured business failures without treating them as lost authentication', async () => {
    const unauthorized = vi.fn();
    const errorHandler = vi.fn();
    const onResponseError = vi.fn((error: Error) => {
      Object.assign(error, { domainHandled: true });
      return true;
    });
    const client = new HttpClient({ onUnauthorized: unauthorized, errorHandler, onResponseError });
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError(
        'Limited',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        response(config, 402, {
          message: 'Capacity unavailable',
          code: 'CAPACITY_LIMIT',
          details: { available: 0 },
        }),
      );
    };
    await expect(client.get('/limited', {}, { adapter })).rejects.toMatchObject({
      status: 402,
      code: 'CAPACITY_LIMIT',
      details: { available: 0 },
      domainHandled: true,
    });
    expect(onResponseError).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('does not report deliberate request cancellation as a failure', async () => {
    const handler = vi.fn();
    const client = new HttpClient({ errorHandler: handler });
    const controller = new AbortController();
    controller.abort();
    const result = client
      .get('/cancelled', {}, { signal: controller.signal, adapter: protectedAdapter })
      .catch((error) => error);
    expect(axios.isCancel(await result)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
