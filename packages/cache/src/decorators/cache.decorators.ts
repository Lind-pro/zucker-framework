import type { ICache } from '../cache.interface';

const CACHE_METADATA = Symbol('CACHE_METADATA');

/**
 * 解析缓存 key 模板，将 #0, #1 替换为对应参数值
 * Strings, numbers and booleans are inserted as text (unchanged keys for existing
 * templates); other values use the type-preserving encoding below.
 *
 * @example resolveCacheKey('user:#0', ['42']) => 'user:42'
 */
function resolveCacheKey(template: string, args: unknown[]): string {
  return template.replace(/#(\d+)/g, (_, index) => {
    const idx = parseInt(index, 10);
    if (idx >= args.length) return '';
    const arg = args[idx];
    return typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean'
      ? String(arg)
      : stableStringify(arg);
  });
}

/** Map a value to a JSON-safe structure that keeps type distinctions (string vs number, Date, Map...). */
function normalizeKeyPart(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return { $u: 1 };
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $n: String(value) };
  if (typeof value === 'bigint') return { $big: value.toString() };
  if (typeof value === 'symbol' || typeof value === 'function') return { $t: typeof value, v: String(value) };
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() };
  const obj = value as object;
  if (seen.has(obj)) return { $cycle: 1 };
  seen.add(obj);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeKeyPart(item, seen));
    if (value instanceof Map) {
      return { $map: [...value.entries()]
        .map(([k, v]) => [normalizeKeyPart(k, seen), normalizeKeyPart(v, seen)])
        .sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1)) };
    }
    if (value instanceof Set) {
      return { $set: [...value].map((item) => normalizeKeyPart(item, seen))
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) };
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = normalizeKeyPart(record[key], seen);
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * 稳定序列化：对象按 key 排序后 stringify，保证相同内容生成相同 key。
 * Type-preserving: `1` and `"1"` differ, every Date has its own key, and separators
 * inside arguments cannot make two different argument lists collide.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeKeyPart(value, new WeakSet()));
}

function defaultCacheKey(cacheName: string, propertyKey: string | symbol, args: unknown[]): string {
  return `${cacheName}:${propertyKey.toString()}:${stableStringify(args)}`;
}

/**
 * Keys written through a custom `key` template do not necessarily start with
 * `cacheName:`; remember them (per cache service, process-local) so
 * `@CacheEvict({ allEntries: true })` removes them too.
 */
const customKeyRegistry = new WeakMap<object, Map<string, Set<string>>>();
function rememberCustomKey(cache: ICache, cacheName: string, key: string): void {
  let byName = customKeyRegistry.get(cache);
  if (!byName) customKeyRegistry.set(cache, (byName = new Map()));
  let keys = byName.get(cacheName);
  if (!keys) byName.set(cacheName, (keys = new Set()));
  keys.add(key);
}
function takeCustomKeys(cache: ICache, cacheName: string): string[] {
  const byName = customKeyRegistry.get(cache);
  const keys = byName?.get(cacheName);
  if (!keys) return [];
  byName!.delete(cacheName);
  return [...keys];
}

/** 获取实例上挂载的 __cacheService__（由 @InjectCache 配合 CacheModule 注入） */
function getCacheService(instance: unknown): ICache | undefined {
  return (instance as Record<string, unknown>).__cacheService__ as ICache | undefined;
}

/**
 * @Cacheable — 方法结果自动缓存
 * 对标 Spring @Cacheable
 *
 * - 先查缓存，命中则直接返回
 * - 未命中则执行原方法，并将结果写入缓存
 *
 * @param cacheName 缓存名称（用作 key 前缀）
 * @param options.key 自定义 key 模板，支持 #0, #1 引用参数
 * @param options.ttl 过期时间（毫秒）
 */
export function Cacheable(
  cacheName: string,
  options?: { key?: string; ttl?: number },
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const cache = getCacheService(this);
      if (!cache) return originalMethod.apply(this, args);

      const cacheKey = options?.key
        ? resolveCacheKey(options.key, args)
        : defaultCacheKey(cacheName, propertyKey, args);

      const cached = await cache.get(cacheKey);
      if (cached !== undefined && cached !== null) return cached;

      const result = await originalMethod.apply(this, args);
      if (result !== undefined && result !== null) {
        await cache.set(cacheKey, result, options?.ttl);
        if (options?.key) rememberCustomKey(cache, cacheName, cacheKey);
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * @CacheEvict — 清除缓存
 * 对标 Spring @CacheEvict
 *
 * - 先执行原方法，然后删除对应缓存
 * - allEntries=true 时通过 keys() 列出并批量删除同前缀的 key
 *
 * @param cacheName 缓存名称
 * @param options.key 自定义 key 模板
 * @param options.allEntries 是否清除该 cacheName 下所有条目
 */
export function CacheEvict(
  cacheName: string,
  options?: { key?: string; allEntries?: boolean },
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const result = await originalMethod.apply(this, args);
      const cache = getCacheService(this);
      if (cache) {
        if (options?.allEntries) {
          // 若缓存实现支持 keys()，则按前缀过滤删除；否则 clear() 全清
          if (typeof cache.keys === 'function') {
            const allKeys = await cache.keys();
            const prefix = `${cacheName}:`;
            const toDelete = [...new Set([
              ...allKeys.filter((k) => k.startsWith(prefix)),
              ...takeCustomKeys(cache, cacheName),
            ])];
            if (cache.evictAll) {
              await cache.evictAll(toDelete);
            } else {
              await Promise.all(toDelete.map((k) => cache.del(k)));
            }
          } else {
            await cache.clear();
          }
        } else {
          const cacheKey = options?.key
            ? resolveCacheKey(options.key, args)
            : defaultCacheKey(cacheName, propertyKey, args);
          await cache.del(cacheKey);
        }
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * @CachePut — 执行方法并更新缓存（不查缓存，始终执行）
 * 对标 Spring @CachePut
 *
 * @param cacheName 缓存名称
 * @param options.key 自定义 key 模板
 * @param options.ttl 过期时间（毫秒）
 */
export function CachePut(
  cacheName: string,
  options?: { key?: string; ttl?: number },
): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const result = await originalMethod.apply(this, args);
      const cache = getCacheService(this);
      if (cache && result !== undefined) {
        const cacheKey = options?.key
          ? resolveCacheKey(options.key, args)
          : defaultCacheKey(cacheName, propertyKey, args);
        await cache.set(cacheKey, result, options?.ttl);
        if (options?.key) rememberCustomKey(cache, cacheName, cacheKey);
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * @InjectCache — 类装饰器，标记此类需要注入缓存服务
 *
 * 配合 CacheModule 的 OnModuleInit 钩子，在实例化时将 CACHE_PROVIDER
 * 注入到实例的 __cacheService__ 属性上，供 @Cacheable/@CacheEvict/@CachePut 使用。
 */
export function InjectCache(): ClassDecorator {
  return (target: Function) => {
    (target as unknown as Record<symbol, boolean>)[CACHE_METADATA] = true;
  };
}

export { CACHE_METADATA };
