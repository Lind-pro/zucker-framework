import { describe, expect, it, vi } from 'vitest';
import { connectSse, parseSseEventBlock, readSseStream } from './sse';

function createResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('parseSseEventBlock', () => {
  it('parses event, multiline data, id and retry fields', () => {
    expect(
      parseSseEventBlock('event: status\r\nid: 42\r\nretry: 1500\r\ndata: first\r\ndata: second'),
    ).toEqual({
      event: 'status',
      data: 'first\nsecond',
      id: '42',
      retry: 1500,
      isComment: false,
    });
  });

  it('recognizes heartbeat comment blocks', () => {
    expect(parseSseEventBlock(': heartbeat')).toEqual({
      event: '',
      data: '',
      isComment: true,
    });
  });

  it('ignores empty non-event blocks', () => {
    expect(parseSseEventBlock('unknown: value')).toBeNull();
  });
});

describe('readSseStream', () => {
  it('reassembles events split across network chunks', async () => {
    const onEvent = vi.fn();
    await readSseStream(createResponse(['event: res', 'ult\ndata: {"ok":', 'true}\n\n']), {
      onEvent,
    });
    expect(onEvent).toHaveBeenCalledWith({
      event: 'result',
      data: '{"ok":true}',
      isComment: false,
    });
  });

  it('stops reading when the consumer returns false', async () => {
    const events: string[] = [];
    await readSseStream(createResponse(['data: one\n\ndata: two\n\n']), {
      onEvent(event) {
        events.push(event.data);
        return false;
      },
    });
    expect(events).toEqual(['one']);
  });
});

describe('readSseStream limits (L12)', () => {
  it('rejects an unterminated event larger than maxBufferLength', async () => {
    await expect(
      readSseStream(createResponse(['data: ' + 'x'.repeat(100)]), { onEvent: () => {}, maxBufferLength: 50 }),
    ).rejects.toThrow('buffered characters');
  });
});

describe('connectSse lifecycle (L12)', () => {
  it('does not reconnect after onEvent returns false and re-evaluates headers per connection', async () => {
    vi.useFakeTimers();
    try {
      let token = 't1';
      const fetcher = vi.fn(async () => createResponse(['data: one\n\n']));
      const stop = connectSse({
        url: '/events',
        headers: () => ({ Authorization: `Bearer ${token}` }),
        onEvent: () => false,
        fetcher: fetcher as unknown as typeof fetch,
        openWhenHidden: true,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledOnce();
      stop.close();

      const reconnecting = vi.fn(async () => createResponse(['data: one\n\n']));
      const live = connectSse({
        url: '/events',
        headers: () => ({ Authorization: `Bearer ${token}` }),
        onEvent: () => {},
        fetcher: reconnecting as unknown as typeof fetch,
        openWhenHidden: true,
        initialRetryDelay: 10,
      });
      await vi.advanceTimersByTimeAsync(1);
      token = 't2';
      await vi.advanceTimersByTimeAsync(20);
      live.close();
      const auth = (reconnecting.mock.calls as unknown as Array<[string, RequestInit]>).map(
        ([, init]) => (init.headers as Record<string, string>).Authorization,
      );
      expect(auth[0]).toBe('Bearer t1');
      expect(auth[1]).toBe('Bearer t2');
    } finally {
      vi.useRealTimers();
    }
  });
});
