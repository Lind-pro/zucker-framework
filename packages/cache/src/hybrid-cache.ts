import { ICache } from './cache.interface';

/**
 * 混合缓存：先查本地 (L1) 再查远程 (L2, 通常是 Redis)
 * 写入时同时写 L1 和 L2
 */
export class HybridCache<T = unknown> implements ICache<T> {
  private readonly l1BackfillTtlMs: number;

  constructor(
    private readonly l1: ICache<T>,
    private readonly l2: ICache<T>,
    options?: { l1BackfillTtlMs?: number },
  ) {
    this.l1BackfillTtlMs = options?.l1BackfillTtlMs ?? 60_000;
  }

  async get(key: string): Promise<T | undefined> {
    const l1Val = await this.l1.get(key);
    if (l1Val !== undefined) return l1Val;

    const l2Val = await this.l2.get(key);
    if (l2Val !== undefined) {
      await this.l1.set(key, l2Val, this.l1BackfillTtlMs);
    }
    return l2Val;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    await Promise.all([
      this.l1.set(key, value, ttlMs),
      this.l2.set(key, value, ttlMs),
    ]);
  }

  async del(key: string): Promise<void> {
    await Promise.all([this.l1.del(key), this.l2.del(key)]);
  }

  async has(key: string): Promise<boolean> {
    return (await this.l1.has(key)) || (await this.l2.has(key));
  }

  async clear(): Promise<void> {
    await Promise.all([this.l1.clear(), this.l2.clear()]);
  }

  async getOrDefault(key: string, defaultValue: T): Promise<T> {
    const val = await this.get(key);
    return val !== undefined ? val : defaultValue;
  }

  async getAndRemove(key: string): Promise<T | undefined> {
    const val = await this.get(key);
    if (val !== undefined) {
      await this.del(key);
    }
    return val;
  }

  async keys(): Promise<string[]> {
    // 合并两层缓存的键（去重）
    const l1Keys = this.l1.keys ? await this.l1.keys() : [];
    const l2Keys = this.l2.keys ? await this.l2.keys() : [];
    return [...new Set([...l1Keys, ...l2Keys])];
  }

  async getAll(...keys: string[]): Promise<T[]> {
    if (!keys || keys.length === 0) {
      // 从 L2 获取所有（权威层）
      if (this.l2.getAll) return this.l2.getAll();
      if (this.l1.getAll) return this.l1.getAll();
      return [];
    }
    const result: T[] = [];
    for (const k of keys) {
      const val = await this.get(k);
      if (val !== undefined) result.push(val);
    }
    return result;
  }

  async evictAll(keys: Iterable<string>): Promise<void> {
    const keysArray = Array.from(keys);
    await Promise.all([
      this.l1.evictAll ? this.l1.evictAll(keysArray) : Promise.all(keysArray.map(k => this.l1.del(k))),
      this.l2.evictAll ? this.l2.evictAll(keysArray) : Promise.all(keysArray.map(k => this.l2.del(k))),
    ]);
  }
}
