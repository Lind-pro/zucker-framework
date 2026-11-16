import { afterEach, describe, expect, it, vi } from 'vitest';
import { HybridCache } from './hybrid-cache';
import { MemoryCache } from './memory-cache';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Package review regressions', () => {
  it('R11: direct hybrid writes expire within the L1 bound', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const shared = new MemoryCache<string>();
    const a = new HybridCache(new MemoryCache<string>(), shared, { l1BackfillTtlMs: 60_000 });
    const b = new HybridCache(new MemoryCache<string>(), shared, { l1BackfillTtlMs: 60_000 });
    await a.set('setting', 'old');
    await b.set('setting', 'new');
    clock.mockReturnValue(120_000);
    expect(await shared.get('setting')).toBe('new');
    expect(await a.get('setting')).toBe('new');
  });

  it.each([undefined, 1_000, 5] as const)('caps direct L1 writes without shortening L2 TTL %s', async ttl => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const l1 = new MemoryCache<string>(); const l2 = new MemoryCache<string>();
    const cache = new HybridCache(l1, l2, { l1BackfillTtlMs: 10 });
    await cache.set('k', 'v', ttl);
    clock.mockReturnValue(11);
    expect(await l1.get('k')).toBeUndefined();
    expect(await l2.get('k')).toBe(ttl === 5 ? undefined : 'v');
  });

  it('zero L1 TTL disables direct writes and backfill', async () => {
    const l1 = new MemoryCache<string>(); const l2 = new MemoryCache<string>();
    const cache = new HybridCache(l1, l2, { l1BackfillTtlMs: 0 });
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
    expect(await l1.get('k')).toBeUndefined();
  });

});
