import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';

const reply = (config: InternalAxiosRequestConfig, status: number, data: unknown, headers: Record<string, string> = {}) => ({
  config,
  status,
  statusText: '',
  headers,
  data,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bearer scope (M9)', () => {
  const seen: Array<{ url: string; auth: unknown }> = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push({ url: `${config.baseURL ?? ''}|${config.url}`, auth: config.headers.get('Authorization') });
    return reply(config, 200, { status: 200, result: 'ok' });
  };

  it('sends the bearer to baseURL-relative and same-API-origin requests only', async () => {
    seen.length = 0;
    const client = new HttpClient({ baseURL: 'https://api.example.test/v1', getToken: () => 'secret' });
    await client.get('/me', {}, { adapter });
    await client.get('https://api.example.test/other', {}, { adapter });
    await client.get('https://evil.example/collect', {}, { adapter });
    await client.get('//evil.example/collect', {}, { adapter });
    expect(seen.map((entry) => entry.auth)).toEqual(['Bearer secret', 'Bearer secret', undefined, undefined]);
  });

  it('allows explicitly trusted extra origins', async () => {
    seen.length = 0;
    const client = new HttpClient({
      baseURL: '/api',
      getToken: () => 'secret',
      trustedOrigins: ['https://files.example.test'],
    });
    await client.get('https://files.example.test/x', {}, { adapter });
    await client.get('https://other.example.test/x', {}, { adapter });
    expect(seen.map((entry) => entry.auth)).toEqual(['Bearer secret', undefined]);
  });

  it('does not send the bearer from fetchStream to a foreign origin', async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpClient({ baseURL: '', getToken: () => 'secret' });
    await client.fetchStream('https://evil.example/stream');
    await client.fetchStream('/stream');
    const headers = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    const local = (fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(local.Authorization).toBe('Bearer secret');
  });

  it('does not clear the session on a 401 from a foreign origin', async () => {
    const clearAuth = vi.fn();
    const refresh = vi.fn();
    const client = new HttpClient({ baseURL: '/api', getToken: () => 'secret', clearAuth, refreshWithCookie: refresh, errorHandler: () => {} });
    const denied: AxiosAdapter = async (config) => {
      throw new AxiosError('no', 'ERR_BAD_REQUEST', config, undefined, reply(config, 401, { message: 'no' }));
    };
    await expect(client.get('https://other.example/x', {}, { adapter: denied })).rejects.toMatchObject({ status: 401 });
    expect(clearAuth).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('bearer scope without baseURL (N-L4)', () => {
  const seen: Array<{ url: string | undefined; auth: unknown }> = [];
  const adapter: AxiosAdapter = async (config) => {
    seen.push({ url: config.url, auth: config.headers.get('Authorization') });
    return reply(config, 200, { status: 200, result: 'ok' });
  };
  const authFor = async (client: HttpClient, urls: string[]) => {
    seen.length = 0;
    for (const url of urls) await client.get(url, {}, { adapter });
    return seen.map((entry) => entry.auth);
  };

  it('with a (jsdom) location, resolves like the browser: /\\evil.example is another origin and gets no bearer', async () => {
    expect(window.location.href).toMatch(/^https?:/);
    const client = new HttpClient({ getToken: () => 'secret' });
    const auth = await authFor(client, [
      '/me',
      'relative/path',
      '/\\evil.example/collect',
      '\\\\evil.example/collect',
      '//evil.example/collect',
      'https://evil.example/collect',
      `${window.location.origin}/same-origin`,
    ]);
    expect(auth).toEqual(['Bearer secret', 'Bearer secret', undefined, undefined, undefined, undefined, 'Bearer secret']);
  });

  it('with a location, a trusted origin is still honoured', async () => {
    const client = new HttpClient({ getToken: () => 'secret', trustedOrigins: ['https://files.example.test'] });
    const auth = await authFor(client, ['https://files.example.test/x', 'https://other.example.test/x']);
    expect(auth).toEqual(['Bearer secret', undefined]);
  });

  describe('without a window', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('treats /\\x, \\\\x and URLs with leading whitespace or control characters as untrusted', async () => {
      vi.stubGlobal('window', undefined);
      expect(typeof window).toBe('undefined');
      const client = new HttpClient({ getToken: () => 'secret' });
      const auth = await authFor(client, [
        '/\\x',
        '\\\\x',
        ' /x',
        '\t/x',
        '\n//evil.example/x',
        '//evil.example/x',
      ]);
      expect(auth).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    });

    it('still trusts unambiguous relative paths and the configured API origin', async () => {
      vi.stubGlobal('window', undefined);
      const bare = new HttpClient({ getToken: () => 'secret' });
      expect(await authFor(bare, ['/me', 'relative/path', 'a/b?x=1'])).toEqual(['Bearer secret', 'Bearer secret', 'Bearer secret']);

      const withBase = new HttpClient({ baseURL: 'https://api.example.test/v1', getToken: () => 'secret' });
      expect(await authFor(withBase, ['/me', 'https://api.example.test/other', 'https://evil.example/x']))
        .toEqual(['Bearer secret', 'Bearer secret', undefined]);
    });
  });
});

describe('response-header token adoption (M9)', () => {
  const withHeader = (token: string): AxiosAdapter => async (config) =>
    reply(config, 200, { status: 200, result: 'ok' }, { 'x-auth-token': token });

  it('adopts a rotated token from the API origin for the current session', async () => {
    let token: string | null = 'a1';
    const client = new HttpClient({ baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; } });
    await client.get('/me', {}, { adapter: withHeader('a2') });
    expect(token).toBe('a2');
  });

  it('ignores tokens from foreign origins', async () => {
    let token: string | null = 'a1';
    const client = new HttpClient({ baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; } });
    await client.get('https://evil.example/x', {}, { adapter: withHeader('attacker') });
    expect(token).toBe('a1');
  });

  it('never restores a session that signed out while the request was in flight', async () => {
    let token: string | null = 'a1';
    const client = new HttpClient({ baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; } });
    const lateAdapter: AxiosAdapter = async (config) => {
      token = null; // user signs out before the response lands
      return reply(config, 200, { status: 200, result: 'ok' }, { 'x-auth-token': 'a2' });
    };
    await client.get('/me', {}, { adapter: lateAdapter });
    expect(token).toBeNull();
  });

  it('honours acceptResponseToken', async () => {
    let token: string | null = 'a1';
    const client = new HttpClient({
      baseURL: '/api',
      getToken: () => token,
      setToken: (value) => { token = value; },
      acceptResponseToken: (value) => value !== 'other-session',
    });
    await client.get('/me', {}, { adapter: withHeader('other-session') });
    expect(token).toBe('a1');
    const disabled = new HttpClient({ baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; }, acceptResponseToken: false });
    await disabled.get('/me', {}, { adapter: withHeader('a3') });
    expect(token).toBe('a1');
  });
});

describe('refresh after sign-out (M9)', () => {
  it.each(['cookie', 'refresh-token'] as const)('does not store %s refresh results when the user signed out meanwhile', async (mode) => {
    let token: string | null = 'expired';
    let refreshToken: string | null = 'r1';
    const setToken = vi.fn((value: string) => { token = value; });
    const setRefreshToken = vi.fn((value: string) => { refreshToken = value; });
    const errorHandler = vi.fn();
    const signOutDuringRefresh = async () => {
      token = null;
      refreshToken = null;
      return { access_token: 'fresh', refresh_token: 'r2' };
    };
    const client = new HttpClient({
      baseURL: '/api',
      getToken: () => token,
      setToken,
      errorHandler,
      ...(mode === 'cookie'
        ? { refreshWithCookie: signOutDuringRefresh }
        : { getRefreshToken: () => refreshToken, setRefreshToken, refreshTokenFn: signOutDuringRefresh }),
    });
    const denied: AxiosAdapter = async (config) => {
      throw new AxiosError('no', 'ERR_BAD_REQUEST', config, undefined, reply(config, 401, { message: 'no' }));
    };
    const failure = await client.get('/me', {}, { adapter: denied }).catch((error: unknown) => error);
    expect(axios.isCancel(failure)).toBe(true);
    expect(setToken).not.toHaveBeenCalled();
    expect(setRefreshToken).not.toHaveBeenCalled();
    expect(token).toBeNull();
    expect(refreshToken).toBeNull();
    expect(errorHandler).not.toHaveBeenCalled();
  });
});

describe('refresh with a mid-flight access token change (N-L4)', () => {
  const denied: AxiosAdapter = async (config) => {
    if (config.headers.get('Authorization') === 'Bearer adopted') return reply(config, 200, { status: 200, result: 'ok' });
    throw new AxiosError('no', 'ERR_BAD_REQUEST', config, undefined, reply(config, 401, { message: 'no' }));
  };

  it('stores the rotated refresh token when the access token changed but the stored refresh token is unchanged', async () => {
    let token: string | null = 'expired';
    let refreshToken: string | null = 'r1';
    const setToken = vi.fn((value: string) => { token = value; });
    const setRefreshToken = vi.fn((value: string) => { refreshToken = value; });
    const refreshTokenFn = vi.fn(async (presented: string) => {
      expect(presented).toBe('r1');
      token = 'adopted'; // e.g. adopted from an x-auth-token response header while refreshing
      return { access_token: 'refreshed', refresh_token: 'r2' };
    });
    const client = new HttpClient({
      baseURL: '/api', getToken: () => token, setToken, getRefreshToken: () => refreshToken, setRefreshToken, refreshTokenFn,
    });
    await expect(client.get('/me', {}, { adapter: denied })).resolves.toBeDefined();
    expect(setRefreshToken).toHaveBeenCalledExactlyOnceWith('r2');
    expect(refreshToken).toBe('r2');
    // The adopted access token wins; the refreshed one is not written over it.
    expect(setToken).not.toHaveBeenCalled();
    expect(token).toBe('adopted');
  });

  it('does not store the rotated refresh token when the stored refresh token changed meanwhile (another session)', async () => {
    let token: string | null = 'expired';
    let refreshToken: string | null = 'r1';
    const setRefreshToken = vi.fn((value: string) => { refreshToken = value; });
    const refreshTokenFn = vi.fn(async () => {
      token = 'adopted';
      refreshToken = 'other-session-refresh';
      return { access_token: 'refreshed', refresh_token: 'r2' };
    });
    const client = new HttpClient({
      baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; },
      getRefreshToken: () => refreshToken, setRefreshToken, refreshTokenFn,
    });
    await expect(client.get('/me', {}, { adapter: denied })).resolves.toBeDefined();
    expect(setRefreshToken).not.toHaveBeenCalled();
    expect(refreshToken).toBe('other-session-refresh');
  });

  it('cookie refresh never reads or persists a refresh token', async () => {
    let token: string | null = 'expired';
    const getRefreshToken = vi.fn(() => 'r1');
    const setRefreshToken = vi.fn();
    const refreshWithCookie = vi.fn(async () => {
      token = 'adopted';
      return { access_token: 'refreshed', refresh_token: 'r2' };
    });
    const client = new HttpClient({
      baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; },
      getRefreshToken, setRefreshToken, refreshWithCookie,
    });
    await expect(client.get('/me', {}, { adapter: denied })).resolves.toBeDefined();
    expect(setRefreshToken).not.toHaveBeenCalled();
    expect(getRefreshToken).not.toHaveBeenCalled();
  });

  it('still cancels when the session ended (no access token) during the refresh', async () => {
    let token: string | null = 'expired';
    let refreshToken: string | null = 'r1';
    const setRefreshToken = vi.fn();
    const client = new HttpClient({
      baseURL: '/api', getToken: () => token, setToken: (value) => { token = value; },
      getRefreshToken: () => refreshToken, setRefreshToken, errorHandler: () => {},
      refreshTokenFn: async () => { token = null; refreshToken = null; return { access_token: 'x', refresh_token: 'r2' }; },
    });
    const failure = await client.get('/me', {}, { adapter: denied }).catch((error: unknown) => error);
    expect(axios.isCancel(failure)).toBe(true);
    expect(setRefreshToken).not.toHaveBeenCalled();
  });
});

describe('envelope status (L13)', () => {
  it('rejects a non-success business status without a message', async () => {
    const client = new HttpClient({ baseURL: '/api', errorHandler: () => {} });
    const adapter: AxiosAdapter = async (config) => reply(config, 200, { status: 500, result: null });
    await expect(client.get('/x', {}, { adapter })).rejects.toThrow('请求失败 (500)');
  });
});

describe('fetchStream timeout with a caller signal (L12)', () => {
  it('still applies the timeout when a signal is passed', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })));
      const errorHandler = vi.fn();
      const client = new HttpClient({ baseURL: '/api', errorHandler });
      const pending = client.fetchStream('/s', { timeout: 100, signal: new AbortController().signal });
      const assertion = expect(pending).rejects.toThrow('请求超时');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetchStream error body', () => {
  it('exposes the JSON error code and body of a refused stream like an axios error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 409, code: 'AI_CHAT_BUSY', message: 'Busy' }), { status: 409 })));
    const client = new HttpClient({ baseURL: '', getToken: () => 'secret' });
    const error = await client.fetchStream('/chat/x/messages').catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Busy', status: 409, code: 'AI_CHAT_BUSY', response: { status: 409, data: { code: 'AI_CHAT_BUSY' } } });
  });

  it('keeps status only for a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    const client = new HttpClient({ baseURL: '', getToken: () => 'secret' });
    const error = await client.fetchStream('/chat/x/messages').catch((caught) => caught);
    expect(error).toMatchObject({ message: 'bad gateway', status: 502 });
    expect(error.code).toBeUndefined();
    expect(error.response).toBeUndefined();
  });
});
