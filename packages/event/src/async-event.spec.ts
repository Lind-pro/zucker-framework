import { describe, it, expect, vi } from 'vitest';
import { createAsyncEvent } from './async-event';

describe('createAsyncEvent', () => {
  it('should create event with payload and timestamp', () => {
    const event = createAsyncEvent({ message: 'hello' });
    expect(event.payload).toEqual({ message: 'hello' });
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.handled).toBe(false);
  });

  it('should mark as handled', () => {
    const event = createAsyncEvent('data');
    event.markHandled();
    expect(event.handled).toBe(true);
  });

  it('should report hasListener after registering tasks', () => {
    const event = createAsyncEvent(null);
    expect(event.hasListener).toBe(false);
    event.async(async () => {});
    expect(event.hasListener).toBe(true);
  });

  it('should execute first tasks before async tasks', async () => {
    const order: number[] = [];
    const event = createAsyncEvent('test');

    event.async(async () => { order.push(2); });
    event.first(async () => { order.push(1); });

    await event.getAsync();
    expect(order).toEqual([1, 2]);
  });

  it('should execute multiple first tasks in prepend order (last-added runs first)', async () => {
    const order: string[] = [];
    const event = createAsyncEvent('test');

    event.first(async () => { order.push('first-a'); });
    event.first(async () => { order.push('first-b'); });
    event.async(async () => { order.push('async-a'); });

    await event.getAsync();
    // 参考 hsweb DefaultAsyncEvent.first(): this.first = publisher.then(first)
    // 后注册的 first 任务先执行（prepend 语义）
    expect(order).toEqual(['first-b', 'first-a', 'async-a']);
  });

  it('should execute multiple async tasks in order', async () => {
    const order: string[] = [];
    const event = createAsyncEvent('test');

    event.async(async () => { order.push('a'); });
    event.async(async () => { order.push('b'); });
    event.async(async () => { order.push('c'); });

    await event.getAsync();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('should apply transformFirst', async () => {
    const order: string[] = [];
    const event = createAsyncEvent('test');

    event.first(async () => { order.push('original'); });
    event.transformFirst(async (chain) => {
      // The chain IIFE starts immediately, so 'original' runs before mapper code
      await chain;
      order.push('after-transform');
    });

    await event.getAsync();
    expect(order).toEqual(['original', 'after-transform']);
  });

  it('should apply transform on async chain', async () => {
    const order: string[] = [];
    const event = createAsyncEvent('test');

    event.async(async () => { order.push('task'); });
    event.transform(async (chain) => {
      // The chain IIFE starts immediately, so 'task' runs before mapper code
      await chain;
      order.push('wrap-end');
    });

    await event.getAsync();
    expect(order).toEqual(['task', 'wrap-end']);
  });

  it('should propagate errors from first tasks', async () => {
    const event = createAsyncEvent('test');
    event.first(async () => { throw new Error('first error'); });

    await expect(event.getAsync()).rejects.toThrow('first error');
  });

  it('should propagate errors from async tasks', async () => {
    const event = createAsyncEvent('test');
    event.async(async () => { throw new Error('async error'); });

    await expect(event.getAsync()).rejects.toThrow('async error');
  });

  it('should handle no tasks gracefully', async () => {
    const event = createAsyncEvent('empty');
    await expect(event.getAsync()).resolves.toBeUndefined();
  });

  it('should chain multiple transforms', async () => {
    const order: string[] = [];
    const event = createAsyncEvent('test');

    event.async(async () => { order.push('task'); });
    event.transform(async (chain) => {
      // outer mapper — receives the task chain promise
      await chain;
      order.push('outer-end');
    });
    event.transform(async (chain) => {
      // inner mapper — wraps the outer mapper
      await chain;
      order.push('inner-end');
    });

    await event.getAsync();
    // Task runs eagerly, then outer-end, then inner-end
    expect(order).toEqual(['task', 'outer-end', 'inner-end']);
  });
});
