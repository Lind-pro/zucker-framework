import { Logger } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DefaultTopicEventBus, matchesTopic, createTopicPayload } from './topic-event-bus';
import { SubscribeFeature } from './subscribe.decorator';

describe('matchesTopic', () => {
  it('should match exact topics', () => {
    expect(matchesTopic('/device/status', '/device/status')).toBe(true);
    expect(matchesTopic('/device/status', '/device/other')).toBe(false);
  });

  it('should match single-level wildcard *', () => {
    expect(matchesTopic('/device/*/status', '/device/d1/status')).toBe(true);
    expect(matchesTopic('/device/*/status', '/device/d2/status')).toBe(true);
    expect(matchesTopic('/device/*/status', '/device/d1/other')).toBe(false);
  });

  it('should not match multiple levels with *', () => {
    expect(matchesTopic('/device/*/status', '/device/a/b/status')).toBe(false);
  });

  it('should match multi-level wildcard **', () => {
    expect(matchesTopic('/device/**', '/device/d1/status')).toBe(true);
    expect(matchesTopic('/device/**', '/device/d1/d2/d3')).toBe(true);
    expect(matchesTopic('/device/**', '/device')).toBe(true);
  });

  it('should match ** in the middle', () => {
    expect(matchesTopic('/device/**/status', '/device/a/b/status')).toBe(true);
    expect(matchesTopic('/device/**/status', '/device/status')).toBe(true);
  });

  it('should match comma-separated segments', () => {
    expect(matchesTopic('/device/d1,d2/status', '/device/d1/status')).toBe(true);
    expect(matchesTopic('/device/d1,d2/status', '/device/d2/status')).toBe(true);
    expect(matchesTopic('/device/d1,d2/status', '/device/d3/status')).toBe(false);
  });

  it('should handle trailing **', () => {
    expect(matchesTopic('/**', '/anything/here')).toBe(true);
  });

  it('should not match when pattern is shorter without wildcard', () => {
    expect(matchesTopic('/a/b', '/a/b/c')).toBe(false);
  });

  it('should not match when topic is shorter', () => {
    expect(matchesTopic('/a/b/c', '/a/b')).toBe(false);
  });

  it('should match empty segments correctly', () => {
    expect(matchesTopic('/', '/')).toBe(true);
  });
});

describe('createTopicPayload', () => {
  it('should create payload with topic and data', () => {
    const tp = createTopicPayload('/test', { value: 1 });
    expect(tp.topic).toBe('/test');
    expect(tp.payload).toEqual({ value: 1 });
    expect(tp.headers.size).toBe(0);
  });

  it('should accept record headers', () => {
    const tp = createTopicPayload('/test', 'data', { traceId: '123' });
    expect(tp.headers.get('traceId')).toBe('123');
  });

  it('should accept Map headers', () => {
    const headers = new Map([['key', 'value']]);
    const tp = createTopicPayload('/test', 'data', headers);
    expect(tp.headers.get('key')).toBe('value');
  });
});

describe('DefaultTopicEventBus', () => {
  let bus: DefaultTopicEventBus;

  beforeEach(() => {
    bus = new DefaultTopicEventBus();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deliver messages to matching subscribers', async () => {
    const received: unknown[] = [];
    bus.subscribe('/device/status', (msg) => {
      received.push(msg.payload);
    });

    await bus.publish('/device/status', { online: true });
    expect(received).toEqual([{ online: true }]);
  });

  it('should support wildcard subscriptions', async () => {
    const received: string[] = [];
    bus.subscribe('/device/*/status', (msg) => {
      received.push(msg.topic);
    });

    await bus.publish('/device/d1/status', 'ok');
    await bus.publish('/device/d2/status', 'ok');
    await bus.publish('/device/d1/data', 'nope');

    expect(received).toEqual(['/device/d1/status', '/device/d2/status']);
  });

  it('should support ** wildcard', async () => {
    const received: string[] = [];
    bus.subscribe('/device/**', (msg) => {
      received.push(msg.topic);
    });

    await bus.publish('/device/d1/status', null);
    await bus.publish('/device/d1/d2/data', null);

    expect(received).toHaveLength(2);
  });

  it('should deliver in priority order', async () => {
    const order: number[] = [];
    bus.subscribe(
      '/test',
      () => {
        order.push(3);
      },
      3,
    );
    bus.subscribe(
      '/test',
      () => {
        order.push(1);
      },
      1,
    );
    bus.subscribe(
      '/test',
      () => {
        order.push(2);
      },
      2,
    );

    await bus.publish('/test', null);
    expect(order).toEqual([1, 2, 3]);
  });

  it('should unsubscribe correctly', async () => {
    let count = 0;
    const sub = bus.subscribe('/test', () => {
      count++;
    });

    await bus.publish('/test', null);
    expect(count).toBe(1);

    sub.unsubscribe();
    await bus.publish('/test', null);
    expect(count).toBe(1);
  });

  it('should deliver to multiple subscribers on the same topic', async () => {
    const calls: string[] = [];
    bus.subscribe('/test', () => {
      calls.push('handler-a');
    });
    bus.subscribe('/test', () => {
      calls.push('handler-b');
    });
    bus.subscribe('/test', () => {
      calls.push('handler-c');
    });

    await bus.publish('/test', null);
    expect(calls).toEqual(['handler-a', 'handler-b', 'handler-c']);
  });

  it('should not throw when subscriber errors', async () => {
    const loggerSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    bus.subscribe('/test', () => {
      throw new Error('boom');
    });

    await expect(bus.publish('/test', null)).resolves.toBeUndefined();
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('Subscriber error on topic "/test": boom'),
      expect.any(String),
    );
  });

  it('should isolate errors — other handlers still execute after one throws', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const calls: string[] = [];

    bus.subscribe('/test', () => {
      calls.push('before');
    });
    bus.subscribe('/test', () => {
      throw new Error('boom');
    });
    bus.subscribe('/test', () => {
      calls.push('after');
    });

    await bus.publish('/test', null);
    expect(calls).toEqual(['before', 'after']);
  });

  it('should support legacy handler (payload, topic)', async () => {
    let receivedPayload: unknown;
    let receivedTopic = '';

    bus.subscribe('/test', (payload: unknown, topic: string) => {
      receivedPayload = payload;
      receivedTopic = topic;
    });

    await bus.publish('/test', { data: 1 });
    expect(receivedPayload).toEqual({ data: 1 });
    expect(receivedTopic).toBe('/test');
  });

  it('should support SubscriptionInfo-based subscribe', async () => {
    const received: string[] = [];
    bus.subscribe(
      {
        subscriberId: 'test-sub',
        topics: ['/a/**', '/b/**'],
        features: [SubscribeFeature.LOCAL],
      },
      (msg) => {
        received.push(msg.topic);
      },
    );

    await bus.publish('/a/1', null);
    await bus.publish('/b/2', null);
    await bus.publish('/c/3', null);

    expect(received).toEqual(['/a/1', '/b/2']);
  });

  it('should unsubscribe all topics from SubscriptionInfo', async () => {
    let count = 0;
    const sub = bus.subscribe({ subscriberId: 'x', topics: ['/a', '/b'] }, () => {
      count++;
    });

    await bus.publish('/a', null);
    await bus.publish('/b', null);
    expect(count).toBe(2);

    sub.unsubscribe();
    await bus.publish('/a', null);
    await bus.publish('/b', null);
    expect(count).toBe(2);
  });

  it('should normalize MQTT wildcards # and +', async () => {
    const received: string[] = [];
    bus.subscribe('/device/#', (msg) => {
      received.push(msg.topic);
    });

    await bus.publish('/device/a/b/c', null);
    expect(received).toEqual(['/device/a/b/c']);

    const received2: string[] = [];
    bus.subscribe('/device/+/status', (msg) => {
      received2.push(msg.topic);
    });

    await bus.publish('/device/d1/status', null);
    expect(received2).toEqual(['/device/d1/status']);
  });

  it('should pass headers via publish', async () => {
    let headers: ReadonlyMap<string, unknown> | undefined;
    bus.subscribe('/test', (msg) => {
      headers = msg.headers;
    });

    await bus.publish('/test', 'payload', { traceId: 'abc' });
    expect(headers?.get('traceId')).toBe('abc');
  });

  it('should remove all listeners', async () => {
    let count = 0;
    bus.subscribe('/a', () => {
      count++;
    });
    bus.subscribe('/b', () => {
      count++;
    });

    bus.removeAllListeners();
    await bus.publish('/a', null);
    await bus.publish('/b', null);
    expect(count).toBe(0);
  });
});
