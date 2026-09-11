import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayEventBus } from './replay-event-bus';

const options = {
  channel: (key: string) => key,
  isTerminal: (event: { value: number; done?: boolean }) => event.done === true,
  channelTtlMs: 100,
  cleanupIntervalMs: 25,
};

describe('ReplayEventBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays only the last event and isolates context-derived channels', async () => {
    const bus = new ReplayEventBus(options);
    bus.publish('alice', { value: 1 });
    bus.publish('alice', { value: 2 });
    const alice: number[] = [];
    const bob: number[] = [];
    bus.stream('alice').subscribe((event) => alice.push(event.value));
    bus.stream('bob').subscribe((event) => bob.push(event.value));
    expect(alice).toEqual([2]);
    expect(bob).toEqual([]);
    await bus.onModuleDestroy();
  });

  it('delivers a terminal event before completing and allows a fresh stream', async () => {
    const bus = new ReplayEventBus(options);
    const seen: string[] = [];
    bus
      .stream('a')
      .subscribe({
        next: (event) => seen.push(String(event.value)),
        complete: () => seen.push('complete'),
      });
    bus.publish('a', { value: 3, done: true });
    expect(seen).toEqual(['3', 'complete']);
    const fresh: number[] = [];
    bus.stream('a').subscribe((event) => fresh.push(event.value));
    expect(fresh).toEqual([]);
    await bus.onModuleDestroy();
  });

  it('retains active streams beyond TTL and evicts only idle unobserved channels', async () => {
    const bus = new ReplayEventBus(options);
    const values: number[] = [];
    const complete = vi.fn();
    const subscription = bus
      .stream('slow')
      .subscribe({ next: (event) => values.push(event.value), complete });
    bus.publish('orphan', { value: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    bus.publish('slow', { value: 2 });
    expect(values).toEqual([2]);
    expect(complete).not.toHaveBeenCalled();
    const stale: number[] = [];
    bus.stream('orphan').subscribe((event) => stale.push(event.value));
    expect(stale).toEqual([]);
    subscription.unsubscribe();
    await bus.onModuleDestroy();
    await bus.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
