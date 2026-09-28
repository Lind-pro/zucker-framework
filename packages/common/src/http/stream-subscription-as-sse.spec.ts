import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamSubscriptionAsSSE } from './stream-subscription-as-sse';

function response() {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
  });
  return res;
}
type Payload = { version: number; terminal?: boolean; content?: string };
afterEach(() => vi.useRealTimers());

describe('streamSubscriptionAsSSE', () => {
  it('waits for authorized final data before completing a synchronously ended source', async () => {
    const res = response();
    const unsubscribe = vi.fn();
    let authorize!: () => void;
    const ready = streamSubscriptionAsSSE<Payload>(res as unknown as Response, {
      source: {
        subscribe(observer) {
          observer.next({ version: 2, terminal: true, content: 'private' });
          observer.complete();
          return { unsubscribe };
        },
      },
      snapshot: () => ({ version: 1 }),
      shouldSend: (value, prior) => value.version > (prior?.version ?? -1),
      transform: async (value) => {
        await new Promise<void>((resolve) => {
          authorize = resolve;
        });
        return { ...value, content: 'masked' };
      },
      isTerminal: (value) => !!value.terminal,
    });
    await Promise.resolve();
    expect(res.end).not.toHaveBeenCalled();
    authorize();
    await ready;
    expect(res.write).toHaveBeenCalledExactlyOnceWith(
      'data: {"version":2,"terminal":true,"content":"masked"}\n\n',
    );
    expect(res.end).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('cleans disconnected subscriptions without cancelling the producer or sending late data', async () => {
    vi.useFakeTimers();
    const res = response();
    const source = new Subject<Payload>();
    const backgroundEvent = vi.fn();
    const background = source.subscribe(backgroundEvent);
    await streamSubscriptionAsSSE<Payload>(res as unknown as Response, {
      source,
      snapshot: () => ({ version: 1 }),
      isTerminal: (value) => !!value.terminal,
      heartbeatMs: 10,
    });
    res.emit('close');
    source.next({ version: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(background.closed).toBe(false);
    expect(backgroundEvent).toHaveBeenCalledExactlyOnceWith({ version: 2 });
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    background.unsubscribe();
    expect(source.observed).toBe(false);
  });

  it('allows a same-version terminal according to consumer policy', async () => {
    const res = response();
    const source = new Subject<Payload>();
    await streamSubscriptionAsSSE<Payload>(res as unknown as Response, {
      source,
      snapshot: () => ({ version: 1 }),
      isTerminal: (value) => !!value.terminal,
      shouldSend: (value, prior) =>
        !prior ||
        value.version > prior.version ||
        (value.version === prior.version && !!value.terminal),
    });
    source.next({ version: 1, terminal: true });
    source.complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(res.write).toHaveBeenLastCalledWith('data: {"version":1,"terminal":true}\n\n');
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('fails closed when an asynchronous authorization transform rejects', async () => {
    const res = response();
    const source = new Subject<Payload>();
    const onError = vi.fn();
    await streamSubscriptionAsSSE<Payload>(res as unknown as Response, {
      source,
      snapshot: () => ({ version: 1 }),
      isTerminal: () => false,
      transform: async () => {
        throw new Error('authorization unavailable');
      },
      onError,
    });
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
    expect(source.observed).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });
});
