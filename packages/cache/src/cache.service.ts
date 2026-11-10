import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MemoryCache } from './memory-cache';
import { RedisCacheService, type RedisCacheServiceOptions } from './redis-cache.service';

export interface CacheServiceOptions {
  /** Preferred backend. Redis falls back to bounded memory while unavailable. */
  preferredProvider?: 'memory' | 'redis';
  defaultTtlSeconds?: number;
  memoryMaxEntries?: number;
  memoryCleanupIntervalMs?: number;
  redis?: RedisCacheServiceOptions;
}

interface CachedValue {
  value: unknown;
  expiresAt: number;
}

/** Application cache with seconds-based TTL, null misses and coalesced loads.
 * The injected Redis service owns the connection; this service owns only memory.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly memory: MemoryCache<CachedValue>;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Per-key fence for in-flight loads: a mutation of key A must not discard a load of key B. */
  private readonly loadFences = new Map<string, { fenced: boolean }>();
  private cleanup?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly redis: RedisCacheService,
    private readonly options: CacheServiceOptions = {},
  ) {
    this.memory = new MemoryCache({ maxEntries: options.memoryMaxEntries });
  }

  onModuleInit(): void {
    if (this.cleanup || this.stopped) return;
    const interval = this.options.memoryCleanupIntervalMs;
    if (interval && interval > 0) {
      this.cleanup = setInterval(() => { void this.memory.keys(); }, interval);
      this.cleanup.unref?.();
    }
  }

  getProviderType(): 'memory' | 'redis' {
    return this.options.preferredProvider !== 'memory' && this.redis.isAvailable()
      ? 'redis' : 'memory';
  }

  get providerType(): 'memory' | 'redis' { return this.getProviderType(); }
  isAvailable(): boolean { return !this.stopped; }
  isRedisAvailable(): boolean { return this.redis.isAvailable(); }

  async get<T>(key: string): Promise<T | null> {
    if (this.stopped) return null;
    if (this.getProviderType() === 'redis') return this.redis.get<T>(key);
    const entry = await this.memory.get(key);
    return entry ? entry.value as T : null;
  }

  async set<T>(key: string, value: T, ttlSeconds = this.defaultTtl): Promise<void> {
    this.invalidate(key);
    await this.write(key, value, ttlSeconds);
  }

  getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds = this.defaultTtl): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const fence = { fenced: false };
    this.loadFences.set(key, fence);
    const pending = (async () => {
      const cached = await this.get<T>(key);
      if (cached !== null) return cached;
      const value = await factory();
      // A mutation of this key or shutdown fences the earlier load. A completed
      // caller still receives its own result, but it cannot repopulate stale data.
      if (!fence.fenced && !this.stopped) {
        await this.write(key, value, ttlSeconds, fence);
      }
      return value;
    })().finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      if (this.loadFences.get(key) === fence) this.loadFences.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  async delete(key: string): Promise<void> {
    this.invalidate(key);
    // Remove the fallback copy as well, so a later outage cannot resurrect it.
    await this.memory.del(key);
    // While Redis is degraded this records the key and deletes it on recovery, so the
    // old Redis value cannot be served again once reads return to Redis.
    if (this.options.preferredProvider !== 'memory') await this.redis.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    if (this.stopped) return false;
    return this.getProviderType() === 'redis' ? this.redis.exists(key) : this.memory.has(key);
  }

  async incr(key: string, ttlSeconds = this.defaultTtl): Promise<number> {
    this.invalidate(key);
    if (this.stopped) return 0;
    if (this.getProviderType() === 'redis') return this.redis.incr(key, ttlSeconds);
    // Synchronous read-modify-write: concurrent increments cannot interleave, and the
    // expiry is fixed by the first increment (as with Redis INCR + EXPIRE on a new key).
    const now = Date.now();
    const current = this.memory.getSync(key);
    const live = current && current.expiresAt > now ? current : undefined;
    const value = (typeof live?.value === 'number' ? live.value : 0) + 1;
    const expiresAt = live ? live.expiresAt : now + Math.max(1, ttlSeconds * 1000);
    this.memory.setSync(key, { value, expiresAt }, Math.max(1, expiresAt - now));
    return value;
  }

  async ttl(key: string): Promise<number> {
    if (this.stopped) return -2;
    if (this.getProviderType() === 'redis') return this.redis.ttl(key);
    const entry = await this.memory.get(key);
    const remaining = entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : -2;
    return remaining > 0 ? remaining : -2;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.cleanup) clearInterval(this.cleanup);
    this.cleanup = undefined;
    for (const fence of this.loadFences.values()) fence.fenced = true;
    this.loadFences.clear();
    this.inFlight.clear();
    await this.memory.clear();
  }

  private get defaultTtl(): number { return this.options.defaultTtlSeconds ?? 3600; }
  private invalidate(key: string): void {
    const fence = this.loadFences.get(key);
    if (fence) fence.fenced = true;
    this.loadFences.delete(key);
    this.inFlight.delete(key);
  }

  private async write<T>(
    key: string, value: T, ttlSeconds: number, fence?: { fenced: boolean },
  ): Promise<void> {
    if (this.stopped) return;
    if (this.getProviderType() === 'redis') {
      await this.memory.del(key);
      if (this.stopped || fence?.fenced) return;
      await this.redis.set(key, value, ttlSeconds);
      return;
    }
    // The memory copy is now newer than whatever Redis holds for this key.
    if (this.options.preferredProvider !== 'memory') this.redis.markStale(key);
    await this.memory.set(key, {
      value, expiresAt: Date.now() + ttlSeconds * 1000,
    }, ttlSeconds === 0 ? 1 : ttlSeconds * 1000);
  }
}
