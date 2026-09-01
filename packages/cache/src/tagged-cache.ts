import type { ICache } from './cache.interface';

/**
 * 标签化缓存 — 对标 Claude Code postCompactCleanup 的分层缓存清理
 *
 * 给缓存条目打标签，支持按标签批量失效。解决"清除所有与某用户相关的缓存"类需求。
 *
 * 用法:
 * ```ts
 * const cache = new TaggedCache(innerCache);
 * await cache.setWithTags('user:123:profile', data, ['user:123', 'profile']);
 * await cache.setWithTags('user:123:perms', perms, ['user:123', 'permission']);
 *
 * // 按标签失效
 * await cache.invalidateByTag('user:123'); // 清除该用户所有缓存
 * ```
 */
export class TaggedCache<T = unknown> {
  /** tag → Set<key> 的映射 */
  private readonly tagIndex = new Map<string, Set<string>>();
  /** key → Set<tag> 的映射（反向索引，用于清理 tagIndex） */
  private readonly keyTags = new Map<string, Set<string>>();

  constructor(private readonly inner: ICache<T>) {}

  async get(key: string): Promise<T | undefined> {
    return this.inner.get(key);
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    return this.inner.set(key, value, ttlMs);
  }

  /**
   * 设置缓存值并关联标签
   */
  async setWithTags(key: string, value: T, tags: string[], ttlMs?: number): Promise<void> {
    await this.inner.set(key, value, ttlMs);

    // 清理旧的标签映射
    this.removeKeyFromIndexes(key);

    // 建立新映射
    const tagSet = new Set(tags);
    this.keyTags.set(key, tagSet);
    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  async del(key: string): Promise<void> {
    await this.inner.del(key);
    this.removeKeyFromIndexes(key);
  }

  async has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }

  async clear(): Promise<void> {
    await this.inner.clear();
    this.tagIndex.clear();
    this.keyTags.clear();
  }

  /**
   * 按标签失效：删除所有关联该标签的缓存条目
   * @returns 被删除的 key 数量
   */
  async invalidateByTag(tag: string): Promise<number> {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) return 0;

    const keysToDelete = [...keys];
    // 并行删除
    await Promise.all(keysToDelete.map((key) => this.inner.del(key)));

    // 清理索引
    for (const key of keysToDelete) {
      this.removeKeyFromIndexes(key);
    }

    return keysToDelete.length;
  }

  /**
   * 按多个标签失效（并集）
   */
  async invalidateByTags(tags: string[]): Promise<number> {
    const allKeys = new Set<string>();
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        for (const key of keys) allKeys.add(key);
      }
    }

    if (allKeys.size === 0) return 0;

    await Promise.all([...allKeys].map((key) => this.inner.del(key)));
    for (const key of allKeys) {
      this.removeKeyFromIndexes(key);
    }

    return allKeys.size;
  }

  /**
   * 获取标签关联的所有 key（自动清理已过期的引用）
   */
  async getKeysByTag(tag: string): Promise<string[]> {
    const keys = this.tagIndex.get(tag);
    if (!keys) return [];

    const alive: string[] = [];
    const expired: string[] = [];
    for (const key of keys) {
      if (await this.inner.has(key)) {
        alive.push(key);
      } else {
        expired.push(key);
      }
    }

    // Clean up stale references
    for (const key of expired) {
      this.removeKeyFromIndexes(key);
    }

    return alive;
  }

  /**
   * 获取 key 关联的所有标签
   */
  getTagsByKey(key: string): string[] {
    const tags = this.keyTags.get(key);
    return tags ? [...tags] : [];
  }

  private removeKeyFromIndexes(key: string): void {
    const tags = this.keyTags.get(key);
    if (tags) {
      for (const tag of tags) {
        const keys = this.tagIndex.get(tag);
        if (keys) {
          keys.delete(key);
          if (keys.size === 0) this.tagIndex.delete(tag);
        }
      }
      this.keyTags.delete(key);
    }
  }
}
