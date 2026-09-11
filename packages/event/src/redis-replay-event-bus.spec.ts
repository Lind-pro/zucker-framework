import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisReplayEventBus, type ReplayEventRedisClient } from './redis-replay-event-bus';

function harness() {
  const subscriber = Object.assign(new EventEmitter(), {
    duplicate: (): ReplayEventRedisClient => {
      throw new Error('unexpected duplicate');
    },
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 0),
    quit: vi.fn(async () => 'OK'),
  });
  const publisher = Object.assign(new EventEmitter(), {
    duplicate: vi.fn(() => subscriber),
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 0),
    quit: vi.fn(async () => 'OK'),
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const createClient = vi.fn(() => publisher);
  const bus = new RedisReplayEventBus({
    channel: (key: string) => `progress:${key}`,
    isTerminal: (event: { value: number; done?: boolean }) => event.done === true,
    channelTtlMs: 100,
    cleanupIntervalMs: 25,
    createClient,
    logger,
    parsePayload: (value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        !('value' in value) ||
        typeof value.value !== 'number'
      )
        throw new Error('invalid');
      return value as { value: number; done?: boolean };
    },
  });
  return { bus, publisher, subscriber, createClient, logger };
}

describe('RedisReplayEventBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes once, shares subscriptions and delivers only subscribed channels', async () => {
    const { bus, publisher, subscriber, createClient } = harness();
    bus.onModuleInit();
    bus.onModuleInit();
    const first: number[] = [];
    const second: number[] = [];
    bus.stream('a').subscribe((event) => first.push(event.value));
    bus.stream('a').subscribe((event) => second.push(event.value));
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    subscriber.emit('message', 'progress:other', '{"value":99}');
    subscriber.emit('message', 'progress:a', '{"value":1}');
    expect(first).toEqual([1]);
    expect(second).toEqual([1]);
    bus.publish('a', { value: 2 });
    expect(publisher.publish).toHaveBeenCalledWith('progress:a', '{"value":2}');
    expect(createClient).toHaveBeenCalledTimes(1);
    await bus.onModuleDestroy();
    await bus.onModuleDestroy();
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    expect(publisher.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves active streams past TTL and unsubscribes after terminal delivery', async () => {
    const { bus, subscriber } = harness();
    bus.onModuleInit();
    const seen: string[] = [];
    bus
      .stream('slow')
      .subscribe({
        next: (event) => seen.push(String(event.value)),
        complete: () => seen.push('complete'),
      });
    await vi.advanceTimersByTimeAsync(1000);
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    subscriber.emit('message', 'progress:slow', '{"value":3,"done":true}');
    expect(seen).toEqual(['3', 'complete']);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('progress:slow');
    await bus.onModuleDestroy();
  });

  it('drops invalid payloads without leaking wire data and can retry a failed subscription', async () => {
    const { bus, subscriber, logger } = harness();
    bus.onModuleInit();
    subscriber.subscribe.mockRejectedValueOnce(new Error('private connection data'));
    bus.stream('a');
    await Promise.resolve();
    bus.stream('a');
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    const received: number[] = [];
    bus.stream('a').subscribe((event) => received.push(event.value));
    subscriber.emit('message', 'progress:a', 'private malformed JSON');
    subscriber.emit('message', 'progress:a', 'null');
    subscriber.emit('message', 'progress:a', '{"value":4}');
    expect(received).toEqual([4]);
    expect(logger.warn).toHaveBeenCalledWith('Invalid Redis progress event');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private');
    await bus.onModuleDestroy();
  });

  it('closes both connections even if one quit fails', async () => {
    const { bus, subscriber, publisher } = harness();
    bus.onModuleInit();
    subscriber.quit.mockRejectedValueOnce(new Error('failed close'));
    await bus.onModuleDestroy();
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    expect(publisher.quit).toHaveBeenCalledTimes(1);
  });
});
