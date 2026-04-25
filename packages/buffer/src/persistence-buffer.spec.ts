import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersistenceBuffer } from './persistence-buffer';

describe('PersistenceBuffer', () => {
  let buffer: PersistenceBuffer<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new PersistenceBuffer<string>({
      bufferSize: 5,
      flushTimeoutMs: 1000,
      maxRetries: 2,
      parallelism: 1,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('should write items to buffer and report size', () => {
    buffer.write('a');
    buffer.write('b');
    expect(buffer.size).toBe(2);
  });

  it('should flush items to handler', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    buffer.write('a');
    buffer.write('b');
    await buffer.flush();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(['a', 'b']);
    expect(buffer.size).toBe(0);
  });

  it('should not flush when buffer is empty', async () => {
    const handler = vi.fn();
    buffer.onFlush(handler);
    await buffer.flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it('should auto-flush when buffer reaches bufferSize', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    // Write exactly bufferSize items (5)
    for (let i = 0; i < 5; i++) {
      buffer.write(`item-${i}`);
    }

    // Allow async flush to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(5);
  });

  it('should send failed items to dead letter queue after retries exhausted', async () => {
    const errors: unknown[] = [];
    buffer.onError = (err) => errors.push(err);
    buffer.onFlush(async () => {
      throw new Error('flush error');
    });

    buffer.write('a');
    buffer.write('b');
    await buffer.flush();

    const dlq = buffer.getDeadLetterQueue();
    expect(dlq).toEqual(['a', 'b']);
  });

  it('should clear dead letter queue', async () => {
    buffer.onFlush(async () => {
      throw new Error('fail');
    });
    buffer.onError = () => {};

    buffer.write('a');
    await buffer.flush();

    expect(buffer.getDeadLetterQueue()).toHaveLength(1);
    buffer.clearDeadLetterQueue();
    expect(buffer.getDeadLetterQueue()).toHaveLength(0);
  });

  it('should writeMany items', () => {
    buffer.writeMany(['x', 'y', 'z']);
    expect(buffer.size).toBe(3);
  });

  it('should ignore empty writeMany', () => {
    buffer.writeMany([]);
    expect(buffer.size).toBe(0);
  });

  it('should throw when writing to disposed buffer', async () => {
    await buffer.stop();
    expect(() => buffer.write('a')).toThrow('Buffer has been disposed');
  });

  it('should flush remaining items on stop', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    buffer.write('a');
    buffer.write('b');
    await buffer.stop();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(['a', 'b']);
  });

  it('should support multiple flush handlers', async () => {
    const results1: string[][] = [];
    const results2: string[][] = [];

    buffer.onFlush(async (items) => { results1.push([...items]); });
    buffer.onFlush(async (items) => { results2.push([...items]); });

    buffer.write('a');
    await buffer.flush();

    expect(results1).toHaveLength(1);
    expect(results2).toHaveLength(1);
  });

  it('should chain onFlush calls', () => {
    const result = buffer.onFlush(async () => {});
    expect(result).toBe(buffer);
  });

  it('should start and stop timer-driven flush', async () => {
    const flushed: string[][] = [];
    buffer.onFlush(async (items) => {
      flushed.push([...items]);
    });

    buffer.start();
    buffer.write('a');
    await vi.advanceTimersByTimeAsync(1100);

    expect(flushed.length).toBeGreaterThanOrEqual(1);
    await buffer.stop();
  });
});
