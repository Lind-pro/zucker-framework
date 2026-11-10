import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAction, defaultHttpDestinationPolicy } from './http-action';
import type { HttpActionConfig } from './http-action';

// The built-in transport is node:http(s) pinned to the vetted addresses; these tests inject a
// transport that delegates to the (stubbed) global fetch and a resolver that returns a public IP.
const testOptions = {
  fetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
  resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
};

describe('HttpAction', () => {
  let action: HttpAction;

  beforeEach(() => {
    action = new HttpAction(testOptions);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('빈 URL이면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ url: '', method: 'GET' }),
      ).toThrow('HTTP action URL is required');
    });

    it('공백만 있는 URL이면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ url: '   ', method: 'GET' }),
      ).toThrow('HTTP action URL is required');
    });

    it('지원하지 않는 HTTP 메서드면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ url: 'http://example.com', method: 'CONNECT' as any }),
      ).toThrow('Invalid HTTP method: CONNECT');
    });

    it('유효한 설정이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        action.validate({ url: 'http://example.com', method: 'POST' }),
      ).not.toThrow();
    });
  });

  // ─── GET 요청 ───────────────────────────────────────────────────────────────

  describe('GET 요청', () => {
    it('정상 응답을 JSON으로 파싱해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ code: 0, data: 'ok' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/status',
        method: 'GET',
      };
      const promise = action.execute(config, {});
      vi.runAllTimers();
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][0]).toBe('http://api.example.com/status');
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
      expect(result).toEqual({ code: 0, data: 'ok' });
    });

    it('응답이 JSON이 아니면 텍스트 그대로 반환해야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'plain text response',
      }));

      const config: HttpActionConfig = { url: 'http://example.com', method: 'GET' };
      const promise = action.execute(config, {});
      vi.runAllTimers();
      const result = await promise;

      expect(result).toBe('plain text response');
    });
  });

  // ─── POST 요청 ──────────────────────────────────────────────────────────────

  describe('POST 요청', () => {
    it('body를 JSON으로 직렬화하여 전송해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"success":true}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/data',
        method: 'POST',
        body: { deviceId: 'D001', value: 42 },
      };
      const promise = action.execute(config, {});
      vi.runAllTimers();
      await promise;

      const fetchCall = mockFetch.mock.calls[0][1];
      expect(fetchCall.method).toBe('POST');
      expect(fetchCall.body).toBe(JSON.stringify({ deviceId: 'D001', value: 42 }));
    });
  });

  // ─── URL 템플릿 변수 치환 ────────────────────────────────────────────────────

  describe('URL 템플릿 변수 치환', () => {
    it('URL 안의 ${variable}을 data에서 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/devices/${deviceId}/status',
        method: 'GET',
      };
      const promise = action.execute(config, { deviceId: 'sensor-99' });
      vi.runAllTimers();
      await promise;

      expect(mockFetch.mock.calls[0][0]).toBe(
        'http://api.example.com/devices/sensor-99/status',
      );
    });

    it('중첩 경로 ${a.b}를 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/${device.id}',
        method: 'GET',
      };
      const promise = action.execute(config, { device: { id: 'nested-id' } });
      vi.runAllTimers();
      await promise;

      expect(mockFetch.mock.calls[0][0]).toBe('http://api.example.com/nested-id');
    });

    it('body 템플릿 변수도 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/report',
        method: 'POST',
        body: { name: '${name}', score: '${score}' },
      };
      const promise = action.execute(config, { name: 'Alice', score: 95 });
      vi.runAllTimers();
      await promise;

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sentBody).toEqual({ name: 'Alice', score: '95' });
    });

    it('headers 템플릿 변수도 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com',
        method: 'GET',
        headers: { Authorization: 'Bearer ${token}' },
      };
      const promise = action.execute(config, { token: 'abc123' });
      vi.runAllTimers();
      await promise;

      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer abc123');
    });
  });

  // ─── 에러 처리 ───────────────────────────────────────────────────────────────

  describe('에러 처리', () => {
    it('HTTP 4xx/5xx 응답이면 오류를 던져야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
      }));

      const config: HttpActionConfig = { url: 'http://example.com/missing', method: 'GET' };
      const promise = action.execute(config, {});
      vi.runAllTimers();

      await expect(promise).rejects.toThrow('HTTP 404');
    });

    it('네트워크 오류면 오류를 전파해야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      const config: HttpActionConfig = { url: 'http://example.com', method: 'GET' };
      const promise = action.execute(config, {});
      vi.runAllTimers();

      await expect(promise).rejects.toThrow('network error');
    });

    it('retryCount 지정 시 실패 후 재시도해야 한다', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ ok: true, text: async () => '"ok"' });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://example.com',
        method: 'GET',
        retryCount: 1,
        retryDelay: 100,
      };
      const promise = action.execute(config, {});
      // advance past retryDelay and flush all pending timers/microtasks
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toBe('ok');
    });

    it('모든 재시도 실패 시 마지막 오류를 던져야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('always fails')));

      const config: HttpActionConfig = {
        url: 'http://example.com',
        method: 'GET',
        retryCount: 1,
        retryDelay: 50,
      };
      const promise = action.execute(config, {});
      // Attach rejection handler BEFORE running timers to avoid unhandled-rejection warning
      const expectation = expect(promise).rejects.toThrow('always fails');
      await vi.runAllTimersAsync();
      await expectation;
    });
  });

  // ─── M10: injection and destination policy ───────────────────────────────────

  describe('injection and destination policy', () => {
    const okFetch = () => vi.fn().mockResolvedValue({ ok: true, text: async () => '{}' });

    it('quotes in data cannot inject JSON body fields', async () => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await action.execute(
        { url: 'http://api.example.com/r', method: 'POST', body: { name: '${name}' } },
        { name: 'x","admin":true,"y":"' },
      );
      const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sent).toEqual({ name: 'x","admin":true,"y":"' });
      expect(sent.admin).toBeUndefined();
    });

    it('URL placeholders are percent-encoded', async () => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await action.execute(
        { url: 'http://api.example.com/devices/${id}', method: 'GET' },
        { id: '../admin?x=@evil.com/' },
      );
      const sentUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(sentUrl.host).toBe('api.example.com');
      expect(sentUrl.pathname).toBe('/devices/..%2Fadmin%3Fx%3D%40evil.com%2F');
      expect(sentUrl.search).toBe('');
    });

    it.each([
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/',
      'http://localhost:8080/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'file:///etc/passwd',
    ])('refuses private or non-http destination %s by default', async (url) => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await expect(action.execute({ url, method: 'GET' }, {})).rejects.toThrow(/not allowed/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allowPrivateNetwork opt-in permits internal destinations', async () => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await new HttpAction({ ...testOptions, allowPrivateNetwork: true }).execute({ url: 'http://10.0.0.5/', method: 'GET' }, {});
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][1].redirect).toBe('manual');
    });

    it('caps response size', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'x'.repeat(20) }));
      await expect(
        new HttpAction({ ...testOptions, maxResponseBytes: 10 }).execute({ url: 'http://api.example.com', method: 'GET' }, {}),
      ).rejects.toThrow(/exceeds/);
    });
  });
});


// ─── M2: destination policy table, resolution, redirects, pinning (real timers) ───────────────

describe('HttpAction destination policy (M2)', () => {
  const fakeDns: Record<string, string[]> = {
    'pub.example': ['93.184.216.34'],
    'priv.example': ['10.0.0.5'],
    'mixed.example': ['93.184.216.34', '10.0.0.5'],
    'v6.example': ['2606:4700::1'],
  };
  const resolver = async (host: string) => {
    const list = fakeDns[host];
    if (!list) throw new Error(`ENOTFOUND ${host}`);
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const policy = defaultHttpDestinationPolicy(false, resolver);

  it.each([
    'http://localhost./',
    'http://metadata.google.internal./',
    'http://foo.local./',
    'http://127.0.0.1./',
    'http://[fec0::1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://redis:6379/',
    'http://kubernetes.default.svc/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/',
    'http://user:pw@pub.example/',
    'ftp://pub.example/',
  ])('refuses %s', async (u) => {
    expect(await policy(new URL(u))).toBe(false);
  });

  it.each([
    'http://pub.example/',
    'http://pub.example./',
    'http://v6.example/',
    'http://8.8.8.8/',
    'http://[2606:4700::1]/',
    'http://[2002:5db8:d822::1]/', // 6to4 of a public IPv4
    'http://[64:ff9b::5db8:d822]/', // NAT64 of a public IPv4
  ])('allows %s', async (u) => {
    expect(await policy(new URL(u))).toBe(true);
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    expect(await policy(new URL('http://priv.example/'))).toBe(false);
  });

  it('refuses when any resolved address is private (mixed public + private)', async () => {
    expect(await policy(new URL('http://mixed.example/'))).toBe(false);
  });

  it('execute() rejects with "not allowed" for a name resolving to 10.0.0.5 and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    const a = new HttpAction({ resolveHost: resolver, fetch: fetchSpy });
    await expect(a.execute({ url: 'http://priv.example/', method: 'GET' }, {})).rejects.toThrow(/not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('HttpAction redirects (M2)', () => {
  const resolveHost = async (host: string) =>
    host.startsWith('priv')
      ? [{ address: '10.0.0.5', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }];
  const redirect = (status: number, location: string) =>
    new Response(null, { status, headers: { location } });
  const ok = () => new Response('{"done":true}', { status: 200 });

  it('refuses a redirect to a private address with followRedirects: true', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(redirect(302, 'http://127.0.0.1:9/latest/meta-data'));
    const a = new HttpAction({ resolveHost, fetch: fetchSpy });
    await expect(
      a.execute({ url: 'http://pub.example/a', method: 'GET', followRedirects: true }, {}),
    ).rejects.toThrow(/not allowed/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a name resolving to a private address', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(redirect(302, 'http://priv.example/x'));
    const a = new HttpAction({ resolveHost, fetch: fetchSpy });
    await expect(
      a.execute({ url: 'http://pub.example/a', method: 'GET', followRedirects: true }, {}),
    ).rejects.toThrow(/not allowed/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('follows a public redirect and re-vets each hop', async () => {
    const seen: string[] = [];
    const vetted: string[] = [];
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, 'http://other.example/b'))
      .mockResolvedValueOnce(ok());
    const a = new HttpAction({
      resolveHost: async (h) => {
        vetted.push(h);
        return resolveHost(h);
      },
      fetch: async (u, init) => {
        seen.push(u);
        return fetchSpy(u, init);
      },
    });
    const result = await a.execute({ url: 'http://pub.example/a', method: 'GET', followRedirects: true }, {});
    expect(result).toEqual({ done: true });
    expect(seen).toEqual(['http://pub.example/a', 'http://other.example/b']);
    expect(vetted).toEqual(['pub.example', 'other.example']);
  });

  it('drops configured headers on a cross-origin hop but keeps them same-origin', async () => {
    const inits: RequestInit[] = [];
    const responses = [redirect(302, 'http://pub.example/same'), redirect(302, 'http://other.example/x'), ok()];
    const a = new HttpAction({
      resolveHost,
      fetch: async (_u, init) => {
        inits.push(init);
        return responses.shift()!;
      },
    });
    await a.execute(
      { url: 'http://pub.example/a', method: 'GET', followRedirects: true, headers: { Authorization: 'Bearer secret' } },
      {},
    );
    const auth = (i: RequestInit) => new Headers(i.headers).get('authorization');
    expect(auth(inits[0])).toBe('Bearer secret');
    expect(auth(inits[1])).toBe('Bearer secret');
    expect(auth(inits[2])).toBeNull();
  });

  it('a 303 switches to GET and drops the body', async () => {
    const inits: RequestInit[] = [];
    const responses = [redirect(303, 'http://pub.example/after'), ok()];
    const a = new HttpAction({
      resolveHost,
      fetch: async (_u, init) => {
        inits.push(init);
        return responses.shift()!;
      },
    });
    await a.execute({ url: 'http://pub.example/a', method: 'POST', body: { x: 1 }, followRedirects: true }, {});
    expect(inits[0].method).toBe('POST');
    expect(inits[0].body).toBe('{"x":1}');
    expect(inits[1].method).toBe('GET');
    expect(inits[1].body).toBeUndefined();
  });

  it('fails on the 6th redirect hop (max 5 followed)', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => redirect(302, 'http://pub.example/loop'));
    const a = new HttpAction({ resolveHost, fetch: fetchSpy });
    await expect(
      a.execute({ url: 'http://pub.example/a', method: 'GET', followRedirects: true }, {}),
    ).rejects.toThrow(/redirects/);
    expect(fetchSpy).toHaveBeenCalledTimes(6); // initial request + 5 followed hops
  });

  it('without followRedirects the error says "redirect not followed"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(redirect(302, 'http://pub.example/b'));
    const a = new HttpAction({ resolveHost, fetch: fetchSpy });
    await expect(a.execute({ url: 'http://pub.example/a', method: 'GET' }, {})).rejects.toThrow(/redirect not followed/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('HttpAction opt-ins, retries and pinning (M2)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it('allowPrivateNetwork permits trailing dots, single-label, internal names and private IPs', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => new Response('{"ok":1}', { status: 200 }));
    const a = new HttpAction({ allowPrivateNetwork: true, fetch: fetchSpy });
    for (const url of [
      'http://localhost./',
      'http://redis:6379/',
      'http://kubernetes.default.svc/',
      'http://127.0.0.1/',
      'http://[fec0::1]/',
      'http://[2002:7f00:1::]/',
    ]) {
      await expect(a.execute({ url, method: 'GET' }, {})).resolves.toEqual({ ok: 1 });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('allowPrivateNetwork lets a redirect reach a private address', async () => {
    const responses = [new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } }), new Response('"in"', { status: 200 })];
    const a = new HttpAction({ allowPrivateNetwork: true, fetch: async () => responses.shift()! });
    await expect(a.execute({ url: 'http://10.0.0.5/', method: 'GET', followRedirects: true }, {})).resolves.toBe('in');
  });

  it('a refused destination is not retried even with retryCount: 2', async () => {
    const fetchSpy = vi.fn();
    const a = new HttpAction({ fetch: fetchSpy, resolveHost: async () => [{ address: '10.0.0.5', family: 4 }] });
    await expect(
      a.execute({ url: 'http://priv.example/', method: 'GET', retryCount: 2, retryDelay: 1 }, {}),
    ).rejects.toThrow(/not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pins the connection to the vetted address: a loopback server is not reached', async () => {
    let hits = 0;
    server = createServer((_q, s) => {
      hits++;
      s.end('{"secret":true}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    // The name would resolve to loopback through the OS resolver (localhost), but the vetted
    // answer is a public IP; the transport must connect there only (and fail/time out).
    const a = new HttpAction({ resolveHost: async () => [{ address: '192.0.2.1', family: 4 }] });
    await expect(
      a.execute({ url: `http://pinned.example.test:${port}/`, method: 'GET', timeout: 700 }, {}),
    ).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it('the built-in transport does reach a server when the vetted address is the server (positive control)', async () => {
    server = createServer((_q, s) => s.end('{"hello":"world"}'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const a = new HttpAction({ allowPrivateNetwork: true });
    await expect(a.execute({ url: `http://127.0.0.1:${port}/`, method: 'GET' }, {})).resolves.toEqual({ hello: 'world' });
  });
});
