import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { streamPromiseAsSSE } from './stream-promise-as-sse';

function createResponse(): Response {
  const response = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    status: Mock;
    setHeader: Mock;
    flushHeaders: Mock;
    write: Mock;
    end: Mock;
  };
  response.writableEnded = false;
  response.status = vi.fn().mockReturnValue(response);
  response.setHeader = vi.fn();
  response.flushHeaders = vi.fn();
  response.write = vi.fn();
  response.end = vi.fn(() => {
    response.writableEnded = true;
  });
  return response as unknown as Response;
}

describe('streamPromiseAsSSE', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not abort a slow AI call when no hard timeout is configured', async () => {
    const response = createResponse();
    let complete: ((value: string) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const pending = streamPromiseAsSSE(response, {
      task: (signal, events) => {
        observedSignal = signal;
        events.emit('task', { taskId: 'task-1' });
        return new Promise<string>((resolve) => {
          complete = resolve;
        });
      },
    });

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(observedSignal?.aborted).toBe(false);

    complete?.('ready');
    await pending;

    expect(response.write).toHaveBeenCalledWith('event: result\ndata: "ready"\n\n');
    expect(response.write).toHaveBeenCalledWith('event: task\ndata: {"taskId":"task-1"}\n\n');
  });

  it('does not stream internal error details to the client', async () => {
    const response = createResponse();
    await streamPromiseAsSSE(response, {
      task: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
      },
    });
    const written = (response.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toContain('hunter2');
    expect(written).toContain('event: error');
  });

  it('keeps the message of client (4xx) errors', async () => {
    const response = createResponse();
    await streamPromiseAsSSE(response, {
      task: async () => {
        throw Object.assign(new Error('credits required'), { status: 402, code: 'CREDITS' });
      },
    });
    expect(response.write).toHaveBeenCalledWith('event: error\ndata: {"message":"credits required","code":"CREDITS"}\n\n');
  });

  it('still supports an explicit business timeout', async () => {
    const response = createResponse();
    let observedSignal: AbortSignal | undefined;
    const pending = streamPromiseAsSSE(response, {
      hardTimeoutMs: 1_000,
      task: (signal) => {
        observedSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(response.write).toHaveBeenCalledWith('event: error\ndata: {"message":"aborted"}\n\n');
  });

  it('cancels disconnected clients and clears heartbeat even if writableEnded is false', async () => {
    const response = createResponse();
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    const pending = streamPromiseAsSSE(response, {
      task: (inputSignal) => {
        signal = inputSignal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    const writes = vi.mocked(response.write).mock.calls.length;
    response.emit('close');
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    finish('late result');
    await pending;
    expect(vi.mocked(response.write).mock.calls).toHaveLength(writes);
    expect(response.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });
});
