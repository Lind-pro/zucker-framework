import type { ICache, ICacheManager } from './cache.interface';
import { MemoryCache } from './memory-cache';

/**
 * 内存缓存管理器 — 对应 hsweb AbstractReactiveCacheManager / CaffeineReactiveCacheManager
 *
 * 按名称管理多个缓存实例，每个名称对应一个独立的 MemoryCache。
 * hsweb 中 ReactiveCacheManager.getCache(name) 返回命名缓存，
 * 本实现采用懒创建策略（首次调用时创建）。
 */
export class MemoryCacheManager implements ICacheManager {
  private readonly caches = new Map<string, ICache>();
  private readonly defaultTtlMs: number | undefined;

  constructor(options?: { defaultTtlMs?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs;
  }

  getCache<T = unknown>(name: string): ICache<T> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache<T>({ defaultTtlMs: this.defaultTtlMs });
      this.caches.set(name, cache);
    }
    return cache as ICache<T>;
  }

  /** 获取所有已创建的缓存名称 */
  getCacheNames(): string[] {
    return Array.from(this.caches.keys());
  }

  /** 销毁指定缓存 */
  async destroyCache(name: string): Promise<void> {
    const cache = this.caches.get(name);
    if (cache) {
      await cache.clear();
      this.caches.delete(name);
    }
  }

  /** 销毁所有缓存 */
  async destroyAll(): Promise<void> {
    for (const cache of this.caches.values()) {
      await cache.clear();
    }
    this.caches.clear();
  }
}
