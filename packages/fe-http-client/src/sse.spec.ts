import { describe, expect, it, vi } from 'vitest';
import { parseSseEventBlock, readSseStream } from './sse';

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
