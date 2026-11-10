import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DistributedEventBus } from './distributed-event-bus';
import type { RedisLike } from './cluster-manager';
import { DefaultTopicEventBus, type TopicPayload } from '@zucker-framework/event';

function createMockRedis(): RedisLike {
  const messageListeners: Array<(channel: unknown, message: unknown) => void> = [];
  const subscribedChannels = new Set<string>();

  const redis: any = {
    async publish(channel: string, message: string) {
      // Simulate pub/sub by calling listeners on subscriber
      for (const listener of messageListeners) {
        listener(channel, message);
      }
      return 1;
    },
    async subscribe(channel: string) {
      subscribedChannels.add(channel);
    },
    async unsubscribe(...channels: string[]) {
      for (const ch of channels) subscribedChannels.delete(ch);
    },
    on(event: string, callback: (...args: unknown[]) => void) {
      if (event === 'message') {
        messageListeners.push(callback);
      }
      return redis;
    },
    duplicate() {
      // Return a subscriber connection that shares the same listeners
      const sub: any = {
        ...redis,
        on(event: string, callback: (...args: unknown[]) => void) {
          if (event === 'message') {
            messageListeners.push(callback);
          }
          return sub;
        },
        async subscribe(channel: string) {
          subscribedChannels.add(channel);
        },
        async unsubscribe(...channels: string[]) {
          for (const ch of channels) subscribedChannels.delete(ch);
        },
        async quit() {},
      };
      return sub;
    },
    async quit() {},
    // Unused but required by interface
    async set() { return null; },
    async get() { return null; },
    async del() { return 0; },
    async hset() { return 1; },
    async hget() { return null; },
    async hdel() { return 1; },
    async hgetall() { return {}; },
    async eval() { return 0; },
    async pexpire() { return 0; },
    _subscribedChannels: subscribedChannels,
    _messageListeners: messageListeners,
  };
  return redis;
}

describe('DistributedEventBus', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let localBus: DefaultTopicEventBus;
  let distributedBus: DistributedEventBus;

  beforeEach(() => {
    redis = createMockRedis();
    localBus = new DefaultTopicEventBus();
    distributedBus = new DistributedEventBus(redis, localBus);
  });

  it('should publish to local bus', async () => {
    const received: unknown[] = [];
    localBus.subscribe('/test', (msg: TopicPayload) => {
      received.push(msg.payload);
    });
    await distributedBus.publish('/test', { data: 1 });
    expect(received).toContainEqual({ data: 1 });
  });

  it('should throw on empty topic publish', async () => {
    await expect(distributedBus.publish('', 'data')).rejects.toThrow('Topic must not be empty');
  });

  it('should subscribe with string pattern', async () => {
    const received: unknown[] = [];
    distributedBus.subscribe('/events/test', (msg) => {
      received.push(msg.payload);
    });
    // Publish via local bus directly to test local subscription
    await localBus.publish('/events/test', 'hello');
    expect(received).toContainEqual('hello');
  });

  it('should subscribe with SubscriptionInfo', async () => {
    const received: string[] = [];
    distributedBus.subscribe(
      { subscriberId: 'sub1', topics: ['/a', '/b'] },
      (msg) => { received.push(msg.topic); },
    );
    await localBus.publish('/a', null);
    await localBus.publish('/b', null);
    expect(received).toContain('/a');
    expect(received).toContain('/b');
  });

  it('should unsubscribe from string pattern', async () => {
    let count = 0;
    const sub = distributedBus.subscribe('/test', () => { count++; });
    await localBus.publish('/test', null);
    expect(count).toBe(1);

    sub.unsubscribe();
    await localBus.publish('/test', null);
    expect(count).toBe(1);
  });

  it('should unsubscribe from SubscriptionInfo (all topics)', async () => {
    let count = 0;
    const sub = distributedBus.subscribe(
      { subscriberId: 'sub1', topics: ['/a', '/b'] },
      () => { count++; },
    );
    await localBus.publish('/a', null);
    await localBus.publish('/b', null);
    expect(count).toBe(2);

    sub.unsubscribe();
    await localBus.publish('/a', null);
    await localBus.publish('/b', null);
    expect(count).toBe(2);
  });

  it('should publish to Redis channel', async () => {
    const publishSpy = vi.spyOn(redis as any, 'publish');
    await distributedBus.publish('/test/topic', { key: 'value' });
    expect(publishSpy).toHaveBeenCalledWith(
      'zucker:events:/test/topic',
      expect.any(String),
    );
  });

  it('should use custom channel prefix', () => {
    const customBus = new DistributedEventBus(redis, localBus, { channelPrefix: 'custom:' });
    const publishSpy = vi.spyOn(redis as any, 'publish');
    customBus.publish('/test', 'data');
    expect(publishSpy).toHaveBeenCalledWith('custom:/test', expect.any(String));
  });

  it('should destroy and clean up', async () => {
    distributedBus.subscribe('/test', () => {});
    await distributedBus.destroy();
    // After destroy, internal handlers should be cleared
    // Verify no error on double destroy
    await expect(distributedBus.destroy()).resolves.toBeUndefined();
  });

  it('should serialize headers in publish', async () => {
    const publishSpy = vi.spyOn(redis as any, 'publish');
    await distributedBus.publish('/test', 'data', { traceId: 'abc' });
    const call = publishSpy.mock.calls[0];
    const message = JSON.parse(call[1] as string);
    expect(message.headers.traceId).toBe('abc');
    expect(message.payload).toBe('data');
  });

  describe('cross-node delivery (regression: H2)', () => {
    /** Two buses sharing one fake Redis that supports PSUBSCRIBE. */
    function createPatternRedis() {
      const pListeners: Array<(p: unknown, c: unknown, m: unknown) => void> = [];
      const patterns = new Set<string>();
      const toRegex = (glob: string) =>
        new RegExp('^' + glob.replace(/\\(.)/g, '$1').replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const base: any = {
        publishFails: false,
        psubscribeFails: false,
        async publish(channel: string, message: string) {
          if (base.publishFails) throw new Error('redis down');
          for (const pattern of patterns) {
            if (toRegex(pattern).test(channel)) for (const l of pListeners) l(pattern, channel, message);
          }
          return 1;
        },
        on() { return base; },
        duplicate() {
          const sub: any = {
            on(event: string, cb: any) { if (event === 'pmessage') pListeners.push(cb); return sub; },
            async psubscribe(pattern: string) {
              if (base.psubscribeFails) throw new Error('subscribe failed');
              patterns.add(pattern);
            },
            async punsubscribe(pattern: string) { patterns.delete(pattern); },
            async subscribe() {},
            async unsubscribe() {},
            async quit() {},
          };
          return sub;
        },
        patterns,
      };
      return base;
    }

    it('runs a handler on the publishing node exactly once', async () => {
      const shared = createPatternRedis();
      const bus = new DistributedEventBus(shared, new DefaultTopicEventBus());
      let count = 0;
      bus.subscribe('/orders/created', () => { count++; });
      await bus.publish('/orders/created', { id: 1 });
      await new Promise((r) => setTimeout(r, 0));
      expect(count).toBe(1);
    });

    it('delivers remote events to wildcard subscribers with the same payload shape and headers', async () => {
      const shared = createPatternRedis();
      const nodeA = new DistributedEventBus(shared, new DefaultTopicEventBus());
      const nodeB = new DistributedEventBus(shared, new DefaultTopicEventBus());
      const received: Array<{ topic: string; payload: unknown; trace: unknown }> = [];
      nodeB.subscribe('entity/user/**', (msg) => {
        received.push({ topic: msg.topic, payload: msg.payload, trace: msg.headers.get('traceId') });
      });
      await new Promise((r) => setTimeout(r, 0));
      await nodeA.publish('entity/user/create', { id: 7 }, { traceId: 't1' });
      await new Promise((r) => setTimeout(r, 0));
      expect(received).toEqual([{ topic: 'entity/user/create', payload: { id: 7 }, trace: 't1' }]);
    });

    it('still delivers locally when the Redis publish fails, then rejects', async () => {
      const shared = createPatternRedis();
      const bus = new DistributedEventBus(shared, new DefaultTopicEventBus());
      const received: unknown[] = [];
      bus.subscribe('/a', (msg) => { received.push(msg.payload); });
      shared.publishFails = true;
      await expect(bus.publish('/a', 1)).rejects.toThrow('redis down');
      expect(received).toEqual([1]);

      const lenient = new DistributedEventBus(shared, new DefaultTopicEventBus(), { onRemotePublishError: 'log' });
      await expect(lenient.publish('/a', 2)).resolves.toBeUndefined();
    });

    it('handles a failed Redis subscribe and retries on the next subscribe', async () => {
      const shared = createPatternRedis();
      shared.psubscribeFails = true;
      const bus = new DistributedEventBus(shared, new DefaultTopicEventBus());
      bus.subscribe('/a', () => {});
      await new Promise((r) => setTimeout(r, 0));
      expect(shared.patterns.size).toBe(0);
      shared.psubscribeFails = false;
      bus.subscribe('/b', () => {});
      await new Promise((r) => setTimeout(r, 0));
      expect(shared.patterns.size).toBe(1);
      await bus.destroy();
      expect(shared.patterns.size).toBe(0);
    });

    it('unsubscribes the exact Redis channel when the last handler leaves (no psubscribe)', async () => {
      const sub = distributedBus.subscribe('/x', () => {});
      const channels = (redis as any)._subscribedChannels as Set<string>;
      await new Promise((r) => setTimeout(r, 0));
      expect(channels.has('zucker:events:/x')).toBe(true);
      sub.unsubscribe();
      await new Promise((r) => setTimeout(r, 0));
      expect(channels.has('zucker:events:/x')).toBe(false);
    });
  });
});
