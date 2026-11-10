import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { CacheService } from './cache.service';
import { RedisCacheService } from './redis-cache.service';
import { MemoryCache } from './memory-cache';
import { RedisCache, type RedisClient } from './redis-cache';
import { HybridCache } from './hybrid-cache';
import { Cacheable, CacheEvict } from './decorators/cache.decorators';

class RedisDouble extends EventEmitter {
  store = new Map<string, string>();
  connect = vi.fn(async () => { this.emit('ready'); });
  disconnect = vi.fn((_reconnect = false) => undefined);
  get = vi.fn(async (key: string) => this.store.get(key) ?? null);
  set = vi.fn(async (key: string, value: string) => { this.store.set(key, value); return 'OK'; });
  del = vi.fn(async (...keys: string[]) => { keys.forEach((k) => this.store.delete(k)); return keys.length; });
  exists = vi.fn(async (key: string) => (this.store.has(key) ? 1 : 0));
  incr = vi.fn(async () => 1);
  expire = vi.fn(async () => 1);
  ttl = vi.fn(async () => 60);
  eval = vi.fn(async () => 7);
}

async function connected(client = new RedisDouble(), extra: Record<string, unknown> = {}) {
  const service = new RedisCacheService({
    url: 'redis://synthetic.invalid', createClient: () => client as unknown as Redis, ...extra,
  });
  await service.onModuleInit();
  return { service, client };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('H9A: invalidation survives a Redis outage', () => {
  it('replays deletes issued while degraded before serving reads again', async () => {
    vi.useFakeTimers();
    const { service, client } = await connected();
    const cache = new CacheService(service);
    await cache.set('perm:user-1', ['admin'], 3600);
    expect(client.store.get('perm:user-1')).toBe('["admin"]');

    // One failed command opens the breaker.
    client.get.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    await cache.get('other');
    expect(service.isAvailable()).toBe(false);

    await cache.delete('perm:user-1'); // revocation during the outage
    await cache.set('profile', { name: 'new' }, 60); // memory-only write during the outage
    expect(service.pendingInvalidationCount).toBe(2);

    client.emit('ready');
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.isAvailable()).toBe(true);
    await expect(cache.get('perm:user-1')).resolves.toBeNull();
    await expect(cache.get('profile')).resolves.toBeNull();
    expect(client.del).toHaveBeenCalledWith('perm:user-1', 'profile');
    expect(service.pendingInvalidationCount).toBe(0);
    service.onModuleDestroy();
  });

  it('applies the optional key prefix to every command', async () => {
    const { service, client } = await connected(new RedisDouble(), { keyPrefix: 'app:' });
    await service.set('k', 1, 60);
    expect(client.set).toHaveBeenCalledWith('app:k', '1', 'PX', 60000);
    await expect(service.get('k')).resolves.toBe(1);
    await service.delete('k');
    expect(client.del).toHaveBeenCalledWith('app:k');
    service.onModuleDestroy();
  });
});

describe('H9B: fences are per key', () => {
  it('a mutation of another key does not stop getOrSet from caching', async () => {
    const cache = new CacheService(new RedisCacheService(), { preferredProvider: 'memory' });
    const value = deferred<string>();
    const started = deferred<void>();
    const pending = cache.getOrSet('slow', () => { started.resolve(); return value.promise; }, 60);
    await started.promise;
    await cache.incr('rate:ip', 60);
    await cache.set('unrelated', 'x', 60);
    await cache.delete('unrelated');
    value.resolve('loaded');
    await expect(pending).resolves.toBe('loaded');
    await expect(cache.get('slow')).resolves.toBe('loaded');
    await cache.onModuleDestroy();
  });
});

describe('M19: counters and TTL edge cases', () => {
  it('increments with an atomic script when EVAL is available', async () => {
    const { service, client } = await connected();
    await expect(service.incr('count', 60)).resolves.toBe(7);
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining('INCR'), 1, 'count', 60);
    expect(client.incr).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('memory incr does not lose concurrent increments nor extend the expiry', async () => {
    vi.useFakeTimers();
    const cache = new CacheService(new RedisCacheService(), { preferredProvider: 'memory' });
    const values = await Promise.all(Array.from({ length: 20 }, () => cache.incr('hits', 10)));
    expect(Math.max(...values)).toBe(20);
    await vi.advanceTimersByTimeAsync(6000);
    await cache.incr('hits', 10);
    await vi.advanceTimersByTimeAsync(4001);
    await expect(cache.get('hits')).resolves.toBeNull();
    await cache.onModuleDestroy();
  });

  it('a zero TTL never creates an immortal entry', async () => {
    const memory = new MemoryCache<string>();
    await memory.set('k', 'old');
    await memory.set('k', 'new', 0);
    await expect(memory.get('k')).resolves.toBeUndefined();

    const client = new RedisDouble();
    const redis = new RedisCache<string>(client as unknown as RedisClient, { prefix: 'p:' });
    await redis.set('k', 'v', 0);
    expect(client.set).not.toHaveBeenCalled();
    expect(client.del).toHaveBeenCalledWith('p:k');
  });

  it('a corrupt value is a miss and does not open the breaker', async () => {
    const { service, client } = await connected();
    client.store.set('bad', '{not json');
    await expect(service.get('bad')).resolves.toBeNull();
    expect(service.isAvailable()).toBe(true);
    expect(client.disconnect).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
});

describe('L10: memory bound and hybrid backfill', () => {
  it('prunes expired entries before evicting live ones', async () => {
    vi.useFakeTimers();
    const memory = new MemoryCache<string>({ maxEntries: 2 });
    await memory.set('live', 'a', 10_000);
    await memory.set('short', 'b', 10);
    await vi.advanceTimersByTimeAsync(20);
    await memory.set('new', 'c', 10_000);
    await expect(memory.get('live')).resolves.toBe('a');
    await expect(memory.get('new')).resolves.toBe('c');
  });

  it('L1 backfill never outlives the remaining L2 TTL', async () => {
    vi.useFakeTimers();
    const l1 = new MemoryCache<string>();
    const l2 = new MemoryCache<string>();
    await l2.set('k', 'v', 1000);
    const hybrid = new HybridCache(l1, l2, { l1BackfillTtlMs: 60_000 });
    await expect(hybrid.get('k')).resolves.toBe('v');
    await vi.advanceTimersByTimeAsync(1001);
    await expect(l1.get('k')).resolves.toBeUndefined();
  });
});

describe('M10: decorator keys are type-preserving', () => {
  class Service {
    __cacheService__ = new MemoryCache();
    calls = 0;
    @Cacheable('report')
    async range(from: unknown, to?: unknown) { this.calls++; return `${String(from)}..${String(to)}`; }
    @Cacheable('byId', { key: 'item:#0' })
    async custom(id: string) { this.calls++; return id; }
    @CacheEvict('byId', { allEntries: true })
    async evictAll() { return true; }
  }

  it('distinguishes dates, strings vs numbers and separator-containing arguments', async () => {
    const s = new Service();
    await s.range(new Date('2026-01-01'), new Date('2026-02-01'));
    await s.range(new Date('2026-03-01'), new Date('2026-04-01'));
    await s.range(1);
    await s.range('1');
    await s.range('a:b', 'c');
    await s.range('a', 'b:c');
    expect(s.calls).toBe(6);
    await s.range(new Date('2026-01-01'), new Date('2026-02-01'));
    expect(s.calls).toBe(6);
  });

  it('allEntries also evicts keys written through a custom key template', async () => {
    const s = new Service();
    await s.custom('42');
    expect(await s.__cacheService__.get('item:42')).toBe('42');
    await s.evictAll();
    expect(await s.__cacheService__.get('item:42')).toBeUndefined();
  });
});
