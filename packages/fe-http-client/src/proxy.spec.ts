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
});
