import { ICache } from './cache.interface';

/** Minimal Redis client interface (compatible with ioredis) */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  getdel?(key: string): Promise<string | null>;
}

export class RedisCache<T = unknown> implements ICache<T> {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisClient,
    options?: { prefix?: string },
  ) {
    this.prefix = options?.prefix ?? 'zucker:cache:';
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs) {
      await this.redis.set(this.key(key), serialized, 'PX', ttlMs);
    } else {
      await this.redis.set(this.key(key), serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(this.key(key))) === 1;
  }

  async clear(): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  async getOrDefault(key: string, defaultValue: T): Promise<T> {
    const val = await this.get(key);
    return val !== undefined ? val : defaultValue;
  }

  async getAndRemove(key: string): Promise<T | undefined> {
    if (this.redis.getdel) {
      const raw = await this.redis.getdel(this.key(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    }
    // Fallback for Redis < 6.2: non-atomic but best effort
    const val = await this.get(key);
    if (val !== undefined) {
      await this.del(key);
    }
    return val;
  }

  async keys(): Promise<string[]> {
    const result: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      for (const k of keys) {
        result.push(k.substring(this.prefix.length));
      }
    } while (cursor !== '0');
    return result;
  }

  async getAll(...keys: string[]): Promise<T[]> {
    if (!keys || keys.length === 0) {
      const allKeys = await this.keys();
      const result: T[] = [];
      for (const k of allKeys) {
        const val = await this.get(k);
        if (val !== undefined) result.push(val);
      }
      return result;
    }
    const result: T[] = [];
    for (const k of keys) {
      const val = await this.get(k);
      if (val !== undefined) result.push(val);
    }
    return result;
  }

  async evictAll(keys: Iterable<string>): Promise<void> {
    const keysArray = Array.from(keys).map(k => this.key(k));
    if (keysArray.length > 0) {
      await this.redis.del(...keysArray);
    }
  }
}
