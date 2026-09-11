import { ICache } from './cache.interface';

export interface MemoryCacheOptions {
  defaultTtlMs?: number;
  /** Maximum resident entries, evicting the oldest inserted key when full. */
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

/** In-memory cache implementation with optional TTL-based expiration. */
export class MemoryCache<T = unknown> implements ICache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly defaultTtlMs: number | null;

  constructor(private readonly options: MemoryCacheOptions = {}) {
    this.defaultTtlMs = options?.defaultTtlMs ?? null;
  }

  /** Resident size, including entries not yet pruned by a read or keys(). */
  get size(): number { return this.store.size; }

  async get(key: string): Promise<T | undefined> { return this.getSync(key); }

  /** Synchronous access for local state that cannot cross an asynchronous boundary. */
  getSync(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    this.setSync(key, value, ttlMs);
  }

  setSync(key: string, value: T, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    if (!this.store.has(key) && this.options.maxEntries !== undefined) {
      if (this.options.maxEntries <= 0) return;
      while (this.store.size >= this.options.maxEntries) {
        const oldest = this.store.keys().next();
        if (oldest.done) break;
        this.store.delete(oldest.value);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: effectiveTtl ? Date.now() + effectiveTtl : null,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async getOrDefault(key: string, defaultValue: T): Promise<T> {
    const val = await this.get(key);
    return val !== undefined ? val : defaultValue;
  }

  async getAndRemove(key: string): Promise<T | undefined> {
    const val = await this.get(key);
    if (val !== undefined) {
      this.store.delete(key);
    }
    return val;
  }

  async keys(): Promise<string[]> {
    // 清理过期条目后返回有效键
    const now = Date.now();
    const result: string[] = [];
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.store.delete(key);
      } else {
        result.push(key);
      }
    }
    return result;
  }

  async getAll(...keys: string[]): Promise<T[]> {
    if (!keys || keys.length === 0) {
      // 无参数时返回所有值
      const result: T[] = [];
      for (const [, entry] of this.store) {
        if (entry.expiresAt === null || Date.now() <= entry.expiresAt) {
          result.push(entry.value);
        }
      }
      return result;
    }
    const result: T[] = [];
    for (const key of keys) {
      const val = await this.get(key);
      if (val !== undefined) {
        result.push(val);
      }
    }
    return result;
  }

  async evictAll(keys: Iterable<string>): Promise<void> {
    for (const key of keys) {
      this.store.delete(key);
    }
  }
}
