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

/** In-memory Redis pub/sub shared by several bus instances. */
function pubSubHub() {
  const clients: Array<{ emitter: EventEmitter; channels: Set<string> }> = [];
  const created: ReplayEventRedisClient[] = [];
  const makeClient = (): ReplayEventRedisClient => {
    const emitter = new EventEmitter();
    const channels = new Set<string>();
    clients.push({ emitter, channels });
    const client = Object.assign(emitter, {
      duplicate: () => makeClient(),
      publish: vi.fn(async (channel: string, message: string) => {
        for (const client of clients) if (client.channels.has(channel)) client.emitter.emit('message', channel, message);
        return 1;
      }),
      subscribe: vi.fn(async (channel: string) => { channels.add(channel); return 1; }),
      unsubscribe: vi.fn(async (channel: string) => { channels.delete(channel); return 0; }),
      quit: vi.fn(async () => 'OK'),
    }) as unknown as ReplayEventRedisClient;
    created.push(client);
    return client;
  };
  return { makeClient, created };
}

describe('RedisReplayEventBus run boundaries (N-H3)', () => {
  type Evt = { value: number; run?: string; done?: boolean };
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function twoBuses() {
    const hub = pubSubHub();
    const make = () =>
      new RedisReplayEventBus<string, Evt>({
        channel: (key) => `progress:${key}`,
        isTerminal: (event) => event.done === true,
        channelTtlMs: 120_000,
        cleanupIntervalMs: 1_000,
        createClient: hub.makeClient,
        parsePayload: (value) => value as Evt,
      });
    const a = make();
    const b = make();
    a.onModuleInit();
    b.onModuleInit();
    return { a, b };
  }
  const collect = (bus: RedisReplayEventBus<string, Evt>, key: string) => {
    const seen: number[] = [];
    let completed = false;
    bus.stream(key).subscribe({ next: (event) => seen.push(event.value), complete: () => { completed = true; } });
    return { seen, isComplete: () => completed };
  };

  it('begin() on instance A drops the terminal run retained on instance B', async () => {
    const { a, b } = twoBuses();
    // Both instances follow run 1 and retain its terminal event.
    const aRun1 = collect(a, 'doc');
    const bRun1 = collect(b, 'doc');
    a.publish('doc', { value: 1 });
    a.publish('doc', { value: 2, done: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(aRun1.seen).toEqual([1, 2]);
    expect(bRun1.seen).toEqual([1, 2]);

    // Without begin(), a late subscriber on B would replay run 1.
    expect(collect(b, 'doc').seen).toEqual([2]);

    a.begin('doc');
    await vi.advanceTimersByTimeAsync(0);

    const bRun2 = collect(b, 'doc');
    const aRun2 = collect(a, 'doc');
    expect(bRun2.seen).toEqual([]);
    expect(bRun2.isComplete()).toBe(false);
    expect(aRun2.seen).toEqual([]);

    a.publish('doc', { value: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(bRun2.seen).toEqual([10]);
    expect(aRun2.seen).toEqual([10]);
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it('subscribes to the control channel only once the instance retains a finished run', async () => {
    const hub = pubSubHub();
    const bus = new RedisReplayEventBus<string, Evt>({
      channel: (key) => `progress:${key}`,
      isTerminal: (event) => event.done === true,
      channelTtlMs: 120_000,
      cleanupIntervalMs: 1_000,
      createClient: hub.makeClient,
      parsePayload: (value) => value as Evt,
    });
    bus.onModuleInit();
    const subscriber = hub.created[1];
    bus.stream('doc').subscribe();
    expect((subscriber.subscribe as ReturnType<typeof vi.fn>).mock.calls).toEqual([['progress:doc']]);

    bus.publish('doc', { value: 1, done: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((subscriber.subscribe as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['progress:doc'],
      ['zucker:replay-bus:control'],
    ]);
    await bus.onModuleDestroy();
  });

  it('honours a custom controlChannel', async () => {
    const hub = pubSubHub();
    const publishers: ReplayEventRedisClient[] = [];
    const bus = new RedisReplayEventBus<string, Evt>({
      channel: (key) => `progress:${key}`,
      isTerminal: (event) => event.done === true,
      channelTtlMs: 120_000,
      cleanupIntervalMs: 1_000,
      controlChannel: 'custom:control',
      createClient: () => { const client = hub.makeClient(); publishers.push(client); return client; },
      parsePayload: (value) => value as Evt,
    });
    bus.onModuleInit();
    bus.begin('doc');
    expect(publishers[0].publish).toHaveBeenCalledWith('custom:control', JSON.stringify({ begin: 'progress:doc' }));
    await bus.onModuleDestroy();
  });
});
