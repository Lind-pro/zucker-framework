import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyHttpRequest } from './proxy';

afterEach(() => vi.useRealTimers());

describe('Web request proxy', () => {
  it('preserves authentication and SSE response streaming without draining the body', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Set-Cookie': 'refresh=value; HttpOnly',
          'transfer-encoding': 'chunked',
        },
      }),
    );
    const request = new Request('https://frontend.test/api/events', {
      headers: { Host: 'frontend.test', Authorization: 'Bearer token', Cookie: 'refresh=value' },
    });
    const response = await proxyHttpRequest(request, 'https://backend.test/events', { fetcher });
    expect(fetcher.mock.calls[0][1].headers.get('host')).toBeNull();
    expect(fetcher.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer token');
    expect(fetcher.mock.calls[0][1].headers.get('Cookie')).toBe('refresh=value');
    expect(fetcher.mock.calls[0][1].signal).toBe(request.signal);
    expect(response.body).toBe(body);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Set-Cookie')).toBe('refresh=value; HttpOnly');
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    expect(response.headers.get('transfer-encoding')).toBeNull();
    streamController!.close();
  });

  it('retries only transport failures of GET requests using the configured delays', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection unavailable'))
      .mockResolvedValueOnce(new Response('ready'));
    const pending = proxyHttpRequest(
      new Request('https://frontend.test/ready'),
      'https://backend.test/ready',
      {
        fetcher,
        retryDelaysMs: [250],
      },
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).text()).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('forwards an application error status without retrying it', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const response = await proxyHttpRequest(
      new Request('https://frontend.test/ready'),
      'https://backend.test/ready',
      {
        fetcher,
        retryDelaysMs: [250],
      },
    );
    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('forwards a mutation body once without replaying a failed request', async () => {
    const failure = new TypeError('connection unavailable');
    const fetcher = vi.fn().mockRejectedValue(failure);
    const request = new Request('https://frontend.test/items', {
      method: 'POST',
      body: '{"name":"synthetic"}',
    });
    await expect(
      proxyHttpRequest(request, 'https://backend.test/items', {
        fetcher,
        retryDelaysMs: [250, 500],
      }),
    ).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe('{"name":"synthetic"}');
  });

  it('cancels a retry wait when the caller aborts and never opens another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('connection unavailable'));
    const pending = proxyHttpRequest(
      new Request('https://frontend.test/ready', { signal: controller.signal }),
      'https://backend.test/ready',
      {
        fetcher,
        retryDelaysMs: [250],
      },
    );
    const rejection = expect(pending).rejects.toBe('cancelled');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort('cancelled');
    await rejection;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never forwards client-chosen forwarding or hop-by-hop headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok'));
    const request = new Request('https://frontend.test/auth/login', {
      headers: {
        'X-Forwarded-For': '203.0.113.9',
        'X-Real-IP': '203.0.113.9',
        Forwarded: 'for=203.0.113.9',
        'Keep-Alive': 'timeout=5',
        'X-Custom-Hop': 'secret',
        Connection: 'X-Custom-Hop',
        Authorization: 'Bearer token',
      },
    });
    await proxyHttpRequest(request, 'https://backend.test/auth/login', { fetcher });
    const sent = fetcher.mock.calls[0][1].headers as Headers;
    expect(sent.get('x-forwarded-for')).toBeNull();
    expect(sent.get('x-real-ip')).toBeNull();
    expect(sent.get('forwarded')).toBeNull();
    expect(sent.get('keep-alive')).toBeNull();
    expect(sent.get('x-custom-hop')).toBeNull();
    expect(sent.get('authorization')).toBe('Bearer token');
  });

  it('sets X-Forwarded-For from the trusted client address', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('ok'));
    const request = new Request('https://frontend.test/auth/login', {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    await proxyHttpRequest(request, 'https://backend.test/auth/login', { fetcher, clientIp: '198.51.100.7' });
    const sent = fetcher.mock.calls[0][1].headers as Headers;
    expect(sent.get('x-forwarded-for')).toBe('198.51.100.7');
    expect(sent.get('x-real-ip')).toBe('198.51.100.7');

    await proxyHttpRequest(request, 'https://backend.test/auth/login', {
      fetcher,
      clientIp: '198.51.100.7',
      trustForwardedFor: true,
    });
    expect((fetcher.mock.calls[1][1].headers as Headers).get('x-forwarded-for')).toBe('203.0.113.9, 198.51.100.7');
  });

  it('drops encoding and length headers that no longer describe the decoded body', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '31' },
      }),
    );
    const response = await proxyHttpRequest(new Request('https://frontend.test/x'), 'https://backend.test/x', { fetcher });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });
});
