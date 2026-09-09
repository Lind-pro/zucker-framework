/** Generic cache interface supporting get, set, delete, and TTL-based expiration. */
export interface ICache<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;

  /**
   * 获取值，若不存在则返回默认值 — 对应 jetlinks 缓存模式中的 getOrDefault 语义
   */
  getOrDefault?(key: string, defaultValue: T): Promise<T>;

  /**
   * 原子地获取并删除值 — 对应 jetlinks ReactiveCacheManager 的 getAndRemove 语义
   * 返回被删除的值，若不存在则返回 undefined
   */
  getAndRemove?(key: string): Promise<T | undefined>;

  /**
   * 列出所有缓存键 — 用于缓存管理和调试
   * 注意：在大型缓存中此操作可能开销较大
   */
  keys?(): Promise<string[]>;

  /**
   * 批量获取多个键的值
   * 返回所有存在的值（跳过不存在的键）
   */
  getAll?(...keys: string[]): Promise<T[]>;

  /**
   * 批量删除多个键
   */
  evictAll?(keys: Iterable<string>): Promise<void>;
}

/**
 * 缓存管理器接口
 *
 * 按名称获取/创建缓存实例，适用于多模块隔离场景。
 * 每个缓存名称对应独立命名空间，例如 "user-auth"。
 */
export interface ICacheManager {
  /**
   * 获取或创建命名缓存
   * @param name 缓存名称（命名空间）
   */
  getCache<T = unknown>(name: string): ICache<T>;
}
