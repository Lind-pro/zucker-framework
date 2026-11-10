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

  it('delivers a terminal event before completing, replays it to late subscribers and allows a fresh run', async () => {
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
    // A subscriber arriving just after the terminal event still receives it and completes.
    const late: string[] = [];
    bus.stream('a').subscribe({
      next: (event) => late.push(String(event.value)),
      complete: () => late.push('complete'),
    });
    expect(late).toEqual(['3', 'complete']);
    // A later non-terminal event starts a fresh run on the same channel.
    bus.publish('a', { value: 4 });
    const fresh: number[] = [];
    bus.stream('a').subscribe((event) => fresh.push(event.value));
    expect(fresh).toEqual([4]);
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
  describe('run boundaries (N-H3)', () => {
    type Evt = { value: number; run?: string; done?: boolean };
    const runOptions = {
      channel: (key: string) => key,
      isTerminal: (event: Evt) => event.done === true,
      runId: (event: Evt) => event.run,
      channelTtlMs: 120_000,
      cleanupIntervalMs: 1_000,
    };
    const collect = (observable: import('rxjs').Observable<Evt>) => {
      const seen: string[] = [];
      let completed = false;
      const subscription = observable.subscribe({
        next: (event) => seen.push(`${event.run ?? ''}${event.value}`),
        complete: () => { completed = true; },
      });
      return { seen, subscription, isComplete: () => completed };
    };

    it('begin() drops the previous run: a new subscriber sees nothing, stays open, then only run 2 events', async () => {
      const bus = new ReplayEventBus(runOptions);
      bus.publish('doc', { value: 1 });
      bus.publish('doc', { value: 2, done: true });

      bus.begin('doc');
      const run2 = collect(bus.stream('doc'));
      expect(run2.seen).toEqual([]);
      expect(run2.isComplete()).toBe(false);

      bus.publish('doc', { value: 10 });
      bus.publish('doc', { value: 11, done: true });
      expect(run2.seen).toEqual(['10', '11']);
      expect(run2.isComplete()).toBe(true);
      await bus.onModuleDestroy();
    });

    it('reset() is an alias of begin()', async () => {
      const bus = new ReplayEventBus(runOptions);
      bus.publish('doc', { value: 2, done: true });
      bus.reset('doc');
      const run2 = collect(bus.stream('doc'));
      expect(run2.seen).toEqual([]);
      expect(run2.isComplete()).toBe(false);
      await bus.onModuleDestroy();
    });

    it('begin() does not disturb a channel with a live (non-terminal) run', async () => {
      const bus = new ReplayEventBus(runOptions);
      const live = collect(bus.stream('doc'));
      bus.publish('doc', { value: 1 });
      bus.begin('doc');
      bus.publish('doc', { value: 2 });
      expect(live.seen).toEqual(['1', '2']);
      await bus.onModuleDestroy();
    });

    it('without begin() the retained terminal replay is still delivered within the retention window', async () => {
      const bus = new ReplayEventBus(runOptions);
      bus.publish('doc', { value: 2, done: true });
      await vi.advanceTimersByTimeAsync(29_000);
      const late = collect(bus.stream('doc'));
      expect(late.seen).toEqual(['2']);
      expect(late.isComplete()).toBe(true);
      await bus.onModuleDestroy();
    });

    it('without begin() the retained replay expires after min(channelTtlMs, 30 s)', async () => {
      const bus = new ReplayEventBus(runOptions);
      bus.publish('doc', { value: 2, done: true });
      await vi.advanceTimersByTimeAsync(31_500);
      const late = collect(bus.stream('doc'));
      expect(late.seen).toEqual([]);
      expect(late.isComplete()).toBe(false);
      await bus.onModuleDestroy();
    });

    it('a short channelTtlMs shortens the retention below 30 s', async () => {
      const bus = new ReplayEventBus({ ...runOptions, channelTtlMs: 5_000 });
      bus.publish('doc', { value: 2, done: true });
      await vi.advanceTimersByTimeAsync(6_500);
      expect(collect(bus.stream('doc')).seen).toEqual([]);
      await bus.onModuleDestroy();
    });

    it('an explicit terminalRetentionMs overrides the default', async () => {
      const bus = new ReplayEventBus({ ...runOptions, terminalRetentionMs: 60_000 });
      bus.publish('doc', { value: 2, done: true });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(collect(bus.stream('doc')).seen).toEqual(['2']);
      await bus.onModuleDestroy();
    });

    it('stream(ctx, { runId }) ignores a retained entry of another run', async () => {
      const bus = new ReplayEventBus(runOptions);
      bus.publish('doc', { value: 2, run: 'r1', done: true });

      const other = collect(bus.stream('doc', { runId: 'r2' }));
      expect(other.seen).toEqual([]);
      expect(other.isComplete()).toBe(false);
      bus.publish('doc', { value: 5, run: 'r2' });
      expect(other.seen).toEqual(['r25']);
      await bus.onModuleDestroy();
    });

    it('stream(ctx, { runId }) still replays the retained entry of the same run', async () => {
      const bus = new ReplayEventBus(runOptions);
      bus.publish('doc', { value: 2, run: 'r1', done: true });
      const same = collect(bus.stream('doc', { runId: 'r1' }));
      expect(same.seen).toEqual(['r12']);
      expect(same.isComplete()).toBe(true);
      await bus.onModuleDestroy();
    });
  });
});
