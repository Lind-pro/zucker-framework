import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryCache } from './memory-cache';

describe('MemoryCache', () => {
  let cache: MemoryCache<string>;

  beforeEach(() => {
    cache = new MemoryCache<string>();
  });

  it('should return undefined for missing key', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('should set and get a value', async () => {
    await cache.set('key1', 'value1');
    const result = await cache.get('key1');
    expect(result).toBe('value1');
  });

  it('should overwrite existing value', async () => {
    await cache.set('key1', 'old');
    await cache.set('key1', 'new');
    const result = await cache.get('key1');
    expect(result).toBe('new');
  });

  it('should delete a value', async () => {
    await cache.set('key1', 'value1');
    await cache.del('key1');
    const result = await cache.get('key1');
    expect(result).toBeUndefined();
  });

  it('should not throw when deleting nonexistent key', async () => {
    await expect(cache.del('nonexistent')).resolves.toBeUndefined();
  });

  it('should report has correctly', async () => {
    expect(await cache.has('key1')).toBe(false);
    await cache.set('key1', 'value1');
    expect(await cache.has('key1')).toBe(true);
  });

  it('should clear all values', async () => {
    await cache.set('key1', 'v1');
    await cache.set('key2', 'v2');
    await cache.clear();
    expect(await cache.get('key1')).toBeUndefined();
    expect(await cache.get('key2')).toBeUndefined();
  });

  it('should expire values after TTL', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('key1', 'value1', 100);
      expect(await cache.get('key1')).toBe('value1');
      vi.advanceTimersByTime(150);
      expect(await cache.get('key1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not expire values without TTL', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('key1', 'value1');
      vi.advanceTimersByTime(100000);
      expect(await cache.get('key1')).toBe('value1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should use defaultTtlMs when no per-key TTL provided', async () => {
    vi.useFakeTimers();
    try {
      const cacheTtl = new MemoryCache<string>({ defaultTtlMs: 200 });
      await cacheTtl.set('key1', 'value1');
      expect(await cacheTtl.get('key1')).toBe('value1');
      vi.advanceTimersByTime(250);
      expect(await cacheTtl.get('key1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should report has as false for expired keys', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('key1', 'value1', 50);
      vi.advanceTimersByTime(100);
      expect(await cache.has('key1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── TTL >= boundary (bug fix coverage) ────────────────────────────

  it('should expire at exactly the TTL boundary (>= check)', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('k', 'v', 1000);
      // 1ms before expiry — still valid
      vi.advanceTimersByTime(999);
      expect(await cache.get('k')).toBe('v');
      // exactly at expiry — should be expired (>= boundary)
      vi.advanceTimersByTime(1);
      expect(await cache.get('k')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── getOrDefault ──────────────────────────────────────────────────

  it('should return value when key exists via getOrDefault', async () => {
    await cache.set('k1', 'v1');
    expect(await cache.getOrDefault('k1', 'fallback')).toBe('v1');
  });

  it('should return default when key is missing via getOrDefault', async () => {
    expect(await cache.getOrDefault('missing', 'fallback')).toBe('fallback');
  });

  // ─── getAndRemove ──────────────────────────────────────────────────

  it('should return and remove value via getAndRemove', async () => {
    await cache.set('k1', 'v1');
    expect(await cache.getAndRemove('k1')).toBe('v1');
    expect(await cache.get('k1')).toBeUndefined();
  });

  it('should return undefined for missing key via getAndRemove', async () => {
    expect(await cache.getAndRemove('missing')).toBeUndefined();
  });

  // ─── keys ──────────────────────────────────────────────────────────

  it('should return all valid keys and evict expired ones', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('a', '1');
      await cache.set('b', '2', 100);
      await cache.set('c', '3');
      vi.advanceTimersByTime(101);
      const keys = await cache.keys();
      expect(keys).toContain('a');
      expect(keys).toContain('c');
      expect(keys).not.toContain('b');
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── getAll ────────────────────────────────────────────────────────

  it('should return values for specified keys via getAll', async () => {
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.set('c', '3');
    const result = await cache.getAll('a', 'c');
    expect(result).toEqual(['1', '3']);
  });

  it('should return all non-expired values when called without args', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('a', '1');
      await cache.set('b', '2', 50);
      await cache.set('c', '3');
      vi.advanceTimersByTime(51);
      const all = await cache.getAll();
      expect(all).toEqual(['1', '3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should skip missing keys in getAll', async () => {
    await cache.set('a', '1');
    const result = await cache.getAll('a', 'missing');
    expect(result).toEqual(['1']);
  });

  // ─── evictAll ──────────────────────────────────────────────────────

  it('should remove all specified keys via evictAll', async () => {
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.set('c', '3');
    await cache.evictAll(['a', 'c']);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe('2');
    expect(await cache.get('c')).toBeUndefined();
  });
});
