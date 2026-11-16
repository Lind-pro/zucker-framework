import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from './memory-cache';
import { RedisCache, type RedisClient } from './redis-cache';
import { HybridCache } from './hybrid-cache';
import type { ICache } from './cache.interface';

afterEach(() => vi.useRealTimers());

describe('atomic cache sequences', () => {
  it('allocates distinct monotonic values for simultaneous memory calls and respects the minimum', async () => {
    const cache = new MemoryCache();
    expect(await cache.readSequence('watermark')).toBeUndefined();
    const values = await Promise.all(Array.from({ length: 50 }, () => cache.advanceSequence('watermark', 1000, 60_000)));
    expect(values).toEqual(Array.from({ length: 50 }, (_, i) => 1000 + i));
    expect(await cache.advanceSequence('watermark', 3000, 60_000)).toBe(3000);
    expect(await cache.readSequence('watermark')).toBe(3000);
  });

  it('extends expiry without shortening an existing window', async () => {
    vi.useFakeTimers();
    const cache = new MemoryCache();
    await cache.advanceSequence('k', 100, 10_000);
    await vi.advanceTimersByTimeAsync(1000);
    await cache.advanceSequence('k', 0, 1000);
    expect(await cache.remainingTtlMs('k')).toBe(9000);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await cache.readSequence('k')).toBe(101);
    await cache.advanceSequence('k', 0, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(await cache.readSequence('k')).toBe(102);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.readSequence('k')).toBeUndefined();
  });

  it('fails without modifying invalid or overflowing memory state', async () => {
    const cache = new MemoryCache();
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '42', null]) {
      await cache.set('k', value);
      await expect(cache.readSequence('k')).rejects.toThrow();
      await expect(cache.advanceSequence('k', 100, 1000)).rejects.toThrow();
      expect(await cache.get('k')).toEqual(value);
    }
    await cache.set('k', Number.MAX_SAFE_INTEGER);
    await expect(cache.advanceSequence('k', 100, 1000)).rejects.toThrow();
    expect(await cache.get('k')).toBe(Number.MAX_SAFE_INTEGER);
    await expect(cache.advanceSequence('new', 1, 0)).rejects.toThrow();
    await expect(cache.advanceSequence('new', -1, 1000)).rejects.toThrow();
    await expect(new MemoryCache({ maxEntries: 0 }).advanceSequence('k', 1, 1000)).rejects.toThrow();
  });

  it('hybrid reads always see the L2 sequence even when another instance has stale L1 data', async () => {
    const l2 = new MemoryCache();
    const aL1 = new MemoryCache();
    const bL1 = new MemoryCache();
    const a = new HybridCache(aL1, l2);
    const b = new HybridCache(bL1, l2);
    await a.advanceSequence('k', 100, 60_000);
    await b.get('k'); // normal cache read backfills an old copy
    expect(await bL1.get('k')).toBe(100);
    await a.advanceSequence('k', 0, 60_000);
    expect(await b.readSequence('k')).toBe(101);
    expect(await b.advanceSequence('k', 0, 60_000)).toBe(102);
    expect(await bL1.get('k')).toBeUndefined();
    expect(await a.readSequence('k')).toBe(102);
  });

  it('does not emulate an atomic backend with ordinary get/set', async () => {
    const noAtomic = { get: vi.fn(), set: vi.fn() } as unknown as ICache;
    const hybrid = new HybridCache(new MemoryCache(), noAtomic);
    await expect(hybrid.advanceSequence('k', 1, 1000)).rejects.toThrow(/atomic/);
    await expect(hybrid.readSequence('k')).rejects.toThrow(/authoritative/);
    const redis = new RedisCache(noAtomic as unknown as RedisClient);
    await expect(redis.advanceSequence('k', 1, 1000)).rejects.toThrow(/EVAL/);
    expect(noAtomic.set).not.toHaveBeenCalled();
  });

  it('Redis uses one namespaced atomic operation and propagates backend failures', async () => {
    const client = { eval: vi.fn().mockResolvedValue(1000), get: vi.fn().mockResolvedValue('1000') };
    const cache = new RedisCache(client as unknown as RedisClient, { prefix: 'app:' });
    expect(await cache.advanceSequence('k', 1000, 60_000)).toBe(1000);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'app:k', 1000, 60_000);
    expect(await cache.readSequence('k')).toBe(1000);
    expect(client.get).toHaveBeenCalledWith('app:k');
    client.get.mockResolvedValueOnce('"1000"');
    await expect(cache.readSequence('k')).rejects.toThrow();
    client.eval.mockRejectedValueOnce(new Error('backend unavailable'));
    await expect(cache.advanceSequence('k', 1000, 60_000)).rejects.toThrow('backend unavailable');
  });

  it('decodes exact Redis decimal replies without trusting lossy or malformed transport values', async () => {
    const client = { eval: vi.fn().mockResolvedValue(String(Number.MAX_SAFE_INTEGER)) };
    const cache = new RedisCache(client as unknown as RedisClient);
    expect(await cache.advanceSequence('k', Number.MAX_SAFE_INTEGER - 1, 1000)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ['9007199254740992', '1.5', '1e3', '-1', ' 1', '01', '', Number.MAX_SAFE_INTEGER + 1]) {
      client.eval.mockResolvedValueOnce(value);
      await expect(cache.advanceSequence('k', 1000, 1000)).rejects.toThrow();
    }
  });
});
