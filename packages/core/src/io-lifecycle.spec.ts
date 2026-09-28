import { describe, it, expect, vi } from 'vitest';
import { createCancellationScope } from './cancellation-scope';
import { ConcurrencyBulkhead } from './concurrency-bulkhead';
import { shuffle } from './shuffle';

describe('IO lifecycle primitives', () => {
  it('unrefs deadlines and disposal clears them without aborting', () => {
    const unref = vi.fn();
    const timer = { unref };
    const set = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer as unknown as ReturnType<typeof setTimeout>);
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    try {
      const scope = createCancellationScope({ timeoutMs: 100, ref: false });
      expect(unref).toHaveBeenCalledOnce();
      scope.dispose();
      expect(clear).toHaveBeenCalledWith(timer);
      expect(scope.signal.aborted).toBe(false);
    } finally { set.mockRestore(); clear.mockRestore(); }
  });
  it('provides immediate idempotent leases and preserves queued admission', async () => {
    const pool = new ConcurrencyBulkhead(1, 1, 1000);
    const release = pool.tryAcquire()!;
    expect(pool.tryAcquire()).toBeUndefined();
    const waiting = pool.acquire();
    release(); release();
    expect(pool.tryAcquire()).toBeUndefined();
    const next = await waiting;
    next(); next();
    expect(pool.tryAcquire()).toBeTypeOf('function');
  });
  it('changes capacity without evicting active leases or bypassing FIFO waiters', async () => {
    const pool = new ConcurrencyBulkhead(2, 2, 1000);
    const first = pool.tryAcquire()!;
    const second = pool.tryAcquire()!;
    let admitted = false;
    const waiting = pool.acquire().then((release) => { admitted = true; return release; });
    pool.setConcurrency(1);
    first(); await Promise.resolve();
    expect(admitted).toBe(false);
    expect(pool.tryAcquire()).toBeUndefined();
    pool.setConcurrency(2);
    const release = await waiting;
    expect(admitted).toBe(true);
    expect(pool.tryAcquire()).toBeUndefined();
    second(); release();
    expect(pool.tryAcquire()).toBeTypeOf('function');
    expect(() => pool.setConcurrency(0)).toThrow(RangeError);
  });

  it('rejects invalid capacity and shuffles without modifying input', () => {
    expect(() => new ConcurrencyBulkhead(0, 0, 0)).toThrow(RangeError);
    const input = Object.freeze([1, 2, 3]);
    expect(shuffle(input, () => 0)).toEqual([2, 3, 1]);
    expect(input).toEqual([1, 2, 3]);
    expect(() => shuffle(input, () => 1)).toThrow(RangeError);
    expect(shuffle([])).toEqual([]);
  });
});
