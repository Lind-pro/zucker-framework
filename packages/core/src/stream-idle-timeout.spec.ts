import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStreamIdleTimeout, StreamIdleTimeoutError } from './stream-idle-timeout';

afterEach(() => vi.useRealTimers());
describe('stream idle boundary', () => {
  it('passes every chunk and finalizes the source on early consumer exit', async () => {
    let closed = false;
    async function* source() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    }
    for await (const _ of withStreamIdleTimeout(source(), 100)) {
      break;
    }
    await Promise.resolve();
    expect(closed).toBe(true);
  });
  it('rejects a stalled next and aborts upstream without waiting for iterator return', async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => {}),
        return: () => new Promise<IteratorResult<number>>(() => {}),
      }),
    };
    const pending = withStreamIdleTimeout(source, 50, { onIdle }).next();
    const rejected = expect(pending).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(onIdle).toHaveBeenCalledOnce();
  });
});
