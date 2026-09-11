import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service';
import { RedisCacheService } from './redis-cache.service';
import { ZuckerCacheModule } from './cache.module';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const memory = (maxEntries = 1000) =>
  new CacheService(new RedisCacheService(), {
    preferredProvider: 'memory',
    memoryMaxEntries: maxEntries,
  });

afterEach(() => vi.useRealTimers());

describe('CacheService loading and invalidation', () => {
  it('coalesces concurrent loads and permits a retry after rejection', async () => {
    const cache = memory();
    const result = deferred<string>();
    const started = deferred<void>();
    const factory = vi.fn(() => {
      started.resolve();
      return result.promise;
    });
    const first = cache.getOrSet('item', factory, 60);
    const second = cache.getOrSet('item', factory, 60);
    await started.promise;
    expect(factory).toHaveBeenCalledTimes(1);
    const outcome = Promise.allSettled([first, second]);
    result.reject(new Error('load failed'));
    expect((await outcome).map((item) => item.status)).toEqual(['rejected', 'rejected']);
    await expect(cache.getOrSet('item', async () => 'retry', 60)).resolves.toBe('retry');
    await expect(cache.get('item')).resolves.toBe('retry');
    await cache.onModuleDestroy();
  });

  it.each(['delete', 'set', 'shutdown'] as const)('fences late loads after %s', async (action) => {
    const cache = memory();
    const result = deferred<string>();
    const started = deferred<void>();
    const pending = cache.getOrSet(
      'item',
      () => {
        started.resolve();
        return result.promise;
      },
      60,
    );
    await started.promise;
    if (action === 'delete') await cache.delete('item');
    if (action === 'set') await cache.set('item', 'replacement', 60);
    if (action === 'shutdown') await cache.onModuleDestroy();
    result.resolve('stale');
    await expect(pending).resolves.toBe('stale');
    await expect(cache.get('item')).resolves.toBe(action === 'set' ? 'replacement' : null);
    await cache.onModuleDestroy();
  });

  it('an earlier completion cannot remove a newer in-flight load', async () => {
    const cache = memory();
    const firstValue = deferred<string>();
    const secondValue = deferred<string>();
    const firstStarted = deferred<void>();
    const first = cache.getOrSet(
      'item',
      () => {
        firstStarted.resolve();
        return firstValue.promise;
      },
      60,
    );
    await firstStarted.promise;
    await cache.delete('item');
    const secondFactory = vi.fn(() => secondValue.promise);
    const second = cache.getOrSet('item', secondFactory, 60);
    firstValue.resolve('stale');
    await first;
    const third = cache.getOrSet('item', secondFactory, 60);
    secondValue.resolve('fresh');
    await expect(Promise.all([second, third])).resolves.toEqual(['fresh', 'fresh']);
    expect(secondFactory).toHaveBeenCalledTimes(1);
    await expect(cache.get('item')).resolves.toBe('fresh');
    await cache.onModuleDestroy();
  });

  it('keeps the configured capacity, seconds TTL and non-immortal zero TTL', async () => {
    vi.useFakeTimers();
    const cache = memory(2);
    await cache.set('oldest', 'old', 60);
    await cache.set('second', 'second', 60);
    await cache.set('newest', 'new', 2);
    await expect(cache.get('oldest')).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(cache.ttl('newest')).resolves.toBe(1);
    await cache.set('zero', 'zero', 0);
    await vi.advanceTimersByTimeAsync(1001);
    await expect(cache.exists('newest')).resolves.toBe(false);
    await expect(cache.ttl('newest')).resolves.toBe(-2);
    await expect(cache.get('zero')).resolves.toBeNull();
    await cache.onModuleDestroy();
  });

  it('owns one cleanup timer and clears it on repeated shutdown', async () => {
    vi.useFakeTimers();
    const cache = new CacheService(new RedisCacheService(), { memoryCleanupIntervalMs: 1000 });
    cache.onModuleInit();
    cache.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    await cache.onModuleDestroy();
    await cache.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back while Redis is unavailable and removes stale fallback copies', async () => {
    const redis = new RedisCacheService();
    const available = vi.spyOn(redis, 'isAvailable').mockReturnValue(false);
    const cache = new CacheService(redis);
    await cache.set('item', 'fallback', 60);
    available.mockReturnValue(true);
    vi.spyOn(redis, 'set').mockResolvedValue(undefined);
    await cache.set('item', 'distributed', 60);
    available.mockReturnValue(false);
    await expect(cache.get('item')).resolves.toBeNull();
    await cache.onModuleDestroy();
  });

  it('clears coalescing state after a cache write rejects', async () => {
    const redis = new RedisCacheService();
    vi.spyOn(redis, 'isAvailable').mockReturnValue(true);
    vi.spyOn(redis, 'get').mockResolvedValue(null);
    vi.spyOn(redis, 'set')
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(undefined);
    const cache = new CacheService(redis);
    await expect(cache.getOrSet('item', async () => 'first')).rejects.toThrow('write failed');
    await expect(cache.getOrSet('item', async () => 'second')).resolves.toBe('second');
    await cache.onModuleDestroy();
  });

  it('registers each service once, without a lifecycle alias', () => {
    for (const definition of [
      ZuckerCacheModule.forRoot({ provider: 'fallback' }),
      ZuckerCacheModule.forRootAsync({
        mode: 'service',
        useFactory: () => ({ provider: 'fallback' }),
      }),
    ]) {
      const providers = definition.providers ?? [];
      expect(
        providers.filter(
          (provider) =>
            typeof provider === 'object' &&
            'provide' in provider &&
            provider.provide === RedisCacheService,
        ),
      ).toHaveLength(1);
      expect(
        providers.filter(
          (provider) =>
            typeof provider === 'object' &&
            'provide' in provider &&
            provider.provide === CacheService,
        ),
      ).toHaveLength(1);
      expect(
        providers.some((provider) => typeof provider === 'object' && 'useExisting' in provider),
      ).toBe(false);
    }
  });
});
